// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyAffine } from '../elements/resolve.js';
import { IDENTITY_PLACEMENT, instancePlacements, mirrorAxis, placementTransform, radialCenter, radialStep, SCALED_PARAMS, scaledParams } from './instances.js';
import { defaultParams, instanceCount, type RepeatParams } from './params.js';

const content = { minX: 100, minY: 100, maxX: 140, maxY: 120 }; // centre (120, 110)
const centreOf = (p: Parameters<typeof placementTransform>[0]): readonly [number, number] => applyAffine(placementTransform(p), 120, 110);
const close = (a: readonly number[], b: readonly number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 6));

describe('instance placements', () => {
  it('radial: the source sits at the start angle; copies go clockwise around the centre', () => {
    const p = { kind: 'radial', count: 4, radius: 50, startAngle: 0, sweep: 360, rotate: true } as const;
    close(radialCenter(p, content), [120, 160]); // 12 o'clock: the centre is below the source
    expect(radialStep(p)).toBe(90);
    const placements = instancePlacements(p, content);
    expect(placements[0]).toBe(IDENTITY_PLACEMENT);
    close(centreOf(placements[1]!), [170, 160]); // 3 o'clock
    close(centreOf(placements[2]!), [120, 210]); // 6 o'clock
    close(centreOf(placements[3]!), [70, 160]);
    expect(placements[1]!.rotation).toBe(90);
    const upright = instancePlacements({ ...p, rotate: false }, content);
    expect(upright.every((q) => q.rotation === 0)).toBe(true);
    close(centreOf(upright[1]!), [170, 160]);
  });

  it('radial: a partial sweep spreads count copies over the arc, ends included', () => {
    const p = { kind: 'radial', count: 3, radius: 10, startAngle: 90, sweep: 180, rotate: false } as const;
    expect(radialStep(p)).toBe(90);
    expect(radialStep({ ...p, count: 1 })).toBe(0);
    const c = radialCenter(p, content);
    close(c, [110, 110]); // source at 3 o'clock of the centre
    close(centreOf(instancePlacements(p, content)[2]!), [100, 110]); // 9 o'clock
  });

  it('grid: cells of content + gap, row and column offsets, brick shifts', () => {
    const p = { kind: 'grid', rows: 2, columns: 3, gapX: 10, gapY: 5, rowOffset: 4, columnOffset: 2, brick: 'none', brickShift: 0.5 } as const;
    const placements = instancePlacements(p, content);
    expect(placements).toHaveLength(6);
    expect(placements[0]).toBe(IDENTITY_PLACEMENT);
    expect(placements[2]).toEqual({ x: 100, y: 4, rotation: 0, flipY: false }); // r0 c2: 2 × 50, 2 × 2
    expect(placements[3]).toEqual({ x: 4, y: 25, rotation: 0, flipY: false }); // r1 c0
    const rows = instancePlacements({ ...p, rowOffset: 0, columnOffset: 0, brick: 'rows' }, content);
    expect(rows[3]).toEqual({ x: 25, y: 25, rotation: 0, flipY: false }); // odd row shifted half a cell
    const cols = instancePlacements({ ...p, rowOffset: 0, columnOffset: 0, brick: 'columns' }, content);
    expect(cols[1]).toEqual({ x: 50, y: 12.5, rotation: 0, flipY: false });
  });

  it('mirror: reflects across an axis touching the content, moved out by the offset', () => {
    const vertical = defaultParams('mirror') as Extract<RepeatParams, { kind: 'mirror' }>;
    close(mirrorAxis(vertical, content).point, [140, 110]);
    const [, reflected] = instancePlacements(vertical, content);
    close(centreOf(reflected!), [160, 110]);
    expect(reflected!.flipY).toBe(true);
    close(applyAffine(placementTransform(reflected!), 100, 100), [180, 100]); // left edge maps to the far right
    const below = instancePlacements({ ...vertical, axis: 'horizontal', offset: 5 }, content)[1]!;
    close(centreOf(below), [120, 140]);
    const diagonal = instancePlacements({ ...vertical, axis: 'angle', angle: 45 }, content)[1]!;
    const axis = mirrorAxis({ ...vertical, axis: 'angle', angle: 45 }, content);
    close(applyAffine(placementTransform(diagonal), axis.point[0], axis.point[1]), axis.point); // the axis is fixed
  });

  it('property: instance count matches the parameters; instance 0 is the identity; radial copies stay on the circle', () => {
    const radial = fc.record({ kind: fc.constant('radial' as const), count: fc.integer({ min: 1, max: 60 }), radius: fc.double({ min: 0, max: 500, noNaN: true }), startAngle: fc.double({ min: -360, max: 360, noNaN: true }), sweep: fc.double({ min: 1, max: 360, noNaN: true }), rotate: fc.boolean() });
    const grid = fc.record({
      kind: fc.constant('grid' as const),
      rows: fc.integer({ min: 1, max: 12 }),
      columns: fc.integer({ min: 1, max: 12 }),
      gapX: fc.double({ min: -50, max: 50, noNaN: true }),
      gapY: fc.double({ min: -50, max: 50, noNaN: true }),
      rowOffset: fc.double({ min: -20, max: 20, noNaN: true }),
      columnOffset: fc.double({ min: -20, max: 20, noNaN: true }),
      brick: fc.constantFrom('none' as const, 'rows' as const, 'columns' as const),
      brickShift: fc.double({ min: -1, max: 1, noNaN: true }),
    });
    const mirror = fc.record({ kind: fc.constant('mirror' as const), axis: fc.constantFrom('vertical' as const, 'horizontal' as const, 'angle' as const), angle: fc.double({ min: -360, max: 360, noNaN: true }), offset: fc.double({ min: -100, max: 100, noNaN: true }) });
    fc.assert(
      fc.property(fc.oneof(radial, grid, mirror), (params: RepeatParams) => {
        const placements = instancePlacements(params, content);
        expect(placements).toHaveLength(instanceCount(params));
        expect(placements[0]).toEqual(IDENTITY_PLACEMENT);
        if (params.kind === 'radial') {
          const c = radialCenter(params, content);
          for (const q of placements) {
            const [x, y] = centreOf(q);
            expect(Math.hypot(x - c[0], y - c[1])).toBeCloseTo(params.radius, 6);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('scaled parameters (#76: a resize scales a repeat like a group)', () => {
  const scale = (b: typeof content, kx: number, ky: number) => ({ minX: b.minX * kx, minY: b.minY * ky, maxX: b.maxX * kx, maxY: b.maxY * ky });
  const centres = (p: RepeatParams, b: typeof content): (readonly [number, number])[] =>
    instancePlacements(p, b).map((q) => applyAffine(placementTransform(q), (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2));

  it('grid gaps and offsets scale per axis; counts and the brick shift stay; every instance is the scaled one', () => {
    const p = { kind: 'grid', rows: 2, columns: 3, gapX: 10, gapY: 5, rowOffset: 4, columnOffset: 2, brick: 'rows', brickShift: 0.5 } as const;
    const q = scaledParams(p, 2, 3);
    expect(q).toEqual({ ...p, gapX: 20, gapY: 15, rowOffset: 8, columnOffset: 6 });
    const before = centres(p, content);
    centres(q, scale(content, 2, 3)).forEach((c, i) => close(c, [(before[i] as readonly number[])[0]! * 2, (before[i] as readonly number[])[1]! * 3]));
  });

  it('the mirror offset scales along the axis normal; the radial radius along the start direction (exact when uniform)', () => {
    expect(scaledParams({ kind: 'mirror', axis: 'vertical', angle: 0, offset: 10 }, 2, 5)).toMatchObject({ offset: 20 });
    expect(scaledParams({ kind: 'mirror', axis: 'horizontal', angle: 0, offset: 10 }, 2, 5)).toMatchObject({ offset: 50 });
    const r = { kind: 'radial', count: 6, radius: 50, startAngle: 90, sweep: 360, rotate: true } as const;
    expect(scaledParams(r, 2, 5)).toEqual({ ...r, radius: 100 });
    expect(scaledParams({ ...r, startAngle: 0 }, 2, 5)).toMatchObject({ radius: expect.closeTo(250, 9) });
    fc.assert(
      fc.property(fc.double({ min: 0.1, max: 10, noNaN: true }), fc.integer({ min: 0, max: 359 }), (k, startAngle) => {
        const p = { ...r, startAngle };
        const before = centres(p, content);
        centres(scaledParams(p, k, k), scale(content, k, k)).forEach((c, i) => close(c, [(before[i] as readonly number[])[0]! * k, (before[i] as readonly number[])[1]! * k]));
      }),
    );
  });

  it('names what it changes per generator; a scale of 1 changes nothing', () => {
    for (const kind of ['radial', 'grid', 'mirror'] as const) {
      const p = defaultParams(kind);
      expect(scaledParams(p, 1, 1)).toEqual(p);
      const q = scaledParams(p, 3, 7) as unknown as Record<string, unknown>;
      const changed = Object.keys(q).filter((name) => q[name] !== (p as unknown as Record<string, unknown>)[name]);
      expect(SCALED_PARAMS[kind]).toEqual(expect.arrayContaining(changed));
    }
  });
});
