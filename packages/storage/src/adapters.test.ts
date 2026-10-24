import { unwrap } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  createBroadcastHub,
  createCookieStore,
  createFakeCookieDocument,
  createFakeIndexedDb,
  createFakeOpfsRoot,
  createIndexedDbStore,
  createLocalStorageStore,
  createMemoryStore,
  createMockRemoteTransport,
  createOpfsStore,
  createRemoteStore,
  createSessionStorageStore,
  createWebStorageStore,
  effectiveBounds,
  filterEntries,
  isQuotaError,
  opfsFileName,
  opfsKeyOf,
  parseCookies,
  prefixUpperBound,
  probeWebStorage,
  serializeCookie,
  toStoreError,
  type StorageEventLike,
  type StorageEventSource,
  type StoreChange,
  type WebStorageLike,
} from './index.js';

const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStorage(options: { quotaChars?: number; throwOnAccess?: boolean } = {}): WebStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const used = (): number => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => {
      if (options.throwOnAccess === true) throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      return map.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (options.throwOnAccess === true) throw Object.assign(new Error('denied'), { name: 'SecurityError' });
      if (options.quotaChars !== undefined && used() - (map.get(k)?.length ?? 0) + k.length + v.length > options.quotaChars) {
        throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      }
      map.set(k, v);
    },
    removeItem: (k) => void map.delete(k),
  };
}

function fakeEvents(): StorageEventSource & { fire(event: StorageEventLike): void; count: number } {
  const listeners = new Set<(event: StorageEventLike) => void>();
  return {
    get count() {
      return listeners.size;
    },
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    fire: (event) => {
      for (const l of listeners) l(event);
    },
  };
}

describe('base helpers', () => {
  it('filters, sorts and limits entries', () => {
    const entries = [['b', 1], ['a', 2], ['c', 3]] as const;
    expect(filterEntries(entries)).toEqual([['a', 2], ['b', 1], ['c', 3]]);
    expect(filterEntries(entries, { reverse: true, limit: 1 })).toEqual([['c', 3]]);
    expect(filterEntries(entries, { gte: 'b' })).toEqual([['b', 1], ['c', 3]]);
  });
  it('computes prefix bounds exactly', () => {
    expect(prefixUpperBound('ab')).toBe('ac');
    expect(prefixUpperBound('a￿')).toBe('b');
    expect(prefixUpperBound('￿')).toBeUndefined();
    expect(effectiveBounds({ prefix: 'b:', gte: 'a', lt: 'z' })).toEqual({ lower: 'b:', upper: 'b;' });
    expect(effectiveBounds({ prefix: 'b:', gte: 'b:5' })).toEqual({ lower: 'b:5', upper: 'b;' });
  });
  it('classifies thrown errors', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
    expect(toStoreError({ name: 'QuotaExceededError' }, 'b', 'set').code).toBe('SF-STORE-001');
    expect(toStoreError({ name: 'AbortError' }, 'b', 'set').code).toBe('SF-STORE-004');
    expect(toStoreError({ name: 'DataCloneError' }, 'b', 'set').code).toBe('SF-STORE-006');
    expect(toStoreError({ name: 'SecurityError' }, 'b', 'set').code).toBe('SF-STORE-002');
    expect(toStoreError(new Error('boom'), 'b', 'set').code).toBe('SF-STORE-008');
  });
});

describe('memory adapter', () => {
  it('declares capabilities and tracks size', async () => {
    const store = createMemoryStore({ initial: { a: 1 } });
    expect(store.capabilities).toMatchObject({ atomicBatch: true, ordered: true, persistent: false, ttl: true });
    expect(store.size).toBe(1);
    await store.set('b', 2);
    expect(store.size).toBe(2);
  });
  it('rejects oversized values and keeps batches atomic', async () => {
    const store = createMemoryStore({ maxValueBytes: 10 });
    expect((await store.set('big', 'x'.repeat(20))).ok).toBe(false);
    const result = await store.batch([{ type: 'set', key: 'ok', value: 1 }, { type: 'set', key: 'big', value: 'x'.repeat(20) }]);
    expect(!result.ok && result.error.code).toBe('SF-STORE-001');
    expect(unwrap(await store.get('ok'))).toBeUndefined();
  });
  it('rejects non-cloneable values with SF-STORE-006', async () => {
    const store = createMemoryStore();
    const result = await store.set('fn', { f: () => 1 });
    expect(!result.ok && result.error.code).toBe('SF-STORE-006');
  });
  it('isolates listener failures', async () => {
    const store = createMemoryStore();
    const seen: string[] = [];
    store.watch(() => {
      throw new Error('bad listener');
    });
    store.watch((c) => seen.push(c.type));
    expect((await store.set('a', 1)).ok).toBe(true);
    expect(seen).toEqual(['set']);
  });
});

