/**
 * DI: apps choose a backend per storage scope (device / user / workspace /
 * session) by contributing `StoreFactory`s to `StoreFactoryToken`; consumers
 * ask the `StoreRegistry` for `(scope, namespace)` and never name a backend.
 * Scopes without a working factory fall back to memory and are reported
 * (`registry.report()`).
 *
 * @example
 * units: [storeRegistryUnit, ...browserStoreFactoryUnits(), namespacedStoreUnit({
 *   id: 'studio/prefs-store-unit', provides: PrefsStoreToken, storeScope: 'device', namespace: 'studio/prefs' })]
 */
import { contribution, ok, type Result, type ScopeLevel, type Token, type TokenId, token, unit, type UnitDefinition } from '@staticflux/core';
import { borrowed } from './create.js';
import { fallback, type StoreCandidate } from './fallback.js';
import { createIndexedDbStore, type IndexedDbStoreOptions } from './indexeddb.js';
import { createMemoryStore } from './memory.js';
import type { AsyncStore } from './types.js';
import { createWebStorageStore } from './web-storage.js';

export const STORE_SCOPES = ['device', 'user', 'workspace', 'session'] as const;
/** Lifetime/ownership of stored data: device-wide, per user, per workspace, per browser session. */
export type StoreScope = (typeof STORE_SCOPES)[number];

export interface StoreFactory {
  readonly scope: StoreScope;
  /** Backend description for reports, e.g. `indexeddb`. */
  readonly id: string;
  /** Higher is tried first when several factories serve one scope (default 0). */
  readonly priority?: number;
  create(namespace: string): Result<AsyncStore>;
}

export interface StoreReportEntry {
  readonly scope: StoreScope;
  readonly namespace: string;
  readonly store: string;
  readonly degraded: boolean;
}

export interface StoreRegistry {
  /**
   * The store for `(scope, namespace)`, created once and shared. Returns a
   * borrowed view: disposing it does not close the shared store. Never fails
   * (memory is the last resort; check `report()`).
   */
  open<V = unknown>(scope: StoreScope, namespace: string): AsyncStore<V>;
  report(): readonly StoreReportEntry[];
  /** Close every store (the registry unit does this when its scope ends). */
  dispose(): Promise<void>;
}

export const StoreFactoryToken = token('storage/store-factories').multi<StoreFactory>();
export const StoreRegistryToken = token('storage/registry').type<StoreRegistry>();

export function createStoreRegistry(factories: readonly StoreFactory[]): StoreRegistry {
  const stores = new Map<string, { scope: StoreScope; namespace: string; store: ReturnType<typeof fallback<unknown>> }>();
  const ordered = [...factories].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return {
    open<V>(scope: StoreScope, namespace: string): AsyncStore<V> {
      const cacheKey = `${scope}\u0000${namespace}`;
      let entry = stores.get(cacheKey);
      if (entry === undefined) {
        const candidates: StoreCandidate<unknown>[] = ordered.filter((f) => f.scope === scope).map((f) => () => f.create(namespace));
        candidates.push(() => createMemoryStore({ id: `memory(${scope}/${namespace})` }));
        entry = { scope, namespace, store: fallback(candidates) };
        stores.set(cacheKey, entry);
      }
      if (!entry.store.ok) throw entry.store.error; // unreachable: memory always succeeds
      return borrowed(entry.store.value) as AsyncStore<V>;
    },
    report() {
      const out: StoreReportEntry[] = [];
      for (const { scope, namespace, store } of stores.values()) {
        if (!store.ok) continue;
        const preferred = ordered.some((f) => f.scope === scope);
        out.push({ scope, namespace, store: store.value.active.id, degraded: store.value.degraded || !preferred });
      }
      return out;
    },
    async dispose() {
      const all = [...stores.values()];
      stores.clear();
      for (const { store } of all) if (store.ok) await store.value.dispose();
    },
  };
}

// ---------------------------------------------------------------- units

