import { describe, expect, it } from 'vitest';
import { MilestoneDataError } from './errors.js';
import { createPartCapture, UNCAPTURED_PARTS } from './parts.js';
import { createCountingStore, editPages, pagePart, registry, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';

describe('createPartCapture', () => {
  it('encodes every part once, then only parts whose frontier moved; known digests are never written', async () => {
    const store = createCountingStore();
    const doc = await seedDocument(repoOn(store), 'as_1', 3);
    const capture = createPartCapture({ store, registry });
    const first = unwrap(await capture.capture(doc, signal));
    expect([...first.encoded].sort()).toEqual(['page:p0', 'page:p1', 'page:p2', 'root']);
    expect(first.written).toHaveLength(4);
    expect(first.references).toEqual([{ ref: { asset: 'as_bg_lamps' }, where: 3 }]);

    const again = unwrap(await capture.capture(doc, signal));
    expect(again.encoded).toEqual([]);
    expect(again.written).toEqual([]);
    expect(again.parts).toEqual(first.parts);
    expect(again.references).toEqual(first.references);

    await editPages(doc, [1], 9);
    const third = unwrap(await capture.capture(doc, signal));
    expect(third.encoded).toEqual([pagePart(1)]);
    expect(third.written).toEqual([pagePart(1)]);
    expect(third.bytesWritten).toBe(third.parts[pagePart(1)]?.size);

    // A fresh capture (no cache) re-encodes, but known digests are not written again.
    store.reset();
    const fresh = unwrap(await createPartCapture({ store, registry }).capture(doc, signal, { known: new Set(Object.values(third.parts).map((r) => r.digest)) }));
    expect(fresh.encoded).toHaveLength(4);
    expect(fresh.written).toEqual([]);
    expect(store.counts().puts).toBe(0);
  });

  it('skips the comments part and forgets an asset’s cache', async () => {
    const store = createCountingStore();
    const doc = await seedDocument(repoOn(store), 'as_1', 1);
    unwrap(doc.createPart('comments'));
    const capture = createPartCapture({ store });
    expect(UNCAPTURED_PARTS).toContain('comments');
    const first = unwrap(await capture.capture(doc, signal));
    expect(Object.keys(first.parts)).not.toContain('comments');
    capture.forget('as_1');
    expect(unwrap(await capture.capture(doc, signal)).encoded).toHaveLength(2);
  });

  it('returns store errors as values', async () => {
    const store = createCountingStore();
    const doc = await seedDocument(repoOn(store), 'as_1', 1);
    store.inner.failNext('putBlob', MilestoneDataError({ message: 'quota' }));
    expect(await createPartCapture({ store }).capture(doc, signal)).toMatchObject({ ok: false, error: { message: 'quota' } });
  });
});
