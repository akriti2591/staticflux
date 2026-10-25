/**
 * The file system port: the subset of the File System Access / OPFS handle API
 * the store uses, so the same code runs on OPFS, on a picked folder and on the
 * in-memory fake (`createMemoryDirectory`). Helpers implement the S6 rules:
 *
 * - **Atomic publish** = write `name.tmp-<rnd>` in full (sync handle flushed and
 *   closed, or writable closed), then `FileSystemFileHandle.move(dir, name)`,
 *   which overwrites the target. `move` lives on the *file* handle prototype.
 * - Never keep a sync handle open on a file that gets moved (move throws
 *   `NoModificationAllowedError`).
 * - A `File` snapshot taken before a swap throws `NotReadableError` when read
 *   afterwards: readers re-open the handle and retry.
 */
import { err, ok, type Result } from '@staticflux/core';
import { abortedError, BlobInvalidInputError, BlobNotFoundError, BlobUnavailableError, toBlobError } from './errors.js';
import type { BlobRange } from './types.js';

export interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface SyncAccessHandleLike {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

export interface FileLike {
  readonly size: number;
  readonly lastModified: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type PermissionStateLike = 'granted' | 'denied' | 'prompt';

export interface FileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<FileLike>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
  /** Dedicated workers on OPFS only. */
  createSyncAccessHandle?(): Promise<SyncAccessHandleLike>;
  /** Chromium: on `FileSystemFileHandle.prototype`; overwrites an existing target. */
  move?(destination: DirectoryHandleLike, name: string): Promise<void>;
}

export interface DirectoryHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<FileHandleLike | DirectoryHandleLike>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionStateLike>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionStateLike>;
}

/**
 * View a platform `FileSystemDirectoryHandle` (OPFS root, `showDirectoryPicker()`
 * result) as the port. TypeScript's DOM lib omits the async iterators, which
 * Chromium implements.
 */
export function asDirectoryHandle(handle: FileSystemDirectoryHandle): DirectoryHandleLike {
  return handle as unknown as DirectoryHandleLike;
}

/** How a file's bytes are written: `createWritable` (any context) or a sync access handle (dedicated worker, OPFS). */
export type WriteMode = 'writable' | 'sync';

export interface PublishHooks {
  /** Fault injection: runs after the temp file is complete, before `move()`. A throw aborts the publish. */
  readonly beforeMove?: () => Promise<void> | void;
}

function errorName(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'name' in value ? String((value as { name: unknown }).name) : undefined;
}

export const TEMP_MARKER = '.tmp-';

let tempCounter = 0;

/** A unique temp name for `name` (`name.tmp-<rnd>`). */
export function tempNameFor(name: string): string {
  tempCounter += 1;
  return `${name}${TEMP_MARKER}${Math.random().toString(36).slice(2, 10)}${tempCounter.toString(36)}`;
}

export function isTempName(name: string): boolean {
  return name.includes(TEMP_MARKER);
}

/** Validate a single path segment. */
export function checkName(name: string): Result<string> {
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return err(BlobInvalidInputError({ message: `Invalid file name "${name}".`, details: { name } }));
  }
  return ok(name);
}

/**
 * Resolve a directory below `root`. With `create: false`, a missing directory
 * resolves to `undefined` (not an error).
 */
export async function openDirectory(
  root: DirectoryHandleLike,
  path: readonly string[],
  create: boolean,
): Promise<Result<DirectoryHandleLike | undefined>> {
  let dir = root;
  for (const part of path) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (cause) {
      if (!create && (errorName(cause) === 'NotFoundError' || errorName(cause) === 'TypeMismatchError')) return ok(undefined);
      return err(toBlobError(cause, 'open-directory', path.join('/')));
    }
  }
  return ok(dir);
}

/** A cache of opened directories (handles are cheap to keep, slow to resolve). */
export interface DirectoryCache {
  get(path: readonly string[], create: boolean): Promise<Result<DirectoryHandleLike | undefined>>;
  forget(path: readonly string[]): void;
}

export function createDirectoryCache(root: DirectoryHandleLike): DirectoryCache {
  const cache = new Map<string, DirectoryHandleLike>();
  return {
    async get(path, create) {
      const key = path.join('/');
      const hit = cache.get(key);
      if (hit !== undefined) return ok(hit);
      const opened = await openDirectory(root, path, create);
      if (opened.ok && opened.value !== undefined) cache.set(key, opened.value);
      return opened;
    },
    forget(path) {
      const prefix = path.join('/');
      for (const key of [...cache.keys()]) if (key === prefix || key.startsWith(`${prefix}/`)) cache.delete(key);
    },
  };
}

/** True when the file exists. */
export async function fileExists(dir: DirectoryHandleLike, name: string): Promise<Result<boolean>> {
  try {
    await dir.getFileHandle(name);
    return ok(true);
  } catch (cause) {
    const n = errorName(cause);
    if (n === 'NotFoundError' || n === 'TypeMismatchError') return ok(false);
    return err(toBlobError(cause, 'exists', name));
  }
}

const READ_RETRIES = 5;

/**
 * Read a file (or a range of it). Retries `NotReadableError` (a snapshot made
 * stale by a concurrent swap) by re-opening the handle.
 */
