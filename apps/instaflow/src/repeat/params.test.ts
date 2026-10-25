// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REPEAT_KIND_COMPONENTS, REPEAT_KIND_PARAMS, REPEAT_PATHS, Repeat, RP } from './components.js';
import {
  applyPatch,
  checkRepeatValue,
  clearRepeatOps,
  defaultParams,
  instanceCount,
  patchOps,
  readRepeat,
  REPEAT_LIMITS,
  type RepeatParams,
  repeatOps,
  validateRepeatOps,
} from './params.js';

describe('repeat component and parameters', () => {
  it('declares the repeat component and adds it to the group kind', () => {
    expect(Repeat.id).toBe('repeat');
    expect(REPEAT_KIND_COMPONENTS['group']).toContain('repeat');
    expect(REPEAT_KIND_COMPONENTS['group']).toContain('geometry');
    expect(REPEAT_PATHS).toContain(RP.kind);
    expect(REPEAT_PATHS).toHaveLength(Object.keys(RP).length);
  });

  it('reads nothing without a valid kind, and defaults per generator', () => {
    expect(readRepeat({})).toBeUndefined();
    expect(readRepeat({ [RP.kind]: 'spiral' })).toBeUndefined();
    expect(readRepeat({ [RP.kind]: 'radial' })).toEqual(defaultParams('radial'));
    expect(defaultParams('radial')).toEqual({ kind: 'radial', count: 6, radius: 120, startAngle: 0, sweep: 360, rotate: true });
    expect(defaultParams('grid')).toMatchObject({ kind: 'grid', rows: 3, columns: 3, brick: 'none', brickShift: 0.5 });
    expect(defaultParams('mirror')).toEqual({ kind: 'mirror', axis: 'vertical', angle: 90, offset: 0 });
  });

  it('clamps out-of-range values on read (the live view never exceeds the limits)', () => {
    expect(readRepeat({ [RP.kind]: 'radial', [RP.count]: 5000, [RP.radius]: -3, [RP.sweep]: -1, [RP.rotate]: 'yes' })).toEqual({ kind: 'radial', count: 360, radius: 0, startAngle: 0, sweep: 360, rotate: true });
    const g = readRepeat({ [RP.kind]: 'grid', [RP.rows]: 100, [RP.columns]: 100, [RP.brick]: 'diagonal', [RP.brickShift]: 7 }) as Extract<RepeatParams, { kind: 'grid' }>;
    expect(g.rows * g.columns).toBeLessThanOrEqual(REPEAT_LIMITS.instances);
    expect(g.brick).toBe('none');
    expect(g.brickShift).toBe(1);
    expect(readRepeat({ [RP.kind]: 'mirror', [RP.axis]: 'diagonal', [RP.offset]: Number.NaN })).toEqual(defaultParams('mirror'));
  });

  it('counts instances: radial count, grid rows × columns, mirror 2', () => {
    expect(instanceCount({ ...defaultParams('radial'), count: 12 } as RepeatParams)).toBe(12);
    expect(instanceCount({ ...defaultParams('grid'), rows: 4, columns: 5 } as RepeatParams)).toBe(20);
    expect(instanceCount(defaultParams('mirror'))).toBe(2);
  });

  it('checks values (IF-REP-001) and instance limits (IF-REP-002)', () => {
    expect(checkRepeatValue(RP.count, 6).ok).toBe(true);
    expect(checkRepeatValue(RP.count, null).ok).toBe(true);
    expect(checkRepeatValue('spatial.x', 'anything').ok).toBe(true);
    for (const [path, value] of [
      [RP.count, 0],
      [RP.count, 2.5],
      [RP.radius, -1],
      [RP.sweep, 0],
      [RP.sweep, 400],
      [RP.rotate, 1],
      [RP.rows, 101],
      [RP.brick, 'diagonal'],
      [RP.brickShift, 2],
      [RP.axis, 'z'],
      [RP.angle, Number.POSITIVE_INFINITY],
      [RP.kind, 'spiral'],
    ] as const) {
      const r = checkRepeatValue(path, value);
      expect(!r.ok && r.error.code, `${path}=${String(value)}`).toBe('IF-REP-001');
      expect(!r.ok && r.error.details?.['path']).toBe(path);
    }
    const many = validateRepeatOps([
      { op: 'set', node: 'r', path: RP.kind, value: 'grid' },
      { op: 'set', node: 'r', path: RP.rows, value: 50 },
      { op: 'set', node: 'r', path: RP.columns, value: 50 },
    ]);
    expect(!many.ok && many.error.code).toBe('IF-REP-002');
    const against = validateRepeatOps([{ op: 'set', node: 'r', path: RP.rows, value: 40 }], () => ({ ...defaultParams('grid'), columns: 30 }) as RepeatParams);
    expect(!against.ok && against.error.code).toBe('IF-REP-002');
    expect(validateRepeatOps([{ op: 'create', node: 'r', kind: 'group', parent: 'p1', props: { [RP.kind]: 'radial', [RP.count]: 8 } }]).ok).toBe(true);
    const bad = validateRepeatOps([{ op: 'create', node: 'r', kind: 'group', parent: 'p1', props: { [RP.count]: -2 } }]);
    expect(!bad.ok && bad.error.code).toBe('IF-REP-001');
    expect(validateRepeatOps([{ op: 'delete', node: 'r' }]).ok).toBe(true);
  });

  it('writes, patches, clears and applies patches', () => {
    const radial = defaultParams('radial');
    const ops = repeatOps('r', radial);
    expect(ops).toHaveLength(1 + REPEAT_KIND_PARAMS.radial.length);
    expect(ops[0]).toEqual({ op: 'set', node: 'r', path: RP.kind, value: 'radial' });
    expect(patchOps('r', { count: 9, rotate: false, radius: undefined })).toEqual([
      { op: 'set', node: 'r', path: RP.count, value: 9 },
      { op: 'set', node: 'r', path: RP.rotate, value: false },
    ]);
    expect(clearRepeatOps('r').every((op) => op.op === 'set' && op.value === null)).toBe(true);
    expect(applyPatch(radial, { count: 3 })).toEqual({ ...radial, count: 3 });
    expect(applyPatch(radial, { kind: 'mirror' })).toEqual(defaultParams('mirror'));
    expect(applyPatch(radial, { count: 9999 })).toMatchObject({ count: 360 });
  });

  it('property: written parameters read back exactly and validate', () => {
    fc.assert(
      fc.property(
        fc.record({ count: fc.integer({ min: 1, max: 360 }), radius: fc.double({ min: 0, max: 1e4, noNaN: true }), startAngle: fc.double({ min: -720, max: 720, noNaN: true }), sweep: fc.double({ min: 0.5, max: 360, noNaN: true }), rotate: fc.boolean() }),
        (r) => {
          const params: RepeatParams = { kind: 'radial', ...r };
          const values = Object.fromEntries(repeatOps('n', params).map((op) => [op.op === 'set' ? op.path : '', op.op === 'set' ? op.value : null]));
          expect(readRepeat(values)).toEqual(params);
          expect(validateRepeatOps(repeatOps('n', params)).ok).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
