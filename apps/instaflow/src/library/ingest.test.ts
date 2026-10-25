import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createIngestService, IngestMachine, type MediaProbe } from './ingest.js';
import type { LibraryEntry } from './library-doc.js';
import { ASSET_RECORD_MIME, decodeBlobAssetRecord } from './records.js';
import { decoderMediaProbe } from './thumbnails.js';
import { fakeImageBytes, fakeImageDecoder, fileOf, libraryFixture, nextAssetId, priya, signal, unwrap } from './test-helpers.js';

async function service(extra: { probes?: Parameters<typeof createIngestService>[0]['probes'] } = {}) {
  const fixture = await libraryFixture();
  const listed: LibraryEntry[] = [];
  const ingest = createIngestService({
    library: fixture.library,
    blobs: fixture.blobs,
    probes: extra.probes ?? { image: decoderMediaProbe(fakeImageDecoder()) },
    newAssetId: nextAssetId,
    actor: () => priya,
    now: () => fixture.clock.now,
    onListed: (entry) => listed.push(entry),
  });
  return { ...fixture, ingest, listed };
}

describe('createIngestService', () => {
  it('hashes into the blob store, writes an immutable record and lists the entry with media facts', async () => {
    const { ingest, blobs, library, listed } = await service();
    const bytes = fakeImageBytes(640, 480);
    const result = unwrap(await ingest.ingest(fileOf('night_market.png', 'image/png', bytes), { signal, folder: 'Brand' }));
    expect(result.deduplicated).toBe(false);
    expect(result.provisional).toMatch(/^pv_/);
    expect(ingest.resolve(result.provisional)).toBe(result.entry.asset);
    const { entry } = result;
    expect(entry).toMatchObject({ kind: 'image', title: 'night market', mime: 'image/png', size: bytes.byteLength, folder: 'Brand', media: { width: 640, height: 480 } });
    expect(entry.content?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(unwrap(await blobs.get(entry.content ?? { digest: 'sha256:', size: 0, mime: '' }))).toEqual(bytes);
    const recordRef = entry.record ?? { digest: 'sha256:', size: 0, mime: '' };
    expect(recordRef.mime).toBe(ASSET_RECORD_MIME);
    const record = unwrap(decodeBlobAssetRecord(unwrap(await blobs.get(recordRef)), recordRef.digest));
    expect(record).toMatchObject({ id: entry.asset, kind: 'image', content: entry.content, media: { width: 640, height: 480, alpha: false }, provenance: { action: 'imported', ingredients: [] } });
    expect(record.createdBy).toMatchObject({ kind: 'human', id: priya.id });
    expect(library.entries()).toHaveLength(1);
    expect(listed.map((e) => e.asset)).toEqual([entry.asset]);
    expect(ingest.pending()).toEqual([]);
  });

  it('shows the import under a provisional id with progress while hashing', async () => {
    const { ingest } = await service();
    const seen: string[] = [];
    const bytes = new Uint8Array(64).fill(7);
    bytes.set(fakeImageBytes(2, 2), 0);
    const running = ingest.ingest(fileOf('big.png', 'image/png', bytes, 8), { signal });
    const first = ingest.pending()[0];
    expect(first).toMatchObject({ name: 'big.png', kind: 'image', size: 64 });
    expect(first?.id).toMatch(/^pv_/);
    seen.push(first?.state ?? '');
    await running;
    expect(seen).toEqual(['hashing']);
    expect(ingest.pending()).toEqual([]);
  });

  it('returns the existing entry for the same bytes (dedupe by digest), not a second asset', async () => {
    const { ingest, library, listed } = await service();
    const bytes = fakeImageBytes(4, 4);
    const a = unwrap(await ingest.ingest(fileOf('a.png', 'image/png', bytes), { signal }));
    const b = unwrap(await ingest.ingest(fileOf('copy of a.png', 'image/png', bytes), { signal }));
    expect(b.deduplicated).toBe(true);
    expect(b.entry.asset).toBe(a.entry.asset);
    expect(ingest.resolve(b.provisional)).toBe(a.entry.asset);
    expect(library.entries()).toHaveLength(1);
    expect(listed).toHaveLength(1);
  });

  it('rejects unsupported files before reading them (IF-LIB-001)', async () => {
    const { ingest } = await service();
    let read = false;
    const file = { ...fileOf('notes.txt', 'text/plain', new Uint8Array(3)), stream: () => ((read = true), new ReadableStream()) };
    const result = await ingest.ingest(file, { signal });
    expect(!result.ok && result.error.code).toBe('IF-LIB-001');
    expect(read).toBe(false);
  });

  it('fails with IF-LIB-005 when the probe cannot decode, and lists nothing', async () => {
    const { ingest, library } = await service();
    const result = await ingest.ingest(fileOf('broken.png', 'image/png', Uint8Array.of(1, 2)), { signal });
    expect(!result.ok && result.error.code).toBe('IF-LIB-005');
    expect(library.entries()).toEqual([]);
    expect(ingest.pending()).toEqual([]);
    const wrapped: MediaProbe = { probe: async () => ({ ok: false, error: (await import('./errors.js')).RenditionError() }) };
    const other = await service({ probes: { image: wrapped } });
    const failed = await other.ingest.ingest(fileOf('x.png', 'image/png', fakeImageBytes(1, 1)), { signal });
    expect(!failed.ok && [failed.error.code, (failed.error.cause as { code?: string })?.code]).toEqual(['IF-LIB-005', 'IF-LIB-006']);
  });

  it('lists kinds without a probe without media facts, by extension when the type is empty', async () => {
    const { ingest } = await service({ probes: {} });
    const font = unwrap(await ingest.ingest(fileOf('Brand.woff2', '', Uint8Array.of(1, 2, 3)), { signal }));
    expect(font.entry).toMatchObject({ kind: 'font', mime: 'font/woff2' });
    expect(font.entry.media).toBeUndefined();
  });

  it('is cancellable: an aborted import is SF-CORE-002 and lists nothing', async () => {
    const { ingest, library } = await service();
    const controller = new AbortController();
    controller.abort();
    const result = await ingest.ingest(fileOf('a.png', 'image/png', fakeImageBytes(2, 2)), { signal: controller.signal });
    expect(!result.ok && result.error.code).toBe('SF-CORE-002');
    expect(library.entries()).toEqual([]);
    const late = new AbortController();
    const slow: MediaProbe = {
      probe: async () => {
        late.abort();
        return ok({ width: 1, height: 1 });
      },
    };
    const other = await service({ probes: { image: slow } });
    const cancelled = await other.ingest.ingest(fileOf('b.png', 'image/png', fakeImageBytes(3, 3)), { signal: late.signal });
    expect(!cancelled.ok && cancelled.error.code).toBe('SF-CORE-002');
    expect(other.library.entries()).toEqual([]);
  });

  it('refuses after dispose (IF-LIB-009); the machine has the documented states', async () => {
    const { ingest } = await service();
    ingest.dispose();
    ingest.dispose();
    const result = await ingest.ingest(fileOf('a.png', 'image/png', fakeImageBytes(2, 2)), { signal });
    expect(!result.ok && result.error.code).toBe('IF-LIB-009');
    expect(IngestMachine.states).toEqual(['provisional', 'hashing', 'probing', 'recording', 'listed', 'failed']);
  });
});
