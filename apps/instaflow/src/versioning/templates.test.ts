import { createUndoService } from '@staticflux/stage';
import type { CanonicalPart } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { RequiredSlotError, SlotFillError, SlotMarkError } from './errors.js';
import { createMilestoneService } from './milestones.js';
import { createPartCapture } from './parts.js';
import { checkFills, createDocumentFromTemplate, fillPart, listSlots, markSlot, SLOT_TARGETS, unmarkSlot, validateFill } from './templates.js';
import { createCountingStore, engine, pagePart, priya, registry, repoOn, sam, seedDocument, signal, unwrap } from './test-helpers.js';

async function template() {
  const store = createCountingStore();
  const repo = repoOn(store);
  const doc = await seedDocument(repo, 'as_tpl', 2);
  const undo = createUndoService({ doc });
  unwrap(markSlot(doc, undo, priya, { part: pagePart(0), node: 't0', slot: { name: 'headline', accepts: 'text', required: true, maxChars: 40 } }));
  unwrap(markSlot(doc, undo, priya, { part: pagePart(1), node: 't1', slot: { name: 'headline', accepts: 'text' } }));
  unwrap(markSlot(doc, undo, priya, { part: pagePart(0), node: 'img0', slot: { name: 'hero', accepts: 'image' } }));
  unwrap(markSlot(doc, undo, priya, { part: pagePart(1), node: 's1-0', slot: { name: 'brand', accepts: 'color' } }));
  const milestones = createMilestoneService({ doc, store, capture: createPartCapture({ store, registry }), registry });
  const created = unwrap(await milestones.create({ name: 'Sale flyer template', actor: priya }, signal));
  return { store, repo, doc, undo, milestones, created };
}

describe('markSlot / unmarkSlot', () => {
  it('marks are ordinary commits: one undo step per actor', async () => {
    const store = createCountingStore();
    const doc = await seedDocument(repoOn(store), 'as_x', 1);
    const undo = createUndoService({ doc });
    unwrap(markSlot(doc, undo, sam, { part: pagePart(0), node: 't0', slot: { name: 'headline', accepts: 'text' } }));
    const part = doc.loadedPart(pagePart(0));
    expect(part?.node('t0')?.props).toMatchObject({ 'slot.name': 'headline', 'slot.accepts': 'text', 'slot.target': SLOT_TARGETS.text.path, 'slot.required': false });
    expect(undo.canUndo(sam.id)).toBe(true);
    unwrap(await undo.undo(sam, signal));
    expect(part?.prop('t0', 'slot.name')).toBeUndefined();
    unwrap(markSlot(doc, undo, sam, { part: pagePart(0), node: 't0', slot: { name: 'headline', accepts: 'text' } }));
    unwrap(unmarkSlot(undo, sam, { part: pagePart(0), node: 't0' }));
    expect(part?.prop('t0', 'slot.name')).toBeUndefined();
    undo.dispose();
  });

  it('rejects unknown nodes, kinds that do not fit, bad targets, limits on non-text slots and kind clashes', async () => {
    const store = createCountingStore();
    const doc = await seedDocument(repoOn(store), 'as_x', 1);
    const undo = createUndoService({ doc });
    const mark = (node: string, slot: Parameters<typeof markSlot>[3]['slot'], part = pagePart(0)) => markSlot(doc, undo, priya, { part, node, slot });
    for (const result of [
      mark('nope', { name: 'a', accepts: 'text' }),
      mark('t0', { name: 'a', accepts: 'text' }, 'page:zzz'),
      mark('s0-0', { name: 'a', accepts: 'text' }),
      mark('t0', { name: 'a', accepts: 'image' }),
      mark('t0', { name: ' ', accepts: 'text' }),
      mark('t0', { name: 'a', accepts: 'text', target: 'text' }),
      mark('s0-0', { name: 'a', accepts: 'color', maxChars: 4 }),
      mark('t0', { name: 'a', accepts: 'video' as 'text' }),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: SlotMarkError.code } });
    }
    unwrap(mark('s0-0', { name: 'brand', accepts: 'color' }));
    expect(mark('s0-1', { name: 'brand', accepts: 'text' }).ok).toBe(false);
    expect(mark('s0-1', { name: 'brand', accepts: 'color' }).ok).toBe(true);
    undo.dispose();
  });
});

