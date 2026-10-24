/**
 * R9.0d — user-data slices over any `@staticflux/storage` `AsyncStore`:
 * `sliceBackendFromStore(store)` for local persistence (IndexedDB, OPFS,
 * encrypted, budgeted, …) and `remoteSyncFromStore(store)` for the remote sync
 * port (e.g. `createRemoteStore(transport)`). Records keep the stable
 * `{ v, value, updatedAt }` format under the same `sf-ud/…` keys.
 *
 * Backend failures → `SF-DATA-054` (remote: `SF-DATA-056`) with the
 * `SF-STORE-*` error as `cause` and `details.code`. Entries that are not slice
 * records, or that the store cannot decode, read as absent (the slice falls
 * back to its default and the next write replaces them) — never a crash.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { AsyncStore } from '@staticflux/storage';
import { RemoteSyncError, StorageBackendError } from './errors.js';
import type { SliceRecord } from './slices.js';
import type { RemoteSyncPort, SliceBackend } from './storage.js';

export function isSliceRecord(value: unknown): value is SliceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r['v'] === 'number' && typeof r['updatedAt'] === 'number' && 'value' in r;
}

const CORRUPT = 'SF-STORE-003';

function backendFailed(error: SfError, backend: string, op: string): Result<never> {
  return err(StorageBackendError({ cause: error, message: `User-data backend "${backend}" failed on ${op}: ${error.message}`, details: { backend, op, code: error.code } }));
}

async function readRecords(store: AsyncStore<unknown>, keys: readonly string[], signal: AbortSignal | undefined): Promise<Result<Readonly<Record<string, SliceRecord>>>> {
  const out: Record<string, SliceRecord> = {};
  const values = await Promise.all(keys.map((key) => store.get(key, signal === undefined ? {} : { signal })));
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = values[i];
    if (key === undefined || value === undefined) continue;
    if (!value.ok) {
      if (value.error.code === CORRUPT) continue;
      return err(value.error);
    }
    if (isSliceRecord(value.value)) out[key] = value.value;
  }
  return ok(out);
}

export interface SliceBackendFromStoreOptions {
  /** Backend id reported in errors/telemetry (default: the store id). */
  readonly id?: string;
}

/** Adapt an `AsyncStore` to the `SliceBackend` port (`UserDataOptions.local`). One flush = one `batch`. */
export function sliceBackendFromStore(store: AsyncStore<unknown>, options: SliceBackendFromStoreOptions = {}): SliceBackend {
  const id = options.id ?? store.id;
  return {
    id,
    async get(keys) {
      const read = await readRecords(store, keys, undefined);
      return read.ok ? read : backendFailed(read.error, id, 'get');
    },
    async write(puts, deletes) {
      const written = await store.batch([
        ...puts.map((put) => ({ type: 'set' as const, key: put.key, value: put.record })),
        ...deletes.map((key) => ({ type: 'delete' as const, key })),
      ]);
      return written.ok ? written : backendFailed(written.error, id, 'write');
    },
    async keys(prefix) {
      const keys = await store.seek({ prefix }).keys();
      return keys.ok ? keys : backendFailed(keys.error, id, 'keys');
    },
  };
}

/** Adapt an `AsyncStore` (typically `createRemoteStore(transport)` or `tiered`) to the `RemoteSyncPort`. */
export function remoteSyncFromStore(store: AsyncStore<unknown>): RemoteSyncPort {
  const failed = (error: SfError, op: string): Result<never> =>
    err(error.kind === 'aborted' ? error : RemoteSyncError({ cause: error, message: `User-data remote ${op} failed: ${error.message}`, details: { remote: store.id, op, code: error.code } }));
  return {
    async pull(keys, signal) {
      const read = await readRecords(store, keys, signal);
      return read.ok ? read : failed(read.error, 'pull');
    },
    async push(puts, signal) {
      const pushed = await store.batch(
        puts.map((put) => ({ type: 'set' as const, key: put.key, value: put.record })),
        { signal },
      );
      return pushed.ok ? pushed : failed(pushed.error, 'push');
    },
  };
}