describe('web storage adapter', () => {
  it('is unavailable when storage throws (Safari private mode / sandbox)', () => {
    const result = createWebStorageStore({ area: 'local', storage: fakeStorage({ throwOnAccess: true }) });
    expect(!result.ok && result.error.code).toBe('SF-STORE-002');
    expect(createWebStorageStore({ area: 'session', storage: null }).ok).toBe(false);
    expect(probeWebStorage(() => undefined)).toBeUndefined();
  });
  it('prefixes keys and clears only its own entries', async () => {
    const area = fakeStorage();
    area.setItem('foreign', 'keep');
    const store = unwrap(createLocalStorageStore({ storage: area, prefix: 'app:', events: null }));
    await store.set('a', { n: 1 });
    expect(area.map.get('app:a')).toBe('{"n":1}');
    await store.clear();
    expect([...area.map.keys()]).toEqual(['foreign']);
  });
  it('reports corrupt entries', async () => {
    const area = fakeStorage();
    const store = unwrap(createLocalStorageStore({ storage: area, events: null }));
    area.setItem('sf:bad', '{not json');
    const result = await store.get('bad');
    expect(!result.ok && result.error.code).toBe('SF-STORE-003');
    expect((await store.seek().toArray()).ok).toBe(false);
  });
  it('maps quota errors and rolls back batches', async () => {
    const area = fakeStorage({ quotaChars: 40 });
    const store = unwrap(createLocalStorageStore({ storage: area, events: null }));
    await store.set('a', 'old');
    const result = await store.batch([
      { type: 'set', key: 'a', value: 'new' },
      { type: 'set', key: 'b', value: 'x'.repeat(50) },
    ]);
    expect(!result.ok && result.error.code).toBe('SF-STORE-001');
    expect(unwrap(await store.get('a'))).toBe('old');
    expect(unwrap(await store.get('b'))).toBeUndefined();
  });
  it('emits external changes from storage events (localStorage only)', async () => {
    const area = fakeStorage();
    const events = fakeEvents();
    const store = unwrap(createLocalStorageStore({ storage: area, events }));
    expect(store.capabilities.crossTabEvents).toBe(true);
    const changes: StoreChange<unknown>[] = [];
    const stop = store.watch((c) => changes.push(c));
    expect(events.count).toBe(1);
    events.fire({ key: 'sf:k', newValue: '{"v":1}', storageArea: area });
    events.fire({ key: 'sf:k', newValue: null, storageArea: area });
    events.fire({ key: 'other', newValue: '1', storageArea: area });
    events.fire({ key: 'sf:k', newValue: '1', storageArea: fakeStorage() });
    events.fire({ key: null, newValue: null, storageArea: area });
    expect(changes).toEqual([
      { type: 'set', key: 'k', value: { v: 1 }, origin: 'external' },
      { type: 'delete', key: 'k', origin: 'external' },
      { type: 'clear', origin: 'external' },
    ]);
    stop();
    expect(events.count).toBe(0);
    const session = unwrap(createSessionStorageStore({ storage: fakeStorage(), events }));
    expect(session.capabilities).toMatchObject({ crossTabEvents: false, persistent: false });
  });
});

describe('cookie adapter', () => {
  it('serializes attributes and parses headers', () => {
    expect(serializeCookie('n', 'v', { path: '/app', sameSite: 'Strict', secure: true, maxAgeSeconds: 60, domain: 'example.com' })).toBe(
      'n=v; Path=/app; Domain=example.com; Max-Age=60; SameSite=Strict; Secure',
    );
    expect(serializeCookie('n', 'v', { sameSite: 'None' })).toContain('; Secure');
    expect([...parseCookies('a=1; b=2;c=x=y; bad')]).toEqual([['a', '1'], ['b', '2'], ['c', 'x=y']]);
  });
  it('writes encoded cookies with the configured attributes and ttl as max-age', async () => {
    const doc = createFakeCookieDocument();
    const store = unwrap(createCookieStore({ document: doc, path: '/', sameSite: 'Lax', secure: true, maxAgeSeconds: 3600 }));
    expect(store.capabilities).toMatchObject({ persistent: true, ttl: true, maxValueBytes: 4096 });
    await store.set('theme', { dark: true });
    expect(doc.writes.at(-1)).toBe(`sf_theme=${encodeURIComponent('{"dark":true}')}; Path=/; Max-Age=3600; SameSite=Lax; Secure`);
    await store.set('short', 1, { ttlMs: 1500 });
    expect(doc.writes.at(-1)).toContain('Max-Age=2');
    await store.delete('theme');
    expect(doc.writes.at(-1)).toContain('Max-Age=0');
    expect(unwrap(await store.get('theme'))).toBeUndefined();
  });
  it('enforces size and count limits', async () => {
    const store = unwrap(createCookieStore({ document: createFakeCookieDocument(), maxCookieBytes: 100, maxCookies: 2 }));
    const big = await store.set('big', 'x'.repeat(200));
    expect(!big.ok && big.error.code).toBe('SF-STORE-001');
    await store.set('a', 1);
    await store.set('b', 2);
    const third = await store.set('c', 3);
    expect(!third.ok && third.error.code).toBe('SF-STORE-001');
    expect((await store.set('a', 5)).ok).toBe(true); // overwrite allowed at the limit
  });
  it('is unavailable without a document or when cookies are disabled', () => {
    expect(createCookieStore({ document: null }).ok).toBe(false);
    const disabled = { get cookie() { return ''; }, set cookie(_v: string) { /* dropped */ } };
    const result = createCookieStore({ document: disabled });
    expect(!result.ok && result.error.code).toBe('SF-STORE-002');
  });
  it('ignores foreign cookies', async () => {
    const doc = createFakeCookieDocument();
    doc.cookie = 'session=abc; Path=/';
    const store = unwrap(createCookieStore({ document: doc }));
    await store.set('x', 1);
    expect(unwrap(await store.seek().keys())).toEqual(['x']);
    await store.clear();
    expect(doc.cookie).toBe('session=abc');
  });
});

