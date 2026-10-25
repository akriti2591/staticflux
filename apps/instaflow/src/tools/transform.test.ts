// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { elementBounds } from '../elements/layout.js';
import { authoringBuilt, createToolFixture, shape, unwrap } from './testing/fixtures.js';
import {
  angleAbout,
  axisAligned,
  boundsAfter,
  captureTransform,
  fixedFraction,
  HANDLE_SIZES,
  moveValues,
  normalizeDegrees,
  pickHandle,
  resizeByValues,
  resizedBounds,
  resizeValues,
  rotateValues,
  type SelectionFrame,
  selectionFrame,
  snapRotation,
  transformHandles,
  valuesToOps,
} from './transform.js';

const frame: SelectionFrame = {
  corners: [
    [0, 0],
    [100, 0],
    [100, 50],
    [0, 50],
  ],
  rotation: 0,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
  center: [50, 25],
};

describe('handles and resize maths (no Wasm)', () => {
  it('places eight round resize handles and four rotate zones; sizes are screen pixels', () => {
    const handles = transformHandles(frame, 2);
    expect(handles.filter((h) => h.kind === 'resize').map((h) => [h.id, h.x, h.y])).toEqual([
      ['nw', 0, 0],
      ['n', 50, 0],
      ['ne', 100, 0],
      ['e', 100, 25],
      ['se', 100, 50],
      ['s', 50, 50],
      ['sw', 0, 50],
      ['w', 0, 25],
    ]);
    expect(handles[0]?.radius).toBe(HANDLE_SIZES.radius / 2);
    expect(pickHandle(handles, 101, 1)?.id).toBe('ne');
    const rotate = handles.find((h) => h.id === 'rotate-se');
    expect(rotate !== undefined && rotate.x > 100 && rotate.y > 50).toBe(true);
    expect(pickHandle(handles, rotate?.x ?? 0, rotate?.y ?? 0)?.id).toBe('rotate-se');
    expect(pickHandle(handles, 50, 25)).toBeUndefined();
  });

  it('resizes boxes from the opposite edge, about the centre, keeping the aspect, never below the minimum', () => {
    const b = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
    expect(resizedBounds(b, 'se', 10, 20)).toEqual({ minX: 0, minY: 0, maxX: 110, maxY: 70 });
    expect(resizedBounds(b, 'nw', 10, 10)).toEqual({ minX: 10, minY: 10, maxX: 100, maxY: 50 });
    expect(resizedBounds(b, 'e', 10, 99)).toEqual({ minX: 0, minY: 0, maxX: 110, maxY: 50 });
    expect(resizedBounds(b, 'e', 10, 0, { fromCenter: true })).toEqual({ minX: -10, minY: 0, maxX: 110, maxY: 50 });
    expect(resizedBounds(b, 'se', 100, 0, { aspect: true })).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
    expect(resizedBounds(b, 's', 0, 50, { aspect: true })).toEqual({ minX: -50, minY: 0, maxX: 150, maxY: 100 });
    expect(resizedBounds(b, 'w', 500, 0).maxX - resizedBounds(b, 'w', 500, 0).minX).toBe(1);
    expect(fixedFraction('ne')).toEqual([0, 1]);
    expect(fixedFraction('n', { fromCenter: true })).toEqual([0.5, 0.5]);
    fc.assert(
      fc.property(fc.constantFrom('nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w' as const), fc.double({ min: -40, max: 40, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true }), (handle, dx, dy) => {
        // The dragged edge follows the pointer exactly (what resize snapping relies on).
        const r = resizedBounds(b, handle, dx, dy);
        if (handle.includes('e')) expect(r.maxX).toBeCloseTo(100 + dx, 9);
        if (handle.includes('w')) expect(r.minX).toBeCloseTo(dx, 9);
        if (handle.includes('s')) expect(r.maxY).toBeCloseTo(50 + dy, 9);
        if (handle.startsWith('n')) expect(r.minY).toBeCloseTo(dy, 9);
      }),
    );
  });

  it('angles, normalisation and axis alignment', () => {
    expect(angleAbout([0, 0], 0, 10)).toBe(90);
    expect(normalizeDegrees(270)).toBe(-90);
    expect(normalizeDegrees(-180)).toBe(180);
    expect(normalizeDegrees(540)).toBe(180);
    expect(axisAligned([1, 0, 0, 1, 5, 5])).toBe(true);
    expect(axisAligned([0, 1, -1, 0, 0, 0])).toBe(false);
    expect(axisAligned([-1, 0, 0, 1, 0, 0])).toBe(false);
  });
});

