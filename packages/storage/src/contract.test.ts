import { unwrap } from '@staticflux/core';
import { describe, it } from 'vitest';
import {
  createBroadcastHub,
  createCookieStore,
  createFakeCookieDocument,
  createFakeIndexedDb,
  createFakeOpfsRoot,
  createIndexedDbStore,
  createMemoryStore,
  createMockRemoteTransport,
  createOpfsStore,
  createRemoteStore,
  createStore,
  createWebStorageStore,
  encrypted,
  envelopeCodec,
  fallback,
  namespaced,
  runStoreContract,
  staticKeyProvider,
  tiered,
  withBudget,
  withCodec,
  jsonCodec,
  withTelemetry,
  withTtl,
  type TtlRecord,
  type WebStorageLike,
} from './index.js';
import { createTelemetry } from '@staticflux/core';

function fakeStorage(): WebStorageLike {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

const runner = { describe, it };

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

{
  const c = clock();
  runStoreContract('memory', () => createMemoryStore({ now: c.now }), runner, { advanceTime: c.advance });
}

runStoreContract('localStorage (fake area)', () => unwrap(createWebStorageStore({ area: 'local', storage: fakeStorage(), events: null })), runner);
runStoreContract('sessionStorage (happy-dom)', () => {
  globalThis.sessionStorage.clear();
  return unwrap(createWebStorageStore({ area: 'session' }));
}, runner);
runStoreContract('localStorage (happy-dom)', () => {
  globalThis.localStorage.clear();
  return unwrap(createWebStorageStore({ area: 'local' }));
}, runner);

{
  const c = clock();
  runStoreContract('cookies (fake jar)', () => unwrap(createCookieStore({ document: createFakeCookieDocument(c.now) })), runner, { advanceTime: c.advance });
}

runStoreContract('indexeddb (fake)', () => {
  const idb = createFakeIndexedDb();
  return unwrap(createIndexedDbStore({ namespace: 'contract', indexedDB: idb, keyRange: idb.keyRange, broadcast: createBroadcastHub() }));
}, runner);

runStoreContract('opfs (fake)', () => unwrap(createOpfsStore({ namespace: 'contract', root: async () => createFakeOpfsRoot(), broadcast: null })), runner);

runStoreContract('remote (mock transport)', () => createRemoteStore(createMockRemoteTransport()), runner);
runStoreContract('remote (mock transport, no batch)', () => createRemoteStore(createMockRemoteTransport({ atomicBatch: false })), runner);

runStoreContract('namespaced(memory)', () => namespaced<unknown>('ns:')(createMemoryStore()), runner);
runStoreContract('namespaced(namespaced(localStorage))', () => {
  const base = unwrap(createWebStorageStore<unknown>({ area: 'local', storage: fakeStorage(), events: null }));
  return namespaced<unknown>('inner:')(namespaced<unknown>('outer:')(base));
}, runner);

{
  const c = clock();
  runStoreContract('withTtl(indexeddb)', () => {
    const idb = createFakeIndexedDb();
    const store = unwrap(createIndexedDbStore<TtlRecord<unknown>>({ namespace: 'ttl', indexedDB: idb, keyRange: idb.keyRange, broadcast: null }));
    return withTtl<unknown>({ now: c.now })(store);
  }, runner, { advanceTime: c.advance });
}

runStoreContract('withCodec(json)(string memory)', () => withCodec(jsonCodec())(createMemoryStore<string>()), runner);
runStoreContract('withCodec(envelope)(memory)', () => withCodec(envelopeCodec<unknown>({ version: 1 }))(createMemoryStore()), runner);

runStoreContract('encrypted(memory)', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return encrypted<unknown>(staticKeyProvider(key))(createMemoryStore());
}, runner);

runStoreContract('withBudget(memory)', () => withBudget<unknown>({ maxBytes: 100_000, maxEntries: 100 })(createMemoryStore()), runner);
runStoreContract('withTelemetry(memory)', () => withTelemetry<unknown>(createTelemetry({ defaultLevel: 'debug' }), 'test/store')(createMemoryStore()), runner);

runStoreContract('tiered write-through', () => tiered({ local: createMemoryStore(), remote: createRemoteStore(createMockRemoteTransport()), mode: 'write-through' }), runner);
runStoreContract('tiered write-back', () => tiered({ local: createMemoryStore(), remote: createRemoteStore(createMockRemoteTransport()), mode: 'write-back', flushIntervalMs: 0 }), runner);

runStoreContract('fallback([unavailable, memory])', () => unwrap(fallback([createIndexedDbStore({ namespace: 'x', indexedDB: null }), createMemoryStore()])), runner);

{
  const c = clock();
  runStoreContract('createStore(full chain)', () => {
    const idb = createFakeIndexedDb();
    return unwrap(
      createStore({
        backend: [createIndexedDbStore({ namespace: 'chain', indexedDB: idb, keyRange: idb.keyRange, broadcast: null }), () => createMemoryStore()],
        namespace: 'app:',
        middleware: [withTtl({ now: c.now }), withBudget({ maxBytes: 1_000_000 })],
      }),
    );
  }, runner, { advanceTime: c.advance });
}
