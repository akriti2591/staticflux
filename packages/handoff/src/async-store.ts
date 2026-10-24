/**
 * R9.0d — back the handoff storage port with any `@staticflux/storage`
 * `AsyncStore` (IndexedDB, OPFS, encrypted, tiered, …). Envelopes are stored as
 * values under the slot key; wrap the store with `namespaced('sf-handoff:')` to
 * share a backend. Errors map to `SF-HANDOFF-006` (cause = the `SF-STORE-*`
 * error). A value the store cannot decode (`SF-STORE-003`) reads as a
 * non-envelope, so the handoff store discards and reports it like any malformed entry.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { type AsyncStore, StoreCorruptError } from '@staticflux/storage';
import type { HandoffScope } from './slot.js';
import { createMemoryStorage, type HandoffStorage, type HandoffStorages, StorageFailedError } from './storage.js';

export interface HandoffStorageFromStoreOptions {
  /** Reported kind (default: the store id). */
  readonly kind?: string;
  /** Survives a reload (default: `store.capabilities.persistent`). */
  readonly durable?: boolean;
}

function failed(error: SfError, op: string, key?: string): Result<never> {
  return err(
    StorageFailedError({
      cause: error,
      message: `Handoff storage ${op}${key === undefined ? '' : ` of "${key}"`} failed: ${error.message}`,
      details: { code: error.code, op, ...(key === undefined ? {} : { key }) },
    }),
  );
}

/** Adapt an `AsyncStore` to the `HandoffStorage` port. */
export function handoffStorageFromStore(store: AsyncStore<unknown>, options: HandoffStorageFromStoreOptions = {}): HandoffStorage {
  return {
    kind: options.kind ?? store.id,
    durable: options.durable ?? store.capabilities.persistent,
    async read(key) {
      const value = await store.get(key);
      if (value.ok) return value;
      // undecodable entry: hand the store a non-envelope so it is discarded and reported (SF-HANDOFF-001)
      if (value.error.code === StoreCorruptError.code) return ok(null);
      return failed(value.error, 'read', key);
    },
    async write(key, envelope) {
      const written = await store.set(key, envelope);
      return written.ok ? written : failed(written.error, 'write', key);
    },
    async remove(key) {
      const removed = await store.delete(key);
      return removed.ok ? removed : failed(removed.error, 'remove', key);
    },
    async keys() {
      const keys = await store.seek().keys();
      return keys.ok ? keys : failed(keys.error, 'keys');
    },
  };
}

export interface HandoffStoresInput {
  /** Default: in-memory. */
  readonly memory?: AsyncStore<unknown>;
  /** Per-tab store (e.g. sessionStorage-backed). Omitted → memory, reported degraded. */
  readonly tab?: AsyncStore<unknown>;
  /** Origin-wide store (e.g. IndexedDB/localStorage-backed). Omitted → memory, reported degraded. */
  readonly origin?: AsyncStore<unknown>;
  /** Extra scopes to report as degraded (e.g. from `detectLocalStore().degraded`). */
  readonly degraded?: readonly HandoffScope[];
}

/** Build `HandoffStorages` from AsyncStores (bind it to `HandoffStoragesToken`). */
export function handoffStoragesFromStores(input: HandoffStoresInput): HandoffStorages {
  const degraded = new Set<HandoffScope>(input.degraded ?? []);
  if (input.tab === undefined) degraded.add('tab');
  if (input.origin === undefined) degraded.add('origin');
  return {
    memory: input.memory === undefined ? createMemoryStorage() : handoffStorageFromStore(input.memory),
    tab: input.tab === undefined ? createMemoryStorage('memory(tab)') : handoffStorageFromStore(input.tab),
    origin: input.origin === undefined ? createMemoryStorage('memory(origin)') : handoffStorageFromStore(input.origin),
    degraded: [...degraded],
  };
}
