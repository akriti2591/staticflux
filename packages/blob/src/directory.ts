/**
 * `createDirectoryObjectStore(root)` — objects as files under
 * `blobs/sha256/<2 hex>/<64 hex>` (DOCUMENT-FORMAT §5.1) in any directory
 * handle: OPFS, a picked folder, or the in-memory fake.
 *
 * Write path (S6): small immutable objects use `createWritable` (opening a
 * sync handle costs more than it saves); objects of `syncThreshold` bytes or
 * more use a sync access handle when one is available (dedicated worker on
 * OPFS). Every object is published by temp file + `move()`.
 */
import { err, ok, type Result } from '@staticflux/core';
import { digestFromHex, digestHex } from './codec.js';
import { abortedError, BlobDisposedError, BlobNotFoundError, toBlobError } from './errors.js';
import {
  createDirectoryCache,
  type DirectoryHandleLike,
  fileExists,
  isTempName,
  listDirectories,
  listFiles,
  publishFile,
  readFile,
  removeFile,
  removeTempFiles,
  statFile,
  type WriteMode,
} from './fs.js';
import type { Digest, ObjectStore, StoreObserver } from './types.js';

export const BLOBS_PATH = ['blobs', 'sha256'] as const;
export const QUARANTINE_PATH = ['quarantine', 'sha256'] as const;
/** Objects at least this large use a sync access handle when available (1 MiB). */
export const DEFAULT_SYNC_THRESHOLD = 1024 * 1024;

export type WriteModePolicy = 'auto' | WriteMode;

export interface DirectoryObjectStoreOptions {
  readonly id?: string;
  /** `auto` (default): sync handles for large objects when available, `createWritable` otherwise. */
  readonly writeMode?: WriteModePolicy;
  readonly syncThreshold?: number;
  /** Whether sync access handles can be used (default: `detectSyncAccessHandles()`). */
  readonly syncAvailable?: boolean;
  /** Notified after each object is published or deleted (the folder mirror listens). */
  readonly observer?: StoreObserver;
}

export interface DirectoryObjectStore extends ObjectStore {
  readonly root: DirectoryHandleLike;
  /** Remove temp files left in blob shards by crashed writes. Lists every shard: run in the background. */
  sweepTemps(signal?: AbortSignal): Promise<Result<number>>;
}

