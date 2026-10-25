// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { authoringBuilt, loadGeometry, shape, unwrap } from '../elements/testing/fixtures.js';
import { REPEAT_KIND_PARAMS, RP } from './components.js';
import { repeatEditOps, repeatModel } from './inspector.js';
import { createRepeatFixture } from './testing/fixtures.js';

describe.skipIf(!authoringBuilt)('repeat panel model', () => {
  it('models a live repeat and turns edits into ops', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [shape('r', { [RP.kind]: 'grid', [RP.rows]: 2 }, 'p1', 'group'), shape('a', { [P.w]: 10, [P.h]: 10 }, 'r')]);
    const ctx = f.rctx();
    const model = repeatModel(ctx, 'r');
    expect(model).toMatchObject({ node: 'r', instances: 6, fields: REPEAT_KIND_PARAMS.grid, kinds: ['radial', 'grid', 'mirror'] });
    expect(model?.params).toMatchObject({ kind: 'grid', rows: 2, columns: 3 });
    expect(repeatModel(ctx, 'a')).toBeUndefined();
    expect(repeatModel(ctx, 'r~1')).toBeUndefined();
    expect(unwrap(repeatEditOps(ctx, 'r', { op: 'set', patch: { kind: 'radial', count: 7 } }))).toEqual([
      { op: 'set', node: 'r', path: RP.kind, value: 'radial' },
      { op: 'set', node: 'r', path: RP.count, value: 7 },
    ]);
    expect(unwrap(repeatEditOps(ctx, 'r', { op: 'release' })).every((op) => op.op === 'set' && op.value === null)).toBe(true);
    expect(unwrap(repeatEditOps(ctx, 'r', { op: 'expand' })).some((op) => op.op === 'move' && op.node === 'a')).toBe(true);
    const unknown = repeatEditOps(ctx, 'r', { op: 'explode' } as never);
    expect(!unknown.ok && unknown.error.code).toBe('IF-REP-003');
  });
});
