/**
 * The blob catalog: a derived, rebuildable inventory of stored objects
 * (DOCUMENT-FORMAT §5.1). The garbage collector sweeps from it instead of
 * listing directories (S6: listing 10k names cost 570 ms of a 1.4 s sweep).
 * `createBlobStore({ catalog })` records every write and every dedupe hit, so
 * `at` is the last time anything asked for the object: the GC grace period
 * protects objects that were (re)used recently.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { AsyncStore } from '@staticflux/storage';
import { isDigest } from './codec.js';
import { abortedError, BlobIoError } from './errors.js';
import type { BlobStore, Digest } from './types.js';

export interface CatalogEntry {
  readonly digest: Digest;
  /** Stored object size in bytes. */
  readonly size: number;
  /** Last write or reuse, ms since the epoch. */
  readonly at: number;
}

export interface BlobCatalog {
  readonly id: string;
  /** Upsert; an existing entry keeps the later `at`. */
  record(entries: readonly CatalogEntry[]): Promise<Result<void>>;
  forget(digests: readonly Digest[]): Promise<Result<void>>;
  get(digest: Digest): Promise<Result<CatalogEntry | undefined>>;
  entries(signal?: AbortSignal): AsyncIterable<Result<CatalogEntry>>;
  count(): Promise<Result<number>>;
  clear(): Promise<Result<void>>;
}

function merge(previous: CatalogEntry | undefined, next: CatalogEntry): CatalogEntry {
  if (previous === undefined) return next;
  return { digest: next.digest, size: next.size, at: Math.max(previous.at, next.at) };
}

/** In-memory catalog (tests, and stores that do not persist). */
export function createMemoryCatalog(id = 'memory-catalog'): BlobCatalog & { readonly size: number } {
  const map = new Map<Digest, CatalogEntry>();
  return {
    id,
    get size() {
      return map.size;
    },
    record(entries) {
      for (const entry of entries) map.set(entry.digest, merge(map.get(entry.digest), entry));
      return Promise.resolve(ok());
    },
    forget(digests) {
      for (const digest of digests) map.delete(digest);
      return Promise.resolve(ok());
    },
    get(digest) {
      return Promise.resolve(ok(map.get(digest)));
    },
    async *entries(signal) {
      for (const entry of [...map.values()]) {
        const aborted = abortedError(signal);
        if (aborted !== undefined) {
          yield err(aborted);
          return;
        }
        yield ok(entry);
      }
    },
    count() {
      return Promise.resolve(ok(map.size));
    },
    clear() {
      map.clear();
      return Promise.resolve(ok());
    },
  };
}

interface StoredEntry {
  readonly s: number;
  readonly t: number;
}

/**
 * A catalog over any `@staticflux/storage` `AsyncStore` (IndexedDB in
 * production, via `createIndexedDbStore`). Keys are digests; values `{ s, t }`.
 */
export function createStoreCatalog(store: AsyncStore<StoredEntry>, id = `catalog(${store.id})`): BlobCatalog {
  return {
    id,
    async record(entries) {
      const ops: { type: 'set'; key: string; value: StoredEntry }[] = [];
      for (const entry of entries) {
        const previous = await store.get(entry.digest);
        if (!previous.ok) return previous;
        const current = previous.value === undefined ? undefined : { digest: entry.digest, size: previous.value.s, at: previous.value.t };
        const next = merge(current, entry);
        ops.push({ type: 'set', key: entry.digest, value: { s: next.size, t: next.at } });
      }
      if (ops.length === 0) return ok();
      const written = await store.batch(ops);
      return written.ok ? ok() : written;
    },
    async forget(digests) {
      if (digests.length === 0) return ok();
      const removed = await store.batch(digests.map((key) => ({ type: 'delete' as const, key })));
      return removed.ok ? ok() : removed;
    },
    async get(digest) {
      const value = await store.get(digest);
      if (!value.ok) return value;
      return ok(value.value === undefined ? undefined : { digest, size: value.value.s, at: value.value.t });
    },
    async *entries(signal) {
      const cursor = store.seek({ prefix: 'sha256:' });
      for await (const [key, value] of cursor) {
        const aborted = abortedError(signal);
        if (aborted !== undefined) {
          yield err(aborted);
          return;
        }
        if (isDigest(key)) yield ok({ digest: key, size: value.s, at: value.t });
      }
      if (cursor.error !== undefined) yield err(cursor.error);
    },
    async count() {
      const keys = await store.seek({ prefix: 'sha256:' }).keys();
      return keys.ok ? ok(keys.value.length) : keys;
    },
    async clear() {
      return store.clear();
    },
  };
}

export interface RebuildCatalogOptions {
  readonly signal?: AbortSignal;
  /** Timestamp given to objects found by the listing (default: `now()`, so the grace period protects them). */
  readonly at?: number;
  readonly now?: () => number;
  /** Batch size of catalog writes (default 256). */
  readonly batch?: number;
}

export interface RebuildCatalogReport {
  readonly listed: number;
  readonly added: number;
  readonly removed: number;
}

/**
 * Rebuild the catalog from a full listing of the store (the only place a
 * listing is used). Entries for objects that no longer exist are removed;
 * found objects keep their catalog `at` or get `options.at`.
 */
export async function rebuildCatalog(
  blobs: Pick<BlobStore, 'list'>,
  catalog: BlobCatalog,
  options: RebuildCatalogOptions = {},
): Promise<Result<RebuildCatalogReport>> {
  const at = options.at ?? (options.now ?? Date.now)();
  const batchSize = options.batch ?? 256;
  const seen = new Set<Digest>();
  let pending: CatalogEntry[] = [];
  let added = 0;
  const flush = async (): Promise<Result<void>> => {
    if (pending.length === 0) return ok();
    const fresh: CatalogEntry[] = [];
    for (const entry of pending) {
      const existing = await catalog.get(entry.digest);
      if (!existing.ok) return existing;
      if (existing.value === undefined) fresh.push(entry);
    }
    pending = [];
    added += fresh.length;
    return catalog.record(fresh);
  };
  for await (const item of blobs.list(options.signal === undefined ? {} : { signal: options.signal })) {
    if (!item.ok) return item;
    seen.add(item.value);
    pending.push({ digest: item.value, size: 0, at });
    if (pending.length >= batchSize) {
      const written = await flush();
      if (!written.ok) return written;
    }
  }
  const written = await flush();
  if (!written.ok) return written;
  const stale: Digest[] = [];
  for await (const entry of catalog.entries(options.signal)) {
    if (!entry.ok) return entry;
    if (!seen.has(entry.value.digest)) stale.push(entry.value.digest);
  }
  const forgotten = await catalog.forget(stale);
  if (!forgotten.ok) return err(BlobIoError({ cause: forgotten.error, message: 'Catalog rebuild could not remove stale entries.' }));
  return ok({ listed: seen.size, added, removed: stale.length });
}
