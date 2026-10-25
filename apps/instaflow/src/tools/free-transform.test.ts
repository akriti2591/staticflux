// @vitest-environment node
/**
 * B10a transform maths without Wasm: start snapshots built from boxes (`boxTransform`), so the properties run on
 * rotated, skewed, flipped and nested (rotated-parent) elements alike.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Affine, applyAffine, boxTransform, type ElementBox, IDENTITY, multiply } from '../elements/resolve.js';
import {
  CENTER_PIVOT,
  flipValues,
  frameBasis,
  inFrame,
  isCenterPivot,
  numericValues,
  pivotFraction,
  pivotPoint,
  REFERENCE_POINTS,
  SKEW_LIMIT,
  SKEW_STEP,
  skewByValues,
  skewValues,
  snapPivot,
  transformModel,
} from './free-transform.js';
import { aboutPoint, type ElementStart, framePoint, type Point, resizeValues, rotateValues, type SelectionFrame, type SpatialValues, startAfter, type TransformStart, transformValues, valuesForTransform } from './transform.js';

const BOX: ElementBox = { x: 0, y: 0, w: 100, h: 50, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, flipX: false, flipY: false, skewX: 0 };

function element(node: string, box: Partial<ElementBox>, parent: Affine = IDENTITY): ElementStart {
  const b = { ...BOX, ...box };
  return startAfter({ node, box: b, transform: multiply(parent, boxTransform(b)), parent, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }, { node, x: b.x, y: b.y });
}

const cornersOf = (e: ElementStart): [Point, Point, Point, Point] => [
  applyAffine(e.transform, 0, 0),
  applyAffine(e.transform, e.box.w, 0),
  applyAffine(e.transform, e.box.w, e.box.h),
  applyAffine(e.transform, 0, e.box.h),
];

/** A start snapshot as `captureTransform` would take it (one element: its own frame; several: the union bounds). */
function startOf(elements: readonly ElementStart[]): TransformStart {
  if (elements.length === 1) {
    const e = elements[0] as ElementStart;
    const corners = cornersOf(e);
    return { elements, locked: [], frame: { corners, rotation: (Math.atan2(e.transform[1], e.transform[0]) * 180) / Math.PI, bounds: e.bounds, center: [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2] } };
  }
  const b = { minX: Math.min(...elements.map((e) => e.bounds.minX)), minY: Math.min(...elements.map((e) => e.bounds.minY)), maxX: Math.max(...elements.map((e) => e.bounds.maxX)), maxY: Math.max(...elements.map((e) => e.bounds.maxY)) };
  const frame: SelectionFrame = {
    corners: [
      [b.minX, b.minY],
      [b.maxX, b.minY],
      [b.maxX, b.maxY],
      [b.minX, b.maxY],
    ],
    rotation: 0,
    bounds: b,
    center: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2],
  };
  return { elements, locked: [], frame };
}

/** The snapshot after values (what the next gesture or command would capture). */
const after = (start: TransformStart, values: readonly SpatialValues[]): TransformStart => startOf(start.elements.map((e, i) => startAfter(e, values[i] as SpatialValues)));

const expectAffine = (a: Affine, b: Affine, digits = 6): void => {
  for (let i = 0; i < 6; i++) expect(a[i]).toBeCloseTo(b[i] as number, digits);
};
const expectPoint = (a: Point, b: Point, digits = 6): void => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

const arbBox = fc.record({
  x: fc.double({ min: -500, max: 500, noNaN: true }),
  y: fc.double({ min: -500, max: 500, noNaN: true }),
  w: fc.double({ min: 5, max: 400, noNaN: true }),
  h: fc.double({ min: 5, max: 400, noNaN: true }),
  rotation: fc.double({ min: -179, max: 179, noNaN: true }),
  skewX: fc.double({ min: -50, max: 50, noNaN: true }),
  flipX: fc.boolean(),
  flipY: fc.boolean(),
  anchorX: fc.double({ min: 0, max: 1, noNaN: true }),
  anchorY: fc.double({ min: 0, max: 1, noNaN: true }),
});
/** A parent transform: identity, or a rotated, scaled group (nested elements). */
const arbParent = fc.oneof(
  fc.constant(IDENTITY),
  fc.record({ r: fc.double({ min: -3, max: 3, noNaN: true }), s: fc.double({ min: 0.5, max: 2, noNaN: true }), tx: fc.double({ min: -100, max: 100, noNaN: true }) }).map(({ r, s, tx }): Affine => [Math.cos(r) * s, Math.sin(r) * s, -Math.sin(r) * s, Math.cos(r) * s, tx, 20]),
);
const arbPivot = fc.tuple(fc.double({ min: -0.5, max: 1.5, noNaN: true }), fc.double({ min: -0.5, max: 1.5, noNaN: true })) as fc.Arbitrary<Point>;
const arbAxis = fc.constantFrom('horizontal' as const, 'vertical' as const);

