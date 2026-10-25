// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  align,
  ALIGN_EDGES,
  applyToken,
  booleanGroup,
  centerInContainer,
  commitEdit,
  distribute,
  duplicate,
  flatten,
  localValues,
  outlineStroke,
  releaseBoolean,
  releaseMask,
  setBooleanOp,
  setMask,
  tidyUp,
  useAsMask,
} from './actions.js';
import { P } from './components.js';
import { elementBounds } from './layout.js';
import { resolveElement } from './resolve.js';
import { agent, authoringBuilt, createFixture, human, loadGeometry, PAGE, shape, signal, unwrap } from './testing/fixtures.js';

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}, parent = 'p1') => shape(id, { [P.x]: x, [P.y]: y, [P.w]: w, [P.h]: h, [P.fills]: [{ paint: '#ff5c39' }], ...extra }, parent);

describe.skipIf(!authoringBuilt)('element actions', () => {
  it('aligns every edge to the selection with exact geometry (rotation included), as one undo step', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 10, 10, 100, 50), rect('b', 300, 200, 40, 40, { [P.rotation]: 45 }), rect('c', 50, 400, 20, 80)]);
    const ctx = f.ctx(g);
    const target = { undo: f.undo, stage: f.stage, part: PAGE };
    for (const edge of ALIGN_EDGES) expect(unwrap(align(ctx, ['a', 'b', 'c'], edge)).length).toBeGreaterThan(0);
    unwrap(commitEdit(target, human, 'Align left', align(ctx, ['a', 'b', 'c'], 'left')));
    const lefts = ['a', 'b', 'c'].map((n) => unwrap(elementBounds(ctx, n)).geometry.minX);
    for (const v of lefts) expect(v).toBeCloseTo(10, 9);
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    const bottom = align(ctx, ['a', 'b', 'c'], 'bottom');
    unwrap(commitEdit(target, human, 'Align bottom', bottom));
    for (const n of ['a', 'b', 'c']) expect(unwrap(elementBounds(ctx, n)).geometry.maxY).toBeCloseTo(480, 9);
    expect(f.undo.history(human.id).undo).toHaveLength(2);
    expect(align(ctx, ['a'], 'left').ok).toBe(false); // selection alignment needs two
  });

  it('aligns to the container, the page or a key object; centre in container is one action', async () => {
    const g = await loadGeometry();
    const f = await createFixture([shape('fr', { [P.x]: 100, [P.y]: 100, [P.w]: 400, [P.h]: 200 }, 'p1', 'frame'), rect('a', 0, 0, 100, 50, {}, 'fr'), rect('k', 600, 600, 50, 50)]);
    const ctx = f.ctx(g);
    f.seed(unwrap(centerInContainer(ctx, ['a'])));
    expect(unwrap(elementBounds(ctx, 'a')).center).toEqual([300, 200]);
    f.seed(unwrap(align(ctx, ['a'], 'right', { kind: 'page' })));
    expect(unwrap(elementBounds(ctx, 'a')).geometry.maxX).toBe(1000);
    f.seed(unwrap(align(ctx, ['a', 'k'], 'top', { kind: 'key', node: 'k' })));
    expect(unwrap(elementBounds(ctx, 'a')).geometry.minY).toBe(600);
    expect(unwrap(elementBounds(ctx, 'k')).geometry.minY).toBe(600); // the key object stays
    expect(align(ctx, ['k'], 'left', { kind: 'container' }).ok).toBe(true);
  });

  it('distributes by equal gaps and by centres; tidies a rough grid', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 10, 10), rect('b', 13, 0, 30, 10), rect('c', 100, 0, 20, 10), rect('d', 150, 0, 10, 10)]);
    const ctx = f.ctx(g);
    f.seed(unwrap(distribute(ctx, ['a', 'b', 'c', 'd'], 'x', 'spacing')));
    const xs = ['a', 'b', 'c', 'd'].map((n) => unwrap(elementBounds(ctx, n)).geometry);
    const gaps = xs.slice(1).map((b, i) => b.minX - (xs[i]?.maxX ?? 0));
    for (const gap of gaps) expect(gap).toBeCloseTo(30, 9);
    expect(xs[0]?.minX).toBe(0);
    expect(xs[3]?.maxX).toBe(160);
    f.seed(unwrap(distribute(ctx, ['a', 'b', 'c', 'd'], 'x', 'centers')));
    const centers = ['a', 'b', 'c', 'd'].map((n) => unwrap(elementBounds(ctx, n)).center[0]);
    expect(centers[1]! - centers[0]!).toBeCloseTo(centers[3]! - centers[2]!, 9);
    expect(distribute(ctx, ['a', 'b'], 'y', 'spacing').ok).toBe(false);

    const t = await createFixture([rect('p', 3, 2, 40, 40), rect('q', 70, 8, 40, 40), rect('r', 0, 66, 40, 40), rect('s', 77, 70, 40, 40)]);
    const tctx = t.ctx(g);
    t.seed(unwrap(tidyUp(tctx, ['p', 'q', 'r', 's'])));
    const pos = ['p', 'q', 'r', 's'].map((n) => unwrap(elementBounds(tctx, n)).geometry);
    expect(pos[0]?.minY).toBe(pos[1]?.minY);
    expect(pos[2]?.minY).toBe(pos[3]?.minY);
    expect(pos[0]?.minX).toBe(pos[2]?.minX);
    expect(pos[1]!.minX - pos[0]!.maxX).toBeCloseTo(pos[3]!.minX - pos[2]!.maxX, 9);
  });

  it('respects locks: position-locked elements stay put; a content lock rejects the change set', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 10, 10), rect('b', 50, 50, 10, 10, { [P.lockScope]: 'position' }), rect('c', 80, 80, 10, 10, { [P.lockScope]: 'all' })]);
    const ctx = f.ctx(g);
    const ops = unwrap(align(ctx, ['a', 'b'], 'left'));
    expect(ops.every((op) => op.op === 'set' && op.node === 'a')).toBe(true);
    const target = { undo: f.undo, stage: f.stage, part: PAGE };
    const locked = commitEdit(target, human, 'Recolour', applyToken(ctx, ['c'], 'fill', '@primary'));
    expect(!locked.ok && locked.error.code).toBe('SF-STAGE-001');
    const policy = await createFixture([rect('x', 0, 0, 10, 10, { [P.lockPolicy]: { by: { asset: 'as_kit' }, reason: 'Brand' } })]);
    const refused = commitEdit({ undo: policy.undo, stage: policy.stage, part: PAGE }, agent, 'Unlock', { ok: true, value: [{ op: 'set', node: 'x', path: P.lockPolicy, value: null }] });
    expect(!refused.ok && refused.error.code).toBe('SF-STAGE-002');
    expect(commitEdit(target, human, 'Nothing', { ok: true, value: [] }).ok).toBe(false);
    const invalid = commitEdit(target, human, 'Bad', { ok: true, value: [{ op: 'set', node: 'a', path: P.fills, value: 'red' }] });
    expect(!invalid.ok && invalid.error.code).toBe('IF-EL-001');
  });

  it('booleans are live groups; change op, release, flatten', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 100, 100), rect('b', 50, 50, 100, 100, { [P.fills]: [{ paint: '#000' }] })]);
    const ctx = f.ctx(g);
    f.seed(unwrap(booleanGroup(ctx, ['b', 'a'], 'union')));
    const group = f.stage.children('p1')[0] as string;
    expect(f.stage.children(group)).toEqual(['a', 'b']);
    expect(resolveElement(f.stage, group, f.kit)?.geometry).toEqual({ kind: 'boolean', op: 'union' });
    expect(f.stage.value(group, P.fills)).toEqual([{ paint: '#ff5c39' }]); // the bottom operand's style
    expect(unwrap(elementBounds(ctx, group)).geometry).toEqual({ minX: 0, minY: 0, maxX: 150, maxY: 150 });
    f.seed(unwrap(setBooleanOp(ctx, group, 'intersect')));
    expect(unwrap(elementBounds(ctx, group)).geometry).toEqual({ minX: 50, minY: 50, maxX: 100, maxY: 100 });
    // operands stay editable: moving one changes the derived result
    f.seed([{ op: 'set', node: 'b', path: P.x, value: 75 }]);
    expect(unwrap(elementBounds(ctx, group)).geometry.minX).toBe(75);
    f.seed(unwrap(releaseBoolean(ctx, group)));
    expect(f.stage.children('p1')).toEqual(['a', 'b']);
    f.seed(unwrap(booleanGroup(ctx, ['a', 'b'], 'subtract')));
    const sub = f.stage.children('p1')[0] as string;
    f.seed(unwrap(flatten(ctx, sub)));
    const vector = f.stage.children('p1')[0] as string;
    expect(f.stage.read(vector)?.kind).toBe('vector');
    expect(unwrap(elementBounds(ctx, vector)).geometry).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(typeof f.stage.value(vector, P.path)).toBe('string');
    expect(booleanGroup(ctx, ['a'], 'union').ok).toBe(false);
    expect(setBooleanOp(ctx, 'nope', 'union').ok).toBe(false);
  });

  it('outline stroke turns each stroke into a filled vector; the element keeps its fills or goes', async () => {
    const g = await loadGeometry();
    const f = await createFixture([
      rect('a', 0, 0, 100, 100, { [P.strokes]: [{ paint: '@ink', width: 4, align: 'inside' }], [P.matchKey]: 'lk_a' }),
      shape('b', { [P.w]: 50, [P.h]: 50, [P.strokes]: [{ paint: '#000', width: 2 }] }),
    ]);
    const ctx = f.ctx(g);
    f.seed(unwrap(outlineStroke(ctx, 'a')));
    expect(f.stage.value('a', P.strokes)).toEqual([]);
    const ring = f.stage.children('p1').find((n) => f.stage.read(n)?.kind === 'vector') as string;
    expect(f.stage.value(ring, P.fills)).toEqual([{ paint: '@ink', opacity: 1, blend: 'normal' }]);
    expect(f.stage.value(ring, P.matchKey)).toBe('lk_a/stroke');
    expect(unwrap(elementBounds(ctx, ring)).geometry).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    f.seed(unwrap(outlineStroke(ctx, 'b')));
    expect(f.stage.read('b')).toBeUndefined();
    expect(outlineStroke(ctx, 'a').ok).toBe(false);
  });

  it('masks: use as mask (grouped), change mode and invert, release restores everything', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('photo', 0, 0, 200, 200), shape('circle', { [P.shape]: 'ellipse', [P.w]: 100, [P.h]: 100 })]);
    const ctx = f.ctx(g);
    f.seed(unwrap(useAsMask(ctx, ['photo', 'circle'], 'clip')));
    const group = f.stage.children('p1')[0] as string;
    expect(f.stage.children(group)).toEqual(['photo', 'circle']);
    expect(f.stage.value('photo', P.maskMode)).toBe('clip'); // bottom-most masks the rest
    f.seed(unwrap(setMask(ctx, 'photo', 'luminance', true)));
    expect(resolveElement(f.stage, 'photo', f.kit)?.mask).toEqual({ mode: 'luminance', invert: true });
    f.seed(unwrap(releaseMask(ctx, 'photo')));
    expect(resolveElement(f.stage, 'photo', f.kit)?.mask).toBeUndefined();
    expect(f.stage.value('circle', P.w)).toBe(100);
    expect(releaseMask(ctx, 'photo').ok).toBe(false);
    expect(useAsMask(ctx, ['photo']).ok).toBe(false);
    expect(setMask(ctx, 'nope', 'clip').ok).toBe(false);
  });

  it('applies brand tokens by type', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 10, 10), shape('b', {})]);
    const ctx = f.ctx(g);
    f.seed(unwrap(applyToken(ctx, ['a', 'b'], 'fill', '@primary')));
    expect(f.stage.value('b', P.fills)).toEqual([{ paint: '#ff5c39' }].map(() => ({ paint: '@primary' })));
    f.seed(unwrap(applyToken(ctx, ['a'], 'stroke', '@ink')));
    expect(f.stage.value('a', P.strokes)).toEqual([{ paint: '@ink', width: 1 }]);
    f.seed(unwrap(applyToken(ctx, ['a'], 'radius', '@radius-md')));
    expect(f.stage.value('a', P.radius)).toBe(12);
    f.seed(unwrap(applyToken(ctx, ['a'], 'effects', '@shadow-md')));
    expect(resolveElement(f.stage, 'a', f.kit)?.effects).toHaveLength(1);
    const wrongType = applyToken(ctx, ['a'], 'radius', '@primary');
    expect(!wrongType.ok && wrongType.error.code).toBe('IF-EL-002');
    expect(applyToken(ctx, [], 'fill', '@primary').ok).toBe(false);
    const { kit: _kit, ...noKit } = ctx;
    expect(applyToken(noKit, ["a"], "fill", "@primary").ok).toBe(false);
  });

  it('duplicate keeps match keys (fresh ids), also for a page subtree, and is one change set', async () => {
    const g = await loadGeometry();
    const f = await createFixture([rect('a', 0, 0, 10, 10, { [P.matchKey]: 'lk_hero' }), rect('b', 20, 0, 10, 10)]);
    const ctx = f.ctx(g);
    const dup = unwrap(duplicate(ctx, ['a', 'b'], [5, 5]));
    unwrap(commitEdit({ undo: f.undo, stage: f.stage, part: PAGE }, human, 'Duplicate', { ok: true, value: dup.ops }));
    const copyA = dup.copies.get('a') as string;
    const copyB = dup.copies.get('b') as string;
    expect(copyA).not.toBe('a');
    expect(f.stage.value(copyA, P.matchKey)).toBe('lk_hero');
    expect(f.stage.value(copyA, P.x)).toBe(5);
    expect(f.stage.value(copyB, P.matchKey)).toBe(f.stage.value('b', P.matchKey)); // the source got a key too
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    const page = unwrap(duplicate(ctx, ['p1']));
    const copyPage = page.copies.get('p1') as string;
    f.seed(page.ops);
    expect(f.stage.read(copyPage)?.kind).toBe('page');
    const children = f.stage.children(copyPage);
    expect(children.map((c) => f.stage.value(c, P.matchKey))).toEqual(f.stage.children('p1').map((c) => f.stage.value(c, P.matchKey)));
    expect(localValues(f.stage, 'missing')).toEqual({});
    expect(duplicate(ctx, ['missing']).ok).toBe(false);
    expect(signal.aborted).toBe(false);
  });
});
