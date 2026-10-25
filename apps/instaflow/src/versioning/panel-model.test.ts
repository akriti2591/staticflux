import { describe, expect, it } from 'vitest';
import { LATEST } from './compare.js';
import type { MilestoneId } from './records.js';
import { panelFixture, signal, unwrap } from './test-helpers.js';

describe('createMilestonesPanelModel', () => {
  it('creates, lists, pins and renames through the milestone service, tracking busy', async () => {
    const { model } = await panelFixture();
    expect(model.busy()).toBe('idle');
    const creating = model.create('Client v1', 'first');
    expect(model.busy()).toBe('creating');
    const a = unwrap(await creating);
    expect(model.busy()).toBe('idle');
    unwrap(await model.create('Client v2'));
    expect(model.milestones().map((m) => m.name)).toEqual(['Client v2', 'Client v1']);
    unwrap(await model.pin(a.id, true));
    unwrap(await model.rename(a.id, 'Approved'));
    expect(model.milestones()[1]).toMatchObject({ name: 'Approved', pinned: true });
    expect((await model.create('  ')).ok).toBe(false);
    expect(unwrap(await model.refresh())).toHaveLength(2);
  });

  it('open, compare and new document hand results to the host', async () => {
    const { model, shown, store } = await panelFixture();
    const a = unwrap(await model.create('A'));
    const b = unwrap(await model.create('B'));
    unwrap(await model.open(a.id));
    expect(shown.readOnly[0]?.source).toMatchObject({ kind: 'milestone', id: a.id });
    unwrap(await model.compare(a.id, LATEST));
    unwrap(await model.compare(a.id, b.id));
    expect(shown.compared.map((s) => [s.left.source.kind, s.right.source.kind])).toEqual([
      ['milestone', 'snapshot'],
      ['milestone', 'milestone'],
    ]);
    const made = unwrap(await model.newDocument(b.id));
    expect(shown.opened).toEqual(['as_new1']);
    expect(made.record.createdFrom).toEqual({ asset: 'as_flyer', milestone: b.id, title: 'Night Market Flyer · B' });
    expect(unwrap(await store.readHead('as_new1', signal))?.generation).toBe(1);
  });

  it('failures reach the caller and the host is not called', async () => {
    const { model, shown } = await panelFixture();
    const ghost = `ms_${'c'.repeat(64)}` as MilestoneId;
    expect((await model.open(ghost)).ok).toBe(false);
    expect((await model.compare(ghost, LATEST)).ok).toBe(false);
    expect((await model.newDocument(ghost)).ok).toBe(false);
    expect(shown).toEqual({ readOnly: [], compared: [], opened: [] });
    expect(model.busy()).toBe('idle');
  });
});