describe('valuesForTransform (affine → box)', () => {
  it('gives back the box for its own transform and lands every corner where a page affine sends it', () => {
    fc.assert(
      fc.property(arbBox, arbParent, fc.double({ min: -3, max: 3, noNaN: true }), fc.double({ min: 0.3, max: 3, noNaN: true }), fc.double({ min: -0.8, max: 0.8, noNaN: true }), fc.boolean(), (box, parent, r, k, shear, mirror) => {
        const e = element('a', box, parent);
        const same = valuesForTransform(e, e.transform);
        expect(same.rotation).toBeCloseTo(box.rotation, 6);
        expect(same.skewX).toBeCloseTo(box.skewX, 6);
        expect([same.flipX, same.flipY]).toEqual([box.flipX, box.flipY]);
        expect(same.x).toBeCloseTo(box.x, 6);
        expect(same.w).toBeCloseTo(box.w, 6);
        // Any non-singular page affine (rotation · scale · shear · mirror) about a point.
        const lin: Affine = multiply([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0], multiply([k * (mirror ? -1 : 1), 0, shear, 1 / k, 0, 0], IDENTITY));
        const g = aboutPoint(lin, [37, -12]);
        const moved = startAfter(e, valuesForTransform(e, multiply(g, e.transform)));
        const want = cornersOf(e).map(([x, y]) => applyAffine(g, x, y));
        cornersOf(moved).forEach((c, i) => expectPoint(c, want[i] as Point, 5));
      }),
    );
  });

  it('keeps a flip a flip (not a 180° turn) and changes nothing for a singular affine', () => {
    const e = element('a', { rotation: 30 });
    const flipped = valuesForTransform(e, multiply(e.transform, aboutPoint([-1, 0, 0, 1, 0, 0], [50, 25])));
    expect(flipped.flipX).toBe(true);
    expect(flipped.rotation).toBeCloseTo(30, 9);
    expect(valuesForTransform(e, [0, 0, 0, 0, 1, 1])).toEqual({ node: 'a', x: 0, y: 0 });
  });
});

describe('flip (IF-34.1)', () => {
  it('flipping twice is the identity, about any pivot, on rotated, skewed and nested elements', () => {
    fc.assert(
      fc.property(arbBox, arbParent, arbPivot, arbAxis, (box, parent, pivot, axis) => {
        const start = startOf([element('a', box, parent)]);
        const once = after(start, flipValues(start, axis, pivot));
        const e1 = once.elements[0] as ElementStart;
        // One flip toggles exactly one flag and keeps the rotation (own axes).
        expect(e1.box.rotation).toBeCloseTo(box.rotation, 6);
        expect(axis === 'horizontal' ? e1.box.flipX !== box.flipX : e1.box.flipY !== box.flipY).toBe(true);
        const twice = after(once, flipValues(once, axis, pivot));
        const e2 = twice.elements[0] as ElementStart;
        expectAffine(e2.transform, (start.elements[0] as ElementStart).transform, 5);
        expect([e2.box.flipX, e2.box.flipY]).toEqual([box.flipX, box.flipY]);
        expect(e2.box.skewX).toBeCloseTo(box.skewX, 6);
      }),
    );
  });

  it('a multi-selection mirrors over its centre on the page axes (twice is the identity)', () => {
    fc.assert(
      fc.property(arbBox, arbBox, arbAxis, (a, b) => {
        const start = startOf([element('a', a), element('b', b)]);
        const once = after(start, flipValues(start, 'horizontal'));
        expectPoint(once.frame.center, start.frame.center, 5);
        const twice = after(once, flipValues(once, 'horizontal'));
        twice.elements.forEach((e, i) => expectAffine(e.transform, (start.elements[i] as ElementStart).transform, 5));
      }),
    );
  });
});

