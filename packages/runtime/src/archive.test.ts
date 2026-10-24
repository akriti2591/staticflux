import { createInjector, unwrap } from '@staticflux/core';
import {
  createFakeIndexedDb,
  createIndexedDbStore,
  createMemoryStore,
  memoryStoreFactory,
  storeFactoryUnit,
  storeRegistryUnit,
  StoreRegistryToken,
} from '@staticflux/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  archiveStoreFromStore,
  ArchiveStoreToken,
  createFeatureHost,
  defineFeature,
  registryArchiveStoreUnit,
  SNAPSHOT_FORMAT,
  type SnapshotEnvelope,
} from './index.js';

const snapshot = (id: `${string}/${string}`, data: unknown): SnapshotEnvelope => ({ format: SNAPSHOT_FORMAT, id, version: 1, createdAt: 1, epoch: 0, data });

describe('archiveStoreFromStore', () => {
  it('persists snapshots in an AsyncStore (IndexedDB)', async () => {
    const idb = createFakeIndexedDb();
    const backend = unwrap(createIndexedDbStore({ namespace: 'archive', indexedDB: idb, keyRange: idb.keyRange, broadcast: null }));
    const archive = archiveStoreFromStore(backend);
    unwrap(await archive.put(snapshot('studio/canvas', { shapes: [1, 2] })));
    expect(unwrap(await archive.get('studio/canvas'))).toEqual(snapshot('studio/canvas', { shapes: [1, 2] }));
    expect(unwrap(await archive.keys())).toEqual(['studio/canvas']);
    unwrap(await archive.delete('studio/canvas'));
    expect(unwrap(await archive.get('studio/canvas'))).toBeUndefined();
  });

  it('rejects and discards entries that are not sf-snapshot/1 envelopes for the id', async () => {
    const backend = createMemoryStore({ initial: { 'studio/a': { format: 'other' }, 'studio/b': snapshot('studio/x', 1) } });
    const archive = archiveStoreFromStore(backend);
    for (const id of ['studio/a', 'studio/b'] as const) {
      const result = await archive.get(id);
      expect(!result.ok && result.error.code).toBe('SF-FT-009');
    }
    expect(unwrap(await backend.seek().keys())).toEqual([]);
  });

  it('maps backend failures to SF-FT-009 with the storage code', async () => {
    const archive = archiveStoreFromStore(createMemoryStore({ maxValueBytes: 10 }));
    const result = await archive.put(snapshot('studio/big', 'x'.repeat(100)));
    expect(!result.ok && result.error.code).toBe('SF-FT-009');
    expect(!result.ok && result.error.details['code']).toBe('SF-STORE-001');
    const controller = new AbortController();
    controller.abort();
    const aborted = await archive.get('studio/big', controller.signal);
    expect(!aborted.ok && aborted.error.details['code']).toBe('SF-STORE-004');
  });

  it('drives the feature host archive/restore cycle', async () => {
    const backend = createMemoryStore();
    const injector = createInjector();
    const host = createFeatureHost({ injector, archive: archiveStoreFromStore(backend) });
    let state = { doc: 'draft' };
    const restore = vi.fn((data: unknown) => {
      state = data as typeof state;
    });
    host.register(defineFeature({ id: 'test/studio', weight: 'heavy', load: async () => ({ snapshot: () => state, restore }) }));
    await host.activate('test/studio');
    state = { doc: 'edited' };
    expect((await host.archive('test/studio')).ok).toBe(true);
    expect(unwrap(await backend.get('test/studio'))).toMatchObject({ format: SNAPSHOT_FORMAT, data: { doc: 'edited' } });
    state = { doc: 'lost' };
    await host.activate('test/studio');
    expect(state).toEqual({ doc: 'edited' });
  });

  it('registryArchiveStoreUnit uses the device-scope registry store', async () => {
    const injector = createInjector({ units: [storeRegistryUnit, storeFactoryUnit(memoryStoreFactory('device')), registryArchiveStoreUnit] });
    const archive = unwrap(await injector.get(ArchiveStoreToken));
    unwrap(await archive.put(snapshot('a/b', 1)));
    const registry = unwrap(await injector.get(StoreRegistryToken));
    expect(unwrap(await registry.open('device', 'runtime/archive').get('a/b'))).toEqual(snapshot('a/b', 1));
  });
});
