import { describe, expect, it } from 'vitest';
import { LATEST, openComparison } from './compare.js';
import { UnknownMilestoneError } from './errors.js';
import { createMilestoneService } from './milestones.js';
import { createPartCapture } from './parts.js';
import type { MilestoneId } from './records.js';
import { createExportSnapshotService } from './snapshot.js';
import { createCountingStore, editPages, pagePart, priya, registry, repoOn, seedDocument, signal, unwrap } from './test-helpers.js';

async function setup() {
  const store = createCountingStore();
  const doc = await seedDocument(repoOn(store), 'as_1', 2);
  const capture = createPartCapture({ store, registry });
  const milestones = createMilestoneService({ doc, store, capture, registry });
  const snapshots = createExportSnapshotService({ doc, store, capture, registry });
  return { store, doc, milestones, snapshots };
}

describe('openComparison', () => {
  it('opens two milestones side by side as two read-only documents (visual only, no diff)', async () => {
    const { doc, milestones, snapshots } = await setup();
    const a = unwrap(await milestones.create({ name: 'A', actor: priya }, signal)).entry;
    await editPages(doc, [0], 50);
    unwrap(doc.createPart('page:p9'));
    const b = unwrap(await milestones.create({ name: 'B', actor: priya }, signal)).entry;
    const session = unwrap(await openComparison({ milestones, snapshots }, a.id, b.id, signal));
    expect(session.kind).toBe('side-by-side');
    expect(session.left.readOnly && session.right.readOnly).toBe(true);
    expect(session.left.source).toMatchObject({ kind: 'milestone', id: a.id });
    expect(session.parts()).toEqual(['page:p0', 'page:p1', 'root', 'page:p9']);
    expect(unwrap(await session.left.part(pagePart(0), signal)).node('s0-0')?.props['spatial']).toMatchObject({ x: 0 });
    expect(unwrap(await session.right.part(pagePart(0), signal)).node('s0-0')?.props['spatial']).toMatchObject({ x: 50 });
    expect(Object.keys(session)).not.toContain('diff');
  });

  it('compares a milestone with Latest through a frozen snapshot (no milestone is created)', async () => {
    const { doc, milestones, snapshots } = await setup();
    const a = unwrap(await milestones.create({ name: 'A', actor: priya }, signal)).entry;
    await editPages(doc, [1], 7);
    const session = unwrap(await openComparison({ milestones, snapshots }, a.id, LATEST, signal));
    expect(session.right.source.kind).toBe('snapshot');
    expect(unwrap(await session.right.part(pagePart(1), signal)).node('s1-0')?.props['spatial']).toMatchObject({ x: 7 });
    expect(unwrap(await milestones.refresh(signal))).toHaveLength(1);
  });

  it('fails as a value for an unknown milestone on either side', async () => {
    const { milestones, snapshots } = await setup();
    const ghost = `ms_${'f'.repeat(64)}` as MilestoneId;
    expect(await openComparison({ milestones, snapshots }, LATEST, ghost, signal)).toMatchObject({ ok: false, error: { code: UnknownMilestoneError.code } });
    expect(await openComparison({ milestones, snapshots }, ghost, LATEST, signal)).toMatchObject({ ok: false, error: { code: UnknownMilestoneError.code } });
  });
});
