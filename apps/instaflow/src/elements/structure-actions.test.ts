// @vitest-environment node
// B12 (IF-37.1–37.6): group, ungroup, frame selection, reorder, rename, hide — each one change set = one undo step.
import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { commitEdit, frameSelection, group, NAME_MAX_LENGTH, rename, reorder, reorderedChildren, setHidden, showAll, STRUCTURE_NAMES, ungroup, useAsMask } from './actions.js';
import { type ElementEditEnv, runElementAction, selectionFacts } from './capabilities.js';
import { P } from './components.js';
import { elementBounds, hitElement, isHidden, siblingBounds } from './layout.js';
import { authoringBuilt, createFixture, human, loadGeometry, PAGE, shape, signal, unwrap } from './testing/fixtures.js';

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}, parent = 'p1') => shape(id, { [P.x]: x, [P.y]: y, [P.w]: w, [P.h]: h, [P.fills]: [{ paint: '#ff5c39' }], ...extra }, parent);

describe('reorderedChildren', () => {
  const list = ['a', 'x', 'b', 'y', 'c'];
  it('steps forward and backward past the next unselected sibling, keeping the selected in order', () => {
    expect(reorderedChildren(list, new Set(['a', 'b']), 'forward')).toEqual(['x', 'a', 'y', 'b', 'c']);
    expect(reorderedChildren(list, new Set(['b', 'c']), 'backward')).toEqual(['a', 'b', 'x', 'c', 'y']);
    expect(reorderedChildren(['a', 'b', 'x'], new Set(['a', 'b']), 'forward')).toEqual(['x', 'a', 'b']);
    expect(reorderedChildren(list, new Set(['c']), 'forward')).toEqual(list); // already on top
  });
  it('sends to the front and the back', () => {
    expect(reorderedChildren(list, new Set(['a', 'b']), 'front')).toEqual(['x', 'y', 'c', 'a', 'b']);
    expect(reorderedChildren(list, new Set(['y', 'c']), 'back')).toEqual(['y', 'c', 'a', 'x', 'b']);
  });
});