/** `[dir path, file name]` of an object. */
export function objectPath(digest: Digest): readonly [readonly string[], string] {
  const hex = digestHex(digest);
  return [[...BLOBS_PATH, hex.slice(0, 2)], hex];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Choose sync or writable for a write of `size` bytes. */
export function chooseWriteMode(policy: WriteModePolicy, size: number, syncAvailable: boolean, threshold = DEFAULT_SYNC_THRESHOLD): WriteMode {
  if (policy !== 'auto') return policy;
  return syncAvailable && size >= threshold ? 'sync' : 'writable';
}

export function createDirectoryObjectStore(root: DirectoryHandleLike, options: DirectoryObjectStoreOptions = {}): DirectoryObjectStore {
  const id = options.id ?? `directory(${root.name})`;
  const policy = options.writeMode ?? 'auto';
  const threshold = options.syncThreshold ?? DEFAULT_SYNC_THRESHOLD;
  const syncAvailable = options.syncAvailable ?? detectSyncAccessHandles();
  const dirs = createDirectoryCache(root);
  let disposed = false;
  const guard = (signal: AbortSignal | undefined) => (disposed ? BlobDisposedError({ details: { store: id } }) : abortedError(signal));

  const shard = async (digest: Digest, create: boolean): Promise<Result<{ dir: DirectoryHandleLike | undefined; name: string; path: readonly string[] }>> => {
    const [path, name] = objectPath(digest);
    const dir = await dirs.get(path, create);
    return dir.ok ? ok({ dir: dir.value, name, path }) : dir;
  };

  return {
    id,
    root,
    capabilities: { persistent: true, rangeReads: true },

    async hasObject(digest, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      const at = await shard(digest, false);
      if (!at.ok) return at;
      return at.value.dir === undefined ? ok(false) : fileExists(at.value.dir, at.value.name);
    },

    async writeObject(digest, bytes, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      const at = await shard(digest, true);
      if (!at.ok) return at;
      const { dir, name, path } = at.value;
      if (dir === undefined) return err(toBlobError(new Error('shard directory missing'), 'write', name));
      const exists = await fileExists(dir, name);
      if (!exists.ok) return exists;
      if (exists.value) return ok();
      const published = await publishFile(dir, name, bytes, chooseWriteMode(policy, bytes.length, syncAvailable, threshold));
      if (!published.ok) return published;
      options.observer?.({ kind: 'object', path, name });
      return ok();
    },

    async readObject(digest, range, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      const at = await shard(digest, false);
      if (!at.ok) return at;
      if (at.value.dir === undefined) return missing(digest);
      return readFile(at.value.dir, at.value.name, range, signal);
    },

    async statObject(digest, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      const at = await shard(digest, false);
      if (!at.ok) return at;
      if (at.value.dir === undefined) return missing(digest);
      const stat = await statFile(at.value.dir, at.value.name);
      return stat.ok ? ok({ digest, storedSize: stat.value.size, modifiedAt: stat.value.lastModified }) : stat;
    },

    async deleteObject(digest, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      const at = await shard(digest, false);
      if (!at.ok) return at;
      if (at.value.dir === undefined) return ok();
      const removed = await removeFile(at.value.dir, at.value.name);
      if (removed.ok) options.observer?.({ kind: 'delete', path: at.value.path, name: at.value.name });
      return removed;
    },

    async quarantineObject(digest, signal) {
      const stopped = guard(signal);
      if (stopped !== undefined) return err(stopped);
      const at = await shard(digest, false);
      if (!at.ok) return at;
      if (at.value.dir === undefined) return missing(digest);
      const target = await dirs.get(QUARANTINE_PATH, true);
      if (!target.ok) return target;
      const destination = target.value;
      if (destination === undefined) return err(toBlobError(new Error('quarantine directory missing'), 'quarantine'));
      const where = `${QUARANTINE_PATH.join('/')}/${at.value.name}`;
      try {
        const handle = await at.value.dir.getFileHandle(at.value.name);
        if (typeof handle.move === 'function') {
          await handle.move(destination, at.value.name);
        } else {
          const bytes = await readFile(at.value.dir, at.value.name);
          if (!bytes.ok) return bytes;
          const copied = await publishFile(destination, at.value.name, bytes.value, 'writable');
          if (!copied.ok) return copied;
          await removeFile(at.value.dir, at.value.name);
        }
      } catch (cause) {
        return err(toBlobError(cause, 'quarantine', at.value.name));
      }
      options.observer?.({ kind: 'delete', path: at.value.path, name: at.value.name });
      return ok(where);
    },

    async *listObjects(signal) {
      const base = await dirs.get(BLOBS_PATH, false);
      if (!base.ok) {
        yield base;
        return;
      }
      if (base.value === undefined) return;
      const shards = await listDirectories(base.value);
      if (!shards.ok) {
        yield shards;
        return;
      }
      for (const name of shards.value.sort()) {
        const stopped = guard(signal);
        if (stopped !== undefined) {
          yield err(stopped);
          return;
        }
        const dir = await dirs.get([...BLOBS_PATH, name], false);
        if (!dir.ok) {
          yield dir;
          return;
        }
        if (dir.value === undefined) continue;
        const files = await listFiles(dir.value);
        if (!files.ok) {
          yield files;
          return;
        }
        for (const file of files.value.sort()) if (!isTempName(file) && HEX64.test(file)) yield ok(digestFromHex(file));
      }
    },

    async sweepTemps(signal) {
      const base = await dirs.get(BLOBS_PATH, false);
      if (!base.ok) return base;
      if (base.value === undefined) return ok(0);
      const shards = await listDirectories(base.value);
      if (!shards.ok) return shards;
      let removed = 0;
      for (const name of shards.value) {
        const stopped = guard(signal);
        if (stopped !== undefined) return err(stopped);
        const dir = await dirs.get([...BLOBS_PATH, name], false);
        if (!dir.ok) return dir;
        if (dir.value === undefined) continue;
        const swept = await removeTempFiles(dir.value);
        if (!swept.ok) return swept;
        removed += swept.value;
      }
      return ok(removed);
    },

    dispose() {
      disposed = true;
    },
  };
}

function missing(digest: Digest): Result<never> {
  return err(BlobNotFoundError({ message: `No object ${digest}.`, details: { digest } }));
}

/** True where `FileSystemSyncAccessHandle` exists (dedicated workers in Chromium). */
export function detectSyncAccessHandles(): boolean {
  return typeof (globalThis as { FileSystemSyncAccessHandle?: unknown }).FileSystemSyncAccessHandle === 'function';
}
