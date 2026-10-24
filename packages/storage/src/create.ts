/**
 * Convenience composition: `createStore({ backend, namespace, middleware })`,
 * `detectLocalStore()` (IndexedDB → localStorage → memory, reported),
 * `detectStorageSupport()` and `borrowed(store)` (share one backend between
 * owners without letting one owner dispose it).
 */
import { err, ok, type Result } from '@staticflux/core';
import { createCursor } from './base.js';
import { StoreDisposedError } from './errors.js';
import { fallback, type FallbackReport, type FallbackStore, type StoreCandidate } from './fallback.js';
import { createIndexedDbStore, type IdbFactoryLike, type IdbKeyRangeLike } from './indexeddb.js';
import { createMemoryStore } from './memory.js';
import { namespaced } from './namespaced.js';
import type { AsyncStore, BroadcastChannelFactory, StoreMiddleware } from './types.js';
import { createWebStorageStore, probeWebStorage, type StorageEventSource, type WebStorageLike } from './web-storage.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMiddleware = StoreMiddleware<any, any>;

export interface CreateStoreOptions {
  /** One candidate, or several (first available wins, see `fallback`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly backend: StoreCandidate<any> | readonly StoreCandidate<any>[];
  /** Applied first (closest to the backend): keys become `namespace + key`. */
  readonly namespace?: string;
  /** Applied in order after the namespace; the last one is outermost. */
  readonly middleware?: readonly AnyMiddleware[];
}

/**
 * Compose a store. `err` only when no backend candidate is available.
 *
 * @example
 * createStore<Prefs>({ backend: [createIndexedDbStore({ namespace: 'prefs' }), () => createMemoryStore()],
 *   middleware: [withTtl(), withBudget({ maxBytes: 64_000 })] })
 */
export function createStore<V = unknown>(options: CreateStoreOptions): Result<AsyncStore<V>> {
  const candidates = isCandidateList(options.backend) ? options.backend : [options.backend];
  const chosen = fallback(candidates);
  if (!chosen.ok) return chosen;
  // a single candidate needs no failover wrapper
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: AsyncStore<any> = candidates.length === 1 ? chosen.value.active : chosen.value;
  if (options.namespace !== undefined) store = namespaced(options.namespace)(store);
  for (const middleware of options.middleware ?? []) store = middleware(store);
  return ok(store as AsyncStore<V>);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isCandidateList(value: CreateStoreOptions['backend']): value is readonly StoreCandidate<any>[] {
  return Array.isArray(value);
}

export interface LocalStoreOptions {
  readonly namespace: string;
  readonly dbName?: string;
  readonly indexedDB?: IdbFactoryLike | null;
  readonly keyRange?: IdbKeyRangeLike | null;
  readonly localStorage?: WebStorageLike | null;
  readonly storageEvents?: StorageEventSource | null;
  readonly broadcast?: BroadcastChannelFactory | null;
}

export interface DetectedStore<V> {
  readonly store: FallbackStore<V>;
  /** Backend actually used (`indexeddb` | `local-storage` | `memory`). */
  readonly backend: string;
  readonly degraded: boolean;
  readonly reports: readonly FallbackReport[];
}

/** Best persistent local store for a namespace: IndexedDB → localStorage (JSON) → memory. Never fails. */
export function detectLocalStore<V = unknown>(options: LocalStoreOptions): DetectedStore<V> {
  const idbOptions = {
    namespace: options.namespace,
    ...(options.dbName === undefined ? {} : { dbName: options.dbName }),
    ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
    ...(options.keyRange === undefined ? {} : { keyRange: options.keyRange }),
    ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }),
  };
  const chosen = fallback<V>([
    () => createIndexedDbStore<V>(idbOptions),
    () =>
      createWebStorageStore<V>({
        area: 'local',
        prefix: `sf:${options.namespace}:`,
        ...(options.localStorage === undefined ? {} : { storage: options.localStorage }),
        ...(options.storageEvents === undefined ? {} : { events: options.storageEvents }),
      }),
    () => createMemoryStore<V>({ id: `memory(${options.namespace})` }),
  ]);
  if (!chosen.ok) throw chosen.error; // unreachable: memory always succeeds
  return { store: chosen.value, backend: chosen.value.active.id, degraded: chosen.value.degraded, reports: chosen.value.reports };
}

export interface StorageSupport {
  readonly indexedDB: boolean;
  readonly opfs: boolean;
  readonly localStorage: boolean;
  readonly sessionStorage: boolean;
  readonly cookies: boolean;
  readonly broadcastChannel: boolean;
  readonly webCrypto: boolean;
}

/** Feature-detect every backend (for devtools/boot reports). Web Storage is write-probed. */
export function detectStorageSupport(global: typeof globalThis = globalThis): StorageSupport {
  const g = global as unknown as Record<string, unknown> & {
    navigator?: { storage?: { getDirectory?: unknown }; cookieEnabled?: boolean };
    crypto?: { subtle?: unknown };
  };
  const read = (name: string): unknown => {
    try {
      return g[name];
    } catch {
      return undefined;
    }
  };
  return {
    indexedDB: typeof (read('indexedDB') as { open?: unknown } | undefined)?.open === 'function',
    opfs: typeof g.navigator?.storage?.getDirectory === 'function',
    localStorage: probeWebStorage(() => read('localStorage') as WebStorageLike | undefined) !== undefined,
    sessionStorage: probeWebStorage(() => read('sessionStorage') as WebStorageLike | undefined) !== undefined,
    cookies: g.navigator?.cookieEnabled === true && read('document') !== undefined,
    broadcastChannel: typeof read('BroadcastChannel') === 'function',
    webCrypto: g.crypto?.subtle !== undefined,
  };
}

/**
 * A view of `store` that does not own it: `dispose()` detaches this view's
 * watchers and blocks further use of the view, leaving the backend open.
 */
export function borrowed<V>(store: AsyncStore<V>): AsyncStore<V> {
  let disposed = false;
  const unsubscribes = new Set<() => void>();
  const closed = (): Promise<Result<never>> => Promise.resolve(err(StoreDisposedError({ details: { store: store.id } })));
  return {
    id: store.id,
    capabilities: store.capabilities,
    get: (key, options) => (disposed ? closed() : store.get(key, options)),
    set: (key, value, options) => (disposed ? closed() : store.set(key, value, options)),
    delete: (key, options) => (disposed ? closed() : store.delete(key, options)),
    has: (key, options) => (disposed ? closed() : store.has(key, options)),
    clear: (options) => (disposed ? closed() : store.clear(options)),
    batch: (ops, options) => (disposed ? closed() : store.batch(ops, options)),
    seek: (options) => (disposed ? createCursor(closed) : store.seek(options)),
    watch(listener, options) {
      if (disposed) return () => undefined;
      const unsubscribe = store.watch(listener, options);
      unsubscribes.add(unsubscribe);
      return () => {
        unsubscribes.delete(unsubscribe);
        unsubscribe();
      };
    },
    async dispose() {
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes.clear();
      return ok();
    },
  };
}
