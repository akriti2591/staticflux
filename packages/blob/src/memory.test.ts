import { describe, expect, it } from 'vitest';
import { sha256 } from './codec.js';
import { createMemoryBlobStore, createMemoryObjectStore } from './memory.js';

describe('createMemoryObjectStore', () => {
  it('stores, reads ranges, stats with the injected clock, quarantines and lists', async () => {
    const objects = createMemoryObjectStore({ id: 'm', now: () => 42 });
    const digest = await sha256(new Uint8Array([1, 2, 3]));
    await objects.writeObject(digest, new Uint8Array([1, 2, 3]));
    await objects.writeObject(digest, new Uint8Array([9, 9, 9]));
    expect(await objects.readObject(digest, { start: 1, end: 3 })).toEqual({ ok: true, value: new Uint8Array([2, 3]) });
    expect(await objects.statObject(digest)).toEqual({ ok: true, value: { digest, storedSize: 3, modifiedAt: 42 } });
    const bad = await objects.readObject(digest, { start: 2, end: 9 });
    expect(bad.ok ? '' : bad.error.code).toBe('SF-BLOB-008');
    const listed = [];
    for await (const item of objects.listObjects()) listed.push(item);
    expect(listed).toEqual([{ ok: true, value: digest }]);
    expect(await objects.quarantineObject(digest)).toEqual({ ok: true, value: `quarantine/${digest.slice(7)}` });
    expect(objects.quarantined()).toEqual([digest]);
    expect(await objects.hasObject(digest)).toEqual({ ok: true, value: false });
    const missing = await objects.quarantineObject(digest);
    expect(missing.ok ? '' : missing.error.code).toBe('SF-BLOB-005');
  });

  it('honours aborts and dispose', async () => {
    const objects = createMemoryObjectStore();
    const controller = new AbortController();
    controller.abort();
    const digest = await sha256(new Uint8Array(0));
    const aborted = await objects.hasObject(digest, controller.signal);
    expect(aborted.ok ? '' : aborted.error.code).toBe('SF-BLOB-006');
    objects.dispose();
    const disposed = await objects.writeObject(digest, new Uint8Array(0));
    expect(disposed.ok ? '' : disposed.error.code).toBe('SF-BLOB-013');
  });
});

describe('createMemoryBlobStore', () => {
  it('is a non-persistent BlobStore', async () => {
    const store = createMemoryBlobStore({ id: 'preview' });
    expect(store.id).toBe('preview');
    expect(store.capabilities).toEqual({ persistent: false, rangeReads: true });
    const ref = await store.put(new Uint8Array([5]));
    expect(ref.ok).toBe(true);
  });
});
