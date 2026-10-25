// @vitest-environment node
import type { Box } from '@staticflux/document/spatial-index';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { collectSnapTargets, formatDistance, NO_TARGETS, shiftBox, SNAP_EPSILON, type SnapLine, snapBox, snapPoint, type SnapTargets } from './snapping.js';
import { authoringBuilt, createToolFixture, shape, unwrap } from './testing/fixtures.js';

const b = (minX: number, minY: number, w: number, h: number): Box => ({ minX, minY, maxX: minX + w, maxY: minY + h });

/** Targets from plain boxes (siblings) and a container box. */
function targetsOf(boxes: readonly Box[], container?: Box): SnapTargets {
  const x: SnapLine[] = [];
  const y: SnapLine[] = [];
  boxes.forEach((box, i) => {
    const node = `n${i}`;
    for (const [value, kind] of [
      [box.minX, 'edge'],
      [(box.minX + box.maxX) / 2, 'center'],
      [box.maxX, 'edge'],
    ] as const)
      x.push({ value, kind, source: node, from: box.minY, to: box.maxY });
    for (const [value, kind] of [
      [box.minY, 'edge'],
      [(box.minY + box.maxY) / 2, 'center'],
      [box.maxY, 'edge'],
    ] as const)
      y.push({ value, kind, source: node, from: box.minX, to: box.maxX });
  });
  if (container !== undefined) {
    x.push({ value: (container.minX + container.maxX) / 2, kind: 'container-center', from: container.minY, to: container.maxY });
    y.push({ value: (container.minY + container.maxY) / 2, kind: 'container-center', from: container.minX, to: container.maxX });
  }
  return { x, y, boxes: boxes.map((box, i) => ({ node: `n${i}`, box })) };
}

describe('snapBox: lines', () => {
  it('snaps the nearest edge or centre within the threshold and reports every guide it touches', () => {
    const t = targetsOf([b(100, 100, 50, 50)], b(0, 0, 1000, 800));
    const r = snapBox(b(153, 300, 20, 20), t, { threshold: 5 });
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([{ kind: 'line', axis: 'x', value: 150, from: 100, to: 320, line: 'edge', source: 'n0' }]);
    const centre = snapBox(b(488, 388, 20, 20), t, { threshold: 5 });
    expect([centre.dx, centre.dy]).toEqual([2, 2]);
    expect(centre.guides.map((g) => g.kind === 'line' && g.line)).toEqual(['container-center', 'container-center']);
    expect(snapBox(b(300, 300, 20, 20), t, { threshold: 5 })).toEqual({ dx: 0, dy: 0, guides: [], labels: [] });
    expect(snapBox(b(153, 300, 20, 20), NO_TARGETS, { threshold: 5 }).dx).toBe(0);
  });

  it('restricts features (resize edges) and line kinds; snaps points', () => {
    const t = targetsOf([b(100, 100, 50, 50)]);
    expect(snapBox(b(80, 300, 72, 20), t, { threshold: 5, features: { x: ['max'], y: [] } }).dx).toBe(-2);
    expect(snapBox(b(80, 300, 72, 20), t, { threshold: 5, features: { x: ['min'], y: [] } }).dx).toBe(0);
    expect(snapBox(b(122, 300, 2, 2), t, { threshold: 5, kinds: ['edge'] }).dx).toBe(0);
    expect(snapBox(b(122, 300, 2, 2), t, { threshold: 5, kinds: ['center'] }).dx).toBe(1);
    expect(snapPoint(98, 151, t, { threshold: 3 })).toMatchObject({ dx: 2, dy: -1 });
    expect(formatDistance(24)).toBe('24');
    expect(formatDistance(-2.5)).toBe('2.5');
    expect(formatDistance(1 / 3)).toBe('0.33');
  });
});

describe('snapBox: equal spacing with distance labels', () => {
  it('centres a box between its row neighbours', () => {
    const t = targetsOf([b(0, 0, 100, 50), b(300, 0, 100, 50)]);
    const r = snapBox(b(173, 10, 50, 20), t, { threshold: 4 });
    expect(r.dx).toBeCloseTo(2, 9);
    const spacing = r.guides.find((g) => g.kind === 'spacing');
    expect(spacing).toMatchObject({ kind: 'spacing', axis: 'x', distance: 75 });
    expect(r.labels.map((l) => l.text)).toEqual(['75', '75']);
    expect(r.labels[0]).toMatchObject({ x: 137.5 });
  });

  it('repeats a gap that exists in the row', () => {
    const t = targetsOf([b(0, 0, 50, 50), b(80, 0, 50, 50)]);
    const r = snapBox(b(158, 0, 40, 50), t, { threshold: 3, kinds: [] });
    expect(r.dx).toBeCloseTo(2, 9);
    expect(r.guides).toEqual([expect.objectContaining({ kind: 'spacing', axis: 'x', distance: 30 })]);
    expect(r.labels).toHaveLength(2);
    const above = targetsOf([b(0, 0, 50, 50), b(0, 80, 50, 50)]);
    expect(snapBox(b(0, -71, 50, 40), above, { threshold: 3, kinds: [] }).dy).toBeCloseTo(1, 9);
    expect(snapBox(b(158, 0, 40, 50), t, { threshold: 3, kinds: [], spacing: false }).dx).toBe(0);
  });
});

