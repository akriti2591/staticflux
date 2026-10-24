import { unwrap } from '@staticflux/core';
import {
  createFakeIndexedDb,
  createIndexedDbStore,
  createMemoryStore,
  createMockRemoteTransport,
  createRemoteStore,
  encrypted,
  generateStoreKey,
  staticKeyProvider,
  type EncryptedRecord,
} from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import { isSliceRecord, remoteSyncFromStore, sliceBackendFromStore } from './async-store.js';
import { s } from './schema.js';
import { defineSlice } from './slices.js';
import { createUserData, type UserIdentity } from './user-data.js';

const ThemeSlice = defineSlice({
  key: 'settings/theme',
  scope: 'user',
  version: 1,
  schema: s.object({ mode: s.enum(['light', 'dark']) }),
  default: () => ({ mode: 'light' as const }),
});
const alice: UserIdentity = { userId: 'alice', workspaceId: 'w1', deviceId: 'dev1' };

describe('sliceBackendFromStore', () => {
  it('implements get/write/keys over an AsyncStore (IndexedDB)', async () => {
    const idb = createFakeIndexedDb();
    const store = unwrap(createIndexedDbStore({ namespace: 'user-data', indexedDB: idb, keyRange: idb.keyRange, broadcast: null }));
    const backend = sliceBackendFromStore(store);
    expect(backend.id).toBe('indexeddb');
    unwrap(await backend.write([{ key: 'sf-ud/user/a/x', record: { v: 1, value: 1, updatedAt: 1 } }, { key: 'sf-ud/user/a/y', record: { v: 1, value: 2, updatedAt: 1 } }], []));
    unwrap(await backend.write([], ['sf-ud/user/a/y']));
    expect(unwrap(await backend.get(['sf-ud/user/a/x', 'sf-ud/user/a/y']))).toEqual({ 'sf-ud/user/a/x': { v: 1, value: 1, updatedAt: 1 } });
    expect(unwrap(await backend.keys('sf-ud/user/'))).toEqual(['sf-ud/user/a/x']);
  });

  it('treats non-record and undecodable entries as absent', async () => {
    const store = createMemoryStore({ initial: { junk: { nope: true }, ok: { v: 1, value: 'x', updatedAt: 2 } } });
    const backend = sliceBackendFromStore(store, { id: 'custom' });
    expect(unwrap(await backend.get(['junk', 'ok', 'missing']))).toEqual({ ok: { v: 1, value: 'x', updatedAt: 2 } });
    expect(isSliceRecord({ v: 1, value: null, updatedAt: 0 })).toBe(true);
    expect(isSliceRecord({ v: '1', value: null, updatedAt: 0 })).toBe(false);
    const key = unwrap(await generateStoreKey());
    const other = unwrap(await generateStoreKey());
    const raw = createMemoryStore<EncryptedRecord>();
    await encrypted(staticKeyProvider(other))(raw).set('k', { v: 1, value: 1, updatedAt: 1 });
    expect(unwrap(await sliceBackendFromStore(encrypted(staticKeyProvider(key))(raw)).get(['k']))).toEqual({});
  });

  it('maps backend failures to SF-DATA-054', async () => {
    const backend = sliceBackendFromStore(createMemoryStore({ maxValueBytes: 10 }));
    const result = await backend.write([{ key: 'k', record: { v: 1, value: 'x'.repeat(50), updatedAt: 1 } }], []);
    expect(!result.ok && result.error.code).toBe('SF-DATA-054');
    expect(!result.ok && result.error.details['code']).toBe('SF-STORE-001');
  });

  it('persists user-data slices through an AsyncStore and reloads them', async () => {
    const store = createMemoryStore();
    const data = createUserData({ identity: alice, local: sliceBackendFromStore(store), writeDelayMs: 0, now: () => 5 });
    const theme = data.slice(ThemeSlice);
    await theme.whenReady();
    theme.set({ mode: 'dark' });
    unwrap(await data.flush());
    expect(unwrap(await store.get('sf-ud/user/alice/settings/theme'))).toEqual({ v: 1, value: { mode: 'dark' }, updatedAt: 5 });
    await data.dispose();
    const again = createUserData({ identity: alice, local: sliceBackendFromStore(store) });
    const reloaded = again.slice(ThemeSlice);
    expect(unwrap(await reloaded.whenReady())).toEqual({ mode: 'dark' });
    await again.dispose();
  });
});

describe('remoteSyncFromStore', () => {
  it('pushes and pulls slice records through a remote AsyncStore', async () => {
    const transport = createMockRemoteTransport();
    const remote = remoteSyncFromStore(createRemoteStore(transport));
    const signal = new AbortController().signal;
    unwrap(await remote.push([{ key: 'k', record: { v: 1, value: 'a', updatedAt: 3 } }], signal));
    expect(transport.records.get('k')).toEqual({ v: 1, value: 'a', updatedAt: 3 });
    expect(unwrap(await remote.pull(['k', 'missing'], signal))).toEqual({ k: { v: 1, value: 'a', updatedAt: 3 } });
    transport.setOffline(true);
    const offline = await remote.pull(['k'], signal);
    expect(!offline.ok && offline.error.code).toBe('SF-DATA-056');
  });

  it('drives user-data sync end to end', async () => {
    const transport = createMockRemoteTransport();
    const data = createUserData({ identity: alice, local: sliceBackendFromStore(createMemoryStore()), remote: remoteSyncFromStore(createRemoteStore(transport)), writeDelayMs: 0, now: () => 10 });
    const theme = data.slice(ThemeSlice);
    await theme.whenReady();
    theme.set({ mode: 'dark' });
    unwrap(await data.sync());
    expect(transport.records.get('sf-ud/user/alice/settings/theme')).toMatchObject({ value: { mode: 'dark' } });
    await data.dispose();
  });
});
