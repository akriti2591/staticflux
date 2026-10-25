// @vitest-environment node
import type { PartOp } from '@staticflux/document/v2';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import {
  canvasSelectable,
  comparePaintOrder,
  createElementIndex,
  elementsInPaintOrder,
  hitTest,
  hitTestBrute,
  isHittableLeaf,
  marqueeSelect,
  marqueeSelectBrute,
  paintOrder,
  rectFrom,
  selectionBounds,
  selectionTarget,
} from './hit-test.js';
import { authoringBuilt, createToolFixture, shape, unwrap } from './testing/fixtures.js';

describe('paint order and rectangles (no Wasm)', () => {
  it('compares paint-order keys and normalises rectangles', () => {
    expect(comparePaintOrder([0, 1], [0, 2])).toBeLessThan(0);
    expect(comparePaintOrder([0], [0, 0])).toBeLessThan(0);
    expect(comparePaintOrder([1], [0, 5])).toBeGreaterThan(0);
    expect(comparePaintOrder([2, 3], [2, 3])).toBe(0);
    expect(rectFrom(10, 20, 0, 5)).toEqual({ minX: 0, minY: 5, maxX: 10, maxY: 20 });
  });
});

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}, parent = 'p1', kind = 'shape'): PartOp =>
  shape(id, { [P.x]: x, [P.y]: y, [P.w]: w, [P.h]: h, [P.fills]: [{ paint: '#ff0000' }], ...extra }, parent, kind);

