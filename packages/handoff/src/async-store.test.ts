import { createInjector, unwrap } from '@staticflux/core';
import {
  createFakeIndexedDb,
  createIndexedDbStore,
  createMemoryStore,
  createWebStorageStore,
  envelopeCodec,
  memoryStoreFactory,
  namespaced,
  storeFactoryUnit,
  storeRegistryUnit,
  withCodec,
  type StoredEnvelope,
  type WebStorageLike,
} from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import { handoffStoragesFromStores, handoffStorageFromStore } from './async-store.js';
import { createEnvelope } from './envelope.js';
import { defineHandoff } from './slot.js';
import { createHandoffStore } from './store.js';
import { HandoffStoragesToken, registryHandoffStoragesUnit } from './units.js';

const DraftSlot = defineHandoff<{ title: string }>({ key: 'studio/guest-draft', version: 1, lifetime: 'one-shot', scope: 'tab' });
const WorkspaceSlot = defineHandoff<string>({ key: 'shell/workspace', version: 1, lifetime: 'session', scope: 'origin' });

function fakeArea(): WebStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('handoffStorageFromStore', () => {
  it('backs the handoff store with AsyncStores (IndexedDB origin, sessionStorage tab)', async () => {
    const idb = createFakeIndexedDb();
    const origin = unwrap(createIndexedDbStore({ namespace: 'handoff', indexedDB: idb, keyRange: idb.keyRange, broadcast: null }));
    const tab = unwrap(createWebStorageStore({ area: 'session', storage: fakeArea(), prefix: 'sf-handoff:', events: null }));
    const storages = handoffStoragesFromStores({ tab, origin });
    expect(storages.degraded).toEqual([]);
    expect(storages.origin).toMatchObject({ kind: 'indexeddb', durable: true });
    expect(storages.tab).toMatchObject({ kind: 'session-storage', durable: false });
    const store = createHandoffStore({ storages, slots: [DraftSlot, WorkspaceSlot] });
    unwrap(await store.put(DraftSlot, { title: 'Hello' }));
    unwrap(await store.put(WorkspaceSlot, 'w-42'));
    expect(unwrap(await origin.get('shell/workspace'))).toMatchObject({ v: 1, key: 'shell/workspace', data: 'w-42' });
    expect(unwrap(await store.take(DraftSlot))).toEqual({ title: 'Hello' });
    expect(unwrap(await store.take(DraftSlot))).toBeUndefined(); // consume-once
    expect(unwrap(await store.peek(WorkspaceSlot))).toBe('w-42');
    expect(unwrap(await storages.origin.keys())).toEqual(['shell/workspace']);
  });

  it('reads envelopes written by the storage envelope codec (shared format)', async () => {
    const raw = createMemoryStore<StoredEnvelope>();
    const writer = withCodec(envelopeCodec<string>({ version: 1 }))(raw);
    await writer.set('shell/workspace', 'from-storage');
    const store = createHandoffStore({ storages: handoffStoragesFromStores({ origin: raw as never, tab: createMemoryStore() }) });
    expect(unwrap(await store.peek(WorkspaceSlot))).toBe('from-storage');
    // and the other direction
    await handoffStorageFromStore(raw as never).write('k', createEnvelope({ key: 'k', version: 1, data: 'from-handoff', now: 0 }));
    expect(unwrap(await writer.get('k'))).toBe('from-handoff');
  });

  it('discards undecodable entries as malformed and maps backend errors to SF-HANDOFF-006', async () => {
    const area = fakeArea();
    const tab = unwrap(createWebStorageStore({ area: 'session', storage: area, prefix: 'h:', events: null }));
    area.setItem('h:studio/guest-draft', '{broken');
    const storages = handoffStoragesFromStores({ tab, origin: createMemoryStore() });
    expect(unwrap(await storages.tab.read('studio/guest-draft'))).toBeNull();
    const store = createHandoffStore({ storages, slots: [DraftSlot] });
    const taken = await store.take(DraftSlot);
    expect(!taken.ok && taken.error.code).toBe('SF-HANDOFF-001');
    expect(area.map.has('h:studio/guest-draft')).toBe(false);

    const limited = handoffStorageFromStore(createMemoryStore({ maxValueBytes: 10 }), { kind: 'tiny', durable: true });
    expect(limited).toMatchObject({ kind: 'tiny', durable: true });
    const written = await limited.write('k', createEnvelope({ key: 'k', version: 1, data: 'x'.repeat(50), now: 0 }));
    expect(!written.ok && written.error.code).toBe('SF-HANDOFF-006');
    expect(!written.ok && written.error.details['code']).toBe('SF-STORE-001');
  });

  it('reports missing scopes as degraded and shares a backend via namespaces', async () => {
    const shared = createMemoryStore();
    const storages = handoffStoragesFromStores({ origin: namespaced<unknown>('sf-handoff:')(shared), degraded: ['tab'] });
    expect(storages.degraded).toEqual(['tab']);
    expect(storages.tab.kind).toBe('memory(tab)');
    await storages.origin.write('a', createEnvelope({ key: 'a', version: 1, data: 1, now: 0 }));
    expect(unwrap(await shared.seek().keys())).toEqual(['sf-handoff:a']);
  });
});

describe('registryHandoffStoragesUnit', () => {
  it('opens tab/origin storages from the storage registry and reports memory fallbacks', async () => {
    const injector = createInjector({ units: [storeRegistryUnit, storeFactoryUnit(memoryStoreFactory('session')), registryHandoffStoragesUnit] });
    const storages = unwrap(await injector.get(HandoffStoragesToken));
    expect(storages.degraded).toEqual(['origin']);
    expect(storages.tab.kind).toBe('fallback(memory(session/handoff))');
  });
});
