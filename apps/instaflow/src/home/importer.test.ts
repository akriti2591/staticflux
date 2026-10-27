import { createBlobStore, createMemoryObjectStore } from '@staticflux/blob';
import { describe, expect, it } from 'vitest';
import { decodeBlobAssetRecord } from '../library/records.js';
import { createHomeImporter, GUEST_ACTOR } from './importer.js';

const signal = (): AbortSignal => new AbortController().signal;

describe('Home importer (HOME-FILES §3.1)', () => {
  it('stores the bytes and the instaflow.asset/1 record (the asset id, the size probe), like Studio’s ingest', async () => {
    const blobs = createBlobStore(createMemoryObjectStore());
    const importer = createHomeImporter({ blobs, actor: GUEST_ACTOR, probe: async () => ({ width: 40, height: 30 }), now: () => Date.parse('2026-10-05T00:00:00.000Z') });
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'Lantern photo.png', { type: 'image/png' });
    const done = await importer.importFile(file, 'as_lamp', signal());
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value).toMatchObject({ asset: 'as_lamp', kind: 'image', title: 'Lantern photo', mime: 'image/png', size: 4, width: 40, height: 30 });
    const bytes = await blobs.get(done.value.content.digest as never, { signal: signal() });
    expect(bytes.ok && [...bytes.value]).toEqual([137, 80, 78, 71]);
    const record = await blobs.get(done.value.record.digest as never, { signal: signal() });
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    const decoded = decodeBlobAssetRecord(record.value, done.value.record.digest as never);
    expect(decoded.ok && decoded.value).toMatchObject({ id: 'as_lamp', kind: 'image', createdAt: '2026-10-05T00:00:00.000Z', media: { width: 40, height: 30 }, provenance: { action: 'imported' } });
  });

  it('fonts are stored without a probe; unsupported files are refused before reading (IF-POL-057)', async () => {
    const blobs = createBlobStore(createMemoryObjectStore());
    let probed = 0;
    const importer = createHomeImporter({ blobs, actor: GUEST_ACTOR, probe: async () => ((probed += 1), undefined) });
    const font = await importer.importFile(new File([new Uint8Array([0, 1, 0, 0])], 'Brand.ttf', { type: '' }), 'as_font', signal());
    expect(font.ok && font.value).toMatchObject({ kind: 'font', mime: 'font/ttf', title: 'Brand' });
    expect(font.ok && 'width' in font.value).toBe(false);
    expect(probed).toBe(0);
    const text = await importer.importFile(new File(['x'], 'notes.txt', { type: 'text/plain' }), 'as_t', signal());
    expect(!text.ok && text.error.code).toBe('IF-POL-057');
  });
});