describe.skipIf(!authoringBuilt)('hit testing (rbush broad phase → exact geometry)', () => {
  it('finds the topmost exact hit: ellipse corners miss, strokes and tolerance hit, rotation counts', async () => {
    const f = await createToolFixture([
      rect('back', 0, 0, 300, 300),
      rect('ring', 100, 100, 100, 100, { [P.shape]: 'ellipse' }),
      rect('line', 400, 100, 100, 100, { [P.fills]: [], [P.strokes]: [{ paint: '#000', width: 4 }] }),
      rect('turned', 600, 100, 200, 20, { [P.rotation]: 90 }),
    ]);
    expect(unwrap(hitTest(f.ctx, f.index, 150, 150))).toEqual({ leaf: 'ring', target: 'ring', kind: 'fill' });
    expect(unwrap(hitTest(f.ctx, f.index, 103, 103))?.target).toBe('back');
    expect(unwrap(hitTest(f.ctx, f.index, 450, 150))).toBeUndefined();
    expect(unwrap(hitTest(f.ctx, f.index, 450, 101))).toMatchObject({ target: 'line', kind: 'stroke' });
    expect(unwrap(hitTest(f.ctx, f.index, 450, 95, { tolerance: 4 }))?.target).toBe('line');
    expect(unwrap(hitTest(f.ctx, f.index, 700, 50))?.target).toBe('turned');
    expect(unwrap(hitTest(f.ctx, f.index, 790, 110))).toBeUndefined();
    expect(unwrap(hitTest(f.ctx, f.index, 900, 700))).toBeUndefined();
    expect(f.index.stats.rebuilds).toBe(1);
  });

  it('hits a text element across its box, not only on its edge (B9: double click to edit inside the text)', async () => {
    const f = await createToolFixture([{ op: 'create', node: 'tx', kind: 'text', parent: 'p1', props: { [P.x]: 100, [P.y]: 400, [P.w]: 300, [P.h]: 60 } }]);
    expect(unwrap(hitTest(f.ctx, f.index, 250, 430))).toMatchObject({ target: 'tx', kind: 'fill' });
    expect(unwrap(hitTest(f.ctx, f.index, 250, 470))).toBeUndefined();
  });

  it('selects through frames, not into groups (Mod+click goes deep), and inside an entered container', async () => {
    const f = await createToolFixture([
      rect('fr', 0, 0, 400, 400, {}, 'p1', 'frame'),
      rect('inFrame', 10, 10, 100, 100, {}, 'fr'),
      shape('g', {}, 'fr', 'group'),
      rect('inGroup', 200, 200, 50, 50, {}, 'g'),
    ]);
    expect(unwrap(hitTest(f.ctx, f.index, 50, 50))?.target).toBe('inFrame');
    expect(unwrap(hitTest(f.ctx, f.index, 300, 50))?.target).toBe('fr');
    expect(unwrap(hitTest(f.ctx, f.index, 220, 220))).toEqual({ leaf: 'inGroup', target: 'g', kind: 'fill' });
    expect(unwrap(hitTest(f.ctx, f.index, 220, 220, { deep: true }))?.target).toBe('inGroup');
    expect(unwrap(hitTest(f.ctx, f.index, 220, 220, { context: 'g' }))?.target).toBe('inGroup');
    // Outside the entered container the root rules apply.
    expect(unwrap(hitTest(f.ctx, f.index, 50, 50, { context: 'g' }))?.target).toBe('inFrame');
    expect(selectionTarget(f.ctx, 'inGroup', 'p1', 'p1', false)).toBe('g');
    expect(selectionTarget(f.ctx, 'nope', 'p1', 'p1', false)).toBeUndefined();
  });

  it('honours frame clips, masks, booleans and full locks', async () => {
    const f = await createToolFixture([
      rect('clip', 0, 0, 100, 100, {}, 'p1', 'frame'),
      rect('spill', 50, 50, 200, 50, {}, 'clip'),
      shape('mg', {}, 'p1', 'group'),
      rect('mask', 300, 0, 50, 50, { [P.maskMode]: 'clip' }, 'mg'),
      rect('masked', 300, 0, 100, 100, {}, 'mg'),
      shape('bool', { [P.boolean]: 'subtract', [P.fills]: [{ paint: '#00f' }] }, 'p1', 'group'),
      rect('base', 500, 0, 100, 100, {}, 'bool'),
      rect('hole', 525, 25, 50, 50, {}, 'bool'),
      rect('under', 700, 0, 100, 100),
      rect('lockedTop', 700, 0, 100, 100, { [P.lockScope]: 'all' }),
    ]);
    expect(unwrap(hitTest(f.ctx, f.index, 75, 75))?.target).toBe('spill');
    expect(unwrap(hitTest(f.ctx, f.index, 150, 75))).toBeUndefined();
    expect(unwrap(hitTest(f.ctx, f.index, 320, 20))?.leaf).toBe('masked');
    expect(unwrap(hitTest(f.ctx, f.index, 380, 80))).toBeUndefined();
    expect(isHittableLeaf(f.ctx, 'mask')).toBe(false);
    expect(unwrap(hitTest(f.ctx, f.index, 510, 10))).toEqual({ leaf: 'bool', target: 'bool', kind: 'fill' });
    expect(unwrap(hitTest(f.ctx, f.index, 550, 50))).toBeUndefined();
    expect(isHittableLeaf(f.ctx, 'base')).toBe(false);
    expect(canvasSelectable(f.stage, 'lockedTop')).toBe(false);
    expect(unwrap(hitTest(f.ctx, f.index, 750, 50))?.target).toBe('under');
  });

  it('keeps the index current from stage invalidations (moves re-index subtrees; deletes drop)', async () => {
    const f = await createToolFixture([shape('g', {}, 'p1', 'group'), rect('a', 0, 0, 50, 50, {}, 'g'), rect('b', 100, 0, 50, 50)]);
    expect(unwrap(hitTest(f.ctx, f.index, 25, 25))?.target).toBe('g');
    f.seed([{ op: 'set', node: 'g', path: P.x, value: 500 }]);
    expect(unwrap(hitTest(f.ctx, f.index, 25, 25))).toBeUndefined();
    expect(unwrap(hitTest(f.ctx, f.index, 525, 25))?.leaf).toBe('a');
    f.seed([{ op: 'delete', node: 'b' }]);
    expect(unwrap(hitTest(f.ctx, f.index, 125, 25))).toBeUndefined();
    expect(f.index.index.has('b')).toBe(false);
    expect(f.index.stats.rebuilds).toBe(1);
    f.index.rebuild();
    expect(f.index.stats.rebuilds).toBe(2);
    const other = createElementIndex(f.ctx, 'p1');
    other.dispose();
    expect(other.index.size).toBe(0);
    await f.scope.dispose();
    expect(f.index.index.size).toBe(0);
  });

  it('keeps a group’s indexed bounds fresh when a child moves (ancestors are re-indexed, B8)', async () => {
    const f = await createToolFixture([shape('g', {}, 'p1', 'group'), rect('c', 0, 0, 50, 50, {}, 'g'), rect('d', 100, 0, 50, 50, {}, 'g')]);
    f.index.refresh();
    expect(f.index.index.get('g')?.maxX).toBeCloseTo(150, 0);
    f.seed([{ op: 'set', node: 'd', path: P.x, value: 400 }]);
    f.index.refresh();
    expect(f.index.index.get('g')?.maxX).toBeCloseTo(450, 0);
    expect(f.index.index.hit(425, 25)).toEqual(expect.arrayContaining(['g', 'd']));
    await f.scope.dispose();
  });

  it('marquee: touch picks what the rectangle meets (exact geometry), contain what lies inside; per entered container', async () => {
    const f = await createToolFixture([
      rect('a', 0, 0, 100, 100, { [P.shape]: 'ellipse' }),
      rect('b', 200, 0, 100, 100),
      shape('g', {}, 'p1', 'group'),
      rect('c', 400, 0, 50, 50, {}, 'g'),
      rect('d', 500, 0, 50, 50, {}, 'g'),
      rect('locked', 600, 0, 50, 50, { [P.lockScope]: 'all' }),
    ]);
    expect(unwrap(marqueeSelect(f.ctx, f.index, rectFrom(-10, -10, 5, 5)))).toEqual([]);
    expect(unwrap(marqueeSelect(f.ctx, f.index, rectFrom(50, 40, 250, 60)))).toEqual(['a', 'b']);
    expect(unwrap(marqueeSelect(f.ctx, f.index, rectFrom(150, -10, 700, 200)))).toEqual(['b', 'g']);
    expect(unwrap(marqueeSelect(f.ctx, f.index, rectFrom(150, -10, 520, 200), { mode: 'contain' }))).toEqual(['b']);
    expect(unwrap(marqueeSelect(f.ctx, f.index, rectFrom(150, -10, 700, 200), { context: 'g' }))).toEqual(['c', 'd']);
    const sb = unwrap(selectionBounds(f.ctx, ['b', 'c']));
    expect([sb?.minX, sb?.minY, sb?.maxX, sb?.maxY].map((v) => Math.round((v ?? Number.NaN) * 1e6) / 1e6)).toEqual([200, 0, 450, 100]);
    expect(unwrap(selectionBounds(f.ctx, []))).toBeUndefined();
  });
});

