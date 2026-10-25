import { describe, expect, it } from 'vitest';
import {
  asDirectoryHandle,
  type DirectoryHandleLike,
  checkName,
  createDirectoryCache,
  fileExists,
  isTempName,
  listDirectories,
  listFiles,
  openDirectory,
  publishFile,
  readFile,
  removeFile,
  removeTempFiles,
  statFile,
  tempNameFor,
  writeHandle,
} from './fs.js';
import { createMemoryDirectory } from './memory-fs.js';

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const utf = (s: string): Uint8Array => new TextEncoder().encode(s);
const code = (r: { ok: boolean; error?: { code: string } }): string => (r.ok ? 'ok' : (r.error?.code ?? '?'));

describe('names', () => {
  it('tempNameFor makes unique temp names that isTempName recognizes', () => {
    const a = tempNameFor('head.json');
    const b = tempNameFor('head.json');
    expect(a).not.toBe(b);
    expect(a.startsWith('head.json.tmp-')).toBe(true);
    expect(isTempName(a)).toBe(true);
    expect(isTempName('head.json')).toBe(false);
  });

  it('checkName rejects empty, path-like and dot names', () => {
    expect(checkName('ok.json')).toEqual({ ok: true, value: 'ok.json' });
    for (const bad of ['', 'a/b', 'a\\b', '.', '..']) expect(code(checkName(bad))).toBe('SF-BLOB-008');
  });
});

describe('directories', () => {
  it('openDirectory creates, or reports a missing directory as undefined', async () => {
    const fs = createMemoryDirectory();
    expect(await openDirectory(fs.root, ['a', 'b'], false)).toEqual({ ok: true, value: undefined });
    const made = await openDirectory(fs.root, ['a', 'b'], true);
    expect(made.ok && made.value?.name).toBe('b');
    fs.inject({ op: 'create', name: /^c$/, error: 'InvalidStateError' });
    expect(code(await openDirectory(fs.root, ['c'], true))).toBe('SF-BLOB-007');
  });

  it('createDirectoryCache caches opened handles and forgets subtrees', async () => {
    const fs = createMemoryDirectory();
    const cache = createDirectoryCache(fs.root);
    const first = await cache.get(['x', 'y'], true);
    const second = await cache.get(['x', 'y'], false);
    expect(first.ok && second.ok && first.value === second.value).toBe(true);
    cache.forget(['x']);
    const third = await cache.get(['x', 'y'], false);
    expect(third.ok && third.value !== (first.ok ? first.value : undefined)).toBe(true);
  });

  it('listFiles / listDirectories separate entries by kind', async () => {
    const fs = createMemoryDirectory();
    await fs.root.getDirectoryHandle('sub', { create: true });
    await fs.root.getFileHandle('f', { create: true });
    expect(await listFiles(fs.root)).toEqual({ ok: true, value: ['f'] });
    expect(await listDirectories(fs.root)).toEqual({ ok: true, value: ['sub'] });
    fs.inject({ op: 'list' });
    expect(code(await listFiles(fs.root))).toBe('SF-BLOB-007');
  });

  it('asDirectoryHandle is a typed view of a platform handle', () => {
    const fs = createMemoryDirectory();
    expect(asDirectoryHandle(fs.root as unknown as FileSystemDirectoryHandle)).toBe(fs.root);
  });
});