describe.skipIf(!authoringBuilt)('transform values on real elements', () => {
  it('captures movable elements, leaves position-locked ones out, and reports none movable (IF-TOOL-002)', async () => {
    const f = await createToolFixture([shape('a', { [P.x]: 10, [P.y]: 10, [P.w]: 20, [P.h]: 20 }), shape('l', { [P.x]: 0, [P.w]: 5, [P.h]: 5, [P.lockScope]: 'position' })]);
    const start = unwrap(captureTransform(f.ctx, ['a', 'l']));
    expect(start.elements.map((e) => e.node)).toEqual(['a']);
    expect(start.locked).toEqual(['l']);
    const none = captureTransform(f.ctx, ['l']);
    expect(!none.ok && none.error.code).toBe('IF-TOOL-002');
    expect(!none.ok && none.error.details).toMatchObject({ locked: ['l'] });
    const empty = captureTransform(f.ctx, []);
    expect(!empty.ok && empty.error.message).toBe('Nothing is selected.');
    expect(unwrap(selectionFrame(f.ctx, []))).toBeUndefined();
  });

  it('moves in parent space: a child of a rotated group moves by the page delta', async () => {
    const f = await createToolFixture([shape('fr', { [P.x]: 100, [P.y]: 100, [P.w]: 200, [P.h]: 200, [P.rotation]: 90 }, 'p1', 'frame'), shape('c', { [P.x]: 0, [P.y]: 0, [P.w]: 20, [P.h]: 20 }, 'fr')]);
    const before = unwrap(elementBounds(f.ctx, 'c')).geometry;
    const start = unwrap(captureTransform(f.ctx, ['c']));
    f.seed(valuesToOps(start, moveValues(start, 30, -10)));
    const after = unwrap(elementBounds(f.ctx, 'c')).geometry;
    expect(after.minX - before.minX).toBeCloseTo(30, 9);
    expect(after.minY - before.minY).toBeCloseTo(-10, 9);
  });

  it('resizes a rotated element in its own frame keeping the opposite corner put on the page', async () => {
    const f = await createToolFixture([shape('r', { [P.x]: 100, [P.y]: 100, [P.w]: 100, [P.h]: 50, [P.rotation]: 30 })]);
    const start = unwrap(captureTransform(f.ctx, ['r']));
    const nw = start.frame.corners[0];
    // Drag the south-east handle by 20 units along the element's own x axis.
    const r = (30 * Math.PI) / 180;
    const values = resizeValues(start, 'se', 20 * Math.cos(r), 20 * Math.sin(r));
    expect(values[0]?.w).toBeCloseTo(120, 9);
    expect(values[0]?.h).toBeCloseTo(50, 9);
    f.seed(valuesToOps(start, values));
    const frameAfter = unwrap(selectionFrame(f.ctx, ['r']));
    expect(frameAfter?.corners[0][0]).toBeCloseTo(nw[0], 9);
    expect(frameAfter?.corners[0][1]).toBeCloseTo(nw[1], 9);
    expect(frameAfter?.rotation).toBeCloseTo(30, 9);
    const centred = resizeValues(start, 'e', 10 * Math.cos(r), 10 * Math.sin(r), { fromCenter: true });
    expect(centred[0]?.w).toBeCloseTo(120, 9);
  });

  it('scales a multi-selection with the frame, rotates about the frame centre, resizes by keys', async () => {
    const f = await createToolFixture([shape('a', { [P.x]: 0, [P.y]: 0, [P.w]: 50, [P.h]: 50 }), shape('b', { [P.x]: 150, [P.y]: 50, [P.w]: 50, [P.h]: 50 })]);
    const start = unwrap(captureTransform(f.ctx, ['a', 'b']));
    expect(start.frame.bounds).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 100 });
    const scaled = resizeValues(start, 'se', 200, 100);
    f.seed(valuesToOps(start, scaled));
    expect(unwrap(elementBounds(f.ctx, 'b')).geometry).toEqual({ minX: 300, minY: 100, maxX: 400, maxY: 200 });
    const again = unwrap(captureTransform(f.ctx, ['a', 'b']));
    const turned = rotateValues(again, 180);
    const e = again.elements[1];
    expect(e === undefined ? undefined : boundsAfter(e, turned[1] as never).minX).toBeCloseTo(0, 6);
    expect(turned[0]?.rotation).toBe(180);
    expect(snapRotation(again, 44)).toBe(45);
    const single = unwrap(captureTransform(f.ctx, ['a']));
    expect(resizeByValues(single, 10, -500)).toEqual([{ node: 'a', x: 0, y: 0, w: 110, h: 1 }]);
    expect(valuesToOps(single, [{ node: 'a', x: 0, y: 0 }])).toEqual([]);
  });
});
