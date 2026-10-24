import { createInjector, err, ok, token, unwrap } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  borrowed,
  browserStoreFactoryUnits,
  createBroadcastHub,
  createFakeIndexedDb,
  createFakeOpfsRoot,
  createIndexedDbStore,
  createMemoryStore,
  createOpfsStore,
  createStore,
  createStoreRegistry,
  detectLocalStore,
  detectStorageSupport,
  fallback,
  indexedDbStoreFactory,
  memoryStoreFactory,
  memoryStoreFactoryUnits,
  namespacedStoreUnit,
  StoreFactoryToken,
  storeFactoryUnit,
  storeRegistryUnit,
  StoreRegistryToken,
  StoreUnavailableError,
  withTtl,
  type AsyncStore,
  type FallbackReport,
  type StoreChange,
  type TtlRecord,
} from './index.js';

describe('fallback', () => {
  it('skips unavailable candidates and reports them', async () => {
    const result = fallback([createIndexedDbStore({ namespace: 'x', indexedDB: null }), () => createMemoryStore({ id: 'mem' })]);
    const store = unwrap(result);
    expect(store.active.id).toBe('mem');
    expect(store.degraded).toBe(true);
    expect(store.reports.map((r) => [r.index, r.phase, r.error.code])).toEqual([[0, 'create', 'SF-STORE-002']]);
    expect(store.id).toBe('fallback(mem)');
  });
  it('is not degraded when the primary works and does not create later candidates', () => {
    let created = false;
    const store = unwrap(fallback([createMemoryStore(), () => {
      created = true;
      return createMemoryStore();
    }]));
    expect(store.degraded).toBe(false);
    expect(created).toBe(false);
  });
  it('fails when nothing is available', () => {
    const result = fallback([err(StoreUnavailableError()), () => err(StoreUnavailableError())]);
    expect(!result.ok && result.error.code).toBe('SF-STORE-002');
  });
  it('fails over at runtime on SF-STORE-002, rebinds watchers and announces', async () => {
    const opfs = unwrap(createOpfsStore({ namespace: 'n', root: async () => createFakeOpfsRoot({ writable: false }), broadcast: null }));
    const store = unwrap(fallback<unknown>([opfs, () => createMemoryStore({ id: 'mem' })]));
    const announced: [FallbackReport, string][] = [];
    store.onFallback((report, active) => announced.push([report, active.id]));
    const seen: StoreChange<unknown>[] = [];
    store.watch((c) => seen.push(c));
    expect((await store.set('k', 1)).ok).toBe(true);
    expect(store.active.id).toBe('mem');
    expect(announced.map(([r, id]) => [r.phase, r.id, id])).toEqual([['runtime', 'opfs', 'mem']]);
    expect(seen).toEqual([{ type: 'set', key: 'k', value: 1, origin: 'local' }]);
    expect(unwrap(await store.get('k'))).toBe(1);
    expect((await store.dispose()).ok).toBe(true);
  });
  it('does not fail over on other errors', async () => {
    const store = unwrap(fallback<unknown>([createMemoryStore({ maxValueBytes: 2, id: 'small' }), () => createMemoryStore()]));
    const result = await store.set('k', 'too long');
    expect(!result.ok && result.error.code).toBe('SF-STORE-001');
    expect(store.active.id).toBe('small');
  });
});

describe('createStore', () => {
  it('applies namespace then middleware in order', async () => {
    let now = 0;
    const base = createMemoryStore<unknown>();
    const store = unwrap(createStore<string>({ backend: base, namespace: 'app:', middleware: [withTtl({ now: () => now })] }));
    await store.set('k', 'v', { ttlMs: 10 });
    expect(unwrap(await base.get('app:k'))).toEqual({ v: 'v', e: 10 } satisfies TtlRecord<string>);
    now = 20;
    expect(unwrap(await store.get('k'))).toBeUndefined();
    expect(store.id).toBe('ttl(ns[app:](memory))');
  });
  it('wraps multiple candidates in fallback and errs when none is available', () => {
    const store = unwrap(createStore({ backend: [createIndexedDbStore({ namespace: 'x', indexedDB: null }), createMemoryStore()] }));
    expect(store.id).toBe('fallback(memory)');
    expect(createStore({ backend: [err(StoreUnavailableError())] }).ok).toBe(false);
  });
});

