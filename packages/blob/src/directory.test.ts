import { describe, expect, it } from 'vitest';
import { sha256 } from './codec.js';
import { BLOBS_PATH, chooseWriteMode, createDirectoryObjectStore, DEFAULT_SYNC_THRESHOLD, detectSyncAccessHandles, objectPath } from './directory.js';
import { tempNameFor } from './fs.js';
import { createMemoryDirectory } from './memory-fs.js';
import type { StoreChange } from './types.js';

describe('objectPath', () => {
  it('shards by the first two hex characters', async () => {
    const digest = await sha256(new Uint8Array([1]));
    const hex = digest.slice(7);
    expect(objectPath(digest)).toEqual([[...BLOBS_PATH, hex.slice(0, 2)], hex]);
  });
});

describe('chooseWriteMode', () => {
  it('uses sync handles only for large objects when available (S6)', () => {
    expect(chooseWriteMode('auto', DEFAULT_SYNC_THRESHOLD, true)).toBe('sync');
    expect(chooseWriteMode('auto', DEFAULT_SYNC_THRESHOLD - 1, true)).toBe('writable');
    expect(chooseWriteMode('auto', 10 * DEFAULT_SYNC_THRESHOLD, false)).toBe('writable');
    expect(chooseWriteMode('sync', 1, false)).toBe('sync');
    expect(chooseWriteMode('writable', 1e9, true)).toBe('writable');
    expect(chooseWriteMode('auto', 100, true, 50)).toBe('sync');
  });
});

describe('detectSyncAccessHandles', () => {
  it('is false outside a dedicated worker', () => {
    expect(detectSyncAccessHandles()).toBe(false);
  });
});

describe('createDirectoryObjectStore', () => {
  it('publishes objects under the shard path, notifies the observer, and lists them', async () => {
    const fs = createMemoryDirectory();
    const changes: StoreChange[] = [];
    const objects = createDirectoryObjectStore(fs.root, { observer: (c) => changes.push(c), syncAvailable: true });
    const digest = await sha256(new Uint8Array([1, 2]));
    expect(objects.id).toBe('directory(memory-root)');
    await objects.writeObject(digest, new Uint8Array([1, 2]));
    await objects.writeObject(digest, new Uint8Array([1, 2]));
    const [path, name] = objectPath(digest);
    expect(fs.paths()).toEqual([[...path, name].join('/')]);
    expect(changes).toEqual([{ kind: 'object', path, name }]);
    const listed = [];
    for await (const item of objects.listObjects()) listed.push(item);
    expect(listed).toEqual([{ ok: true, value: digest }]);
    await objects.deleteObject(digest);
    expect(changes.at(-1)).toEqual({ kind: 'delete', path, name });
  });

  it('quarantines into quarantine/sha256 and stops serving the object', async () => {
    const fs = createMemoryDirectory();
    const objects = createDirectoryObjectStore(fs.root);
    const digest = await sha256(new Uint8Array([3]));
    await objects.writeObject(digest, new Uint8Array([3]));
    expect(await objects.quarantineObject(digest)).toEqual({ ok: true, value: `quarantine/sha256/${digest.slice(7)}` });
    expect(fs.paths()).toEqual([`quarantine/sha256/${digest.slice(7)}`]);
    expect(await objects.hasObject(digest)).toEqual({ ok: true, value: false });
    const again = await objects.quarantineObject(digest);
    expect(again.ok ? '' : again.error.code).toBe('SF-BLOB-005');
  });

  it('skips temp and foreign files when listing; sweepTemps removes crash leftovers', async () => {
    const fs = createMemoryDirectory();
    const objects = createDirectoryObjectStore(fs.root);
    const digest = await sha256(new Uint8Array([4]));
    await objects.writeObject(digest, new Uint8Array([4]));
    const [path, name] = objectPath(digest);
    let shard = fs.root;
    for (const part of path) shard = await shard.getDirectoryHandle(part, { create: true });
    await shard.getFileHandle(tempNameFor(name), { create: true });
    await shard.getFileHandle('README.txt', { create: true });
    const listed = [];
    for await (const item of objects.listObjects()) listed.push(item);
    expect(listed).toEqual([{ ok: true, value: digest }]);
    expect(await objects.sweepTemps()).toEqual({ ok: true, value: 1 });
    expect(await createDirectoryObjectStore(createMemoryDirectory().root).sweepTemps()).toEqual({ ok: true, value: 0 });
  });

  it('missing shards read as not found; dispose rejects later calls', async () => {
    const objects = createDirectoryObjectStore(createMemoryDirectory().root);
    const digest = await sha256(new Uint8Array([5]));
    for (const result of [await objects.readObject(digest), await objects.statObject(digest)]) expect(result.ok ? '' : result.error.code).toBe('SF-BLOB-005');
    expect(await objects.deleteObject(digest)).toEqual({ ok: true, value: undefined });
    const empty = [];
    for await (const item of objects.listObjects()) empty.push(item);
    expect(empty).toEqual([]);
    objects.dispose();
    const disposed = await objects.hasObject(digest);
    expect(disposed.ok ? '' : disposed.error.code).toBe('SF-BLOB-013');
  });

  it('propagates file system faults as SF-BLOB errors and leaves no partial object', async () => {
    const fs = createMemoryDirectory();
    const objects = createDirectoryObjectStore(fs.root);
    const digest = await sha256(new Uint8Array([6]));
    fs.inject({ op: 'move', error: 'QuotaExceededError' });
    const failed = await objects.writeObject(digest, new Uint8Array([6]));
    expect(failed.ok ? '' : failed.error.code).toBe('SF-BLOB-001');
    expect(fs.paths()).toEqual([]);
  });
});
