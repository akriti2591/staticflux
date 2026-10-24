/**
 * Archive port for heavy features (R5.3): a feature provides `snapshot()`/`restore()`,
 * the host persists the snapshot through an `ArchiveStore`. Backends (IndexedDB, OPFS)
 * live in other packages; this package ships the in-memory implementation.
 *
 * The envelope format is shared with handoff (R19.3): `{ format, id, version, createdAt, epoch, data }`.
 */
import { err, ok, type Result } from '@staticflux/core';
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
