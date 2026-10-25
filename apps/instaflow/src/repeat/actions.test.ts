// @vitest-environment node
import { ok } from '@staticflux/core';
import { createRenderProjector } from '@staticflux/document/render-projection';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { elementBounds } from '../elements/layout.js';
import { createElementRenderSource, ElementProjection } from '../elements/projection.js';
import { authoringBuilt, human, loadGeometry, signal, shape, unwrap } from '../elements/testing/fixtures.js';
import { commitRepeatEdit, expandRepeat, liveRepeat, makeRepeat, newRepeatParams, releaseRepeat, setRepeat } from './actions.js';
import { RP } from './components.js';
import { defaultParams, type RepeatParams, repeatOps } from './params.js';
import { createRepeatFixture, keyTree, renderTree } from './testing/fixtures.js';

const fill = [{ paint: '#ff5c39' }];
const source = () => [
  shape('a', { [P.x]: 100, [P.y]: 100, [P.w]: 40, [P.h]: 20, [P.fills]: fill, [P.matchKey]: 'ka', 'style.inherit': { kit: { asset: 'as_kit' }, class: 'outline' } }),
  shape('c', { [P.shape]: 'star', [P.x]: 150, [P.y]: 100, [P.w]: 20, [P.h]: 20, [P.fills]: [{ paint: '@primary' }], [P.strokes]: [{ paint: '@ink', width: 2, align: 'inside' }], [P.effects]: '@shadow-md' }),
];

describe('newRepeatParams', () => {
  it('starts from the generator defaults and keeps the given values as written', () => {
    expect(newRepeatParams('grid', { rows: 2, count: 9, kind: 'radial' })).toMatchObject({ kind: 'grid', rows: 2, columns: 3 });
    expect(newRepeatParams('radial')).toEqual(defaultParams('radial'));
  });
});