describe('files', () => {
  it('fileExists, statFile, readFile with ranges, removeFile', async () => {
    const fs = createMemoryDirectory({ now: () => 7 });
    const handle = await fs.root.getFileHandle('a.bin', { create: true });
    await writeHandle(handle, utf('hello world'), 'writable');
    expect(await fileExists(fs.root, 'a.bin')).toEqual({ ok: true, value: true });
    expect(await fileExists(fs.root, 'zz')).toEqual({ ok: true, value: false });
    expect(await statFile(fs.root, 'a.bin')).toEqual({ ok: true, value: { size: 11, lastModified: 7 } });
    expect(code(await statFile(fs.root, 'zz'))).toBe('SF-BLOB-005');
    const range = await readFile(fs.root, 'a.bin', { start: 6, end: 11 });
    expect(range.ok && text(range.value)).toBe('world');
    expect(code(await readFile(fs.root, 'a.bin', { start: 3, end: 99 }))).toBe('SF-BLOB-008');
    expect(code(await readFile(fs.root, 'nope'))).toBe('SF-BLOB-005');
    expect(await removeFile(fs.root, 'a.bin')).toEqual({ ok: true, value: undefined });
    expect(await removeFile(fs.root, 'a.bin')).toEqual({ ok: true, value: undefined });
  });

  it('readFile retries a NotReadableError (a snapshot made stale by a swap)', async () => {
    const fs = createMemoryDirectory();
    await publishFile(fs.root, 'h.json', utf('v1'), 'writable');
    fs.inject({ op: 'read', name: /^h\.json$/, error: 'NotReadableError' });
    const read = await readFile(fs.root, 'h.json');
    expect(read.ok && text(read.value)).toBe('v1');
  });

  it('readFile stops when aborted', async () => {
    const fs = createMemoryDirectory();
    const controller = new AbortController();
    controller.abort();
    expect(code(await readFile(fs.root, 'x', undefined, controller.signal))).toBe('SF-BLOB-006');
  });

  it('writeHandle writes through a sync handle or a writable, truncating', async () => {
    const fs = createMemoryDirectory();
    const handle = await fs.root.getFileHandle('f', { create: true });
    await writeHandle(handle, utf('longer content'), 'sync');
    await writeHandle(handle, utf('short'), 'sync');
    expect(text(fs.read('f'))).toBe('short');
    await writeHandle(handle, utf('via writable'), 'writable');
    expect(text(fs.read('f'))).toBe('via writable');
    const noSync = createMemoryDirectory({ syncHandles: false });
    const plain = await noSync.root.getFileHandle('f', { create: true });
    expect(code(await writeHandle(plain, utf('x'), 'sync'))).toBe('SF-BLOB-009');
  });

  it('publishFile replaces the target atomically and leaves no temp file', async () => {
    const fs = createMemoryDirectory();
    await publishFile(fs.root, 'head.json', utf('one'), 'writable');
    await publishFile(fs.root, 'head.json', utf('two'), 'sync');
    expect(fs.paths()).toEqual(['head.json']);
    expect(text(fs.read('head.json'))).toBe('two');
  });

  it('publishFile failing before the move keeps the old content and removes the temp', async () => {
    const fs = createMemoryDirectory();
    await publishFile(fs.root, 'head.json', utf('old'), 'writable');
    const crashed = await publishFile(fs.root, 'head.json', utf('new'), 'writable', {
      beforeMove: () => {
        throw new Error('simulated crash');
      },
    });
    expect(code(crashed)).toBe('SF-BLOB-007');
    expect(text(fs.read('head.json'))).toBe('old');
    expect(fs.paths()).toEqual(['head.json']);
    fs.inject({ op: 'move' });
    expect(code(await publishFile(fs.root, 'head.json', utf('x'), 'writable'))).toBe('SF-BLOB-007');
    expect(fs.paths()).toEqual(['head.json']);
    fs.inject({ op: 'create', name: /tmp/ });
    expect(code(await publishFile(fs.root, 'head.json', utf('x'), 'writable'))).toBe('SF-BLOB-007');
  });

  it('publishFile needs move() (SF-BLOB-009) and reports quota (SF-BLOB-001)', async () => {
    const noMove = createMemoryDirectory({ move: false });
    const withoutMove = {
      ...noMove.root,
      getFileHandle: async (n: string, o?: { create?: boolean }) => {
        const { move: _move, ...rest } = await noMove.root.getFileHandle(n, o);
        return rest;
      },
    } as unknown as DirectoryHandleLike;
    expect(code(await publishFile(withoutMove, 'a', utf('x'), 'writable'))).toBe('SF-BLOB-009');
    const tiny = createMemoryDirectory({ quota: 4 });
    expect(code(await publishFile(tiny.root, 'a', utf('too big'), 'writable'))).toBe('SF-BLOB-001');
    expect(tiny.paths()).toEqual([]);
  });

  it('removeTempFiles deletes only crash leftovers', async () => {
    const fs = createMemoryDirectory();
    await publishFile(fs.root, 'keep.json', utf('k'), 'writable');
    await fs.root.getFileHandle(tempNameFor('keep.json'), { create: true });
    await fs.root.getFileHandle(tempNameFor('other.json'), { create: true });
    expect(await removeTempFiles(fs.root)).toEqual({ ok: true, value: 2 });
    expect(fs.paths()).toEqual(['keep.json']);
  });
});
