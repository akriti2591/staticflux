import { describe, expect, it } from 'vitest';
import { createMemoryLocks } from './locks.js';
import { createMemoryDirectory } from './memory-fs.js';
import { createWorkspaceStore, detectOpfs, openOpfsDirectory } from './opfs.js';

describe('detectOpfs', () => {
  it('reports what the context supports', () => {
    const support = detectOpfs({ getDirectory: async () => createMemoryDirectory().root });
    expect(support.opfs).toBe(true);
    expect(support.syncAccessHandles).toBe(false);
    expect(typeof support.move).toBe('boolean');
    expect(detectOpfs({}).opfs).toBe(false);
  });
});

describe('openOpfsDirectory', () => {
  it('opens (creating) a nested path below the OPFS root', async () => {
    const fs = createMemoryDirectory();
    const opened = await openOpfsDirectory(['instaflow', 'ws_1'], { getDirectory: async () => fs.root });
    if (!opened.ok) throw new Error(opened.error.code);
    expect(opened.value.name).toBe('ws_1');
    await opened.value.getFileHandle('x', { create: true });
    expect(fs.paths()).toEqual(['instaflow/ws_1/x']);
  });

  it('fails without OPFS or when the root rejects', async () => {
    const missing = await openOpfsDirectory(['a'], {});
    expect(missing.ok ? '' : missing.error.code).toBe('SF-BLOB-009');
    const denied = await openOpfsDirectory(['a'], { getDirectory: () => Promise.reject(new DOMException('no', 'SecurityError')) });
    expect(denied.ok ? '' : denied.error.code).toBe('SF-BLOB-004');
  });
});

describe('createWorkspaceStore', () => {
  it('wires blobs, heads and journals over one directory', async () => {
    const fs = createMemoryDirectory();
    const ws = createWorkspaceStore(fs.root, { lockPrefix: 'ws_1', peer: 'p', locks: createMemoryLocks().forTab('A'), syncAvailable: false });
    if (!ws.ok) throw new Error(ws.error.code);
    expect(ws.value.journalMode).toBe('segments');
    await ws.value.blobs.put(new Uint8Array([1]));
    await ws.value.heads.cas('as_1', 0, {});
    const journal = ws.value.journal('as_1');
    await journal.open(0);
    await journal.append([new Uint8Array([1])]);
    expect(fs.paths().map((p) => p.split('/')[0])).toEqual(['blobs', 'heads', 'log']);
    ws.value.dispose();
    expect((await ws.value.blobs.put(new Uint8Array([2]))).ok).toBe(false);
  });

  it('picks the append journal where sync handles exist, and requires Web Locks', () => {
    const fs = createMemoryDirectory();
    const ws = createWorkspaceStore(fs.root, { lockPrefix: 'ws', peer: 'p', locks: createMemoryLocks().forTab('A'), syncAvailable: true });
    expect(ws.ok && ws.value.journalMode).toBe('append');
    const noLocks = createWorkspaceStore(fs.root, { lockPrefix: 'ws', peer: 'p' });
    expect(noLocks.ok ? '' : noLocks.error.code).toBe('SF-BLOB-009');
  });
});