describe.skipIf(!authoringBuilt)('structure actions', () => {
  it('groups siblings at the top-most one’s place without moving them; ungroup restores them (one step each)', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 10, 10, 50, 50), rect('b', 100, 10, 50, 50), rect('c', 200, 10, 50, 50), rect('d', 300, 10, 50, 50)]);
    const ctx = f.ctx(g);
    const target = { undo: f.undo, stage: f.stage, part: PAGE };
    const before = unwrap(elementBounds(ctx, 'a')).geometry;
    unwrap(commitEdit(target, human, 'Group', group(ctx, ['c', 'a'])));
    const id = f.stage.children('p1').find((n) => f.stage.read(n)?.kind === 'group') as string;
    expect(f.stage.children('p1')).toEqual(['b', id, 'd']); // at c's place in paint order
    expect(f.stage.children(id)).toEqual(['a', 'c']);
    expect(f.stage.value(id, 'name')).toBe(STRUCTURE_NAMES.group);
    expect(unwrap(elementBounds(ctx, 'a')).geometry).toEqual(before);
    expect(unwrap(elementBounds(ctx, id)).geometry).toEqual({ minX: 10, minY: 10, maxX: 250, maxY: 60 });
    expect(f.undo.history(human.id).undo).toHaveLength(1);

    unwrap(commitEdit(target, human, 'Ungroup', ungroup(ctx, [id])));
    expect(f.stage.children('p1')).toEqual(['b', 'a', 'c', 'd']);
    expect(unwrap(elementBounds(ctx, 'a')).geometry).toEqual(before);
    expect(f.undo.history(human.id).undo).toHaveLength(2);
    unwrap(await f.undo.undo(human, signal));
    expect(f.stage.read(id)).toBeDefined();

    expect(group(ctx, []).ok).toBe(false);
    expect(ungroup(ctx, ['b']).ok).toBe(false);
  });

  it('refuses to group across parents; ungrouping a mask group releases the mask', async () => {
    const g = await loadGeometry();
    const f = await createFixture([shape('fr', { [P.x]: 0, [P.y]: 0, [P.w]: 400, [P.h]: 400 }, 'p1', 'frame'), rect('a', 0, 0, 10, 10, {}, 'fr'), rect('b', 20, 20, 10, 10), rect('c', 40, 40, 10, 10)]);
    const ctx = f.ctx(g);
    const across = group(ctx, ['a', 'b']);
    expect(!across.ok && across.error.code).toBe('IF-EL-004');
    f.seed(unwrap(useAsMask(ctx, ['b', 'c'])));
    const mask = f.stage.children('p1').find((n) => f.stage.read(n)?.kind === 'group') as string;
    f.seed(unwrap(ungroup(ctx, [mask])));
    expect(f.stage.value('b', P.maskMode)).toBeUndefined();
    expect(f.stage.read(mask)).toBeUndefined();
  });

  it('frames a selection with its union (padding optional), clip on, no fill; unframe keeps page positions', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 10, 20, 50, 50), rect('b', 100, 40, 50, 50, { [P.rotation]: 90 }), rect('z', 500, 500, 10, 10)]);
    const ctx = f.ctx(g);
    const before = ['a', 'b'].map((n) => unwrap(elementBounds(ctx, n)).geometry);
    f.seed(unwrap(frameSelection(ctx, ['a', 'b'], 5)));
    const frame = f.stage.children('p1').find((n) => f.stage.read(n)?.kind === 'frame') as string;
    expect(f.stage.children('p1')).toEqual([frame, 'z']);
    expect(f.stage.value(frame, 'name')).toBe(STRUCTURE_NAMES.frame);
    expect(f.stage.value(frame, P.clip)).toBe(true);
    expect(f.stage.value(frame, P.fills)).toEqual([]);
    expect(unwrap(elementBounds(ctx, frame)).geometry).toEqual({ minX: 5, minY: 15, maxX: 155, maxY: 95 });
    ['a', 'b'].forEach((n, i) => {
      const b = unwrap(elementBounds(ctx, n)).geometry;
      expect(b.minX).toBeCloseTo(before[i]!.minX, 9);
      expect(b.minY).toBeCloseTo(before[i]!.minY, 9);
    });
    f.seed(unwrap(ungroup(ctx, [frame])));
    expect(f.stage.children('p1')).toEqual(['a', 'b', 'z']);
    ['a', 'b'].forEach((n, i) => expect(unwrap(elementBounds(ctx, n)).geometry.minX).toBeCloseTo(before[i]!.minX, 9));
    expect(frameSelection(ctx, ['a', 'nope']).ok).toBe(false);
  });

  it('reorders within each parent as one change set; nothing to move is not applicable', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 10, 10), rect('b', 0, 0, 10, 10), rect('c', 0, 0, 10, 10), rect('d', 0, 0, 10, 10)]);
    const ctx = f.ctx(g);
    const target = { undo: f.undo, stage: f.stage, part: PAGE };
    unwrap(commitEdit(target, human, 'Bring forward', reorder(ctx, ['a', 'c'], 'forward')));
    expect(f.stage.children('p1')).toEqual(['b', 'a', 'd', 'c']);
    unwrap(commitEdit(target, human, 'Send to back', reorder(ctx, ['d', 'c'], 'back')));
    expect(f.stage.children('p1')).toEqual(['d', 'c', 'b', 'a']);
    unwrap(commitEdit(target, human, 'Bring to front', reorder(ctx, ['d'], 'front')));
    expect(f.stage.children('p1')).toEqual(['c', 'b', 'a', 'd']);
    unwrap(commitEdit(target, human, 'Send backward', reorder(ctx, ['a'], 'backward')));
    expect(f.stage.children('p1')).toEqual(['c', 'a', 'b', 'd']);
    expect(f.undo.history(human.id).undo).toHaveLength(4);
    const nothing = commitEdit(target, human, 'Bring to front', reorder(ctx, ['d'], 'front'));
    expect(!nothing.ok && nothing.error.code).toBe('IF-EL-004');
    unwrap(await f.undo.undo(human, signal));
    expect(f.stage.children('p1')).toEqual(['c', 'b', 'a', 'd']);
  });

  it('renames with a trimmed name; empty and over-long names are refused (IF-FIX-001)', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 10, 10)]);
    const ctx = f.ctx(g);
    f.seed(unwrap(rename(ctx, 'a', '  Hero  ')));
    expect(f.stage.value('a', 'name')).toBe('Hero');
    expect(unwrap(rename(ctx, 'a', 'Hero'))).toEqual([]);
    const empty = rename(ctx, 'a', '   ');
    expect(!empty.ok && empty.error.code).toBe('IF-FIX-001');
    expect(rename(ctx, 'a', 'x'.repeat(NAME_MAX_LENGTH + 1)).ok).toBe(false);
    expect(rename(ctx, 'p1', 'Page').ok).toBe(false);
  });

  it('hides and shows: hidden elements leave hits, group bounds and guides; show all brings them back', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 10, 10), rect('b', 100, 0, 10, 10), shape('gr', {}, 'p1', 'group'), rect('c', 200, 0, 10, 10, {}, 'gr'), rect('d', 300, 0, 10, 10, {}, 'gr')]);
    const ctx = f.ctx(g);
    f.seed(unwrap(setHidden(ctx, ['a'])));
    expect(f.stage.value('a', P.hidden)).toBe(true);
    expect(unwrap(hitElement(ctx, 'a', 5, 5))).toBe('none');
    expect(siblingBounds(ctx, 'b').map((s) => s.node)).toEqual(['gr']);
    f.seed(unwrap(setHidden(ctx, ['d'], true)));
    expect(unwrap(elementBounds(ctx, 'gr')).geometry.maxX).toBe(210);
    f.seed(unwrap(setHidden(ctx, ['gr'], true)));
    expect(isHidden(ctx, 'c')).toBe(true);
    expect(isHidden(ctx, 'b')).toBe(false);
    expect(unwrap(setHidden(ctx, ['a'], true))).toEqual([]); // already hidden
    f.seed(unwrap(setHidden(ctx, ['a', 'b']))); // toggle: b is visible, so both hide
    expect(f.stage.value('b', P.hidden)).toBe(true);
    f.seed(unwrap(showAll(ctx, 'p1')));
    for (const n of ['a', 'b', 'gr', 'd']) expect(f.stage.value(n, P.hidden)).toBeUndefined();
    expect(setHidden(ctx, []).ok).toBe(false);
  });

  it('runs through the capability seam and names what to select afterwards', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)]);
    const env: ElementEditEnv = { context: () => f.ctx(g), target: () => ({ undo: f.undo, stage: f.stage, part: PAGE }), actorFor: () => ok(human) };
    const grouped = unwrap(runElementAction(env, 'group', { nodes: ['a', 'b'] }, human));
    const id = grouped.select?.[0] as string;
    expect(f.stage.read(id)?.kind).toBe('group');
    expect(selectionFacts(f.ctx(g), [id]).containers).toBe(1);
    expect(unwrap(runElementAction(env, 'ungroup', { nodes: [id] }, human)).select).toEqual(['a', 'b']);
    expect(unwrap(runElementAction(env, 'rename', { nodes: ['a'], name: 'Card' }, human))).toEqual({ ops: 1 });
    expect(runElementAction(env, 'rename', { nodes: ['a', 'b'], name: 'Card' }, human).ok).toBe(false); // one element
    expect(unwrap(runElementAction(env, 'bring-to-front', { nodes: ['a'] }, human))).toEqual({ ops: 1 });
    expect(unwrap(runElementAction(env, 'hide', { nodes: ['a'] }, human))).toEqual({ ops: 1 });
    expect(unwrap(runElementAction(env, 'show-all', { nodes: ['p1'] }, human))).toEqual({ ops: 1 });
    const framed = unwrap(runElementAction(env, 'frame-selection', { nodes: ['a', 'b'], padding: 4 }, human));
    expect(f.stage.read(framed.select?.[0] as string)?.kind).toBe('frame');
    expect(f.undo.history(human.id).undo).toHaveLength(7);
  });
});
