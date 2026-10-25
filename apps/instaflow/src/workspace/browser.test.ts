import { createFakeIndexedDb } from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import { openWorkspaceBlobs } from './blobs.js';
import { LOCAL_WORKSPACE, openWorkspaceDocuments } from './browser.js';

const signal = (): AbortSignal => new AbortController().signal;

describe('openWorkspaceDocuments', () => {
  it('opens the local workspace in IndexedDB (database "instaflow", one object store per workspace)', async () => {
    const idb = createFakeIndexedDb();
    const opened = openWorkspaceDocuments({ indexedDB: idb, keyRange: idb.keyRange, locks: null });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const ref = await opened.value.store.putBlob(new Uint8Array([1, 2]), signal());
    expect(ref.ok).toBe(true);
    expect([...(idb.databases.get(LOCAL_WORKSPACE.database)?.stores.keys() ?? [])]).toEqual([LOCAL_WORKSPACE.namespace]);
    await opened.value.dispose();
  });

  it('is SF-STORE-002 without IndexedDB (Home shows the read error and how to fix it)', () => {
    const opened = openWorkspaceDocuments({ indexedDB: null });
    expect(!opened.ok && opened.error.code).toBe('SF-STORE-002');
  });
});

describe('openWorkspaceBlobs', () => {
  it('falls back to memory where OPFS is unavailable (not persistent)', async () => {
    const opened = await openWorkspaceBlobs();
    expect(opened.persistent).toBe(false);
    const put = await opened.blobs.put(new Uint8Array([9]));
    expect(put.ok).toBe(true);
  });
});
