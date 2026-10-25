import { err, ok } from '@staticflux/core';
import { canonicalJsonBytes, sha256Digest } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { MilestoneNameError, UnknownMilestoneError } from './errors.js';
import { readVersioningState } from './head-state.js';
import { createMilestoneService, type MilestoneCreateState, validateMilestoneName } from './milestones.js';
import { createPartCapture } from './parts.js';
import { digestOfId, type MilestoneId } from './records.js';
import { createCountingStore, editPages, pagePart, priya, registry, repoOn, sam, seedDocument, signal, unwrap } from './test-helpers.js';

async function setup(pages = 10) {
  const store = createCountingStore();
  const repo = repoOn(store);
  const doc = await seedDocument(repo, 'as_flyer', pages);
  const capture = createPartCapture({ store, registry });
  let clock = Date.UTC(2026, 9, 25, 9, 0, 0);
  const milestones = createMilestoneService({ doc, store, capture, registry, now: () => (clock += 1000) });
  return { store, repo, doc, capture, milestones };
}

describe('validateMilestoneName', () => {
  it('trims and accepts 1–120 characters', () => {
    expect(unwrap(validateMilestoneName('  Client v2 '))).toBe('Client v2');
    expect(validateMilestoneName('   ')).toMatchObject({ ok: false, error: { code: MilestoneNameError.code } });
    expect(validateMilestoneName('x'.repeat(121)).ok).toBe(false);
    expect(validateMilestoneName('x'.repeat(120)).ok).toBe(true);
  });
});