describe('detection', () => {
  it('detectLocalStore prefers IndexedDB, then localStorage, then memory', () => {
    const idb = createFakeIndexedDb();
    const viaIdb = detectLocalStore({ namespace: 'n', indexedDB: idb, keyRange: idb.keyRange, broadcast: null });
    expect([viaIdb.backend, viaIdb.degraded]).toEqual(['indexeddb', false]);
    const viaLocal = detectLocalStore({ namespace: 'n', indexedDB: null, storageEvents: null });
    expect([viaLocal.backend, viaLocal.degraded]).toEqual(['local-storage', true]); // happy-dom localStorage
    const viaMemory = detectLocalStore({ namespace: 'n', indexedDB: null, localStorage: null });
    expect([viaMemory.backend, viaMemory.reports.length]).toEqual(['memory(n)', 2]);
  });
  it('detectStorageSupport probes each backend', () => {
    const support = detectStorageSupport();
    expect(support).toMatchObject({ localStorage: true, sessionStorage: true, indexedDB: false, opfs: false });
    expect(detectStorageSupport({} as typeof globalThis)).toEqual({
      indexedDB: false, opfs: false, localStorage: false, sessionStorage: false, cookies: false, broadcastChannel: false, webCrypto: false,
    });
  });
});

describe('borrowed', () => {
  it('disposing a borrowed view leaves the backend open and detaches its watchers', async () => {
    const base = createMemoryStore();
    const view = borrowed(base);
    const seen: string[] = [];
    view.watch((c) => seen.push(c.type));
    await view.set('k', 1);
    await view.dispose();
    await base.set('k', 2);
    expect(seen).toEqual(['set']);
    expect(unwrap(await base.get('k'))).toBe(2);
    const after = await view.get('k');
    expect(!after.ok && after.error.code).toBe('SF-STORE-007');
  });
});

describe('broadcast hub', () => {
  it('delivers to peers with the same name only', async () => {
    const hub = createBroadcastHub();
    const a = hub('x');
    const b = hub('x');
    const c = hub('y');
    const got: unknown[] = [];
    b?.addEventListener('message', (e) => got.push(e.data));
    c?.addEventListener('message', (e) => got.push(['c', e.data]));
    a?.postMessage({ hi: 1 });
    await Promise.resolve();
    expect(got).toEqual([{ hi: 1 }]);
    expect(hub.open).toBe(3);
    a?.close();
    expect(hub.open).toBe(2);
  });
});

describe('DI: registry and units', () => {
  it('opens shared (scope, namespace) stores from the highest-priority working factory', async () => {
    const idb = createFakeIndexedDb();
    const failing = { scope: 'user' as const, id: 'broken', priority: 99, create: () => err(StoreUnavailableError()) };
    const registry = createStoreRegistry([memoryStoreFactory('session'), indexedDbStoreFactory('user', { indexedDB: idb, keyRange: idb.keyRange, broadcast: null }), failing]);
    const a = registry.open('user', 'prefs');
    const b = registry.open('user', 'prefs');
    await a.set('k', 1);
    expect(unwrap(await b.get('k'))).toBe(1);
    await a.dispose(); // borrowed: b keeps working
    expect(unwrap(await b.get('k'))).toBe(1);
    registry.open('workspace', 'none');
    registry.open('session', 's');
    expect(registry.report()).toEqual([
      { scope: 'user', namespace: 'prefs', store: 'indexeddb', degraded: true },
      { scope: 'workspace', namespace: 'none', store: 'memory(workspace/none)', degraded: true },
      { scope: 'session', namespace: 's', store: 'memory(session/s)', degraded: false },
    ]);
    expect(idb.databases.get('staticflux-user')?.stores.has('prefs')).toBe(true);
    await registry.dispose();
  });

  it('wires through the injector with typed namespaced store tokens', async () => {
    const PrefsStore = token('test/prefs-store').type<AsyncStore<{ theme: string }>>();
    const injector = createInjector({
      units: [
        storeRegistryUnit,
        ...memoryStoreFactoryUnits(),
        namespacedStoreUnit({ id: 'test/prefs-store-unit', provides: PrefsStore, storeScope: 'device', namespace: 'prefs' }),
      ],
    });
    const prefs = unwrap(await injector.get(PrefsStore));
    await prefs.set('current', { theme: 'dark' });
    const registry = unwrap(await injector.get(StoreRegistryToken));
    expect(unwrap(await registry.open('device', 'prefs').get('current'))).toEqual({ theme: 'dark' });
    expect(unwrap(await injector.get(StoreFactoryToken))).toHaveLength(4);
  });

  it('browser defaults degrade to localStorage/sessionStorage in happy-dom', async () => {
    const injector = createInjector({ units: [storeRegistryUnit, ...browserStoreFactoryUnits()] });
    const registry = unwrap(await injector.get(StoreRegistryToken));
    expect(registry.open('device', 'd').id).toBe('fallback(local-storage)');
    expect(registry.open('session', 's').id).toBe('fallback(session-storage)');
  });

  it('storeFactoryUnit contributes a custom factory', async () => {
    const injector = createInjector({
      units: [storeRegistryUnit, storeFactoryUnit({ scope: 'workspace', id: 'custom', create: () => ok(createMemoryStore({ id: 'custom-mem' })) })],
    });
    const registry = unwrap(await injector.get(StoreRegistryToken));
    expect(registry.open('workspace', 'w').id).toBe('fallback(custom-mem)');
  });
});
