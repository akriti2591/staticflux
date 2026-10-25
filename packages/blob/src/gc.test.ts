import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createBlobStore } from './blob-store.js';
import { createMemoryCatalog } from './catalog.js';
import { BlobIoError } from './errors.js';
import { collectBlobRefs, collectGarbage, createGcRoots, DEFAULT_GC_GRACE_MS, headRootSource, staticRootSource } from './gc.js';
import { createHeadStore } from './heads.js';
import { createMemoryLocks } from './locks.js';
import { createMemoryDirectory } from './memory-fs.js';
import { createMemoryObjectStore } from './memory.js';
import type { BlobRef } from './types.js';

const DAY = 24 * 60 * 60 * 1000;
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

function setup(now: { t: number }) {
  const catalog = createMemoryCatalog();
  const blobs = createBlobStore(createMemoryObjectStore(), { catalog, now: () => now.t, limits: { whole: 16, chunk: 8 } });
  return { catalog, blobs };
}

describe('roots', () => {
  it('createGcRoots registers and removes sources', () => {
    const roots = createGcRoots();
    const source = staticRootSource([]);
    const remove = roots.add('heads', source);
    roots.add('other', staticRootSource([]));
    expect(roots.sources.map(([id]) => id)).toEqual(['heads', 'other']);
    remove();
    remove();
    expect(roots.sources.map(([id]) => id)).toEqual(['other']);
  });

  it('collectBlobRefs finds every BlobRef in nested JSON', () => {
    const ref: BlobRef = { digest: `sha256:${'1'.repeat(64)}`, size: 1, mime: 'x' };
    const other: BlobRef = { digest: `sha256:${'2'.repeat(64)}`, size: 2, mime: 'y', chunked: true };
    expect(collectBlobRefs({ parts: { root: ref, list: [other, { digest: 'nope', size: 1, mime: 'z' }] }, n: 1 })).toEqual([ref, other]);
  });

  it('headRootSource yields the refs of every head and fails on a torn head', async () => {
    const fs = createMemoryDirectory();
    const heads = createHeadStore(fs.root, { locks: createMemoryLocks().forTab('A'), lockPrefix: 'ws' });
    const ref: BlobRef = { digest: `sha256:${'3'.repeat(64)}`, size: 3, mime: 'x' };
    await heads.cas('as_1', 0, { parts: { root: ref } });
    const items = [];
    for await (const item of headRootSource(heads)(undefined)) items.push(item);
    expect(items).toEqual([{ ok: true, value: ref }]);
    fs.write('heads/as_1.json', new Uint8Array([1, 2]));
    const torn = [];
    for await (const item of headRootSource(heads)(undefined)) torn.push(item);
    expect(torn[0]?.ok === false && torn[0].error.code).toBe('SF-BLOB-010');
  });
});

describe('collectGarbage', () => {
  it('sweeps unmarked objects older than the grace period, from the catalog only', async () => {
    const clock = { t: 0 };
    const { catalog, blobs } = setup(clock);
    const live = unwrap(await blobs.put(new Uint8Array([1])));
    const chunked = unwrap(await blobs.put(new Uint8Array(20).fill(7)));
    const garbage = unwrap(await blobs.put(new Uint8Array([2])));
    clock.t = 40 * DAY;
    const young = unwrap(await blobs.put(new Uint8Array([3])));
    const report = unwrap(await collectGarbage({ blobs, catalog, roots: [staticRootSource([live, chunked])], now: () => clock.t }));
    // The constant 20-byte blob has chunks [8, 8, 4] of which the first two are identical: 2 chunk objects + manifest.
    expect(report).toEqual({ marked: 4, scanned: 6, kept: 4, young: 1, deleted: 1, missing: 0, dryRun: false });
    expect(unwrap(await blobs.has(garbage.digest))).toBe(false);
    expect(unwrap(await blobs.has(young.digest))).toBe(true);
    expect(unwrap(await blobs.get(chunked))).toEqual(new Uint8Array(20).fill(7));
    expect(unwrap(await catalog.get(garbage.digest))).toBeUndefined();
    expect(DEFAULT_GC_GRACE_MS).toBe(30 * DAY);
  });

  it('reuse inside the grace period protects an object (dedupe refreshes the catalog time)', async () => {
    const clock = { t: 0 };
    const { catalog, blobs } = setup(clock);
    const ref = unwrap(await blobs.put(new Uint8Array([9])));
    clock.t = 40 * DAY;
    await blobs.put(new Uint8Array([9]));
    const report = unwrap(await collectGarbage({ blobs, catalog, roots: createGcRoots(), now: () => clock.t }));
    expect(report.deleted).toBe(0);
    expect(unwrap(await blobs.has(ref.digest))).toBe(true);
  });

  it('dry runs delete nothing; a failing root aborts before any sweep', async () => {
    const clock = { t: 0 };
    const { catalog, blobs } = setup(clock);
    const ref = unwrap(await blobs.put(new Uint8Array([4])));
    clock.t = 100 * DAY;
    const dry = unwrap(await collectGarbage({ blobs, catalog, roots: [], now: () => clock.t, dryRun: true }));
    expect(dry).toMatchObject({ deleted: 0, dryRun: true, scanned: 1 });
    const failing = async function* () {
      yield ok(ref.digest);
      yield err(BlobIoError());
    };
    const aborted = await collectGarbage({ blobs, catalog, roots: [failing], now: () => clock.t });
    expect(aborted.ok ? '' : aborted.error.code).toBe('SF-BLOB-007');
    expect(unwrap(await blobs.has(ref.digest))).toBe(true);
  });

  it('counts marked digests missing from the store; stops on abort', async () => {
    const clock = { t: 0 };
    const { catalog, blobs } = setup(clock);
    const ghost = `sha256:${'f'.repeat(64)}` as const;
    const ghostChunked: BlobRef = { digest: `sha256:${'e'.repeat(64)}`, size: 30, mime: 'x', chunked: true };
    const report = unwrap(await collectGarbage({ blobs, catalog, roots: [staticRootSource([ghost, ghostChunked])], now: () => clock.t }));
    expect(report.missing).toBe(2);
    const controller = new AbortController();
    controller.abort();
    const stopped = await collectGarbage({ blobs, catalog, roots: [staticRootSource([ghost])], signal: controller.signal });
    expect(stopped.ok ? '' : stopped.error.code).toBe('SF-BLOB-006');
  });

  it('re-checks the catalog right before deleting (a put during the sweep wins)', async () => {
    const clock = { t: 0 };
    const { catalog, blobs } = setup(clock);
    const ref = unwrap(await blobs.put(new Uint8Array([5])));
    clock.t = 100 * DAY;
    const racing = {
      ...catalog,
      async *entries(signal?: AbortSignal) {
        yield* catalog.entries(signal);
        await catalog.record([{ digest: ref.digest, size: 1, at: clock.t }]);
      },
    };
    const report = unwrap(await collectGarbage({ blobs, catalog: racing, roots: [], now: () => clock.t }));
    expect(report).toMatchObject({ deleted: 0, young: 1 });
  });
});
