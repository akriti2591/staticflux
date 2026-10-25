/**
 * Heads: the only mutable files of a workspace (`heads/<name>.json`,
 * DOCUMENT-FORMAT §5.1). A head is canonical JSON plus a CRC-32 field, so a
 * torn head is detectable, and it is replaced only atomically:
 *
 * 1. take the Web Lock `<prefix>:head:<name>`;
 * 2. re-read the head and compare `generation` (`SF-BLOB-003` on mismatch);
 * 3. write `<name>.json.tmp-<rnd>` in full;
 * 4. `move()` it over `<name>.json`.
 *
 * Recovery deletes leftover `*.tmp-*` files (a crash between 3 and 4).
 */
import { err, ok, type Result } from '@staticflux/core';
import { canonicalJson, crc32, fromUtf8, utf8 } from './codec.js';
import { abortedError, BlobHeadConflictError, BlobHeadTornError, BlobInvalidInputError } from './errors.js';
import {
  checkName,
  createDirectoryCache,
  type DirectoryHandleLike,
  isTempName,
  listFiles,
  publishFile,
  type PublishHooks,
  readFile,
  removeFile,
  TEMP_MARKER,
  type WriteMode,
} from './fs.js';
import { type LockManagerLike, withExclusiveLock } from './locks.js';
import type { StoreObserver } from './types.js';

export const HEADS_PATH = ['heads'] as const;

/** A head: any JSON object with a CAS `generation` (managed by the head store). */
export interface Head {
  readonly generation: number;
  readonly [field: string]: unknown;
}

export type HeadBody<H extends Head> = Omit<H, 'generation'>;

export type DecodedHead<H extends Head = Head> =
  | { readonly status: 'ok'; readonly head: H }
  | { readonly status: 'torn'; readonly reason: 'parse' | 'crc' | 'shape' };

/** Canonical JSON with a `crc` field over the canonical body. */
export function encodeHead(head: Head): Uint8Array {
  const { crc: _ignored, ...body } = head as Head & { crc?: unknown };
  return utf8(canonicalJson({ ...body, crc: crc32(utf8(canonicalJson(body))) }));
}