/** A random scene: shapes, frames and groups (nested), rotations, strokes, ellipses, stars, full locks. */
const nodeArb = fc.record({
  kind: fc.constantFrom('shape', 'shape', 'shape', 'frame', 'group'),
  parent: fc.nat(),
  x: fc.integer({ min: 0, max: 500 }),
  y: fc.integer({ min: 0, max: 500 }),
  w: fc.integer({ min: 4, max: 220 }),
  h: fc.integer({ min: 4, max: 220 }),
  rotation: fc.constantFrom(0, 0, 30, 90, -45),
  form: fc.constantFrom('rect', 'ellipse', 'star'),
  fill: fc.boolean(),
  stroke: fc.constantFrom(0, 0, 2, 8),
  locked: fc.constantFrom(false, false, false, true),
});

type NodeSpec = typeof nodeArb extends fc.Arbitrary<infer T> ? T : never;

function sceneOps(nodes: readonly NodeSpec[]): PartOp[] {
  const containers = ['p1'];
  return nodes.map((n, i) => {
    const id = `n${i}`;
    const parent = containers[n.parent % containers.length] as string;
    if (n.kind !== 'shape') containers.push(id);
    const props: Record<string, unknown> = { [P.x]: n.x, [P.y]: n.y, [P.w]: n.w, [P.h]: n.h, [P.rotation]: n.rotation };
    if (n.kind === 'shape') props[P.shape] = n.form;
    if (n.fill || n.kind === 'frame') props[P.fills] = [{ paint: '#336699' }];
    if (n.stroke > 0) props[P.strokes] = [{ paint: '#000000', width: n.stroke, align: 'center' }];
    if (n.locked) props[P.lockScope] = 'all';
    return shape(id, props, parent, n.kind);
  });
}