describe.skipIf(!authoringBuilt)('repeat actions', () => {
  it('makes a repeat around siblings in one undo step; the elements stay put as the source', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, source());
    const ctx = f.rctx();
    const before = unwrap(elementBounds(ctx, 'a'));
    unwrap(commitRepeatEdit(f.target, human, 'Radial repeat', makeRepeat(ctx, ['c', 'a'], newRepeatParams('radial', { count: 5 }))));
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    expect(f.view.children('p1')).toEqual(['x1']);
    expect(f.view.read('x1')?.values).toMatchObject({ name: 'Radial repeat', [RP.kind]: 'radial', [RP.count]: 5, [P.matchKey]: 'lk_x1' });
    expect(f.view.sourceChildren('x1')).toEqual(['a', 'c']);
    expect(f.view.children('x1')).toHaveLength(5);
    expect(unwrap(elementBounds(ctx, 'a'))).toEqual(before);
    // the same action on the repeat switches its generator
    unwrap(commitRepeatEdit(f.target, human, 'Grid repeat', makeRepeat(ctx, ['x1'], newRepeatParams('grid', { rows: 2, columns: 2 }))));
    expect(f.view.children('x1')).toHaveLength(4);
    for (const [nodes, code] of [
      [[], 'IF-REP-003'],
      [['x1~1^a'], 'IF-REP-004'],
      [['p1'], 'IF-REP-003'],
    ] as const) {
      const r = makeRepeat(ctx, nodes, defaultParams('mirror'));
      expect(!r.ok && r.error.code, nodes.join()).toBe(code);
    }
    const loose = await createRepeatFixture(g, [...source(), shape('grp', {}, 'p1', 'group'), shape('in', { [P.w]: 5, [P.h]: 5 }, 'grp')]);
    const apart = makeRepeat(loose.rctx(), ['a', 'in'], defaultParams('mirror'));
    expect(!apart.ok && apart.error.code).toBe('IF-REP-003');
  });

  it('sets parameters, refuses bad ones (IF-REP-001/002) and derived targets, and releases', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [shape('r', { [RP.kind]: 'grid' }, 'p1', 'group'), ...source().map((op) => ({ ...op, parent: 'r' }) as typeof op)]);
    const ctx = f.rctx();
    const current = (n: string): RepeatParams | undefined => f.view.params(n);
    unwrap(commitRepeatEdit(f.target, human, 'Edit repeat', setRepeat(ctx, 'r', { columns: 4, gapX: 0 }), current));
    expect(f.view.children('r')).toHaveLength(12);
    const bad = commitRepeatEdit(f.target, human, 'Edit repeat', setRepeat(ctx, 'r', { rows: 0 }), current);
    expect(!bad.ok && bad.error.code).toBe('IF-REP-001');
    const many = commitRepeatEdit(f.target, human, 'Edit repeat', setRepeat(ctx, 'r', { rows: 100, columns: 100 }), current);
    expect(!many.ok && many.error.code).toBe('IF-REP-002');
    expect(!setRepeat(ctx, 'r', {}).ok).toBe(true);
    const derived = setRepeat(ctx, 'r~1^a', { count: 2 });
    expect(!derived.ok && derived.error.code).toBe('IF-REP-004');
    const plain = liveRepeat(ctx, 'a');
    expect(!plain.ok && plain.error.code).toBe('IF-REP-003');
    unwrap(commitRepeatEdit(f.target, human, 'Release repeat', releaseRepeat(ctx, 'r')));
    expect(f.view.children('r')).toEqual(['a', 'c']);
    expect(f.view.params('r')).toBeUndefined();
    expect(!releaseRepeat(ctx, 'r').ok).toBe(true);
  });

  it('projects instances incrementally: a source edit updates every copy, a count change creates and deletes them', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [shape('r', { [RP.kind]: 'radial', [RP.count]: 3, [RP.radius]: 80 }, 'p1', 'group'), ...source().map((op) => ({ ...op, parent: 'r' }) as typeof op)]);
    const projection = createElementRenderSource({ stage: f.view, geometry: g, kit: f.kit, root: 'p1' });
    const projector = createRenderProjector(ElementProjection, projection);
    projector.snapshot();
    expect(projector.slotOf('r~2^a')).toBeDefined();
    expect(projector.slotOf('r~2')).toBeDefined();
    f.seed([{ op: 'set', node: 'a', path: P.h, value: 30 }]);
    const edit = projection.changes();
    expect(edit?.updated.has('a')).toBe(true);
    expect(edit?.updated.has('r~1^a')).toBe(true);
    expect(edit?.updated.has('r~2^a')).toBe(true);
    projector.project(edit as NonNullable<typeof edit>);
    f.seed([{ op: 'set', node: 'r', path: RP.count, value: 5 }]);
    const grow = projection.changes();
    expect(grow?.created).toEqual(expect.arrayContaining(['r~3', 'r~4', 'r~4^a', 'r~4^c']));
    projector.project(grow as NonNullable<typeof grow>);
    f.seed([{ op: 'set', node: 'r', path: RP.count, value: 2 }]);
    const shrink = projection.changes();
    expect(shrink?.deleted).toEqual(expect.arrayContaining(['r~2', 'r~4', 'r~4^a', 'r~2^c']));
    expect(shrink?.updated.has('r~1')).toBe(true); // the step changed (count 5 → 2 around the circle)
    projection.dispose();
  });

  it('expand: one undo step, the render equals the live render, keys are deterministic and lineage is kept', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [shape('r', { [RP.kind]: 'radial', [RP.count]: 4, [RP.radius]: 60, [RP.startAngle]: 30, [P.matchKey]: 'kr' }, 'p1', 'group'), ...source().map((op) => ({ ...op, parent: 'r' }) as typeof op)]);
    const live = renderTree(f.view, g, f.kit);
    const liveKeys = keyTree(f.view, 'r');
    const ctx = f.rctx('e');
    const expanded = unwrap(expandRepeat(ctx, 'r'));
    unwrap(commitRepeatEdit(f.target, human, 'Expand repeat', ok(expanded.ops)));
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    expect(f.view.params('r')).toBeUndefined();
    expect(f.view.children('r')).toEqual(expanded.instances);
    expect(f.view.children(expanded.instances[0] as string)).toEqual(['a', 'c']); // the source moved, unchanged
    expect(f.view.isDerived(expanded.instances[1] as string)).toBe(false);
    expect(renderTree(f.view, g, f.kit)).toEqual(live);
    const keys = keyTree(f.view, 'r');
    // live keys show only where the source had one; expand keys every node (lk_<id> first, like duplicate)
    expect(keys.filter((k) => !k.includes('lk_c'))).toEqual(liveKeys.filter((k) => !k.endsWith(':-')));
    expect(keys).toContain('1:lk_c~3');
    expect(f.view.read('c')?.values[P.matchKey]).toBe('lk_c');
    // copies keep classes and tokens as written (lineage of the look, not just its pixels)
    const copyOfA = f.view.children(expanded.instances[2] as string)[0] as string;
    expect(f.stage.explain(copyOfA, P.strokes).winner?.arc).toBe('inherit');
    expect(f.stage.explain(f.view.children(expanded.instances[2] as string)[1] as string, P.effects).winner?.token).toBeDefined();
    // undo restores the live repeat; expanding again gives the same keys with fresh ids
    const undone = unwrap(await f.undo.undo(human, signal));
    expect(undone.kind).toBe('applied');
    expect(f.view.params('r')?.kind).toBe('radial');
    expect(renderTree(f.view, g, f.kit)).toEqual(live);
    unwrap(commitRepeatEdit(f.target, human, 'Expand repeat', ok(unwrap(expandRepeat(f.rctx('again'), 'r')).ops)));
    expect(f.view.children('r')[0]).toBe('again1');
    expect(keyTree(f.view, 'r')).toEqual(keys);
    const derived = expandRepeat(ctx, 'r~1');
    expect(!derived.ok).toBe(true);
  });

  it('composes with booleans (a union of all instances) and masks (each instance masked by its own mask)', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [
      shape('u', { [RP.kind]: 'grid', [RP.rows]: 1, [RP.columns]: 3, [RP.gapX]: -5, [P.boolean]: 'union', [P.fills]: fill }, 'p1', 'group'),
      shape('sq', { [P.x]: 0, [P.y]: 0, [P.w]: 20, [P.h]: 20, [P.fills]: fill }, 'u'),
    ]);
    const ctx = f.rctx();
    const union = unwrap(elementBounds(ctx, 'u'));
    expect(union.geometry.maxX).toBeCloseTo(50); // three 20 px squares overlapping by 5
    const tree = renderTree(f.view, g, f.kit);
    expect(tree).toHaveLength(1); // one boolean leaf; the instances are operands
    expect(tree[0]?.children).toEqual([]);
    expect(tree[0]?.path).toBeDefined();
    // the expanded union draws the same outline
    unwrap(commitRepeatEdit(f.target, human, 'Expand', ok(unwrap(expandRepeat(ctx, 'u')).ops)));
    expect(renderTree(f.view, g, f.kit)).toEqual(tree);
  });

  it('property: expand → render equals the live render for any parameters', async () => {
    const g = await loadGeometry();
    const arb = fc.oneof(
      fc.record({ kind: fc.constant('radial' as const), count: fc.integer({ min: 1, max: 8 }), radius: fc.integer({ min: 0, max: 200 }), startAngle: fc.integer({ min: -180, max: 180 }), sweep: fc.integer({ min: 1, max: 360 }), rotate: fc.boolean() }),
      fc.record({ kind: fc.constant('grid' as const), rows: fc.integer({ min: 1, max: 3 }), columns: fc.integer({ min: 1, max: 3 }), gapX: fc.integer({ min: -10, max: 30 }), gapY: fc.integer({ min: -10, max: 30 }), rowOffset: fc.integer({ min: -5, max: 5 }), columnOffset: fc.integer({ min: -5, max: 5 }), brick: fc.constantFrom('none' as const, 'rows' as const, 'columns' as const), brickShift: fc.constantFrom(0, 0.5) }),
      fc.record({ kind: fc.constant('mirror' as const), axis: fc.constantFrom('vertical' as const, 'horizontal' as const, 'angle' as const), angle: fc.integer({ min: -90, max: 90 }), offset: fc.integer({ min: -10, max: 10 }) }),
    );
    await fc.assert(
      fc.asyncProperty(arb, async (params: RepeatParams) => {
        const f = await createRepeatFixture(g, [shape('r', { [P.matchKey]: 'kr' }, 'p1', 'group'), ...source().map((op) => ({ ...op, parent: 'r' }) as typeof op)]);
        f.seed(repeatOps('r', params));
        const live = renderTree(f.view, g, f.kit);
        const liveKeys = keyTree(f.view, 'r').filter((k) => !k.endsWith(':-'));
        const first = unwrap(expandRepeat(f.rctx('one'), 'r'));
        const second = unwrap(expandRepeat(f.rctx('two'), 'r'));
        unwrap(commitRepeatEdit(f.target, human, 'Expand', ok(first.ops)));
        expect(renderTree(f.view, g, f.kit)).toEqual(live);
        const keys = keyTree(f.view, 'r');
        expect(keys.filter((k) => !k.includes('lk_c'))).toEqual(liveKeys);
        // re-expanding (from the same live state, other ids) writes the same keys in the same places
        const keyOps = (ops: typeof first.ops): string[] => ops.flatMap((op) => (op.op === 'create' ? [String(op.props?.[P.matchKey])] : op.op === 'set' && op.path === P.matchKey ? [String(op.value)] : []));
        expect(keyOps(second.ops)).toEqual(keyOps(first.ops));
      }),
      { numRuns: 25 },
    );
  });
});
