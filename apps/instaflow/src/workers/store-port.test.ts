import { createBlobStore, createMemoryObjectStore } from '@staticflux/blob';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createDocumentRepo, createMemoryDocumentStore, type DocumentStore } from '@staticflux/document/v2';
import { runDocumentRepoContract, runDocumentStoreContract } from '@staticflux/testkit';
import { createLink, createPortPair, createProtocolClient } from '@staticflux/worker';
import { describe, expect, it } from 'vitest';
import { remoteBlobs, remoteDocumentStore, serveStudioStore, StudioStoreProtocol } from './store-port.js';

/** A remote store over an in-memory port pair (cloning, like a real port), served from a memory store. */
function remoteStore(store: DocumentStore = createMemoryDocumentStore(), blobs = createBlobStore(createMemoryObjectStore())) {
  const pair = createPortPair();
  serveStudioStore(createLink({ port: pair.a }), { store, blobs });
  const client = createProtocolClient(createLink({ port: pair.b }), StudioStoreProtocol);
  return { store: remoteDocumentStore(client), blobs: remoteBlobs(client), close: () => pair.close() };
}

const runner = { describe, it, expect };
const engine = createLoroEngine();

// The editor's store is the same port as any DocumentStore: the shared suites run through the protocol.
runDocumentStoreContract('studio store port (memory store behind a port)', () => remoteStore().store, runner);
runDocumentRepoContract('reference repo · Loro · studio store port', { store: () => remoteStore().store, repo: (store, options) => createDocumentRepo({ store, engine, ...options }) }, runner);

describe('the store port (B9)', () => {
  it('reads library blobs by reference; transport failures are IF-WRK-005, store errors pass through', async () => {
    const blobs = createBlobStore(createMemoryObjectStore());
    const ref = await blobs.put(new Uint8Array([1, 2, 3]), { mime: 'image/png' });
    if (!ref.ok) throw ref.error;
    const remote = remoteStore(createMemoryDocumentStore(), blobs);
    const read = await remote.blobs.get(ref.value);
    expect(read.ok && [...read.value]).toEqual([1, 2, 3]);
    expect((await remote.blobs.get(ref.value.digest)).ok).toBe(false); // by digest: not on this port
    const missing = await remote.store.getBlob({ digest: 'sha256:00' as never, size: 1 }, new AbortController().signal);
    expect(!missing.ok && missing.error.code.startsWith('SF-DOC')).toBe(true);
    remote.close();
    const after = await remote.store.readHead('as_x', new AbortController().signal);
    expect(!after.ok && after.error.code).toBe('IF-WRK-005');
  });
});
