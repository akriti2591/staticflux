import { createMemoryStore } from '@staticflux/storage';
import { describe, expect, it } from 'vitest';
import { type BlobCatalog, type CatalogEntry, createMemoryCatalog, createStoreCatalog, rebuildCatalog } from './catalog.js';
import { createMemoryBlobStore } from './memory.js';
import type { Digest } from './types.js';

const d = (n: number): Digest => `sha256:${n.toString(16).padStart(64, '0')}`;

async function all(catalog: BlobCatalog): Promise<CatalogEntry[]> {
  const out: CatalogEntry[] = [];
  for await (const entry of catalog.entries()) if (entry.ok) out.push(entry.value);
  return out.sort((a, b) => (a.digest < b.digest ? -1 : 1));
}

const catalogs: [string, () => BlobCatalog][] = [
  ['memory', () => createMemoryCatalog()],
  ['store (AsyncStore)', () => createStoreCatalog(createMemoryStore() as never)],
];

describe.each(catalogs)('%s catalog', (_name, make) => {
  it('records, upserts keeping the later `at`, gets, counts, forgets and clears', async () => {
    const catalog = make();
    await catalog.record([
      { digest: d(1), size: 10, at: 100 },
      { digest: d(2), size: 20, at: 200 },
    ]);
    await catalog.record([{ digest: d(1), size: 10, at: 50 }]);
    expect((await catalog.get(d(1))).ok && (await catalog.get(d(1)))).toEqual({ ok: true, value: { digest: d(1), size: 10, at: 100 } });
    await catalog.record([{ digest: d(1), size: 10, at: 300 }]);
    expect(await all(catalog)).toEqual([
      { digest: d(1), size: 10, at: 300 },
      { digest: d(2), size: 20, at: 200 },
    ]);
    expect(await catalog.count()).toEqual({ ok: true, value: 2 });
    await catalog.forget([d(2)]);
    expect(await catalog.get(d(2))).toEqual({ ok: true, value: undefined });
    await catalog.clear();
    expect(await catalog.count()).toEqual({ ok: true, value: 0 });
  });

  it('entries stops with SF-BLOB-006 when aborted', async () => {
    const catalog = make();
    await catalog.record([{ digest: d(1), size: 1, at: 1 }]);
    const controller = new AbortController();
    controller.abort();
    const results = [];
    for await (const entry of catalog.entries(controller.signal)) results.push(entry);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok === false && results[0].error.code).toBe('SF-BLOB-006');
  });
});

describe('createMemoryCatalog', () => {
  it('exposes its size', async () => {
    const catalog = createMemoryCatalog();
    await catalog.record([{ digest: d(9), size: 1, at: 1 }]);
    expect(catalog.size).toBe(1);
  });
});

describe('rebuildCatalog', () => {
  it('adds listed objects with the rebuild time, keeps known entries and removes stale ones', async () => {
    const blobs = createMemoryBlobStore();
    const a = await blobs.put(new Uint8Array([1]));
    const b = await blobs.put(new Uint8Array([2]));
    if (!a.ok || !b.ok) throw new Error('put failed');
    const catalog = createMemoryCatalog();
    await catalog.record([
      { digest: a.value.digest, size: 1, at: 5 },
      { digest: d(77), size: 1, at: 5 },
    ]);
    const report = await rebuildCatalog(blobs, catalog, { now: () => 1000, batch: 1 });
    expect(report).toEqual({ ok: true, value: { listed: 2, added: 1, removed: 1 } });
    const entries = await all(catalog);
    expect(entries.find((e) => e.digest === a.value.digest)?.at).toBe(5);
    expect(entries.find((e) => e.digest === b.value.digest)?.at).toBe(1000);
    expect(entries.some((e) => e.digest === d(77))).toBe(false);
  });

  it('fails when listing fails', async () => {
    const failing = {
      async *list() {
        yield { ok: false as const, error: (await import('./errors.js')).BlobIoError() };
      },
    };
    const report = await rebuildCatalog(failing, createMemoryCatalog());
    expect(report.ok ? '' : report.error.code).toBe('SF-BLOB-007');
  });
});