describe('listSlots / validateFill / checkFills / fillPart', () => {
  it('lists slots by name across parts (required if any is, tightest limit)', async () => {
    const { store, created } = await template();
    const parts: CanonicalPart[] = [];
    for (const ref of Object.values(created.record.parts)) parts.push(JSON.parse(new TextDecoder().decode(unwrap(await store.getBlob(ref, signal)))) as CanonicalPart);
    expect(listSlots(parts)).toEqual([
      { name: 'brand', accepts: 'color', required: false, nodes: [{ part: pagePart(1), node: 's1-0', target: 'style.fill' }] },
      {
        name: 'headline',
        accepts: 'text',
        required: true,
        maxChars: 40,
        nodes: expect.arrayContaining([
          { part: pagePart(0), node: 't0', target: 'text.content' },
          { part: pagePart(1), node: 't1', target: 'text.content' },
        ]),
      },
      { name: 'hero', accepts: 'image', required: false, nodes: [{ part: pagePart(0), node: 'img0', target: 'source.asset' }] },
    ]);
  });

  it('validates each kind of fill', () => {
    expect(validateFill({ name: 'h', accepts: 'text', maxChars: 3 }, 'abc').ok).toBe(true);
    expect(validateFill({ name: 'h', accepts: 'text', maxChars: 3 }, 'abcd')).toMatchObject({ ok: false, error: { code: SlotFillError.code } });
    expect(validateFill({ name: 'h', accepts: 'image' }, 'as_photo').ok).toBe(true);
    expect(validateFill({ name: 'h', accepts: 'image' }, 'https://x').ok).toBe(false);
    expect(validateFill({ name: 'h', accepts: 'color' }, '#CF3D17').ok).toBe(true);
    expect(validateFill({ name: 'h', accepts: 'color' }, 'red').ok).toBe(false);
    expect(validateFill({ name: 'h', accepts: 'text' }, 3 as unknown as string).ok).toBe(false);
  });

  it('checks unknown names and required slots', () => {
    const slots = [{ name: 'headline', accepts: 'text', required: true, nodes: [] }] as const;
    expect(checkFills(slots, { headline: 'Hi' }).ok).toBe(true);
    expect(checkFills(slots, {})).toMatchObject({ ok: false, error: { code: RequiredSlotError.code, details: { slots: ['headline'] } } });
    expect(checkFills(slots, { headline: '' }).ok).toBe(false);
    expect(checkFills(slots, { headline: 'Hi', subtitle: 'x' })).toMatchObject({ ok: false, error: { code: SlotFillError.code } });
  });

  it('fills a part purely, keeping the first span’s marks, and strips markers unless asked to keep them', () => {
    const part: CanonicalPart = {
      schema: 'instaflow.part/1',
      part: 'page:p',
      treeSchema: 1,
      nodes: [
        { id: 'a', kind: 'text', parent: null, order: 'a0', props: { slot: { name: 'h', accepts: 'text', target: 'text.content' }, text: { content: { text: 'Old', spans: [{ start: 0, end: 3, marks: { bold: true } }] } } } },
        { id: 'b', kind: 'shape', parent: null, order: 'a1', props: { slot: { name: 'c', accepts: 'color', target: 'style.fill' }, style: { fill: '#000000' } } },
        { id: 'c', kind: 'text', parent: null, order: 'a2', props: { slot: { name: 'raw', accepts: 'text', target: 'note.body' }, note: { body: { $text: { text: 'x', spans: [] } } } } },
        { id: 'd', kind: 'shape', parent: null, order: 'a3', props: {} },
      ],
    };
    const filled = unwrap(fillPart(part, { h: 'New headline', c: '#CF3D17', raw: 'y' }));
    expect(filled.nodes[0]?.props).toEqual({ text: { content: { text: 'New headline', spans: [{ start: 0, end: 12, marks: { bold: true } }] } } });
    expect(filled.nodes[1]?.props).toEqual({ style: { fill: '#CF3D17' } });
    expect(filled.nodes[2]?.props).toEqual({ note: { body: { $text: { text: 'y', spans: [] } } } });
    expect(filled.nodes[3]).toBe(part.nodes[3]);
    expect(part.nodes[0]?.props['slot']).toBeDefined(); // pure
    expect(unwrap(fillPart(part, {}, { keepSlots: true })).nodes[0]?.props['slot']).toBeDefined();
    expect(fillPart(part, { c: 'nope' }).ok).toBe(false);
  });
});

