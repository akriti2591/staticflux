// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { authoringBuilt, loadGeometry, shape, unwrap } from '../elements/testing/fixtures.js';
import { RP } from './components.js';
import { hitInstance, instanceBounds } from './hit.js';
import { createRepeatFixture } from './testing/fixtures.js';

const fill = [{ paint: '#ff5c39' }];

describe.skipIf(!authoringBuilt)('instance-aware hit testing', () => {
  it('returns the source and the instance index of the top-most hit', async () => {
    const g = await loadGeometry();
    // a 1 × 3 grid of 20 px squares, 10 px apart: instances at x 0, 30, 60
    const f = await createRepeatFixture(g, [
      shape('r', { [RP.kind]: 'grid', [RP.rows]: 1, [RP.columns]: 3, [RP.gapX]: 10 }, 'p1', 'group'),
      shape('sq', { [P.w]: 20, [P.h]: 20, [P.fills]: fill }, 'r'),
      shape('plain', { [P.x]: 200, [P.w]: 10, [P.h]: 10, [P.fills]: fill }),
    ]);
    const ctx = f.rctx();
    expect(unwrap(hitInstance(ctx, 'r', 5, 5))).toMatchObject({ node: 'sq', source: 'sq', index: 0, derived: false, hit: 'fill' });
    expect(unwrap(hitInstance(ctx, 'r', 65, 5))).toMatchObject({ node: 'r~2^sq', source: 'sq', index: 2, derived: true, path: [{ repeat: 'r', index: 2 }] });
    expect(unwrap(hitInstance(ctx, 'r', 25, 5))).toBeUndefined(); // the gap
    expect(unwrap(hitInstance(ctx, 'plain', 205, 5))).toMatchObject({ source: 'plain', index: 0, path: [] });
    expect(unwrap(hitInstance(ctx, 'gone', 0, 0))).toBeUndefined();
    const bounds = instanceBounds(ctx, 'r');
    expect(bounds.map((b) => b.geometry.minX)).toEqual([0, 30, 60]);
    expect(instanceBounds(ctx, 'plain')).toEqual([]);
  });

  it('masks each instance with its own mask (a mask is never hit itself)', async () => {
    const g = await loadGeometry();
    // source: a 10 px clip mask over the left half of a 20 px square; mirrored to the right
    const f = await createRepeatFixture(g, [
      shape('r', { [RP.kind]: 'mirror' }, 'p1', 'group'),
      shape('m', { [P.w]: 10, [P.h]: 20, [P.maskMode]: 'clip' }, 'r'),
      shape('sq', { [P.w]: 20, [P.h]: 20, [P.fills]: fill }, 'r'),
    ]);
    const ctx = f.rctx();
    expect(unwrap(hitInstance(ctx, 'r', 5, 5))).toMatchObject({ node: 'sq', index: 0 });
    expect(unwrap(hitInstance(ctx, 'r', 15, 5))).toBeUndefined(); // masked out in the source
    // the mirror (axis at x = 20) shows its square at 20…40 masked to 30…40
    expect(unwrap(hitInstance(ctx, 'r', 35, 5))).toMatchObject({ node: 'r~1^sq', index: 1 });
    expect(unwrap(hitInstance(ctx, 'r', 25, 5))).toBeUndefined();
  });
});