/** Decode and check a head file. */
export function decodeHead<H extends Head = Head>(bytes: Uint8Array): DecodedHead<H> {
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(bytes));
  } catch {
    return { status: 'torn', reason: 'parse' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { status: 'torn', reason: 'shape' };
  const { crc, ...body } = value as Record<string, unknown>;
  if (typeof crc !== 'number' || crc32(utf8(canonicalJson(body))) !== crc) return { status: 'torn', reason: 'crc' };
  if (typeof body.generation !== 'number' || !Number.isInteger(body.generation) || body.generation < 1) return { status: 'torn', reason: 'shape' };
  return { status: 'ok', head: body as H };
}

export interface CasOptions extends PublishHooks {
  readonly signal?: AbortSignal;
}

export interface UpdateOptions {
  readonly signal?: AbortSignal;
  /** CAS attempts before giving up with `SF-BLOB-003` (default 8). */
  readonly attempts?: number;
}

export interface HeadStore {
  /** `undefined` when the head does not exist; `SF-BLOB-010` when it is torn. */
  read<H extends Head>(name: string, options?: { readonly signal?: AbortSignal }): Promise<Result<H | undefined>>;
  /**
   * Replace the head only if its generation is still `expected` (0 = absent).
   * The new head gets `generation: expected + 1`.
   */
  cas<H extends Head>(name: string, expected: number, body: HeadBody<H>, options?: CasOptions): Promise<Result<H>>;
  /** Read → transform → CAS, retried on conflicts. Return `err` from `fn` to stop. */
  update<H extends Head>(
    name: string,
    fn: (current: H | undefined) => Result<HeadBody<H>>,
    options?: UpdateOptions,
  ): Promise<Result<H>>;
  /**
   * Write `head` as is (keeping its generation) if the stored generation is
   * lower or the head is absent or torn. For mirrors and restores; returns
   * whether it wrote.
   */
  replicate<H extends Head>(name: string, head: H, options?: CasOptions): Promise<Result<boolean>>;
  /** Head names (without `.json`). */
  list(): Promise<Result<string[]>>;
  /** Remove temp files left by crashed swaps. */
  recover(): Promise<Result<{ readonly tempsRemoved: number }>>;
}

export interface HeadStoreOptions {
  readonly locks: LockManagerLike;
  /** Lock namespace, normally the workspace id (`<prefix>:head:<name>`). */
  readonly lockPrefix: string;
  /** Heads are small: `writable` (default) is faster than opening a sync handle. */
  readonly writeMode?: WriteMode;
  readonly path?: readonly string[];
  readonly observer?: StoreObserver;
}

const fileName = (name: string): string => `${name}.json`;

export function createHeadStore(root: DirectoryHandleLike, options: HeadStoreOptions): HeadStore {
  const path = options.path ?? HEADS_PATH;
  const mode = options.writeMode ?? 'writable';
  const dirs = createDirectoryCache(root);
  const lockName = (name: string): string => `${options.lockPrefix}:head:${name}`;

  const readRaw = async <H extends Head>(name: string, signal: AbortSignal | undefined): Promise<Result<H | undefined>> => {
    const valid = checkName(fileName(name));
    if (!valid.ok) return valid;
    const dir = await dirs.get(path, false);
    if (!dir.ok) return dir;
    if (dir.value === undefined) return ok(undefined);
    const bytes = await readFile(dir.value, valid.value, undefined, signal);
    if (!bytes.ok) return bytes.error.code === 'SF-BLOB-005' ? ok(undefined) : bytes;
    const decoded = decodeHead<H>(bytes.value);
    if (decoded.status === 'torn') {
      return err(BlobHeadTornError({ message: `Head ${name} is torn (${decoded.reason}).`, details: { name, reason: decoded.reason } }));
    }
    return ok(decoded.head);
  };

  const write = async (name: string, head: Head, hooks: PublishHooks): Promise<Result<void>> => {
    const dir = await dirs.get(path, true);
    if (!dir.ok) return dir;
    if (dir.value === undefined) return err(BlobInvalidInputError({ message: 'heads directory missing' }));
    const published = await publishFile(dir.value, fileName(name), encodeHead(head), mode, hooks);
    if (published.ok) options.observer?.({ kind: 'head', name });
    return published;
  };

  const store: HeadStore = {
    read: (name, readOptions = {}) => readRaw(name, readOptions.signal),

    cas<H extends Head>(name: string, expected: number, body: HeadBody<H>, casOptions: CasOptions = {}) {
      return withExclusiveLock(
        options.locks,
        lockName(name),
        async (): Promise<Result<H>> => {
          const aborted = abortedError(casOptions.signal);
          if (aborted !== undefined) return err(aborted);
          const current = await readRaw<H>(name, casOptions.signal);
          if (!current.ok) return current;
          const found = current.value?.generation ?? 0;
          if (found !== expected) {
            return err(
              BlobHeadConflictError({
                message: `Head ${name}: expected generation ${expected}, found ${found}.`,
                details: { name, expected, current: found },
              }),
            );
          }
          const head = { ...body, generation: expected + 1 } as unknown as H;
          const written = await write(name, head, casOptions);
          return written.ok ? ok(head) : written;
        },
        casOptions.signal,
      );
    },

    async update<H extends Head>(name: string, fn: (current: H | undefined) => Result<HeadBody<H>>, updateOptions: UpdateOptions = {}) {
      const attempts = updateOptions.attempts ?? 8;
      let last: Result<H> | undefined;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const current = await readRaw<H>(name, updateOptions.signal);
        if (!current.ok) return current;
        const next = fn(current.value);
        if (!next.ok) return next;
        const { generation: _drop, ...body } = next.value as HeadBody<H> & { generation?: number };
        last = await store.cas<H>(name, current.value?.generation ?? 0, body as HeadBody<H>, updateOptions.signal === undefined ? {} : { signal: updateOptions.signal });
        if (last.ok || last.error.code !== 'SF-BLOB-003') return last;
      }
      return last ?? err(BlobHeadConflictError({ message: `Head ${name}: no attempts made.` }));
    },

    replicate(name, head, casOptions = {}) {
      return withExclusiveLock(
        options.locks,
        lockName(name),
        async (): Promise<Result<boolean>> => {
          const current = await readRaw(name, casOptions.signal);
          if (current.ok && current.value !== undefined && current.value.generation >= head.generation) return ok(false);
          if (!current.ok && current.error.code !== 'SF-BLOB-010') return current;
          const written = await write(name, head, casOptions);
          return written.ok ? ok(true) : written;
        },
        casOptions.signal,
      );
    },

    async list() {
      const dir = await dirs.get(path, false);
      if (!dir.ok) return dir;
      if (dir.value === undefined) return ok([]);
      const names = await listFiles(dir.value);
      if (!names.ok) return names;
      return ok(
        names.value
          .filter((n) => !isTempName(n) && n.endsWith('.json'))
          .map((n) => n.slice(0, -5))
          .sort(),
      );
    },

    async recover() {
      const dir = await dirs.get(path, false);
      if (!dir.ok) return dir;
      const heads = dir.value;
      if (heads === undefined) return ok({ tempsRemoved: 0 });
      const names = await listFiles(heads);
      if (!names.ok) return names;
      // A temp file may belong to a swap in flight in another context: remove it under that head's lock.
      const owners = new Set(names.value.filter(isTempName).map((n) => n.slice(0, n.indexOf(TEMP_MARKER)).replace(/\.json$/, '')));
      let tempsRemoved = 0;
      for (const owner of owners) {
        const removed = await withExclusiveLock(options.locks, lockName(owner), async () => {
          const current = await listFiles(heads);
          if (!current.ok) return current;
          let n = 0;
          for (const name of current.value) {
            if (!isTempName(name) || !name.startsWith(`${fileName(owner)}${TEMP_MARKER}`)) continue;
            const gone = await removeFile(heads, name);
            if (gone.ok) n += 1;
          }
          return ok(n);
        });
        if (!removed.ok) return removed;
        tempsRemoved += removed.value;
      }
      return ok({ tempsRemoved });
    },
  };
  return store;
}
