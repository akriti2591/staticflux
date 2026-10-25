/**
 * The store port (B9, IF-33.12): the editor module never owns storage (ARCHITECTURE §2: the store worker does; until
 * C0 brings it, main stands in with the in-memory store, the blob store and the library document). The editor reaches
 * the store through `StudioStoreProtocol` on a port of its own: every `DocumentStore` call, and blob reads by
 * reference (image uploads for Place). The same protocol is what the store worker will serve.
 *
 * @example
 * serveStudioStore(createLink({ port: storeSide }), { store, blobs });                          // main (store side)
 * const store = remoteDocumentStore(createProtocolClient(createLink({ port }), StudioStoreProtocol)); // editor
 */
import type { BlobRef as BlobStoreRef, BlobStore } from '@staticflux/blob';
import { err, type Result } from '@staticflux/core';
import type { BlobRef, DocumentHead, DocumentStore, LogEntry } from '@staticflux/document/v2';
import { createProtocolServer, defineProtocol, type Link, type ProtocolClient, type ProtocolServer, request } from '@staticflux/worker';
import { StorePortError } from './errors.js';

export const StudioStoreProtocol = /* @__PURE__ */ defineProtocol({
  id: 'instaflow/studio-store',
  version: 1,
  requests: {
    readHead: request<{ readonly asset: string }, DocumentHead | undefined>({ timeoutMs: 30_000 }),
    writeHead: request<{ readonly asset: string; readonly head: DocumentHead; readonly expected: number | null }, void>({ timeoutMs: 30_000 }),
    putBlob: request<{ readonly bytes: Uint8Array }, BlobRef>({ timeoutMs: 60_000 }),
    getBlob: request<{ readonly ref: BlobRef }, Uint8Array>({ timeoutMs: 60_000 }),
    appendLog: request<{ readonly asset: string; readonly bytes: Uint8Array }, number>({ timeoutMs: 30_000 }),
    readLog: request<{ readonly asset: string; readonly from: number }, readonly LogEntry[]>({ timeoutMs: 30_000 }),
    truncateLog: request<{ readonly asset: string; readonly before: number }, void>({ timeoutMs: 30_000 }),
    /** A content blob of the blob store (library assets) by reference. */
    readContent: request<{ readonly ref: BlobStoreRef }, Uint8Array>({ timeoutMs: 60_000 }),
  },
  events: {},
});

export type StudioStoreClient = ProtocolClient<typeof StudioStoreProtocol>;

/** Serve the store side on `link` (main today, the store worker later). */
export function serveStudioStore(link: Link, sides: { readonly store: DocumentStore; readonly blobs: Pick<BlobStore, 'get'> }): ProtocolServer<typeof StudioStoreProtocol> {
  const { store, blobs } = sides;
  return createProtocolServer(link, StudioStoreProtocol, {
    readHead: ({ asset }, c) => store.readHead(asset, c.signal),
    writeHead: ({ asset, head, expected }, c) => store.writeHead(asset, head, expected, c.signal),
    putBlob: ({ bytes }, c) => store.putBlob(bytes, c.signal),
    getBlob: ({ ref }, c) => store.getBlob(ref, c.signal),
    appendLog: ({ asset, bytes }, c) => store.appendLog(asset, bytes, c.signal),
    readLog: ({ asset, from }, c) => store.readLog(asset, from, c.signal),
    truncateLog: ({ asset, before }, c) => store.truncateLog(asset, before, c.signal),
    readContent: ({ ref }, c) => blobs.get(ref, { signal: c.signal }),
  });
}

/** Transport failures (the link's `SF-WK-*`: closed port, timeout) become IF-WRK-005; store errors pass through. */
const closed = <T>(result: Result<T>): Result<T> => (result.ok || !result.error.code.startsWith('SF-WK') ? result : err(StorePortError({ cause: result.error, details: { cause: result.error.code } })));

/** The editor's `DocumentStore` over the port (store errors pass through; transport failures are IF-WRK-005). */
export function remoteDocumentStore(client: StudioStoreClient): DocumentStore {
  return {
    readHead: async (asset, signal) => closed(await client.request('readHead', { asset }, { signal })),
    writeHead: async (asset, head, expected, signal) => closed(await client.request('writeHead', { asset, head, expected }, { signal })),
    putBlob: async (bytes, signal) => closed(await client.request('putBlob', { bytes }, { signal })),
    getBlob: async (ref, signal) => closed(await client.request('getBlob', { ref }, { signal })),
    appendLog: async (asset, bytes, signal) => closed(await client.request('appendLog', { asset, bytes }, { signal })),
    readLog: async (asset, from, signal) => closed(await client.request('readLog', { asset, from }, { signal })),
    truncateLog: async (asset, before, signal) => closed(await client.request('truncateLog', { asset, before }, { signal })),
  };
}

/** Blob reads for the editor (B4's image uploads read `get(ref)`). */
export function remoteBlobs(client: StudioStoreClient): Pick<BlobStore, 'get'> {
  return {
    async get(target, options) {
      if (typeof target === 'string') return err(StorePortError({ message: 'The store port reads blobs by reference only.', details: { target } }));
      return closed(await client.request('readContent', { ref: target }, { signal: options?.signal }));
    },
  };
}