describe.skipIf(!authoringBuilt)('hit-testing parity: broad + narrow phase ≡ brute force (fast-check)', () => {
  it('point hits agree on random scenes, points, tolerances, contexts and deep selection', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nodeArb, { minLength: 1, maxLength: 18 }),
        fc.array(fc.record({ x: fc.double({ min: -20, max: 800, noNaN: true }), y: fc.double({ min: -20, max: 800, noNaN: true }), tolerance: fc.constantFrom(0, 0, 3), deep: fc.boolean(), context: fc.nat() }), { minLength: 1, maxLength: 25 }),
        async (nodes, points) => {
          const f = await createToolFixture(sceneOps(nodes));
          const all = elementsInPaintOrder(f.stage, 'p1');
          const contexts = ['p1', ...all.filter((n) => f.stage.read(n)?.kind !== 'shape')];
          for (const p of points) {
            const options = { tolerance: p.tolerance, deep: p.deep, context: contexts[p.context % contexts.length] as string };
            const fast = unwrap(hitTest(f.ctx, f.index, p.x, p.y, options));
            const brute = unwrap(hitTestBrute(f.ctx, 'p1', p.x, p.y, options));
            expect(fast).toEqual(brute);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('a point a denormal outside an edge agrees with brute force (the narrow phase rounds it onto the edge)', async () => {
    const base = { parent: 0, x: 0, y: 0, w: 4, h: 4, rotation: 0, form: 'rect', fill: false, stroke: 0, locked: false } as const;
    const f = await createToolFixture(sceneOps([{ ...base, kind: 'frame' }, { ...base, kind: 'shape' }]));
    for (const [x, y] of [[0, -5e-324], [-5e-324, 0], [4, 4 + 1e-12]] as const) {
      expect(unwrap(hitTest(f.ctx, f.index, x, y))).toEqual(unwrap(hitTestBrute(f.ctx, 'p1', x, y)));
    }
  });

  it('a thick stroke on a sharp corner is indexed as far as the stroke hit reaches (miter outline stops short)', async () => {
    const star = { kind: 'shape', parent: 0, x: 0, y: 1, w: 4, h: 10, rotation: 0, form: 'star', fill: false, stroke: 8, locked: false } as const;
    const f = await createToolFixture(sceneOps([star]));
    expect(unwrap(hitTest(f.ctx, f.index, 0, 0))).toEqual(unwrap(hitTestBrute(f.ctx, 'p1', 0, 0)));
  });

  it('marquee results agree with brute force (touch and contain)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nodeArb, { minLength: 1, maxLength: 18 }),
        fc.array(fc.record({ ax: fc.integer({ min: -20, max: 800 }), ay: fc.integer({ min: -20, max: 800 }), bx: fc.integer({ min: -20, max: 800 }), by: fc.integer({ min: -20, max: 800 }), contain: fc.boolean() }), { minLength: 1, maxLength: 8 }),
        async (nodes, rects) => {
          const f = await createToolFixture(sceneOps(nodes));
          for (const r of rects) {
            const box = rectFrom(r.ax, r.ay, r.bx, r.by);
            const options = { mode: r.contain ? ('contain' as const) : ('touch' as const) };
            expect(unwrap(marqueeSelect(f.ctx, f.index, box, options))).toEqual(unwrap(marqueeSelectBrute(f.ctx, 'p1', box, options)));
          }
          // After moving the first node, the index still agrees.
          f.seed([{ op: 'set', node: 'n0', path: P.x, value: 333 }]);
          const box = rectFrom(0, 0, 800, 800);
          expect(unwrap(marqueeSelect(f.ctx, f.index, box))).toEqual(unwrap(marqueeSelectBrute(f.ctx, 'p1', box)));
          for (const n of elementsInPaintOrder(f.stage, 'p1')) expect(paintOrder(f.stage, n).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 40 },
    );
  });
});
