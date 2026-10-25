import { describe, expect, it } from 'vitest';
import type { DirectoryHandleLike } from './fs.js';
import { createMemoryDirectory } from './memory-fs.js';

const utf = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | ArrayBuffer | undefined): string => new TextDecoder().decode(b);
const errorName = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e as DOMException).name,
  );

async function write(dir: DirectoryHandleLike, name: string, content: string): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(utf(content));
  await writable.close();
}

describe('createMemoryDirectory (Chromium OPFS semantics)', () => {
  it('missing entries are NotFoundError; kind clashes are TypeMismatchError', async () => {
    const fs = createMemoryDirectory();
    expect(await errorName(fs.root.getFileHandle('x'))).toBe('NotFoundError');
    expect(await errorName(fs.root.getDirectoryHandle('x'))).toBe('NotFoundError');
    await fs.root.getDirectoryHandle('d', { create: true });
    expect(await errorName(fs.root.getFileHandle('d'))).toBe('TypeMismatchError');
    await write(fs.root, 'f', 'x');
    expect(await errorName(fs.root.getDirectoryHandle('f'))).toBe('TypeMismatchError');
  });

  it('a writable applies on close (and not on abort)', async () => {
    const fs = createMemoryDirectory();
    const handle = await fs.root.getFileHandle('f', { create: true });
    const writable = await handle.createWritable();
    await writable.write(utf('pending'));
    expect(text(fs.read('f'))).toBe('');
    await writable.close();
    expect(text(fs.read('f'))).toBe('pending');
    const aborted = await handle.createWritable({ keepExistingData: true });
    await aborted.write(utf('!!'));
    await aborted.abort?.();
    expect(text(fs.read('f'))).toBe('pending');
    expect(await errorName(aborted.write(utf('x')))).toBe('InvalidStateError');
  });

  it('move() overwrites the target, removes the source and retargets the handle', async () => {
    const fs = createMemoryDirectory();
    await write(fs.root, 'head.json', 'old');
    await write(fs.root, 'tmp', 'new');
    const tmp = await fs.root.getFileHandle('tmp');
    await tmp.move?.(fs.root, 'head.json');
    expect(fs.paths()).toEqual(['head.json']);
    expect(text(fs.read('head.json'))).toBe('new');
    expect(tmp.name).toBe('head.json');
    expect(fs.moves).toBe(1);
  });

  it('sync handles are exclusive and block move() and createWritable()', async () => {
    const fs = createMemoryDirectory();
    await write(fs.root, 'seg', '');
    const handle = await fs.root.getFileHandle('seg');
    const access = await handle.createSyncAccessHandle?.();
    if (access === undefined) throw new Error('sync handles expected');
    expect(await errorName(handle.createSyncAccessHandle?.() ?? Promise.resolve())).toBe('NoModificationAllowedError');
    expect(await errorName(handle.move?.(fs.root, 'other') ?? Promise.resolve())).toBe('NoModificationAllowedError');
    expect(await errorName(handle.createWritable())).toBe('NoModificationAllowedError');
    expect(await errorName(fs.root.removeEntry('seg'))).toBe('NoModificationAllowedError');
    access.write(utf('abc'), { at: 0 });
    access.write(utf('Z'), { at: 5 });
    expect(access.getSize()).toBe(6);
    const back = new Uint8Array(3);
    expect(access.read(back, { at: 0 })).toBe(3);
    expect(text(back)).toBe('abc');
    access.truncate(2);
    access.flush();
    access.close();
    access.close();
    expect(text(fs.read('seg'))).toBe('ab');
    expect(() => access.getSize()).toThrow();
  });

  it('a File snapshot read after the file changed is NotReadableError', async () => {
    const fs = createMemoryDirectory();
    await write(fs.root, 'f', 'one');
    const file = await (await fs.root.getFileHandle('f')).getFile();
    await write(fs.root, 'f', 'two');
    expect(await errorName(file.arrayBuffer())).toBe('NotReadableError');
    const fresh = await (await fs.root.getFileHandle('f')).getFile();
    expect(text(await fresh.slice(1, 3).arrayBuffer())).toBe('wo');
  });

  it('permission gates writes; requestPermission applies the configured answer', async () => {
    const fs = createMemoryDirectory();
    fs.setPermission('prompt', 'granted');
    expect(await fs.root.queryPermission?.({ mode: 'readwrite' })).toBe('prompt');
    expect(await errorName(fs.root.getFileHandle('f', { create: true }))).toBe('NotAllowedError');
    expect(await fs.root.requestPermission?.({ mode: 'readwrite' })).toBe('granted');
    await write(fs.root, 'f', 'ok');
    expect(text(fs.read('f'))).toBe('ok');
  });

  it('quota, injected faults (once or sticky) and removeEntry rules', async () => {
    const fs = createMemoryDirectory({ quota: 5 });
    const handle = await fs.root.getFileHandle('f', { create: true });
    const writable = await handle.createWritable();
    await writable.write(utf('123456'));
    expect(await errorName(writable.close())).toBe('QuotaExceededError');
    fs.inject({ op: 'remove', error: 'InvalidStateError', once: false });
    expect(await errorName(fs.root.removeEntry('f'))).toBe('InvalidStateError');
    expect(await errorName(fs.root.removeEntry('f'))).toBe('InvalidStateError');
    fs.clearFaults();
    const dir = await fs.root.getDirectoryHandle('d', { create: true });
    await write(dir, 'x', 'y');
    expect(await errorName(fs.root.removeEntry('d'))).toBe('InvalidModificationError');
    await fs.root.removeEntry('d', { recursive: true });
    expect(await errorName(fs.root.removeEntry('d'))).toBe('NotFoundError');
    expect(fs.usage()).toBe(0);
  });

  it('paths / read / write expose the tree for assertions and outside edits', async () => {
    const fs = createMemoryDirectory();
    const dir = await fs.root.getDirectoryHandle('a', { create: true });
    await write(dir, 'b', 'content');
    expect(fs.paths()).toEqual(['a/b']);
    fs.write('a/b', utf('tampered'));
    fs.write('a/new', utf('created'));
    fs.write('missing/dir/file', utf('ignored'));
    expect(text(fs.read('a/b'))).toBe('tampered');
    expect(fs.read('a')).toBeUndefined();
    expect(fs.paths()).toEqual(['a/b', 'a/new']);
  });
});