describe('indexeddb adapter (fake IDB)', () => {
  const open = (idb = createFakeIndexedDb(), namespace = 'ns', extra: { broadcast?: ReturnType<typeof createBroadcastHub> | null } = {}) =>
    unwrap(createIndexedDbStore({ namespace, indexedDB: idb, keyRange: idb.keyRange, broadcast: extra.broadcast ?? null }));

  it('is unavailable without indexedDB', () => {
    const result = createIndexedDbStore({ namespace: 'x', indexedDB: null });
    expect(!result.ok && result.error.code).toBe('SF-STORE-002');
    expect(createIndexedDbStore({ namespace: 'x', indexedDB: createFakeIndexedDb(), keyRange: null }).ok).toBe(false);
  });
  it('creates one object store per namespace, upgrading the shared database', async () => {
    const idb = createFakeIndexedDb();
    const a = open(idb, 'alpha');
    const b = open(idb, 'beta');
    await a.set('k', 'from-a');
    await b.set('k', 'from-b');
    expect(unwrap(await a.get('k'))).toBe('from-a');
    expect(unwrap(await b.get('k'))).toBe('from-b');
    const db = idb.databases.get('staticflux');
    expect(db?.version).toBe(2);
    expect([...(db?.stores.keys() ?? [])].sort()).toEqual(['alpha', 'beta']);
    expect(a.connection).toBe('open');
    // a reconnects after it was closed by beta's upgrade
    expect(unwrap(await a.get('k'))).toBe('from-a');
  });
  it('uses native ranges and cursors', async () => {
    const store = open();
    expect(store.capabilities).toMatchObject({ atomicBatch: true, ordered: true, persistent: true });
    await store.batch(['a', 'b1', 'b2', 'b3', 'c'].map((key) => ({ type: 'set' as const, key, value: key })));
    expect(unwrap(await store.seek({ prefix: 'b', reverse: true, limit: 2 }).keys())).toEqual(['b3', 'b2']);
    expect(unwrap(await store.seek({ gte: 'c', lt: 'b' }).keys())).toEqual([]);
  });
  it('batches atomically: a failing put rolls back the whole transaction', async () => {
    const idb = createFakeIndexedDb();
    const store = open(idb);
    await store.set('keep', 'x');
    idb.quotaBytes = 200;
    const result = await store.batch([
      { type: 'delete', key: 'keep' },
      { type: 'set', key: 'small', value: 'ok' },
      { type: 'set', key: 'huge', value: 'y'.repeat(500) },
    ]);
    expect(!result.ok && result.error.code).toBe('SF-STORE-001');
    expect(unwrap(await store.seek().keys())).toEqual(['keep']);
  });
  it('aborts the transaction on non-cloneable values', async () => {
    const store = open();
    const result = await store.batch([
      { type: 'set', key: 'a', value: 1 },
      { type: 'set', key: 'b', value: { f: () => 1 } },
    ]);
    expect(!result.ok && result.error.code).toBe('SF-STORE-006');
    expect(unwrap(await store.get('a'))).toBeUndefined();
  });
  it('reports open failures as unavailable and retries on the next call', async () => {
    const idb = createFakeIndexedDb();
    const store = open(idb);
    idb.failNext('open');
    const failed = await store.get('k');
    expect(!failed.ok && failed.error.code).toBe('SF-STORE-002');
    expect(store.connection).toBe('failed');
    expect(unwrap(await store.get('k'))).toBeUndefined();
    expect(store.connection).toBe('open');
  });
  it('maps request failures to SF-STORE-008', async () => {
    const idb = createFakeIndexedDb();
    const store = open(idb);
    await store.set('k', 1);
    idb.failNext('get');
    const result = await store.get('k');
    expect(!result.ok && result.error.code).toBe('SF-STORE-008');
  });
  it('aborts in-flight writes when the signal aborts', async () => {
    const store = open();
    await store.get('warm');
    const controller = new AbortController();
    const pending = store.set('k', 1, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('SF-STORE-004');
    expect(unwrap(await store.get('k'))).toBeUndefined();
  });
  it('notifies other tabs over BroadcastChannel', async () => {
    const idb = createFakeIndexedDb();
    const hub = createBroadcastHub();
    const tab1 = open(idb, 'shared', { broadcast: hub });
    const tab2 = open(idb, 'shared', { broadcast: hub });
    expect(tab2.capabilities.crossTabEvents).toBe(true);
    const seen: StoreChange<unknown>[] = [];
    tab2.watch((c) => seen.push(c));
    await tab1.set('doc', { v: 1 });
    await tab1.clear();
    await tick();
    expect(seen).toEqual([
      { type: 'set', key: 'doc', origin: 'external' },
      { type: 'clear', origin: 'external' },
    ]);
    await tab1.dispose();
    await tab2.dispose();
    expect(hub.open).toBe(0);
  });
  it('closes the connection on dispose', async () => {
    const store = open();
    await store.set('a', 1);
    await store.dispose();
    expect(store.connection).toBe('disposed');
  });
});

describe('opfs adapter (fake root)', () => {
  it('is unavailable without navigator.storage.getDirectory', () => {
    const result = createOpfsStore({ namespace: 'x', root: null });
    expect(!result.ok && result.error.code).toBe('SF-STORE-002');
    expect(createOpfsStore({ namespace: 'x' }).ok).toBe(false); // happy-dom has no OPFS
  });
  it('stores one file per key with safe names', async () => {
    const root = createFakeOpfsRoot();
    const store = unwrap(createOpfsStore({ namespace: 'docs', root: async () => root, broadcast: null }));
    await store.set('a/b.c', { big: true });
    const dir = root.tree.get('docs') as Map<string, unknown>;
    expect([...dir.keys()]).toEqual([opfsFileName('a/b.c')]);
    expect(opfsFileName('..')).toBe('%2E%2E');
    expect(opfsKeyOf(opfsFileName('a/b.c'))).toBe('a/b.c');
    expect(dir.get(opfsFileName('a/b.c'))).toBe('{"big":true}');
  });
  it('reports missing createWritable (old Safari) as unavailable', async () => {
    const store = unwrap(createOpfsStore({ namespace: 'docs', root: async () => createFakeOpfsRoot({ writable: false }), broadcast: null }));
    const result = await store.set('k', 1);
    expect(!result.ok && result.error.code).toBe('SF-STORE-002');
  });
  it('reports a failing root as unavailable', async () => {
    const store = unwrap(createOpfsStore({ namespace: 'docs', root: () => Promise.reject(new Error('denied')), broadcast: null }));
    const result = await store.get('k');
    expect(!result.ok && result.error.code).toBe('SF-STORE-002');
  });
});

describe('remote adapter', () => {
  it('passes transport errors through and never retries', async () => {
    const transport = createMockRemoteTransport();
    const store = createRemoteStore(transport);
    transport.failNext();
    const result = await store.set('k', 1);
    expect(!result.ok && result.error.code).toBe('SF-STORE-008');
    expect(transport.calls.filter((c) => c.op === 'set')).toHaveLength(1);
    transport.setOffline(true);
    expect((await store.get('k')).ok).toBe(false);
  });
  it('declares atomic batch only when the transport has one', () => {
    expect(createRemoteStore(createMockRemoteTransport()).capabilities.atomicBatch).toBe(true);
    expect(createRemoteStore(createMockRemoteTransport({ atomicBatch: false })).capabilities.atomicBatch).toBe(false);
  });
  it('surfaces server pushes as external changes', () => {
    const transport = createMockRemoteTransport();
    const store = createRemoteStore(transport);
    const seen: StoreChange<unknown>[] = [];
    const stop = store.watch((c) => seen.push(c));
    transport.serverSet('k', 1);
    transport.serverDelete('k');
    stop();
    transport.serverSet('k', 2);
    expect(seen).toEqual([
      { type: 'set', key: 'k', value: 1, origin: 'external' },
      { type: 'delete', key: 'k', origin: 'external' },
    ]);
  });
  it('respects latency and abort', async () => {
    const store = createRemoteStore(createMockRemoteTransport({ latencyMs: 50 }));
    const controller = new AbortController();
    const pending = store.get('k', { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
  });
});
