import { describe, expect, it } from 'vitest';
import { HeadConflictError } from './errors.js';
import { createMemoryDocumentStore } from './store.js';

// The full port behaviour is covered by `runDocumentStoreContract` (testkit). These are the memory store's extras.
describe('createMemoryDocumentStore', () => {
  const signal = new AbortController().signal;

  it('reports stats', async () => {
    const store = createMemoryDocumentStore();
    await store.writeHead('as_1', { asset: 'as_1', generation: 1, engine: 'e', treeSchema: 1, parts: {}, logFrom: 1, undoHorizon: 200 }, null, signal);
    await store.putBlob(new Uint8Array([1, 2]), signal);
    await store.putBlob(new Uint8Array([1, 2]), signal);
    await store.appendLog('as_1', new Uint8Array([3]), signal);
    expect(store.stats()).toEqual({ heads: 1, blobs: 1, blobBytes: 2, logEntries: 1 });
  });

  it('injects one fault per failNext', async () => {
    const store = createMemoryDocumentStore();
    store.failNext('appendLog', HeadConflictError());
    const failed = await store.appendLog('as_1', new Uint8Array([1]), signal);
    expect(failed.ok ? '' : failed.error.code).toBe('SF-DOC-011');
    const next = await store.appendLog('as_1', new Uint8Array([1]), signal);
    expect(next.ok && next.value).toBe(1);
  });
});