describe('skew (IF-34.3–34.4)', () => {
  it('skew then the inverse skew restores (one element, any pivot; horizontal)', () => {
    fc.assert(
      fc.property(arbBox, arbParent, arbPivot, fc.double({ min: -30, max: 30, noNaN: true }), (box, parent, pivot, degrees) => {
        const start = startOf([element('a', { ...box, skewX: box.skewX * 0.5 }, parent)]);
        const skewed = after(start, skewByValues(start, degrees, 0, pivot));
        // The pivot stays put.
        expectPoint(pivotPoint(skewed.frame, pivot), pivotPoint(start.frame, pivot), 5);
        const back = after(skewed, skewByValues(skewed, -degrees, 0, pivot));
        expectAffine((back.elements[0] as ElementStart).transform, (start.elements[0] as ElementStart).transform, 5);
      }),
    );
  });

  it('skew then the inverse skew restores (several elements about a page point; both axes)', () => {
    fc.assert(
      fc.property(arbBox, arbBox, fc.constantFrom('x' as const, 'y' as const), fc.double({ min: -30, max: 30, noNaN: true }), (a, b, axis, degrees) => {
        const start = startOf([element('a', a), element('b', b)]);
        const at: Point = [12, -40];
        const by = (s: TransformStart, d: number) => skewByValues(s, axis === 'x' ? d : 0, axis === 'y' ? d : 0, pivotFraction(s.frame, at));
        const back = after(after(start, by(start, degrees)), by(after(start, by(start, degrees)), -degrees));
        back.elements.forEach((e, i) => expectAffine(e.transform, (start.elements[i] as ElementStart).transform, 5));
      }),
    );
  });

  it('a side handle leans its edge by the drag over the distance to the opposite edge, snaps with Shift and stops at the limit', () => {
    const start = startOf([element('a', { w: 100, h: 50 })]);
    // Top handle 25 right: the top edge leans over the bottom one (atan(25 / 50) to the left of vertical).
    const n = after(start, skewValues(start, 'n', 25, 0));
    expect(n.elements[0]?.box.skewX).toBeCloseTo((-Math.atan(0.5) * 180) / Math.PI, 9);
    expectPoint(cornersOf(n.elements[0] as ElementStart)[3], [0, 50], 9); // the bottom edge stays
    expectPoint(cornersOf(n.elements[0] as ElementStart)[0], [25, 0], 9);
    const s = after(start, skewValues(start, 's', 25, 0, { snap: true }));
    expect(s.elements[0]?.box.skewX).toBeCloseTo(30, 9); // 26.6° snaps to 30°
    expect((s.elements[0]?.box.skewX ?? 0) / SKEW_STEP).toBeCloseTo(2, 9);
    const steep = after(start, skewValues(start, 's', 1e6, 0));
    expect(steep.elements[0]?.box.skewX).toBeCloseTo(SKEW_LIMIT, 9);
    // Right handle 10 down: the right edge moves, the left one stays (a vertical skew).
    const e = after(start, skewValues(start, 'e', 0, 10));
    expectPoint(cornersOf(e.elements[0] as ElementStart)[1], [100, 10], 9);
    expectPoint(cornersOf(e.elements[0] as ElementStart)[3], [0, 50], 9);
    // Alt: about the pivot (the centre stays).
    const about = after(start, skewValues(start, 'n', 20, 0, { aboutPivot: true }));
    expectPoint(about.frame.center, start.frame.center, 9);
  });
});

describe('pivot (IF-34.5–34.7)', () => {
  it('rotating about the pivot keeps the pivot fixed (rotated, skewed, nested elements)', () => {
    fc.assert(
      fc.property(arbBox, arbParent, arbPivot, fc.double({ min: -360, max: 360, noNaN: true }), (box, parent, pivot, degrees) => {
        const start = startOf([element('a', box, parent)]);
        const at = pivotPoint(start.frame, pivot);
        const turned = after(start, rotateValues(start, degrees, at));
        expectPoint(pivotPoint(turned.frame, pivot), at, 5);
      }),
    );
  });

  it('scaling about the pivot (Alt-resize) keeps the pivot fixed', () => {
    fc.assert(
      fc.property(arbBox, fc.tuple(fc.double({ min: 0.1, max: 0.9, noNaN: true }), fc.double({ min: 0.1, max: 0.9, noNaN: true })), fc.double({ min: -20, max: 60, noNaN: true }), (box, pivot, d) => {
        const start = startOf([element('a', { ...box, skewX: 0 })]);
        const at = pivotPoint(start.frame, pivot as Point);
        const scaled = after(start, resizeValues(start, 'se', d, d, { fromCenter: true, pivot: pivot as Point }));
        expectPoint(pivotPoint(scaled.frame, pivot as Point), at, 5);
      }),
    );
  });

  it('fractions and page points round-trip; snapping picks the nearest reference point within the threshold', () => {
    const start = startOf([element('a', { rotation: 30, skewX: 10 })]);
    const p = pivotPoint(start.frame, [0.2, 0.7]);
    expectPoint(pivotFraction(start.frame, p), [0.2, 0.7], 9);
    expectPoint(pivotPoint(start.frame), start.frame.center, 9);
    expect(REFERENCE_POINTS).toHaveLength(9);
    const near = pivotFraction(start.frame, [framePoint(start.frame, 1, 0)[0] + 1, framePoint(start.frame, 1, 0)[1]]);
    expect(snapPivot(start.frame, near, 4)).toEqual([1, 0]);
    expect(snapPivot(start.frame, [0.3, 0.3], 4)).toEqual([0.3, 0.3]);
    expect(isCenterPivot(undefined)).toBe(true);
    expect(isCenterPivot(CENTER_PIVOT)).toBe(true);
    expect(isCenterPivot([0, 0])).toBe(false);
    const degenerate: SelectionFrame = { ...start.frame, corners: [[0, 0], [0, 0], [0, 0], [0, 0]] };
    expect(pivotFraction(degenerate, [5, 5])).toEqual(CENTER_PIVOT);
  });
});