export const storeRegistryUnit = unit({
  id: 'storage/registry-unit',
  provides: StoreRegistryToken,
  scope: 'app',
  deps: { required: { factories: StoreFactoryToken } },
  create: ({ factories }, ctx) => {
    const registry = createStoreRegistry(factories);
    ctx.scope.defer(() => registry.dispose());
    return registry;
  },
  description: 'Opens (scope, namespace) stores from the contributed StoreFactory list; memory fallback is reported.',
});

/** Contribute one factory. */
export function storeFactoryUnit(factory: StoreFactory): UnitDefinition<readonly StoreFactory[], Record<never, never>, 'storage/store-factories'> {
  return contribution({
    id: `storage/factory:${factory.scope}:${factory.id}`,
    provides: StoreFactoryToken,
    scope: 'app',
    order: -(factory.priority ?? 0),
    create: () => factory,
  });
}

/** IndexedDB factory for a scope: one object store per namespace in database `dbName`. */
export function indexedDbStoreFactory(scope: StoreScope, options: Omit<IndexedDbStoreOptions, 'namespace'> = {}): StoreFactory {
  return {
    scope,
    id: 'indexeddb',
    priority: 20,
    create: (namespace) => createIndexedDbStore({ ...options, namespace, dbName: options.dbName ?? `staticflux-${scope}` }),
  };
}

/** Web Storage factory (`session` scope → sessionStorage, others → localStorage), JSON values. */
export function webStorageStoreFactory(scope: StoreScope): StoreFactory {
  const area = scope === 'session' ? 'session' : 'local';
  return {
    scope,
    id: `${area}-storage`,
    priority: 10,
    create: (namespace) => createWebStorageStore({ area, prefix: `sf:${scope}:${namespace}:` }),
  };
}

export function memoryStoreFactory(scope: StoreScope): StoreFactory {
  return { scope, id: 'memory', priority: 0, create: (namespace) => ok(createMemoryStore({ id: `memory(${scope}/${namespace})` })) };
}

/**
 * Browser defaults: device/user/workspace → IndexedDB, then localStorage;
 * session → sessionStorage. Everything degrades to memory (reported).
 */
export function browserStoreFactoryUnits(): readonly UnitDefinition<readonly StoreFactory[], Record<never, never>, 'storage/store-factories'>[] {
  return [
    ...(['device', 'user', 'workspace'] as const).flatMap((scope) => [storeFactoryUnit(indexedDbStoreFactory(scope)), storeFactoryUnit(webStorageStoreFactory(scope))]),
    storeFactoryUnit(webStorageStoreFactory('session')),
  ];
}

/** Memory for every scope (tests, embedded hosts without storage). */
export function memoryStoreFactoryUnits(): readonly UnitDefinition<readonly StoreFactory[], Record<never, never>, 'storage/store-factories'>[] {
  return STORE_SCOPES.map((scope) => storeFactoryUnit(memoryStoreFactory(scope)));
}

export interface NamespacedStoreUnitOptions<V, P extends TokenId> {
  readonly id: TokenId;
  readonly provides: Token<AsyncStore<V>, P>;
  readonly storeScope: StoreScope;
  readonly namespace: string;
  /** DI lifetime of the handle (default `app`). */
  readonly scope?: ScopeLevel;
  /** Optional middleware applied to the registry store (codec, ttl, budget, …). */
  readonly wrap?: (store: AsyncStore) => AsyncStore<V>;
}

/** A typed token for one `(scope, namespace)` store, so features declare it as a dependency. */
export function namespacedStoreUnit<V, P extends TokenId>(
  options: NamespacedStoreUnitOptions<V, P>,
): UnitDefinition<AsyncStore<V>, { readonly required: { readonly registry: typeof StoreRegistryToken } }, P> {
  return unit({
    id: options.id,
    provides: options.provides,
    scope: options.scope ?? 'app',
    deps: { required: { registry: StoreRegistryToken } },
    create: ({ registry }, ctx) => {
      const raw = registry.open(options.storeScope, options.namespace);
      const store = options.wrap === undefined ? (raw as AsyncStore<V>) : options.wrap(raw);
      ctx.scope.defer(async () => {
        await store.dispose();
      });
      return store;
    },
    description: `Store "${options.namespace}" (${options.storeScope} scope).`,
  });
}
