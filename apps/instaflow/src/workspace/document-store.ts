/**
 * A persistent `DocumentStore` (SF-Δ3) over any `@staticflux/storage` `AsyncStore` (C0; IF-28.1–28.3). The browser
 * binding is IndexedDB (`createIndexedDbStore`), so a workspace survives reloads and moves between Home and Studio;
 * tests use the memory store. Loro-free: Home reads heads through it with no document engine (D17).
 *
 * Key layout (one namespace per workspace):
 * - `h/<asset>` — the head (a structured-clone copy; CAS on `generation`, SF-DOC-011);
 * - `b/<digest>` — immutable bytes, content-addressed (sha256), idempotent;
 * - `l/<asset>/<seq>` — commit records, `seq` zero-padded so key order is seq order;
 * - `n/<asset>` — the next seq (never reused, also after truncation).
 *
 * Read-modify-write steps (head CAS, log append) run one at a time per asset in this tab, and inside a Web Lock
 * (`<prefix>/<asset>`) when the platform has one, so two tabs never interleave them.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import { type BlobRef, type Digest, type DocumentHead, type DocumentStore, HeadConflictError, type LogEntry, MissingBlobError, sha256Digest } from '@staticflux/document/v2';
import type { AsyncStore } from '@staticflux/storage';

/** Structurally `navigator.locks` (exclusive requests only). */
export interface WorkspaceLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface PersistentDocumentStoreOptions {
  /** Cross-tab locks (default: `navigator.locks` when present). `null`: this tab only. */
  readonly locks?: WorkspaceLocks | null;
  /** Lock name prefix (the workspace id). */
  readonly lockPrefix?: string;
}

export const DOCUMENT_STORE_KEYS = Object.freeze({
  head: (asset: string): string => `h/${asset}`,
  blob: (digest: Digest): string => `b/${digest}`,
  log: (asset: string, seq: number): string => `l/${asset}/${String(seq).padStart(12, '0')}`,
  logPrefix: (asset: string): string => `l/${asset}/`,
  next: (asset: string): string => `n/${asset}`,
});

const aborted = (signal: AbortSignal): Result<never> | undefined => (signal.aborted ? err(AbortedError({ cause: signal.reason })) : undefined);

function defaultLocks(): WorkspaceLocks | undefined {
  const locks = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks;
  if (typeof locks?.request !== 'function') return undefined;
  return { request: (name, callback) => (locks as unknown as { request(n: string, cb: () => Promise<unknown>): Promise<unknown> }).request(name, callback) as never };
}

/** A `DocumentStore` persisted in `store` (see the module header). */
export function documentStoreFromAsyncStore(store: AsyncStore<unknown>, options: PersistentDocumentStoreOptions = {}): DocumentStore {
  const locks = options.locks === null ? undefined : (options.locks ?? defaultLocks());
  const prefix = options.lockPrefix ?? 'instaflow/workspace';
  const queues = new Map<string, Promise<unknown>>();

  /** Run `step` alone for `asset` (this tab's queue, then the cross-tab lock). */
  const exclusive = <T>(asset: string, step: () => Promise<T>): Promise<T> => {
    const run = (): Promise<T> => (locks === undefined ? step() : locks.request(`${prefix}/${asset}`, step));
    const previous = queues.get(asset) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(asset, settled);
    void settled.then(() => {
      if (queues.get(asset) === settled) queues.delete(asset);
    });
    return next;
  };

  return {
    async readHead(asset, signal) {
      const stop = aborted(signal);
      if (stop !== undefined) return stop;
      const read = await store.get(DOCUMENT_STORE_KEYS.head(asset), { signal });
      if (!read.ok) return read;
      return ok(read.value === undefined ? undefined : structuredClone(read.value as DocumentHead));
    },
    async writeHead(asset, head, expected, signal) {
      const stop = aborted(signal);
      if (stop !== undefined) return stop;
      return exclusive(asset, async (): Promise<Result<void>> => {
        const read = await store.get(DOCUMENT_STORE_KEYS.head(asset), { signal });
        if (!read.ok) return read;
        const current = (read.value as DocumentHead | undefined)?.generation ?? null;
        if (current !== expected || head.generation !== (expected ?? 0) + 1 || head.asset !== asset) {
          return err(HeadConflictError({ details: { asset, expected, current, proposed: head.generation } }));
        }
        return store.set(DOCUMENT_STORE_KEYS.head(asset), structuredClone(head), { signal });
      });
    },
    async putBlob(bytes, signal) {
      const stop = aborted(signal);
      if (stop !== undefined) return stop;
      const digest = await sha256Digest(bytes);
      const key = DOCUMENT_STORE_KEYS.blob(digest);
      const has = await store.has(key, { signal });
      if (!has.ok) return has;
      if (!has.value) {
        const written = await store.set(key, bytes.slice(), { signal });
        if (!written.ok) return written;
      }
      return ok({ digest, size: bytes.byteLength });
    },
    async getBlob(ref: BlobRef, signal) {
      const stop = aborted(signal);
      if (stop !== undefined) return stop;
      const read = await store.get(DOCUMENT_STORE_KEYS.blob(ref.digest), { signal });
      if (!read.ok) return read;
      if (!(read.value instanceof Uint8Array)) return err(MissingBlobError({ details: { digest: ref.digest } }));
      return ok(read.value.slice());
    },
    async appendLog(asset, bytes, signal) {
      const stop = aborted(signal);
      if (stop !== undefined) return stop;
      const copy = bytes.slice();
      return exclusive(asset, async (): Promise<Result<number>> => {
        const next = await store.get(DOCUMENT_STORE_KEYS.next(asset), { signal });
        if (!next.ok) return next;
        const seq = typeof next.value === 'number' ? next.value : 1;
        const written = await store.batch(
          [
            { type: 'set', key: DOCUMENT_STORE_KEYS.log(asset, seq), value: copy },
            { type: 'set', key: DOCUMENT_STORE_KEYS.next(asset), value: seq + 1 },
          ],
          { signal },
        );
        return written.ok ? ok(seq) : written;
      });
    },
    async readLog(asset, from, signal) {
      const stop = aborted(signal);
      if (stop !== undefined) return stop;
      const cursor = store.seek({ prefix: DOCUMENT_STORE_KEYS.logPrefix(asset), gte: DOCUMENT_STORE_KEYS.log(asset, Math.max(0, from)), signal });
      const entries = await cursor.toArray();
      if (!entries.ok) return entries;
      const out: LogEntry[] = [];
      const start = DOCUMENT_STORE_KEYS.logPrefix(asset).length;
      for (const [key, value] of entries.value) {
        if (value instanceof Uint8Array) out.push({ seq: Number(key.slice(start)), bytes: value.slice() });
      }
      return ok(out);
    },
    async truncateLog(asset, before, signal) {
      const stop = aborted(signal);
      if (stop !== undefined) return stop;
      return exclusive(asset, async (): Promise<Result<void>> => {
        const keys = await store.seek({ prefix: DOCUMENT_STORE_KEYS.logPrefix(asset), lt: DOCUMENT_STORE_KEYS.log(asset, before), signal }).keys();
        if (!keys.ok) return keys;
        if (keys.value.length === 0) return ok();
        return store.batch(
          keys.value.map((key) => ({ type: 'delete' as const, key })),
          { signal },
        );
      });
    },
  };
}