describe('resize past the opposite edge (IF-34.2)', () => {
  it('flips on that axis and keeps the fixed edge; several elements mirror over the frame', () => {
    const start = startOf([element('a', { rotation: 90 })]);
    // The east handle of a 90°-rotated box drags along the page's y axis: 130 up = 30 past the west edge.
    const v = resizeValues(start, 'e', 0, -130);
    const e = startAfter(start.elements[0] as ElementStart, v[0] as SpatialValues);
    expect(e.box.flipX).toBe(true);
    expect(e.box.w).toBeCloseTo(30, 9);
    expect(e.box.rotation).toBeCloseTo(90, 9);
    expectPoint(cornersOf(e)[0], cornersOf(start.elements[0] as ElementStart)[0], 9); // the west edge stays
    const two = startOf([element('a', { x: 0, w: 50 }), element('b', { x: 150, w: 50 })]);
    const mirrored = after(two, resizeValues(two, 'e', -300, 0));
    expect(mirrored.elements.map((x) => x.box.flipX)).toEqual([true, true]);
    expect(mirrored.frame.bounds.minX).toBeCloseTo(-100, 9);
    expect(mirrored.frame.bounds.maxX).toBeCloseTo(0, 9);
  });
});

describe('numeric transform bar values (IF-34.8–34.10)', () => {
  it('shows one element in its parent and several as their frame; sets each field', () => {
    const single = startOf([element('a', { x: 10, y: 20, rotation: 30, skewX: 5 })]);
    expect(transformModel(single)).toMatchObject({ nodes: ['a'], x: 10, y: 20, w: 100, h: 50, rotation: 30, skew: 5, locked: 0 });
    const set = (field: 'x' | 'y' | 'w' | 'h' | 'rotation' | 'skew', value: number, linked = false) => {
      const r = numericValues(single, { field, value, linked });
      if (!r.ok) throw new Error(r.error.message);
      return transformModel(after(single, r.value));
    };
    expect(set('x', 40)).toMatchObject({ x: 40, y: 20 });
    expect(set('y', -5)).toMatchObject({ x: 10, y: -5 });
    expect(set('w', 200)).toMatchObject({ w: 200, h: 50 });
    expect(set('w', 200, true)).toMatchObject({ w: 200, h: 100 });
    expect(set('h', 25, true).w).toBeCloseTo(50, 9);
    expect(set('rotation', -45).rotation).toBeCloseTo(-45, 9);
    expect(set('skew', 20).skew).toBeCloseTo(20, 9);
    expect(set('skew', 20).rotation).toBeCloseTo(30, 9);
    const flip = numericValues(single, { flip: 'vertical' });
    expect(flip.ok && transformModel(after(single, flip.value)).flipY).toBe(true);
    for (const bad of [{ field: 'w', value: 0 }, { field: 'skew', value: 89 }, { field: 'x', value: Number.NaN }] as const) {
      const r = numericValues(single, bad);
      expect(!r.ok && r.error.code).toBe('IF-XF-001');
    }
    const several = startOf([element('a', { x: 0 }), element('b', { x: 200 })]);
    expect(transformModel(several)).toMatchObject({ x: 0, y: 0, w: 300, h: 50, rotation: 0, skew: 0 });
    const moved = numericValues(several, { field: 'x', value: 50 });
    expect(moved.ok && transformModel(after(several, moved.value)).x).toBeCloseTo(50, 9);
    const wide = numericValues(several, { field: 'w', value: 600 });
    expect(wide.ok && transformModel(after(several, wide.value)).w).toBeCloseTo(600, 6);
  });

  it('frame bases: one element its own box, several the page bounds', () => {
    const one = startOf([element('a', { rotation: 30 })]);
    expect(frameBasis(one)).toMatchObject({ w: 100, h: 50 });
    expectAffine(inFrame(frameBasis(one), IDENTITY), IDENTITY, 9);
    const two = startOf([element('a', { x: 5, y: 7 }), element('b', { x: 200 })]);
    expect(frameBasis(two).toPage).toEqual([1, 0, 0, 1, 5, 0]);
    expect(transformValues(two, IDENTITY).map((v) => v.x)).toEqual([5, 200]);
  });
});
