/**
 * Test helpers for the library (not built: excluded by name in tsconfig.json): a library document on
 * the Loro engine over a memory document store, a memory blob store, File-like inputs, a fake image
 * format with a decoder for it, and actors.
 */
import { type BlobStore, createMemoryBlobStore } from '@staticflux/blob';
import { err, ok, type Result } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { createDocumentRepo, createMemoryDocumentStore, type DocumentRepo, type PeerId } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import type { RasterImage } from '@staticflux/surface/image';
import { MediaDecodeError } from './errors.js';
import { createIngestService, type IngestFile } from './ingest.js';
import type { LibraryEntry } from './library-doc.js';
import { createLibraryPanelModel, type LibraryHost } from './panel-model.js';
import { createRenditionQueue } from './renditions.js';
import { decoderMediaProbe, pngImageEncoder, scaleThumbnailRenderer } from './thumbnails.js';
import { createLibrary, type Library } from './library.js';
import { type LibraryDocument, openLibraryDocument } from './library-doc.js';
import type { AssetId } from './records.js';
import type { ImageDecoder } from './renditions.js';

export const signal: AbortSignal = new AbortController().signal;
export const priya: Actor = { kind: 'human', id: 'guest-priya', displayName: 'Priya', via: 'direct' };

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

let peerSeq = 5000;
export function libraryRepo(): DocumentRepo {
  return createDocumentRepo({ store: createMemoryDocumentStore(), engine: createLoroEngine(), peer: () => `${(peerSeq += 1)}` as PeerId, compactAfterBytes: Number.POSITIVE_INFINITY });
}

export interface LibraryFixture {
  readonly repo: DocumentRepo;
  readonly document: LibraryDocument;
  readonly library: Library;
  readonly blobs: BlobStore;
  readonly clock: { now: number };
}

export async function libraryFixture(): Promise<LibraryFixture> {
  const repo = libraryRepo();
  const document = unwrap(await openLibraryDocument(repo, signal));
  const clock = { now: Date.parse('2026-10-25T09:00:00.000Z') };
  const library = createLibrary({ source: { part: document.part, commit: (meta, changes) => document.doc.commit(meta, changes) }, actor: () => priya, now: () => clock.now });
  return { repo, document, library, blobs: createMemoryBlobStore(), clock };
}

let assetSeq = 0;
export const nextAssetId = (): AssetId => `as_test${(assetSeq += 1).toString().padStart(4, '0')}`;

/** A File-like input over bytes (streamed in `chunk`-byte pieces). */
export function fileOf(name: string, type: string, bytes: Uint8Array, chunk = 7): IngestFile {
  return {
    name,
    type,
    size: bytes.byteLength,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.byteLength; at += chunk) controller.enqueue(bytes.slice(at, at + chunk));
          controller.close();
        },
      }),
  };
}

/**
 * A fake image format: `[w lo, w hi, h lo, h hi, r, g, b, a, …]`. `fakeImageDecoder` decodes it to a
 * solid `w × h` image of that colour; anything shorter than 8 bytes is IF-LIB-005.
 */
export function fakeImageBytes(width: number, height: number, rgba: readonly [number, number, number, number] = [255, 92, 57, 255], salt = 0): Uint8Array {
  return Uint8Array.of(width & 0xff, width >> 8, height & 0xff, height >> 8, ...rgba, salt);
}

export function fakeImageDecoder(calls: string[] = []): ImageDecoder {
  return {
    async decode(bytes, mime, s): Promise<Result<RasterImage>> {
      calls.push(mime);
      if (s.aborted) return err(MediaDecodeError({ message: 'aborted' }));
      if (bytes.byteLength < 8) return err(MediaDecodeError({ details: { mime } }));
      const width = (bytes[0] as number) | ((bytes[1] as number) << 8);
      const height = (bytes[2] as number) | ((bytes[3] as number) << 8);
      const data = new Uint8Array(width * height * 4);
      for (let i = 0; i < data.length; i += 4) data.set(bytes.subarray(4, 8), i);
      return ok({ width, height, data });
    },
  };
}

/** A panel model over a fresh library, a host that records placements, fake object URLs and a rendition queue. */
export async function panelModelFixture(files: readonly IngestFile[] = []) {
  const fixture = await libraryFixture();
  const placed: LibraryEntry[] = [];
  const host: LibraryHost = { pickFiles: async () => ok(files), place: async (entry) => (placed.push(entry), ok()) };
  const renditions = createRenditionQueue({ library: fixture.library, blobs: fixture.blobs, decoder: fakeImageDecoder(), renderer: scaleThumbnailRenderer(), encoder: pngImageEncoder() });
  const ingest = createIngestService({ library: fixture.library, blobs: fixture.blobs, probes: { image: decoderMediaProbe(fakeImageDecoder()) }, newAssetId: nextAssetId, actor: () => priya, onListed: (e) => void renditions.request(e.asset) });
  const urls = { created: [] as string[], revoked: [] as string[] };
  const lifetime = new AbortController();
  const model = createLibraryPanelModel({
    library: fixture.library,
    ingest,
    blobs: fixture.blobs,
    host,
    urls: { create: (_b, mime) => (urls.created.push(mime), `blob:${urls.created.length}`), revoke: (u) => urls.revoked.push(u) },
    signal: lifetime.signal,
  });
  return { ...fixture, model, placed, urls, lifetime, renditions, ingest };
}
