import { describe, expect, it } from 'vitest';
import { createBlobStore } from './blob-store.js';
import { crc32, deflateRaw, fromUtf8, utf8 } from './codec.js';
import { createMemoryBlobStore, createMemoryObjectStore } from './memory.js';
import {
  addBlobToZip,
  type BlobLike,
  checkBundleMimetype,
  createArraySink,
  createZipWriter,
  importZipBlob,
  openZip,
  writeBundleMimetype,
  ZIP_DEFLATE,
  ZIP_STORED,
} from './zip.js';

const MIME = 'application/vnd.instaflow.bundle+zip';
const asFile = (bytes: Uint8Array): BlobLike => new Blob([bytes.slice()]);
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

async function build(fn: (zip: ReturnType<typeof createZipWriter>) => Promise<void>): Promise<Uint8Array> {
  const sink = createArraySink();
  const zip = createZipWriter(sink, { modified: new Date(Date.UTC(2026, 9, 25, 12, 30, 10)) });
  await fn(zip);
  unwrap(await zip.finish());
  return sink.bytes();
}

describe('zip writer and reader', () => {
  it('round-trips STORED and DEFLATE entries through the central directory', async () => {
    const bytes = await build(async (zip) => {
      unwrap(await writeBundleMimetype(zip, MIME));
      unwrap(await zip.addCompressed('manifest.json', utf8('{"format":"instaflow.bundle/1"}'.repeat(10))));
      unwrap(await zip.addStored('media/clip.bin', new Uint8Array([1, 2, 3, 4, 5])));
      expect(zip.entries.map((e) => e.name)).toEqual(['mimetype', 'manifest.json', 'media/clip.bin']);
    });
    const reader = unwrap(await openZip(asFile(bytes)));
    expect(reader.entries.map((e) => [e.name, e.method])).toEqual([
      ['mimetype', ZIP_STORED],
      ['manifest.json', ZIP_DEFLATE],
      ['media/clip.bin', ZIP_STORED],
    ]);
    unwrap(await checkBundleMimetype(reader, MIME));
    const manifest = reader.entry('manifest.json');
    if (manifest === undefined) throw new Error('missing entry');
    expect(fromUtf8(unwrap(await reader.read(manifest)))).toBe('{"format":"instaflow.bundle/1"}'.repeat(10));
    const clip = reader.entry('media/clip.bin');
    if (clip === undefined) throw new Error('missing entry');
    expect(unwrap(await reader.readRange(clip, { start: 1, end: 4 }))).toEqual(new Uint8Array([2, 3, 4]));
    // mimetype bytes sit at a fixed offset (OCF): local header (30) + name (8).
    expect(fromUtf8(bytes.subarray(38, 38 + MIME.length))).toBe(MIME);
  });

  it('addDeflated copies an existing deflate-raw payload byte for byte (no recompression)', async () => {
    const content = utf8('part data '.repeat(300));
    const deflated = await deflateRaw(content);
    const bytes = await build(async (zip) => {
      unwrap(await zip.addDeflated('blobs/sha256/x', deflated, { crc: crc32(content), size: content.length }));
    });
    const reader = unwrap(await openZip(asFile(bytes)));
    const entry = reader.entries[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(unwrap(await reader.readStored(entry))).toEqual(deflated);
    expect(unwrap(await reader.read(entry))).toEqual(content);
  });

  it('streams STORED parts and rejects parts that do not match the declared size/CRC', async () => {
    const parts = [utf8('ab'), utf8('cd')];
    const iterate = async function* (items: Uint8Array[]) {
      for (const item of items) yield { ok: true as const, value: item };
    };
    const bytes = await build(async (zip) => {
      unwrap(await zip.addStoredParts('big', { crc: crc32(utf8('abcd')), size: 4 }, iterate(parts)));
      const wrong = await zip.addStoredParts('bad', { crc: 1, size: 4 }, iterate(parts));
      expect(wrong.ok ? '' : wrong.error.code).toBe('SF-BLOB-011');
    });
    const reader = unwrap(await openZip(asFile(bytes)));
    const big = reader.entry('big');
    if (big === undefined) throw new Error('missing entry');
    expect(fromUtf8(unwrap(await reader.read(big)))).toBe('abcd');
  });

  it('validates names, duplicates, a finished writer and range reads', async () => {
    const zip = createZipWriter(createArraySink());
    for (const bad of ['', '/abs', 'a\\b', '../up']) expect(((await zip.addStored(bad, new Uint8Array())) as { error: { code: string } }).error.code).toBe('SF-BLOB-008');
    unwrap(await zip.addStored('a', utf8('x')));
    expect(((await zip.addStored('a', utf8('y'))) as { error: { code: string } }).error.code).toBe('SF-BLOB-008');
    const mimetypeLate = await writeBundleMimetype(zip, MIME);
    expect(mimetypeLate.ok ? '' : mimetypeLate.error.code).toBe('SF-BLOB-008');
    unwrap(await zip.finish());
    expect(((await zip.finish()) as { error: { code: string } }).error.code).toBe('SF-BLOB-008');
    expect(((await zip.addStored('b', utf8('z'))) as { error: { code: string } }).error.code).toBe('SF-BLOB-008');
    const bytes = await build(async (w) => void (await w.addCompressed('d', utf8('deflated'))));
    const reader = unwrap(await openZip(asFile(bytes)));
    const entry = reader.entries[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(((await reader.readRange(entry, { start: 0, end: 1 })) as { error: { code: string } }).error.code).toBe('SF-BLOB-008');
  });

  it('detects non-zips, truncation, CRC damage, a wrong mimetype, encryption and zip64', async () => {
    const notZip = await openZip(asFile(utf8('just some text, definitely not a zip archive')));
    expect(notZip.ok ? '' : notZip.error.code).toBe('SF-BLOB-011');
    expect(((await openZip(asFile(new Uint8Array(3)))) as { error: { code: string } }).error.code).toBe('SF-BLOB-011');
    const good = await build(async (zip) => {
      await writeBundleMimetype(zip, 'application/other');
      await zip.addStored('x', utf8('payload'));
    });
    const truncated = await openZip(asFile(good.subarray(0, good.length - 30)));
    expect(truncated.ok ? '' : truncated.error.code).toBe('SF-BLOB-011');
    const reader = unwrap(await openZip(asFile(good)));
    const wrongType = await checkBundleMimetype(reader, MIME);
    expect(wrongType.ok ? '' : (wrongType.error.details as { reason: string }).reason).toBe('mimetype');
    const damaged = good.slice();
    const at = fromUtf8(damaged).indexOf('payload');
    damaged[at] = 0x50;
    const damagedReader = unwrap(await openZip(asFile(damaged)));
    const entry = damagedReader.entry('x');
    if (entry === undefined) throw new Error('missing entry');
    const crc = await damagedReader.read(entry);
    expect(crc.ok ? '' : (crc.error.details as { reason: string }).reason).toBe('crc');
    const cdAt = good.length - 22 - (46 + 1) ;
    const encrypted = good.slice();
    new DataView(encrypted.buffer).setUint16(cdAt + 8, 0x0801, true);
    expect(((await openZip(asFile(encrypted))) as { error: { code: string } }).error.code).toBe('SF-BLOB-012');
    const zip64 = good.slice();
    new DataView(zip64.buffer).setUint32(zip64.length - 22 + 16, 0xffffffff, true);
    expect(((await openZip(asFile(zip64))) as { error: { code: string } }).error.code).toBe('SF-BLOB-012');
    const noMimetype = unwrap(await openZip(asFile(await build(async (z) => void (await z.addStored('a', utf8('b')))))));
    expect(((await checkBundleMimetype(noMimetype, MIME)) as { error: { code: string } }).error.code).toBe('SF-BLOB-011');
  });
});

describe('blobs in bundles', () => {
  it('addBlobToZip copies deflate-raw blobs as stored, plain and chunked blobs as STORED; importZipBlob adopts them', async () => {
    const objects = createMemoryObjectStore();
    const source = createBlobStore(objects);
    const chunker = createBlobStore(objects, { limits: { whole: 16, chunk: 8 } });
    const part = unwrap(await source.put(utf8('{"nodes":[]}'.repeat(40)), { encoding: 'deflate-raw', mime: 'application/json' }));
    const media = unwrap(await source.put(new Uint8Array([9, 8, 7]), { mime: 'image/png' }));
    const big = unwrap(await chunker.put(Uint8Array.from({ length: 30 }, (_, i) => i), { mime: 'video/mp4' }));
    expect(big.chunked).toBe(true);
    const bytes = await build(async (zip) => {
      unwrap(await addBlobToZip(zip, source, part, 'blobs/part'));
      unwrap(await addBlobToZip(zip, source, media, 'blobs/media'));
      unwrap(await addBlobToZip(zip, source, big, 'blobs/big'));
    });
    const reader = unwrap(await openZip(asFile(bytes)));
    const [partEntry, mediaEntry, bigEntry] = reader.entries;
    if (partEntry === undefined || mediaEntry === undefined || bigEntry === undefined) throw new Error('entries');
    expect(partEntry.method).toBe(ZIP_DEFLATE);
    expect(unwrap(await reader.readStored(partEntry))).toEqual(unwrap(await source.get(part.digest)));
    expect(bigEntry.method).toBe(ZIP_STORED);
    expect(unwrap(await reader.read(bigEntry))).toEqual(unwrap(await source.get(big)));

    const target = createMemoryBlobStore();
    expect(unwrap(await importZipBlob(reader, partEntry, target, part))).toEqual(part);
    expect(unwrap(await target.get(part.digest))).toEqual(unwrap(await reader.readStored(partEntry)));
    expect(unwrap(await importZipBlob(reader, partEntry, target, part))).toEqual(part);
    expect(unwrap(await importZipBlob(reader, mediaEntry, target, media))).toEqual(media);
    const mislabeled = await importZipBlob(reader, mediaEntry, createMemoryBlobStore(), { digest: part.digest, size: part.size, mime: part.mime });
    expect(mislabeled.ok ? '' : mislabeled.error.code).toBe('SF-BLOB-011');
  });

  it('addBlobToZip refuses a blob that does not match its digest', async () => {
    const objects = createMemoryObjectStore();
    const store = createBlobStore(objects);
    const ref = unwrap(await store.put(utf8('x'.repeat(50)), { encoding: 'deflate-raw' }));
    objects.corrupt(ref.digest, await deflateRaw(utf8('y'.repeat(50))));
    const zip = createZipWriter(createArraySink());
    const added = await addBlobToZip(zip, store, ref, 'p');
    expect(added.ok ? '' : (added.error.details as { reason: string }).reason).toBe('digest');
    objects.corrupt(ref.digest, new Uint8Array([0xff, 0xff]));
    const inflate = await addBlobToZip(zip, store, ref, 'q');
    expect(inflate.ok ? '' : (inflate.error.details as { reason: string }).reason).toBe('inflate');
  });
});
