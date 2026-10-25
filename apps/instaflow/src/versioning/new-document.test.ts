import { describe, expect, it } from 'vitest';
import { AssetExistsError } from './errors.js';
import { readVersioningState } from './head-state.js';
import { createMilestoneService } from './milestones.js';
import { createDocumentFromMilestone } from './new-document.js';
import { createPartCapture } from './parts.js';
import { decodeAssetRecord, digestOfId } from './records.js';
import { createCountingStore, editPages, engine, pagePart, priya, registry, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';

async function setup() {
  const store = createCountingStore();
  const repo = repoOn(store);
  const source = await seedDocument(repo, 'as_source', 3);
  const milestones = createMilestoneService({ doc: source, store, capture: createPartCapture({ store, registry }), registry });
  const created = unwrap(await milestones.create({ name: 'Client v2', actor: priya }, signal));
  return { store, repo, source, milestones, created };
}

describe('createDocumentFromMilestone', () => {
  it('creates a new asset with a fresh baseline and an informational createdFrom label', async () => {
    const { store, created } = await setup();
    const made = unwrap(
      await createDocumentFromMilestone({ store, engine, registry, now: () => Date.UTC(2026, 9, 25) }, { asset: 'as_copy', actor: priya, source: { milestone: created.entry.id, record: created.record, title: 'Flyer · Client v2' } }, signal),
    );
    expect(made.head).toMatchObject({ asset: 'as_copy', generation: 1, logFrom: 1, engine: engine.id, undoHorizon: 200 });
    expect(Object.keys(made.head.parts).sort()).toEqual(Object.keys(created.record.parts).sort());
    expect(made.record).toMatchObject({
      schema: 'instaflow.asset/1',
      id: 'as_copy',
      kind: 'composition',
      createdAt: '2026-10-25T00:00:00.000Z',
      provenance: { action: 'derived', ingredients: [] },
      createdFrom: { asset: 'as_source', milestone: created.entry.id, title: 'Flyer · Client v2' },
    });
    const state = readVersioningState(made.head);
    expect(state.milestones).toEqual([]);
    expect(state.record).toEqual(made.recordRef);
    expect(unwrap(decodeAssetRecord(unwrap(await store.getBlob(made.recordRef, signal)), made.recordRef.digest))).toEqual(made.record);
  });

  it('detached baseline: edits on the new document never touch the source, and the copy outlives the source', async () => {
    const { store, source, created } = await setup();
    const sourceHeadBefore = unwrap(await store.readHead('as_source', signal));
    const made = unwrap(await createDocumentFromMilestone({ store, engine, registry }, { asset: 'as_copy', actor: priya, source: { milestone: created.entry.id, record: created.record, title: 'Copy' } }, signal));

    // No structural link: the new head names none of the source's objects.
    const sourceDigests = new Set([
      ...Object.values(sourceHeadBefore?.parts ?? {}).map((r) => r.digest),
      ...Object.values(created.record.parts).map((r) => r.digest),
      digestOfId(created.entry.id),
    ]);
    for (const ref of Object.values(made.head.parts)) expect(sourceDigests.has(ref.digest)).toBe(false);

    // "Delete" the source: every read of its objects fails from now on.
    store.forbid(sourceDigests);
    const copy = unwrap(await repoOn(store).open('as_copy', signal));
    for (const id of copy.partIds()) unwrap(await copy.part(id, signal));
    const page = copy.loadedPart(pagePart(0));
    expect(page?.text('t0', 'text.content')?.text).toBe('Headline 1'); // node ids kept
    expect(copy.undoHistory()).toEqual([]); // fresh history
    expect(page?.peer).not.toBe(source.loadedPart(pagePart(0))?.peer);

    unwrap(await copy.transact({ actor: { kind: 'human', id: priya.id }, label: 'Edit copy' }, { [pagePart(0)]: [{ op: 'set', node: 's0-0', path: 'spatial.x', value: 500 }] }, signal));
    unwrap(await copy.compact(signal));
    unwrap(await copy.close(signal));

    const sourceHeadAfter = unwrap(await store.readHead('as_source', signal));
    expect(sourceHeadAfter).toEqual(sourceHeadBefore);
    expect(source.loadedPart(pagePart(0))?.prop('s0-0', 'spatial.x')).toBe(0);
    expect(unwrap(await store.inner.readLog('as_source', 1, signal))).toHaveLength(1); // only the seed commit

    // And edits on the source never reach the copy.
    await editPages(source, [1], 42);
    const again = unwrap(await repoOn(store).open('as_copy', signal));
    const page1 = unwrap(await again.part(pagePart(1), signal));
    expect(page1.prop('s1-0', 'spatial.x')).toBe(0);
    expect(unwrap(await again.part(pagePart(0), signal)).prop('s0-0', 'spatial.x')).toBe(500);
  });

  it('refuses an asset id that is already in use (IF-VER-008) and writes nothing', async () => {
    const { store, created } = await setup();
    store.reset();
    const result = await createDocumentFromMilestone({ store, engine, registry }, { asset: 'as_source', actor: priya, source: { milestone: created.entry.id, record: created.record, title: 'x' } }, signal);
    expect(result).toMatchObject({ ok: false, error: { code: AssetExistsError.code } });
    expect(store.counts().newBlobs).toBe(0);
  });

  it('templates may set the kind; a transform error stops before anything is written', async () => {
    const { store, created } = await setup();
    const template = unwrap(await createDocumentFromMilestone({ store, engine, registry }, { asset: 'as_tpl', kind: 'template', actor: priya, source: { milestone: created.entry.id, record: created.record, title: 'T' } }, signal));
    expect(template.record.kind).toBe('template');
    store.reset();
    const failed = await createDocumentFromMilestone(
      { store, engine, registry },
      { asset: 'as_bad', actor: priya, source: { milestone: created.entry.id, record: created.record, title: 'T' }, check: () => ({ ok: false, error: AssetExistsError() }) },
      signal,
    );
    expect(failed.ok).toBe(false);
    expect(store.counts().newBlobs).toBe(0);
    expect(unwrap(await store.readHead('as_bad', signal))).toBeUndefined();
  });
});