/** A random scene of sibling boxes, a container, and a moving box. */
const sceneArb = fc.record({
  boxes: fc.array(fc.record({ x: fc.integer({ min: -400, max: 400 }), y: fc.integer({ min: -400, max: 400 }), w: fc.integer({ min: 1, max: 160 }), h: fc.integer({ min: 1, max: 160 }) }), { maxLength: 12 }),
  moving: fc.record({ x: fc.double({ min: -450, max: 450, noNaN: true }), y: fc.double({ min: -450, max: 450, noNaN: true }), w: fc.double({ min: 1, max: 160, noNaN: true }), h: fc.double({ min: 1, max: 160, noNaN: true }) }),
  threshold: fc.double({ min: 0.5, max: 12, noNaN: true }),
  spacing: fc.boolean(),
});

describe('snapping properties (fast-check)', () => {
  it('the snapped box is within the threshold of the input, and snapping it again does not move it (stable)', () => {
    fc.assert(
      fc.property(sceneArb, ({ boxes, moving, threshold, spacing }) => {
        const t = targetsOf(
          boxes.map((r) => b(r.x, r.y, r.w, r.h)),
          b(-500, -500, 1000, 1000),
        );
        const input = b(moving.x, moving.y, moving.w, moving.h);
        const r = snapBox(input, t, { threshold, spacing });
        expect(Math.abs(r.dx)).toBeLessThanOrEqual(threshold);
        expect(Math.abs(r.dy)).toBeLessThanOrEqual(threshold);
        const again = snapBox(shiftBox(input, r.dx, r.dy), t, { threshold, spacing });
        expect(Math.abs(again.dx)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(again.dy)).toBeLessThanOrEqual(1e-9);
        // Every line guide touches the snapped box.
        const snapped = shiftBox(input, r.dx, r.dy);
        for (const g of r.guides) {
          if (g.kind !== 'line') continue;
          const lo = g.axis === 'x' ? snapped.minX : snapped.minY;
          const hi = g.axis === 'x' ? snapped.maxX : snapped.maxY;
          expect([lo, (lo + hi) / 2, hi].some((v) => Math.abs(v - g.value) <= SNAP_EPSILON)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('a box already on a line stays there (no snap away from an exact match)', () => {
    fc.assert(
      fc.property(sceneArb, fc.nat(), ({ boxes, moving, threshold }, pick) => {
        fc.pre(boxes.length > 0);
        const t = targetsOf(boxes.map((r) => b(r.x, r.y, r.w, r.h)));
        const line = t.x[pick % t.x.length] as SnapLine;
        const input = b(line.value, moving.y, moving.w, moving.h);
        expect(snapBox(input, t, { threshold, spacing: false }).dx).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});

describe.skipIf(!authoringBuilt)('collectSnapTargets (B1 geometry and layout grids)', () => {
  it('collects sibling edges and centres, container lines and grid lines; excludes the moving elements', async () => {
    const f = await createToolFixture([
      shape('fr', { [P.x]: 100, [P.y]: 100, [P.w]: 400, [P.h]: 300, [P.grids]: [{ kind: 'columns', count: 2, gutter: 20, margin: 0, align: 'stretch' }] }, 'p1', 'frame'),
      shape('a', { [P.x]: 10, [P.y]: 10, [P.w]: 50, [P.h]: 50 }, 'fr'),
      shape('b', { [P.x]: 200, [P.y]: 10, [P.w]: 50, [P.h]: 50 }, 'fr'),
      shape('m', { [P.x]: 0, [P.y]: 0, [P.w]: 20, [P.h]: 20, [P.maskMode]: 'clip' }, 'fr'),
    ]);
    const t = unwrap(collectSnapTargets(f.ctx, { moving: ['a'] }));
    expect(t.boxes.map((x) => x.node)).toEqual(['b']);
    const xs = t.x.map((l) => `${l.kind}:${l.value}`);
    expect(xs).toEqual(expect.arrayContaining(['edge:300', 'center:325', 'edge:350', 'container-edge:100', 'container-center:300', 'container-edge:500', 'grid:290', 'grid:310']));
    expect(t.x.some((l) => l.source === 'a' || l.source === 'm')).toBe(false);
    const noGrid = unwrap(collectSnapTargets(f.ctx, { moving: ['a'], grids: false, extra: ['fr'] }));
    expect(noGrid.x.some((l) => l.kind === 'grid')).toBe(false);
    expect(noGrid.boxes.map((x) => x.node)).toEqual(['b', 'fr']);
    expect(unwrap(collectSnapTargets(f.ctx, { moving: [] }))).toBe(NO_TARGETS);
  });
});
