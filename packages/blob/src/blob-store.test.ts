import { createMemorySink, createTelemetry } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { BlobMetrics, createBlobStore, encodeChunkManifest, parseChunkManifest } from './blob-store.js';
import { createMemoryCatalog } from './catalog.js';
import { sha256, utf8 } from './codec.js';
import { createMemoryObjectStore } from './memory.js';
import { CHUNK_MANIFEST_SCHEMA, type ChunkManifest, type Digest } from './types.js';

const small = { whole: 16, chunk: 8 };
const bytes = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

describe('chunk manifests', () => {
  const manifest: ChunkManifest = { schema: CHUNK_MANIFEST_SCHEMA, size: 10, mime: 'video/mp4', chunkSize: 4_194_304, chunks: [`sha256:${'a'.repeat(64)}`] };

  it('encodeChunkManifest is canonical and parseChunkManifest round-trips it', () => {
    const encoded = encodeChunkManifest(manifest);
    expect(new TextDecoder().decode(encoded)).toBe(
      `{"chunkSize":4194304,"chunks":["sha256:${'a'.repeat(64)}"],"mime":"video/mp4","schema":"instaflow.chunks/1","size":10}`,
    );
    expect(parseChunkManifest(encoded)).toEqual({ ok: true, value: manifest });
  });

  it('parseChunkManifest rejects non-JSON and wrong shapes with SF-BLOB-008', () => {
    for (const input of ['nope', '{"schema":"x"}', JSON.stringify({ ...manifest, chunks: ['bad'] })]) {
      const parsed = parseChunkManifest(utf8(input));
      expect(parsed.ok ? '' : parsed.error.code).toBe('SF-BLOB-008');
    }
  });
});

describe('createBlobStore', () => {
  it('chunks by the configured limits (whole up to the limit, fixed chunks above)', async () => {
    const store = createBlobStore(createMemoryObjectStore(), { limits: small });
    expect(unwrap(await store.put(bytes(16))).chunked).toBeUndefined();
    const ref = unwrap(await store.put(bytes(20)));
    expect(ref.chunked).toBe(true);
    const manifest = unwrap(parseChunkManifest(unwrap(await store.get(ref.digest))));
    expect(manifest.chunks).toHaveLength(3);
    expect(unwrap(await store.get(ref, { range: { start: 7, end: 17 } }))).toEqual(bytes(20).slice(7, 17));
  });

  it('records writes and dedupe hits in the catalog (dedupe refreshes `at`)', async () => {
    const catalog = createMemoryCatalog();
    let now = 1000;
    const store = createBlobStore(createMemoryObjectStore(), { catalog, now: () => now });
    const ref = unwrap(await store.put(bytes(10)));
    expect(unwrap(await catalog.get(ref.digest))).toEqual({ digest: ref.digest, size: 10, at: 1000 });
    now = 5000;
    await store.put(bytes(10));
    expect(unwrap(await catalog.get(ref.digest))?.at).toBe(5000);
    await store.delete(ref.digest);
    expect(unwrap(await catalog.get(ref.digest))).toBeUndefined();
  });

  it('reports metrics and a quarantine event through telemetry', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const objects = createMemoryObjectStore();
    const store = createBlobStore(objects, { telemetry });
    const ref = unwrap(await store.put(bytes(10)));
    await store.put(bytes(10));
    objects.corrupt(ref.digest, bytes(10, 2));
    await store.verify(ref.digest);
    const metrics = sink.records.filter((r) => r.type === 'metric').map((r) => (r as { metric: string }).metric);
    expect(metrics).toContain(BlobMetrics.objectsWritten.id);
    expect(metrics).toContain(BlobMetrics.bytesWritten.id);
    expect(metrics).toContain(BlobMetrics.dedupeHits.id);
    expect(metrics).toContain(BlobMetrics.quarantined.id);
    expect(sink.records.some((r) => r.type === 'event' && (r as { name: string }).name === 'blob.quarantined')).toBe(true);
    expect(objects.quarantined()).toEqual([ref.digest]);
  });

  it('verify of a chunked blob quarantines a corrupt chunk', async () => {
    const objects = createMemoryObjectStore();
    const store = createBlobStore(objects, { limits: small });
    const ref = unwrap(await store.put(bytes(40)));
    const manifest = unwrap(parseChunkManifest(unwrap(await store.get(ref.digest))));
    const victim = manifest.chunks[2] as Digest;
    objects.corrupt(victim, bytes(8, 99));
    const verified = await store.verify(ref);
    expect(verified.ok ? '' : verified.error.code).toBe('SF-BLOB-002');
    expect(objects.quarantined()).toEqual([victim]);
  });

  it('a corrupt deflate-raw object read through its ref is quarantined', async () => {
    const objects = createMemoryObjectStore();
    const store = createBlobStore(objects);
    const ref = unwrap(await store.put(utf8('x'.repeat(100)), { encoding: 'deflate-raw' }));
    objects.corrupt(ref.digest, new Uint8Array([0xff, 0xff, 0xff]));
    const read = await store.get(ref);
    expect(read.ok ? '' : read.error.code).toBe('SF-BLOB-002');
  });

  it('stream() of a whole blob and of a missing chunked blob', async () => {
    const store = createBlobStore(createMemoryObjectStore());
    const ref = unwrap(await store.put(bytes(30)));
    const reader = unwrap(store.stream(ref)).getReader();
    expect((await reader.read()).value).toEqual(bytes(30));
    expect((await reader.read()).done).toBe(true);
    const missing = unwrap(store.stream({ digest: await sha256(bytes(3)), size: 3, mime: 'x', chunked: true }));
    await expect(missing.getReader().read()).rejects.toMatchObject({ code: 'SF-BLOB-005' });
  });

  it('putEncoded rejects chunked refs and undecodable bytes', async () => {
    const store = createBlobStore(createMemoryObjectStore());
    const digest = await sha256(bytes(3));
    const chunked = await store.putEncoded(bytes(3), { digest, size: 3, mime: 'x', chunked: true });
    expect(chunked.ok ? '' : chunked.error.code).toBe('SF-BLOB-008');
    const garbage = await store.putEncoded(new Uint8Array([0xff, 0xff]), { digest, size: 3, mime: 'x', encoding: 'deflate-raw' });
    expect(garbage.ok ? '' : garbage.error.code).toBe('SF-BLOB-002');
    expect(unwrap(await store.putEncoded(bytes(3), { digest, size: 3, mime: 'x' })).digest).toBe(digest);
  });

  it('a failing input stream is SF-BLOB-007 and list() after dispose is SF-BLOB-013', async () => {
    const store = createBlobStore(createMemoryObjectStore());
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('network gone'));
      },
    });
    const put = await store.put(broken);
    expect(put.ok ? '' : put.error.code).toBe('SF-BLOB-007');
    store.dispose();
    store.dispose();
    const items = [];
    for await (const item of store.list()) items.push(item);
    expect(items[0]?.ok === false && items[0].error.code).toBe('SF-BLOB-013');
  });
});
