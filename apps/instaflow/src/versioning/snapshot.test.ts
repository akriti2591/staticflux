import { describe, expect, it } from 'vitest';
import { MilestoneDataError, ReleaseUnavailableError } from './errors.js';
import { createMilestoneService } from './milestones.js';
import { createPartCapture } from './parts.js';
import { digestOfId, type SnapshotId } from './records.js';
import { createExportSnapshotService, unavailableReleasePort } from './snapshot.js';
import { createCountingStore, editPages, pagePart, priya, registry, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';

async function setup() {
  const store = createCountingStore();
  const doc = await seedDocument(repoOn(store), 'as_flyer', 3);
  const capture = createPartCapture({ store, registry });
  const snapshots = createExportSnapshotService({ doc, store, capture, registry });
  const milestones = createMilestoneService({ doc, store, capture, registry });
  return { store, doc, capture, snapshots, milestones };
}

describe('createExportSnapshotService', () => {
  it('freezes Latest at export start: edits made while the export runs never leak in', async () => {
    const { store, doc, snapshots } = await setup();
    const frozen = unwrap(await snapshots.freeze(signal));
    expect(frozen.id).toBe(`sn_${frozen.ref.digest.slice(7)}`);
    expect(digestOfId(frozen.id)).toBe(frozen.ref.digest);
    const bytesBefore = await Promise.all(Object.values(frozen.manifest.parts).map(async (ref) => unwrap(await store.getBlob(ref, signal))));

    // Editing continues, in memory and durably, while the export renders.
    await editPages(doc, [0, 1, 2], 1234);
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Delete' }, { [pagePart(2)]: [{ op: 'delete', node: 't2' }] }));
    unwrap(await doc.compact(signal));

    const view = unwrap(await snapshots.open({ id: frozen.id, ref: frozen.ref }, signal));
    expect(view.source).toEqual({ kind: 'snapshot', id: frozen.id });
    const p0 = unwrap(await view.part(pagePart(0), signal));
    expect(p0.node('s0-0')?.props['spatial']).toMatchObject({ x: 0 });
    expect(unwrap(await view.part(pagePart(2), signal)).node('t2')).toBeDefined();
    const bytesAfter = await Promise.all(Object.values(frozen.manifest.parts).map(async (ref) => unwrap(await store.getBlob(ref, signal))));
    expect(bytesAfter).toEqual(bytesBefore);

    // A second freeze sees the edits and shares unchanged parts (root) by digest.
    const later = unwrap(await snapshots.freeze(signal));
    expect(later.id).not.toBe(frozen.id);
    expect(later.manifest.parts['root']).toEqual(frozen.manifest.parts['root']);
    expect(unwrap(await (unwrap(await snapshots.open(later, signal))).part(pagePart(2), signal)).node('t2')).toBeUndefined();
  });

  it('captures commits that are applied but not yet durable (what the person sees)', async () => {
    const { doc, snapshots } = await setup();
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Nudge' }, { [pagePart(1)]: [{ op: 'set', node: 's1-0', path: 'spatial.x', value: 7 }] }));
    const frozen = unwrap(await snapshots.freeze(signal));
    const view = unwrap(await snapshots.open(frozen, signal));
    expect(unwrap(await view.part(pagePart(1), signal)).node('s1-0')?.props['spatial']).toMatchObject({ x: 7 });
  });

  it('leaves no record: no head change, no milestone, nothing in the list (D10)', async () => {
    const { store, snapshots, milestones } = await setup();
    const head = unwrap(await store.readHead('as_flyer', signal));
    store.reset();
    unwrap(await snapshots.freeze(signal));
    expect(store.counts().headWrites).toBe(0);
    expect(unwrap(await store.readHead('as_flyer', signal))).toEqual(head);
    expect(unwrap(await milestones.refresh(signal))).toEqual([]);
  });

  it('dedupes with milestones by digest: a milestone right after a freeze writes no part', async () => {
    const { store, snapshots, milestones } = await setup();
    unwrap(await snapshots.freeze(signal));
    store.reset();
    const created = unwrap(await milestones.create({ name: 'After export', actor: priya }, signal));
    expect(created.written).toEqual([]);
    expect(store.counts().newBlobs).toBe(1); // the record only
  });

  it('reports a missing or mismatched manifest', async () => {
    const { snapshots } = await setup();
    const frozen = unwrap(await snapshots.freeze(signal));
    const other = `sn_${'1'.repeat(64)}` as SnapshotId;
    expect(await snapshots.open({ id: other, ref: frozen.ref }, signal)).toMatchObject({ ok: false, error: { code: MilestoneDataError.code } });
    expect(await snapshots.open({ id: other, ref: { digest: digestOfId(other), size: 1 } }, signal)).toMatchObject({ ok: false, error: { code: MilestoneDataError.code } });
  });

  it('the M1 Release hook is unavailable (IF-VER-009)', async () => {
    const { snapshots } = await setup();
    const frozen = unwrap(await snapshots.freeze(signal));
    expect(await unavailableReleasePort.createRelease({ snapshot: frozen, outputs: [], format: 'pdf', publishedFrom: { asset: 'as_flyer', title: 'Flyer' } }, signal)).toMatchObject({
      ok: false,
      error: { code: ReleaseUnavailableError.code },
    });
  });
});
