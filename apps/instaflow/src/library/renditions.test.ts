import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { RenditionError } from './errors.js';
import { createIngestService } from './ingest.js';
import { createRenditionQueue, type ImageDecoder, missingRenditions, RENDITION_PRODUCERS, RenditionJobMachine, THUMBNAIL_EDGE, type ThumbnailRenderer } from './renditions.js';
import { decoderMediaProbe, pngImageEncoder, scaleThumbnailRenderer } from './thumbnails.js';
import { fakeImageBytes, fakeImageDecoder, fileOf, libraryFixture, nextAssetId, priya, signal, unwrap } from './test-helpers.js';

async function setup(options: { decoder?: ImageDecoder; renderer?: ThumbnailRenderer; edge?: number } = {}) {
  const fixture = await libraryFixture();
  const decoder = options.decoder ?? fakeImageDecoder();
  const queue = createRenditionQueue({ library: fixture.library, blobs: fixture.blobs, decoder, renderer: options.renderer ?? scaleThumbnailRenderer(), encoder: pngImageEncoder(), ...(options.edge === undefined ? {} : { edge: options.edge }) });
  const ingest = createIngestService({ library: fixture.library, blobs: fixture.blobs, probes: { image: decoderMediaProbe(fakeImageDecoder()) }, newAssetId: nextAssetId, actor: () => priya });
  const add = async (name: string, w: number, h: number, salt = 0) => unwrap(await ingest.ingest(fileOf(name, 'image/png', fakeImageBytes(w, h, [10, 20, 30, 255], salt)), { signal })).entry;
  return { ...fixture, queue, add };
}

describe('missingRenditions', () => {
  it('follows the producer table and skips trashed or content-less entries', () => {
    const base = { asset: 'as_1' as const, title: 't', createdAt: '', folder: '', favorite: false, tags: [], renditions: {}, content: { digest: 'sha256:x' as const, size: 1, mime: 'image/png' } };
    expect(RENDITION_PRODUCERS.image).toEqual(['thumbnail']);
    expect(missingRenditions({ ...base, kind: 'image' })).toEqual(['thumbnail']);
    expect(missingRenditions({ ...base, kind: 'audio' })).toEqual([]);
    expect(missingRenditions({ ...base, kind: 'image', trashedAt: 'x' })).toEqual([]);
    const { content: _content, ...noContent } = base;
    expect(missingRenditions({ ...noContent, kind: 'image' })).toEqual([]);
  });
});

describe('createRenditionQueue', () => {
  it('produces a PNG thumbnail fitted in 256 px and records it in the library document', async () => {
    const { queue, add, library, blobs } = await setup();
    const entry = await add('wide.png', 1024, 512);
    expect(unwrap(queue.request(entry.asset))).toBe(1);
    unwrap(await queue.idle(signal));
    const thumbnail = library.entry(entry.asset)?.renditions.thumbnail;
    expect(thumbnail?.blob.mime).toBe('image/png');
    expect(thumbnail?.params).toEqual({ renderer: 'scale/1', edge: THUMBNAIL_EDGE, source: entry.content?.digest });
    const png = unwrap(await blobs.get(thumbnail?.blob ?? { digest: 'sha256:', size: 0, mime: '' }));
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([256, 128]);
    expect(queue.jobs().map((j) => [j.asset, j.role, j.state])).toEqual([[entry.asset, 'thumbnail', 'done']]);
    expect(unwrap(queue.request(entry.asset))).toBe(0); // nothing missing any more
  });

  it('regenerates idempotently (same params → same blob) and resumes what an earlier session left', async () => {
    const { queue, add, library } = await setup();
    const a = await add('a.png', 300, 300, 1);
    const b = await add('b.png', 40, 30, 2);
    expect(queue.resume()).toBe(2);
    unwrap(await queue.idle(signal));
    const first = library.entry(a.asset)?.renditions.thumbnail?.blob.digest;
    expect(library.entry(b.asset)?.renditions.thumbnail).toBeDefined();
    expect(unwrap(queue.request(a.asset, { force: true }))).toBe(1);
    unwrap(await queue.idle(signal));
    expect(library.entry(a.asset)?.renditions.thumbnail?.blob.digest).toBe(first);
    expect(queue.resume()).toBe(0);
  });

  it('a failing decoder fails the job with IF-LIB-006 and writes nothing', async () => {
    const decoder: ImageDecoder = { decode: async () => err(RenditionError({ message: 'boom' })) };
    const { queue, add, library } = await setup({ decoder });
    const entry = await add('x.png', 8, 8);
    unwrap(queue.request(entry.asset));
    unwrap(await queue.idle(signal));
    const [job] = queue.jobs();
    expect([job?.state, job?.error?.code]).toEqual(['failed', 'IF-LIB-006']);
    expect(library.entry(entry.asset)?.renditions).toEqual({});
    const wrapped = await setup({ decoder: { decode: async () => err(Object.assign(RenditionError(), { code: 'IF-LIB-005' })) } });
    const other = await wrapped.add('y.png', 2, 2);
    unwrap(wrapped.queue.request(other.asset));
    unwrap(await wrapped.queue.idle(signal));
    expect(wrapped.queue.jobs()[0]?.error?.code).toBe('IF-LIB-006');
  });

  it('cancels queued and running jobs; nothing is recorded for them', async () => {
    let release: (() => void) | undefined;
    const renderer: ThumbnailRenderer = {
      id: 'slow/1',
      render: (source, size, s) =>
        new Promise((resolve) => {
          release = () => resolve(s.aborted ? err(RenditionError()) : ok({ width: size.width, height: size.height, data: new Uint8Array(size.width * size.height * 4) }));
        }),
    };
    const { queue, add, library } = await setup({ renderer });
    const a = await add('a.png', 4, 4, 1);
    const b = await add('b.png', 4, 4, 2);
    unwrap(queue.request(a.asset));
    unwrap(queue.request(b.asset));
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.jobs().map((j) => j.state)).toEqual(['rendering', 'queued']);
    queue.cancel(b.asset);
    queue.cancel(a.asset);
    release?.();
    unwrap(await queue.idle(signal));
    expect(queue.jobs().map((j) => j.state)).toEqual(['cancelled', 'cancelled']);
    expect(library.entry(a.asset)?.renditions).toEqual({});
  });

  it('rejects unknown assets, stops on dispose and idles at once when empty', async () => {
    const { queue, add } = await setup();
    const unknown = queue.request('as_nope');
    expect(!unknown.ok && unknown.error.code).toBe('IF-LIB-003');
    unwrap(await queue.idle(signal));
    const entry = await add('a.png', 2, 2);
    queue.dispose();
    queue.dispose();
    const after = queue.request(entry.asset);
    expect(!after.ok && after.error.code).toBe('IF-LIB-009');
    expect(queue.resume()).toBe(0);
    expect(RenditionJobMachine.terminal).toEqual(['done', 'failed', 'cancelled']);
  });

  it('idle() honours its own abort signal', async () => {
    const renderer: ThumbnailRenderer = { id: 'never/1', render: () => new Promise(() => undefined) };
    const { queue, add } = await setup({ renderer });
    const entry = await add('a.png', 2, 2);
    unwrap(queue.request(entry.asset));
    const controller = new AbortController();
    const waiting = queue.idle(controller.signal);
    controller.abort();
    const result = await waiting;
    expect(!result.ok && result.error.code).toBe('SF-CORE-002');
  });
});