describe('createMilestoneService', () => {
  it('first milestone writes every part; later ones write only the changed parts, by hash', async () => {
    const { store, doc, milestones } = await setup(10);
    store.reset();
    const first = unwrap(await milestones.create({ name: 'Client v1', actor: priya }, signal));
    expect(first.written).toHaveLength(11); // root + 10 pages
    expect(store.counts().newBlobs).toBe(12); // 11 parts + the record

    await editPages(doc, [2, 7], 99);
    store.reset();
    const second = unwrap(await milestones.create({ name: 'Client v2', actor: priya }, signal));
    expect([...second.written].sort()).toEqual([pagePart(2), pagePart(7)].sort());
    expect(store.counts().newBlobs).toBe(3); // 2 changed parts + the record
    // Unchanged parts are shared by digest with the first milestone.
    for (const [part, ref] of Object.entries(second.record.parts)) {
      if (part === pagePart(2) || part === pagePart(7)) expect(ref.digest).not.toBe(first.record.parts[part]?.digest);
      else expect(ref.digest).toBe(first.record.parts[part]?.digest);
    }
    expect(second.record.parent).toBe(first.entry.id);
    expect(second.bytesWritten).toBeLessThan(first.bytesWritten);
  });

  it('nothing changed: no part is re-encoded or written, only a new record', async () => {
    const { store, milestones } = await setup(4);
    unwrap(await milestones.create({ name: 'A', actor: priya }, signal));
    store.reset();
    const again = unwrap(await milestones.create({ name: 'B', actor: priya }, signal));
    expect(again.written).toEqual([]);
    expect(store.counts().newBlobs).toBe(1);
  });

  it('a part edited and edited back is re-encoded but not written (same digest)', async () => {
    const { doc, store, milestones } = await setup(3);
    unwrap(await milestones.create({ name: 'A', actor: priya }, signal));
    await editPages(doc, [1], 5);
    await editPages(doc, [1], 0);
    store.reset();
    const back = unwrap(await milestones.create({ name: 'B', actor: priya }, signal));
    expect(back.written).toEqual([]);
    expect(store.counts().newBlobs).toBe(1);
  });

  it('the id is the digest of the canonical record, which records the actor, time, schema and references', async () => {
    const { store, milestones } = await setup(2);
    const created = unwrap(await milestones.create({ name: ' Launch ', note: ' first cut ', actor: priya }, signal));
    const { record, entry } = created;
    expect(entry.id).toBe(`ms_${(await sha256Digest(unwrap(canonicalJsonBytes(record)))).slice(7)}`);
    expect(record).toMatchObject({ schema: 'instaflow.milestone/1', asset: 'as_flyer', kind: 'named', name: 'Launch', note: 'first cut', treeSchema: 1 });
    expect(record.createdBy).toMatchObject({ kind: 'human', id: priya.id, displayName: 'Priya' });
    expect(record.createdAt).toBe('2026-10-25T09:00:01.000Z');
    expect(record.parent).toBeUndefined();
    expect(record.references).toEqual([{ ref: { asset: 'as_bg_lamps' }, where: 2 }]);
    const stored = unwrap(await store.getBlob({ digest: digestOfId(entry.id), size: 0 }, signal));
    expect(stored).toEqual(unwrap(canonicalJsonBytes(record)));
  });

  it('lists newest first; pin and rename are head fields that never rewrite the record', async () => {
    const { store, milestones } = await setup(2);
    const a = unwrap(await milestones.create({ name: 'A', actor: priya }, signal)).entry;
    const b = unwrap(await milestones.create({ name: 'B', actor: sam }, signal)).entry;
    expect(milestones.list().map((m) => m.name)).toEqual(['B', 'A']);
    const recordBytes = unwrap(await store.getBlob({ digest: digestOfId(a.id), size: 0 }, signal));

    unwrap(await milestones.pin(a.id, true, signal));
    unwrap(await milestones.rename(a.id, 'Client approved', signal));
    expect(milestones.list()).toMatchObject([
      { id: b.id, name: 'B', pinned: false },
      { id: a.id, name: 'Client approved', pinned: true },
    ]);
    const head = unwrap(await store.readHead('as_flyer', signal));
    expect(readVersioningState(head)).toMatchObject({ milestones: [{ id: b.id }, { id: a.id }], pinned: [a.id], names: { [a.id]: 'Client approved' } });
    expect(unwrap(await store.getBlob({ digest: digestOfId(a.id), size: 0 }, signal))).toEqual(recordBytes);
    expect(unwrap(await milestones.record(a.id, signal)).name).toBe('A');

    store.reset();
    unwrap(await milestones.pin(a.id, true, signal)); // already pinned: no head write
    expect(store.counts().headWrites).toBe(0);
    unwrap(await milestones.pin(a.id, false, signal));
    expect(milestones.list().find((m) => m.id === a.id)?.pinned).toBe(false);

    expect((await milestones.rename(a.id, '', signal)).ok).toBe(false);
    const ghost = `ms_${'0'.repeat(64)}` as MilestoneId;
    expect(await milestones.pin(ghost, true, signal)).toMatchObject({ ok: false, error: { code: UnknownMilestoneError.code } });
    expect(await milestones.open(ghost, signal)).toMatchObject({ ok: false, error: { code: UnknownMilestoneError.code } });
  });

  it('opens read-only from canonical parts: later edits never show, nothing is written', async () => {
    const { doc, store, milestones } = await setup(3);
    const created = unwrap(await milestones.create({ name: 'A', actor: priya }, signal));
    await editPages(doc, [0], 777);
    store.reset();
    const view = unwrap(await milestones.open(created.entry.id, signal));
    expect(view.readOnly).toBe(true);
    expect(view.source).toMatchObject({ kind: 'milestone', id: created.entry.id, name: 'A' });
    expect(view.partIds()).toEqual(['page:p0', 'page:p1', 'page:p2', 'root']);
    const page = unwrap(await view.part(pagePart(0), signal));
    expect(page.node('s0-0')?.props['spatial']).toMatchObject({ x: 0 });
    expect(page.children('p0')).toEqual(['t0', 'img0', 's0-0', 's0-1', 's0-2', 's0-3']);
    expect(page.node('t0')?.props['text']).toEqual({ content: { text: 'Headline 1', spans: [{ start: 0, end: 8, marks: { bold: true } }] } });
    // Lazy: only the record and the viewed part were read.
    expect(store.counts().gets).toBe(1);
    expect(store.counts().newBlobs).toBe(0);
    expect(store.counts().headWrites).toBe(0);
    // Cached per part.
    await view.part(pagePart(0), signal);
    expect(store.counts().gets).toBe(1);
  });

  it('serializes concurrent creations into a parent chain', async () => {
    const { milestones } = await setup(2);
    const [a, b] = await Promise.all([milestones.create({ name: 'A', actor: priya }, signal), milestones.create({ name: 'B', actor: priya }, signal)]);
    expect(unwrap(b).record.parent).toBe(unwrap(a).entry.id);
    expect(milestones.list().map((m) => m.name)).toEqual(['B', 'A']);
  });

  it('runs the instaflow/milestone-create machine and reports failures as values', async () => {
    const { store, doc, capture } = await setup(2);
    const states: MilestoneCreateState[] = [];
    const service = createMilestoneService({ doc, store, capture, registry, onCreateState: (s) => states.push(s) });
    unwrap(await service.create({ name: 'A', actor: priya }, signal));
    expect(states).toEqual(['flushing', 'capturing', 'recording', 'swapping', 'created']);

    states.length = 0;
    store.inner.failNext('writeHead', UnknownMilestoneError({ message: 'disk gone' }));
    const failed = await service.create({ name: 'B', actor: priya }, signal);
    expect(failed.ok).toBe(false);
    expect(states.at(-1)).toBe('failed');
    expect(service.list().map((m) => m.name)).toEqual(['A']);
  });

  it('flushes the folder mirror after each creation; a failed mirror flush still keeps the milestone', async () => {
    const { store, doc, capture } = await setup(2);
    let flushes = 0;
    let fail = false;
    const mirror = { flush: async () => ((flushes += 1), fail ? err(UnknownMilestoneError()) : ok(undefined)) };
    const service = createMilestoneService({ doc, store, capture, registry, mirror });
    expect(unwrap(await service.create({ name: 'A', actor: priya }, signal)).mirrored).toBe(true);
    fail = true;
    expect(unwrap(await service.create({ name: 'B', actor: priya }, signal)).mirrored).toBe(false);
    expect(flushes).toBe(2);
    expect(service.list()).toHaveLength(2);
  });

  it('survives the repo compacting over the versioning head fields, and reloads in a new session', async () => {
    const { store, doc, milestones } = await setup(2);
    const a = unwrap(await milestones.create({ name: 'A', actor: priya }, signal)).entry;
    unwrap(await milestones.pin(a.id, true, signal));
    await editPages(doc, [0], 3);
    unwrap(await doc.compact(signal)); // the repo's head is stale: CAS conflict → adopt → retry
    const head = unwrap(await store.readHead('as_flyer', signal));
    expect(readVersioningState(head)).toMatchObject({ milestones: [{ id: a.id }], pinned: [a.id] });
    unwrap(await doc.close(signal));

    const reopened = unwrap(await repoOn(store).open('as_flyer', signal));
    const service = createMilestoneService({ doc: reopened, store, capture: createPartCapture({ store, registry }), registry });
    expect(unwrap(await service.refresh(signal)).map((m) => [m.name, m.pinned])).toEqual([['A', true]]);
    const b = unwrap(await service.create({ name: 'B', actor: priya }, signal));
    expect(b.record.parent).toBe(a.id);
    expect(b.written).toEqual([pagePart(0)]);
  });

  it('never captures the comments part; unloaded parts are loaded for the capture and evicted again', async () => {
    const { doc, milestones } = await setup(2);
    const comments = unwrap(doc.createPart('comments'));
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Comment' }, { comments: [{ op: 'create', node: 'c1', kind: 'comment', parent: null }] }));
    expect(comments.size()).toBe(1);
    unwrap(await doc.flush(signal));
    unwrap(doc.evict(pagePart(1)));
    const created = unwrap(await milestones.create({ name: 'A', actor: priya }, signal));
    expect(Object.keys(created.record.parts)).not.toContain('comments');
    expect(Object.keys(created.record.parts)).toContain(pagePart(1));
    expect(doc.partState(pagePart(1))).toBe('unloaded');
  });

  it('refuses work after dispose', async () => {
    const { milestones } = await setup(1);
    milestones.dispose();
    expect((await milestones.create({ name: 'A', actor: priya }, signal)).ok).toBe(false);
    expect((await milestones.refresh(signal)).ok).toBe(false);
  });
});
