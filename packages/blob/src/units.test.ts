import { createInjector } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createMemoryLocks } from './locks.js';
import { createMemoryDirectory } from './memory-fs.js';
import { BlobStoreToken, createWorkspaceOpener, memoryBlobStoreUnit, opfsWorkspaceOpenerUnit, WorkspaceOpenerToken } from './units.js';

describe('createWorkspaceOpener', () => {
  it('opens once (single flight) and retries after a failure', async () => {
    const fs = createMemoryDirectory();
    let calls = 0;
    let fail = true;
    const opener = createWorkspaceOpener({
      path: ['instaflow', 'ws_1'],
      lockPrefix: 'ws_1',
      peer: 'p',
      locks: createMemoryLocks().forTab('A'),
      storage: {
        getDirectory: async () => {
          calls += 1;
          if (fail) throw new DOMException('denied', 'SecurityError');
          return fs.root;
        },
      },
    });
    const failed = await opener.open();
    expect(failed.ok ? '' : failed.error.code).toBe('SF-BLOB-004');
    fail = false;
    const [a, b] = await Promise.all([opener.open(), opener.open()]);
    expect(a.ok && b.ok && a.value === b.value).toBe(true);
    expect(calls).toBe(2);
    opener.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.ok && (await a.value.blobs.put(new Uint8Array([1]))).ok).toBe(false);
  });
});

describe('units', () => {
  it('memoryBlobStoreUnit provides a BlobStore', async () => {
    const injector = createInjector({ units: [memoryBlobStoreUnit] });
    const store = await injector.get(BlobStoreToken);
    expect(store.ok && store.value.capabilities.persistent).toBe(false);
    await injector.dispose();
  });

  it('opfsWorkspaceOpenerUnit provides a workspace-scoped opener', async () => {
    const fs = createMemoryDirectory();
    const definition = opfsWorkspaceOpenerUnit({
      path: ['ws'],
      lockPrefix: 'ws',
      peer: 'p',
      locks: createMemoryLocks().forTab('A'),
      storage: { getDirectory: async () => fs.root },
    });
    expect(definition.scope).toBe('workspace');
    const injector = createInjector({ level: 'workspace', units: [definition] });
    const opener = await injector.get(WorkspaceOpenerToken);
    if (!opener.ok) throw new Error(opener.error.code);
    expect((await opener.value.open()).ok).toBe(true);
    await injector.dispose();
  });
});