export async function readFile(
  dir: DirectoryHandleLike,
  name: string,
  range?: BlobRange,
  signal?: AbortSignal,
): Promise<Result<Uint8Array>> {
  for (let attempt = 0; ; attempt++) {
    const aborted = abortedError(signal);
    if (aborted !== undefined) return err(aborted);
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (range !== undefined && (range.start < 0 || range.end < range.start || range.end > file.size)) {
        return err(BlobInvalidInputError({ message: `Range [${range.start}, ${range.end}) is outside [0, ${file.size}) of ${name}.` }));
      }
      const buffer = range === undefined ? await file.arrayBuffer() : await file.slice(range.start, range.end).arrayBuffer();
      return ok(new Uint8Array(buffer));
    } catch (cause) {
      const n = errorName(cause);
      if (n === 'NotFoundError' || n === 'TypeMismatchError') {
        return err(BlobNotFoundError({ cause, message: `No file ${name}.`, details: { name } }));
      }
      if (n === 'NotReadableError' && attempt < READ_RETRIES) continue;
      return err(toBlobError(cause, 'read', name));
    }
  }
}

/** `{ size, lastModified }` of a file. */
export async function statFile(dir: DirectoryHandleLike, name: string): Promise<Result<{ size: number; lastModified: number }>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      return ok({ size: file.size, lastModified: file.lastModified });
    } catch (cause) {
      const n = errorName(cause);
      if (n === 'NotFoundError' || n === 'TypeMismatchError') return err(BlobNotFoundError({ cause, message: `No file ${name}.`, details: { name } }));
      if (n === 'NotReadableError' && attempt < READ_RETRIES) continue;
      return err(toBlobError(cause, 'stat', name));
    }
  }
}

/** Write `bytes` as the whole content of `handle` (truncating). */
export async function writeHandle(handle: FileHandleLike, bytes: Uint8Array, mode: WriteMode): Promise<Result<void>> {
  try {
    if (mode === 'sync') {
      if (handle.createSyncAccessHandle === undefined) {
        return err(BlobUnavailableError({ message: 'Sync access handles are not available here (dedicated workers on OPFS only).' }));
      }
      const access = await handle.createSyncAccessHandle();
      try {
        access.truncate(0);
        let offset = 0;
        while (offset < bytes.length) {
          const wrote = access.write(bytes.subarray(offset), { at: offset });
          if (wrote <= 0) throw new Error('sync access handle wrote 0 bytes');
          offset += wrote;
        }
        access.flush();
      } finally {
        access.close();
      }
    } else {
      const writable = await handle.createWritable({ keepExistingData: false });
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (cause) {
        await writable.abort?.(cause).catch(() => undefined);
        throw cause;
      }
    }
    return ok();
  } catch (cause) {
    return err(toBlobError(cause, `write(${mode})`, handle.name));
  }
}

/** Remove a file; a missing file is not an error. */
export async function removeFile(dir: DirectoryHandleLike, name: string): Promise<Result<void>> {
  try {
    await dir.removeEntry(name);
    return ok();
  } catch (cause) {
    const n = errorName(cause);
    if (n === 'NotFoundError' || n === 'TypeMismatchError') return ok();
    return err(toBlobError(cause, 'remove', name));
  }
}

/**
 * Atomically publish `bytes` as `dir/name`: write a unique temp file in full,
 * then `move()` it over the target. Readers see the old or the new content,
 * never a partial file. The temp file is removed when the publish fails.
 */
export async function publishFile(
  dir: DirectoryHandleLike,
  name: string,
  bytes: Uint8Array,
  mode: WriteMode,
  hooks: PublishHooks = {},
): Promise<Result<void>> {
  const temp = tempNameFor(name);
  let handle: FileHandleLike;
  try {
    handle = await dir.getFileHandle(temp, { create: true });
  } catch (cause) {
    return err(toBlobError(cause, 'create', temp));
  }
  if (typeof handle.move !== 'function') {
    await removeFile(dir, temp);
    return err(BlobUnavailableError({ message: '`FileSystemFileHandle.move()` is not available; atomic publish is impossible here.' }));
  }
  const written = await writeHandle(handle, bytes, mode);
  if (!written.ok) {
    await removeFile(dir, temp);
    return written;
  }
  try {
    await hooks.beforeMove?.();
    await handle.move(dir, name);
    return ok();
  } catch (cause) {
    await removeFile(dir, temp);
    return err(toBlobError(cause, 'move', name));
  }
}

/** Names of the files (not directories) in `dir`. */
export async function listFiles(dir: DirectoryHandleLike): Promise<Result<string[]>> {
  try {
    const names: string[] = [];
    for await (const entry of dir.values()) if (entry.kind === 'file') names.push(entry.name);
    return ok(names);
  } catch (cause) {
    return err(toBlobError(cause, 'list', dir.name));
  }
}

/** Names of the subdirectories of `dir`. */
export async function listDirectories(dir: DirectoryHandleLike): Promise<Result<string[]>> {
  try {
    const names: string[] = [];
    for await (const entry of dir.values()) if (entry.kind === 'directory') names.push(entry.name);
    return ok(names);
  } catch (cause) {
    return err(toBlobError(cause, 'list', dir.name));
  }
}

/** Remove every `*.tmp-*` file in `dir` (crash leftovers). Returns how many were removed. */
export async function removeTempFiles(dir: DirectoryHandleLike): Promise<Result<number>> {
  const names = await listFiles(dir);
  if (!names.ok) return names;
  let removed = 0;
  for (const name of names.value) {
    if (!isTempName(name)) continue;
    const gone = await removeFile(dir, name);
    if (gone.ok) removed += 1;
  }
  return ok(removed);
}
