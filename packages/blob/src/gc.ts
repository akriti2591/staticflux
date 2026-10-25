/**
 * Mark-and-sweep garbage collection (IF-3.10, DOCUMENT-FORMAT §6.5).
 *
 * - **Mark** from registered root sources (live heads, milestone records,
 *   export records, the library's live blob assets). A chunked `BlobRef` marks
 *   its manifest and every chunk. A root source that fails aborts the run:
 *   GC never sweeps with an incomplete mark set.
 * - **Sweep from the catalog inventory**, never from a directory listing (S6:
 *   0.86 s instead of 1.42 s for 10k blobs). An unmarked object is deleted
 *   only if its catalog `at` is older than the grace period (30 days by
 *   default), so anything written or reused recently survives a concurrent
 *   mark. Cost is O(live set + catalog size).
 */
import { err, ok, type Result } from '@staticflux/core';
import { parseChunkManifest } from './blob-store.js';
import type { BlobCatalog } from './catalog.js';
import { isDigest } from './codec.js';
import { abortedError } from './errors.js';
import { runPool } from './pool.js';
import type { HeadStore } from './heads.js';
import type { BlobRef, BlobStore, Digest } from './types.js';

export const DEFAULT_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export type GcRootItem = Digest | BlobRef;
/** Yields everything one root keeps alive; an `err` item aborts the collection. */
export type GcRootSource = (signal: AbortSignal | undefined) => AsyncIterable<Result<GcRootItem>>;

export interface GcRoots {
  /** Register a root source; returns its removal. */
  add(id: string, source: GcRootSource): () => void;
  readonly sources: readonly (readonly [string, GcRootSource])[];
}

export function createGcRoots(): GcRoots {
  const sources = new Map<string, GcRootSource>();
  return {
    add(id, source) {
      sources.set(id, source);
      return () => {
        if (sources.get(id) === source) sources.delete(id);
      };
    },
    get sources() {
      return [...sources];
    },
  };
}

function isBlobRef(value: unknown): value is BlobRef {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<BlobRef>;
  return isDigest(v.digest) && typeof v.size === 'number' && typeof v.mime === 'string';
}

/** Every `BlobRef` found anywhere in a JSON value (heads, records). */
export function collectBlobRefs(value: unknown, out: BlobRef[] = []): BlobRef[] {
  if (isBlobRef(value)) {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) for (const item of value) collectBlobRefs(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectBlobRefs(item, out);
  return out;
}

/** A root source over every head in a head store (each head's `BlobRef`s). */
export function headRootSource(heads: HeadStore): GcRootSource {
  return async function* (signal) {
    const names = await heads.list();
    if (!names.ok) {
      yield names;
      return;
    }
    for (const name of names.value) {
      const head = await heads.read(name, signal === undefined ? {} : { signal });
      if (!head.ok) {
        yield head;
        return;
      }
      for (const ref of collectBlobRefs(head.value)) yield ok(ref);
    }
  };
}

/** A root source over a fixed list (tests, one-off roots). */
export function staticRootSource(items: readonly GcRootItem[]): GcRootSource {
  return async function* () {
    for (const item of items) yield ok(item);
  };
}

export interface GcOptions {
  readonly blobs: BlobStore;
  readonly catalog: BlobCatalog;
  readonly roots: GcRoots | readonly GcRootSource[];
  readonly graceMs?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /** Deletes in flight (default 16; S6: sequential sweeps were 3x slower). */
  readonly concurrency?: number;
  /** Mark and count, delete nothing. */
  readonly dryRun?: boolean;
}

export interface GcReport {
  readonly marked: number;
  /** Catalog entries examined. */
  readonly scanned: number;
  readonly kept: number;
  /** Unmarked but inside the grace period. */
  readonly young: number;
  readonly deleted: number;
  /** Marked digests that are not in the store (relink candidates). */
  readonly missing: number;
  readonly dryRun: boolean;
}

export async function collectGarbage(options: GcOptions): Promise<Result<GcReport>> {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? DEFAULT_GC_GRACE_MS;
  const signal = options.signal;
  const sources = Array.isArray(options.roots) ? (options.roots as readonly GcRootSource[]) : (options.roots as GcRoots).sources.map(([, s]) => s);
  const markStart = now();
  const cutoff = markStart - graceMs;
  const live = new Set<Digest>();
  const missing = new Set<Digest>();
  const signalOption = signal === undefined ? {} : { signal };

  const mark = async (item: GcRootItem): Promise<Result<void>> => {
    if (typeof item === 'string') {
      live.add(item);
      return ok();
    }
    live.add(item.digest);
    if (item.chunked !== true) return ok();
    const bytes = await options.blobs.get(item.digest, signalOption);
    if (!bytes.ok) {
      if (bytes.error.code === 'SF-BLOB-005') {
        missing.add(item.digest);
        return ok();
      }
      return bytes;
    }
    const manifest = parseChunkManifest(bytes.value);
    if (!manifest.ok) return manifest;
    for (const chunk of manifest.value.chunks) live.add(chunk);
    return ok();
  };

  for (const source of sources) {
    for await (const item of source(signal)) {
      const aborted = abortedError(signal);
      if (aborted !== undefined) return err(aborted);
      if (!item.ok) return item;
      const marked = await mark(item.value);
      if (!marked.ok) return marked;
    }
  }

  let scanned = 0;
  let kept = 0;
  let young = 0;
  let deleted = 0;
  const candidates: Digest[] = [];
  for await (const entry of options.catalog.entries(signal)) {
    if (!entry.ok) return entry;
    scanned += 1;
    if (live.has(entry.value.digest)) kept += 1;
    else if (entry.value.at > cutoff) young += 1;
    else candidates.push(entry.value.digest);
  }

  for (const digest of live) {
    if (missing.has(digest)) continue;
    const present = await options.catalog.get(digest);
    if (present.ok && present.value === undefined) {
      const exists = await options.blobs.has(digest, signalOption);
      if (exists.ok && !exists.value) missing.add(digest);
    }
  }

  if (options.dryRun !== true) {
    let failure: Result<never> | undefined;
    await runPool(candidates, options.concurrency ?? 16, async (digest) => {
      if (failure !== undefined) return;
      const aborted = abortedError(signal);
      if (aborted !== undefined) {
        failure = err(aborted);
        return;
      }
      // A put during the sweep refreshes `at`: re-check right before deleting.
      const fresh = await options.catalog.get(digest);
      if (fresh.ok && fresh.value !== undefined && fresh.value.at > cutoff) {
        young += 1;
        return;
      }
      const removed = await options.blobs.delete(digest, signalOption);
      if (!removed.ok) {
        failure = removed;
        return;
      }
      await options.catalog.forget([digest]);
      deleted += 1;
    });
    if (failure !== undefined) return failure;
  }

  return ok({ marked: live.size, scanned, kept, young, deleted, missing: missing.size, dryRun: options.dryRun === true });
}