describe('createDocumentFromTemplate', () => {
  it('is New document from milestone plus slot filling: every slot of a name filled, markers dropped', async () => {
    const { store, created } = await template();
    const made = unwrap(
      await createDocumentFromTemplate(
        { store, engine, registry },
        { asset: 'as_diwali', actor: priya, source: { milestone: created.entry.id, record: created.record, title: 'Sale flyer' }, fills: { headline: 'Diwali Sale', hero: 'as_lamps', brand: '#CF3D17' } },
        signal,
      ),
    );
    expect(made.record.createdFrom).toMatchObject({ asset: 'as_tpl', milestone: created.entry.id });
    const doc = unwrap(await repoOn(store).open('as_diwali', signal));
    const p0 = unwrap(await doc.part(pagePart(0), signal));
    const p1 = unwrap(await doc.part(pagePart(1), signal));
    expect(p0.text('t0', 'text.content')).toEqual({ text: 'Diwali Sale', spans: [{ start: 0, end: 11, marks: { bold: true } }] });
    expect(p1.text('t1', 'text.content')?.text).toBe('Diwali Sale');
    expect(p0.prop('img0', 'source.asset')).toEqual({ asset: 'as_lamps' });
    expect(p1.prop('s1-0', 'style.fill')).toEqual({ color: '#CF3D17' });
    expect(p0.prop('t0', 'slot.name')).toBeUndefined();
    expect(p1.prop('s1-1', 'style.fill')).toEqual({ color: '#FF5C39' }); // not a slot: unchanged
  });

  it('writes nothing when a required slot is empty or a fill is invalid', async () => {
    const { store, created } = await template();
    store.reset();
    const source = { milestone: created.entry.id, record: created.record, title: 'T' };
    expect(await createDocumentFromTemplate({ store, engine, registry }, { asset: 'as_a', actor: priya, source, fills: { hero: 'as_lamps' } }, signal)).toMatchObject({
      ok: false,
      error: { code: RequiredSlotError.code },
    });
    expect(await createDocumentFromTemplate({ store, engine, registry }, { asset: 'as_b', actor: priya, source, fills: { headline: 'x'.repeat(41) } }, signal)).toMatchObject({
      ok: false,
      error: { code: SlotFillError.code },
    });
    expect(await createDocumentFromTemplate({ store, engine, registry }, { asset: 'as_c', actor: priya, source, fills: { headline: 'Hi', footer: 'x' } }, signal)).toMatchObject({
      ok: false,
      error: { code: SlotFillError.code },
    });
    expect(store.counts().newBlobs).toBe(0);
    expect(store.counts().headWrites).toBe(0);
  });

  it('keepSlots makes another template', async () => {
    const { store, created } = await template();
    unwrap(await createDocumentFromTemplate({ store, engine, registry }, { asset: 'as_t2', kind: 'template', actor: priya, keepSlots: true, source: { milestone: created.entry.id, record: created.record, title: 'T' }, fills: { headline: 'Remix' } }, signal));
    const doc = unwrap(await repoOn(store).open('as_t2', signal));
    expect(unwrap(await doc.part(pagePart(0), signal)).prop('t0', 'slot.name')).toBe('headline');
  });
});
