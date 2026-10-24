/**
 * Snapshot sources for @staticflux/data:
 * - `storeSnapshotSource(owner, …)` — a `defineStore` owner. Data = the stable `StoreSnapshot`
 *   (STORE_FORMAT 1, `getSnapshot`/`applySnapshot`); version = the store `schemaVersion`;
 *   migrations transform `state` per schema version. Restores only into a store nobody wrote
 *   since the source was created (else `superseded`).
 * - `resourceSnapshotSource(resources, …)` — one SWR cache entry. Restores with `setData` +
 *   `invalidate` (shown instantly, revalidated in the background); never over data that is
 *   already cached (the network won → `superseded`).
 */
import { err, ok, type Result, type TokenId, untracked } from '@staticflux/core';
import type { Resources, SingleResource, StoreSnapshot } from '@staticflux/data';
import type { RestoreApplied, RestoredMeta, SnapshotSensitivity, SnapshotSource } from './snapshot.js';
import { SnapshotRestoreFailedError } from './errors.js';

/** The part of an `OwnerStore` a snapshot source needs. */
export interface SnapshotableStore<S> {
  readonly id: TokenId;
  readonly schemaVersion: number;
  readonly version: number;
  getSnapshot(): StoreSnapshot<S>;
  applySnapshot(snapshot: StoreSnapshot<S>): Result<void>;
}

export interface StoreSnapshotSourceOptions {
  /** Default: the store id. */
  readonly id?: TokenId;
  readonly sensitivity: SnapshotSensitivity;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  /** `migrations[v]`: state of schema version v → state of v+1. */
  readonly migrations?: Readonly<Record<number, (state: unknown) => unknown>>;
  /** Called after the snapshot was applied (e.g. trigger a background revalidation). */
  readonly onRestored?: (meta: RestoredMeta) => void;
}

export function storeSnapshotSource<S>(owner: SnapshotableStore<S>, options: StoreSnapshotSourceOptions): SnapshotSource<StoreSnapshot<S>> {
  const baseline = untracked(() => owner.version);
  const migrations: Record<number, (data: unknown) => unknown> = {};
  for (const [from, step] of Object.entries(options.migrations ?? {})) {
    migrations[Number(from)] = (data) => {
      const snapshot = data as StoreSnapshot<unknown>;
      return { ...snapshot, schemaVersion: Number(from) + 1, state: step(snapshot.state) };
    };
  }
  return {
    id: options.id ?? owner.id,
    version: owner.schemaVersion,
    sensitivity: options.sensitivity,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    migrations,
    capture: () => untracked(() => owner.getSnapshot()),
    revision: () => untracked(() => owner.version),
    restore(snapshot, meta): Result<RestoreApplied> {
      if (untracked(() => owner.version) !== baseline) return ok('superseded');
      if (typeof snapshot !== 'object' || snapshot === null || !('state' in snapshot)) {
        return err(SnapshotRestoreFailedError({ message: 'Snapshot data is not a StoreSnapshot.', details: { store: owner.id } }));
      }
      const applied = owner.applySnapshot(snapshot);
      if (!applied.ok) return applied;
      options.onRestored?.(meta);
      return ok('applied');
    },
  };
}

export interface ResourceSnapshotSourceOptions<I> {
  readonly id: TokenId;
  readonly version: number;
  readonly sensitivity: SnapshotSensitivity;
  readonly input: I;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly migrations?: Readonly<Record<number, (data: unknown) => unknown>>;
}

export function resourceSnapshotSource<I, O>(
  resources: Pick<Resources, 'getData' | 'setData' | 'invalidate'>,
  resource: SingleResource<I, O>,
  options: ResourceSnapshotSourceOptions<I>,
): SnapshotSource<O> {
  return {
    id: options.id,
    version: options.version,
    sensitivity: options.sensitivity,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
    capture: () => untracked(() => resources.getData(resource, options.input)),
    restore(data): Result<RestoreApplied> {
      if (untracked(() => resources.getData(resource, options.input)) !== undefined) return ok('superseded');
      const schema = resource.endpoint.response;
      if (schema !== undefined) {
        const validated = schema.validate(data);
        if (!validated.ok) return validated;
      }
      resources.setData(resource, options.input, data);
      // Restored data is stale by definition: show it now, revalidate in the background (SWR).
      resources.invalidate(resource, options.input);
      return ok('applied');
    },
  };
}
