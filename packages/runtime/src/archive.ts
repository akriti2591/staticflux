/**
 * Archive port for heavy features (R5.3): a feature provides `snapshot()`/`restore()`,
 * the host persists the snapshot through an `ArchiveStore`. Backends (IndexedDB, OPFS)
 * come from `@staticflux/storage` via `archiveStoreFromStore(store)`; this package also ships the in-memory implementation.
 *
 * The envelope format is shared with handoff (R19.3): `{ format, id, version, createdAt, epoch, data }`.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { AsyncStore } from '@staticflux/storage';
import { ArchiveFailedError } from './errors.js';
import type { FeatureId } from './feature.js';

export const SNAPSHOT_FORMAT = 'sf-snapshot/1' as const;

export interface SnapshotEnvelope {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly id: FeatureId;
  /** Feature-declared snapshot version (`manifest.snapshotVersion`, default 1). */
  readonly version: number;
  readonly createdAt: number;
  readonly epoch: number;
  /** Structured-clone-safe payload. */
  readonly data: unknown;
}

export interface ArchiveStore {
  put(snapshot: SnapshotEnvelope, signal?: AbortSignal): Promise<Result<void>>;
  get(id: FeatureId, signal?: AbortSignal): Promise<Result<SnapshotEnvelope | undefined>>;
  delete(id: FeatureId): Promise<Result<void>>;
  keys(): Promise<Result<readonly FeatureId[]>>;
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : value;
}

/** In-memory ArchiveStore. Values are structured-cloned on the way in and out (like a real backend). */
export function createMemoryArchiveStore(): ArchiveStore & { readonly size: number } {
  const entries = new Map<FeatureId, SnapshotEnvelope>();
  return {
    get size() {
      return entries.size;
    },
    async put(snapshot) {
      try {
        entries.set(snapshot.id, clone(snapshot));
        return ok();
      } catch (error) {
        return err(ArchiveFailedError({ cause: error, units: [snapshot.id], message: `Snapshot of "${snapshot.id}" is not cloneable.` }));
      }
    },
    async get(id) {
      const entry = entries.get(id);
      return ok(entry === undefined ? undefined : clone(entry));
    },
    async delete(id) {
      entries.delete(id);
      return ok();
    },
    async keys() {
      return ok([...entries.keys()]);
    },
  };
}

// ---------------------------------------------------------------- AsyncStore adapter (R9.0d)

function isSnapshotEnvelope(value: unknown, id: FeatureId): value is SnapshotEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['format'] === SNAPSHOT_FORMAT && v['id'] === id && typeof v['version'] === 'number' && typeof v['createdAt'] === 'number' && typeof v['epoch'] === 'number' && 'data' in v;
}

/**
 * Back the archive port with any `@staticflux/storage` `AsyncStore`
 * (IndexedDB/OPFS for heavy snapshots). Snapshots are stored as values under the
 * feature id. Backend errors and entries that are not `sf-snapshot/1` envelopes
 * for that id → `SF-FT-009` (the host then activates fresh); a bad entry is deleted.
 */
export function archiveStoreFromStore(store: AsyncStore<unknown>): ArchiveStore {
  const failed = (error: SfError, id: FeatureId | undefined, op: string): Result<never> =>
    err(
      ArchiveFailedError({
        cause: error,
        units: id === undefined ? [] : [id],
        message: `Archive ${op}${id === undefined ? '' : ` of "${id}"`} failed: ${error.message}`,
        details: { code: error.code, op },
      }),
    );
  return {
    async put(snapshot, signal) {
      const written = await store.set(snapshot.id, snapshot, signal === undefined ? {} : { signal });
      return written.ok ? written : failed(written.error, snapshot.id, 'put');
    },
    async get(id, signal) {
      const read = await store.get(id, signal === undefined ? {} : { signal });
      if (!read.ok) return failed(read.error, id, 'get');
      if (read.value === undefined) return ok(undefined);
      if (isSnapshotEnvelope(read.value, id)) return ok(read.value);
      await store.delete(id);
      return err(ArchiveFailedError({ units: [id], message: `Stored archive for "${id}" is not an ${SNAPSHOT_FORMAT} envelope; discarded.` }));
    },
    async delete(id) {
      const removed = await store.delete(id);
      return removed.ok ? removed : failed(removed.error, id, 'delete');
    },
    async keys() {
      const keys = await store.seek().keys();
      return keys.ok ? ok(keys.value.filter((k): k is FeatureId => k.includes('/'))) : failed(keys.error, undefined, 'keys');
    },
  };
}
