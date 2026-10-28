// @vitest-environment node
import { createScope } from '@staticflux/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { derivedContent } from '../elements/layout.js';
import { authoringBuilt, human, loadGeometry, shape, unwrap } from '../elements/testing/fixtures.js';
import { RP } from './components.js';
import { instanceCount, type RepeatParams, repeatOps } from './params.js';
import { copyId, createRepeatStage, instanceKey, wrapperId } from './stage.js';
import { createRepeatFixture } from './testing/fixtures.js';

const fill = [{ paint: '#ff5c39' }];
/** A radial repeat `r` (4 copies, radius 50) of a 40 × 20 rect `a` and a group `g` holding `b`. */
const scene = (params: Readonly<Record<string, unknown>> = { [RP.kind]: 'radial', [RP.count]: 4, [RP.radius]: 50 }) => [
  shape('r', { name: 'Repeat', [P.matchKey]: 'kr', ...params }, 'p1', 'group'),
  shape('a', { [P.x]: 100, [P.y]: 100, [P.w]: 40, [P.h]: 20, [P.fills]: fill, [P.matchKey]: 'ka' }, 'r'),
  shape('g', { [P.matchKey]: 'kg' }, 'r', 'group'),
  shape('b', { [P.x]: 110, [P.y]: 105, [P.w]: 5, [P.h]: 5, [P.fills]: fill }, 'g'),
  shape('plain', { [P.x]: 0, [P.w]: 10, [P.h]: 10, [P.fills]: fill }),
];

describe('ids', () => {
  it('builds wrapper, copy and key ids', () => {
    expect(wrapperId('r', 2)).toBe('r~2');
    expect(copyId('r~2', 'a')).toBe('r~2^a');
    expect(instanceKey('ka', 3)).toBe('ka~3');
  });
});

describe.skipIf(!authoringBuilt)('repeat view', () => {
  it('shows one wrapper per instance; instance 0 holds the source, the others hold copies with derived keys', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, scene());
    const v = f.view;
    expect(v.children('p1')).toEqual(['r', 'plain']);
    expect(v.children('r')).toEqual(['r~0', 'r~1', 'r~2', 'r~3']);
    expect(v.children('r~0')).toEqual(['a', 'g']);
    expect(v.children('r~2')).toEqual(['r~2^a', 'r~2^g']);
    expect(v.children('r~2^g')).toEqual(['r~2^b']);
    expect(v.read('a')?.parent).toBe('r~0');
    expect(v.read('r~2^a')?.parent).toBe('r~2');
    expect(v.read('r~2^b')?.parent).toBe('r~2^g');
    expect(v.read('r~2^a')?.values[P.matchKey]).toBe('ka~2');
    expect(v.read('r~2^b')?.values[P.matchKey]).toBeUndefined();
    expect(v.read('r~1')?.values[P.matchKey]).toBe('kr~1');
    expect(v.read('r~1')?.values[P.rotation]).toBeCloseTo(90);
    expect(v.read('r~0')?.values).toMatchObject({ [P.x]: 0, [P.y]: 0, [P.rotation]: 0 });
    expect(v.value('r~2^a', P.w)).toBe(40);
    expect(v.value('a', P.w)).toBe(40);
    // nonsense and out-of-range ids do not exist
    for (const id of ['r~4', 'r~0^a', 'r~1^plain', 'r~1^r~0', 'plain~1', 'r~01', 'r~-1', 'nope', 'r~1^nope']) expect(v.read(id), id).toBeUndefined();
    expect(v.children('nope~1')).toEqual([]);
    expect(v.layout('r')?.content).toEqual({ minX: 100, minY: 100, maxX: 140, maxY: 120 });
    expect(v.layout('plain')).toBeUndefined();
    expect(v.params('r')).toMatchObject({ kind: 'radial', count: 4 });
  });

  it('resolves instances back to their source and instance index; derived nodes are locked and unwritable', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, scene());
    const v = f.view;
    expect(v.resolveInstance('r~3^b')).toEqual({ node: 'r~3^b', source: 'b', derived: true, wrapper: false, index: 3, path: [{ repeat: 'r', index: 3 }] });
    expect(v.resolveInstance('a')).toMatchObject({ source: 'a', derived: false, index: 0, path: [{ repeat: 'r', index: 0 }] });
    expect(v.resolveInstance('r~2')).toMatchObject({ source: 'r', derived: true, wrapper: true, index: 2 });
    expect(v.resolveInstance('plain')).toEqual({ node: 'plain', source: 'plain', derived: false, wrapper: false, index: 0, path: [] });
    expect(v.resolveInstance('gone')).toBeUndefined();
    expect(v.isDerived('r~1^a') && !v.isDerived('a') && !v.isDerived('gone')).toBe(true);
    expect(v.lockOf('r~1^a')).toMatchObject({ position: true, content: true });
    expect(v.lockOf('a').position).toBe(false);
    const write = v.checkWrite([{ op: 'set', node: 'r~1^a', path: P.x, value: 1 }], { actor: human });
    expect(!write.ok && write.error.code).toBe('IF-REP-004');
    expect(!write.ok && write.error.details?.['source']).toBe('a');
    const into = v.checkWrite([{ op: 'create', node: 'n', kind: 'shape', parent: 'r~1', props: {} }], { actor: human });
    expect(!into.ok && into.error.code).toBe('IF-REP-004');
    expect(v.checkWrite([{ op: 'set', node: 'a', path: P.x, value: 1 }], { actor: human }).ok).toBe(true);
    expect(v.explain('r~1^a', P.matchKey).value).toBe('ka~1');
    expect(v.explain('r~1^a', P.w).winner?.value).toBe(40);
    expect(v.explain('r~1', P.x)).toMatchObject({ node: 'r~1', winner: undefined });
    expect(v.explain('a', P.w).value).toBe(40);
  });

  it('editing the source invalidates every copy and wrapper; a smaller count drops wrappers', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, scene());
    const v = f.view;
    for (const k of [0, 1, 2, 3]) v.children(wrapperId('r', k)).forEach((c) => v.read(c));
    const seen: string[][] = [];
    const stop = v.onInvalidate((nodes) => seen.push([...nodes]));
    f.seed([{ op: 'set', node: 'a', path: P.w, value: 60 }]);
    const first = seen.flat();
    expect(first).toEqual(expect.arrayContaining(['a', 'r~1^a', 'r~2^a', 'r~3^a', 'r~0', 'r~3']));
    expect(v.read('r~2^a')?.values[P.w]).toBe(60);
    expect(v.layout('r')?.content.maxX).toBe(160);
    seen.length = 0;
    f.seed([{ op: 'set', node: 'r', path: RP.count, value: 2 }]);
    expect(seen.flat()).toEqual(expect.arrayContaining(['r', 'r~2', 'r~3']));
    expect(v.children('r')).toEqual(['r~0', 'r~1']);
    expect(v.read('r~3^a')).toBeUndefined();
    seen.length = 0;
    f.seed([{ op: 'set', node: 'r', path: RP.kind, value: null }]);
    expect(seen.flat()).toEqual(expect.arrayContaining(['r', 'r~0', 'r~1']));
    expect(v.children('r')).toEqual(['a', 'g']);
    expect(v.read('a')?.parent).toBe('r');
    stop();
  });

  it('nests: a repeat inside a repeat copies its live instances', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [
      shape('outer', { [RP.kind]: 'grid', [RP.rows]: 1, [RP.columns]: 2 }, 'p1', 'group'),
      shape('inner', { [RP.kind]: 'mirror', [P.matchKey]: 'ki' }, 'outer', 'group'),
      shape('dot', { [P.x]: 0, [P.w]: 10, [P.h]: 10, [P.fills]: fill, [P.matchKey]: 'kd' }, 'inner'),
    ]);
    const v = f.view;
    expect(v.children('outer~1')).toEqual(['outer~1^inner']);
    expect(v.children('outer~1^inner')).toEqual(['outer~1^inner~0', 'outer~1^inner~1']);
    expect(v.children('outer~1^inner~1')).toEqual(['outer~1^inner~1^dot']);
    expect(v.read('outer~1^inner~1^dot')?.values[P.matchKey]).toBe('kd~1~1');
    expect(v.read('outer~1^inner~1^dot')?.parent).toBe('outer~1^inner~1');
    expect(v.params('outer~1^inner')?.kind).toBe('mirror');
    expect(v.layout('outer~1^inner')).toEqual(v.layout('inner'));
    expect(v.resolveInstance('outer~1^inner~1^dot')).toMatchObject({
      source: 'dot',
      index: 1,
      path: [
        { repeat: 'outer', index: 1 },
        { repeat: 'outer~1^inner', index: 1 },
      ],
    });
    expect(v.resolveInstance('outer~1^inner~1')).toMatchObject({ wrapper: true, source: 'inner', index: 1 });
    // the outer grid lays out the inner mirror's full extent (both halves): cell width 20 + gap 16
    const content = v.layout('outer')?.content;
    for (const [k, want] of Object.entries({ minX: 0, minY: 0, maxX: 20, maxY: 10 })) expect(content?.[k as 'minX'], k).toBeCloseTo(want, 9);
    expect(v.read('outer~1')?.values[P.x]).toBeCloseTo(36, 9);
  });

  it('disposes with its scope and stops forwarding invalidations', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, scene());
    const scope = createScope('repeat-view');
    const v = createRepeatStage({ stage: f.stage, geometry: g, kit: f.kit, scope });
    let calls = 0;
    v.onInvalidate(() => (calls += 1));
    v.read('a'); // the stage invalidates what was composed
    f.seed([{ op: 'set', node: 'a', path: P.x, value: 1 }]);
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    scope.dispose();
    v.read('a');
    f.seed([{ op: 'set', node: 'a', path: P.x, value: 2 }]);
    expect(calls).toBe(before);
    v.dispose(); // idempotent
  });

  it('property: the view has exactly instanceCount(params) wrappers, each holding a full copy of the source', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, scene());
    const params = fc.oneof(
      fc.record({ kind: fc.constant('radial' as const), count: fc.integer({ min: 1, max: 40 }), radius: fc.integer({ min: 0, max: 300 }), startAngle: fc.integer({ min: -360, max: 360 }), sweep: fc.integer({ min: 1, max: 360 }), rotate: fc.boolean() }),
      fc.record({ kind: fc.constant('grid' as const), rows: fc.integer({ min: 1, max: 8 }), columns: fc.integer({ min: 1, max: 8 }), gapX: fc.integer({ min: -20, max: 40 }), gapY: fc.integer({ min: -20, max: 40 }), rowOffset: fc.integer({ min: -10, max: 10 }), columnOffset: fc.integer({ min: -10, max: 10 }), brick: fc.constantFrom('none' as const, 'rows' as const, 'columns' as const), brickShift: fc.constantFrom(0, 0.25, 0.5) }),
      fc.record({ kind: fc.constant('mirror' as const), axis: fc.constantFrom('vertical' as const, 'horizontal' as const, 'angle' as const), angle: fc.integer({ min: -180, max: 180 }), offset: fc.integer({ min: -20, max: 20 }) }),
    );
    fc.assert(
      fc.property(params, (p: RepeatParams) => {
        f.seed(repeatOps('r', p));
        const wrappers = f.view.children('r');
        expect(wrappers).toHaveLength(instanceCount(p));
        for (const w of wrappers) {
          expect(f.view.children(w)).toHaveLength(2);
          expect(f.view.read(w)?.kind).toBe('group');
        }
        expect(unwrap({ ok: true, value: f.view.layout('r') })?.placements).toHaveLength(instanceCount(p));
      }),
      { numRuns: 60 },
    );
  });
});

describe.skipIf(!authoringBuilt)('derived content (#76)', () => {
  it('a real repeat reports its source children and its scaled spacing; anything else has none', async () => {
    const f = await createRepeatFixture(await loadGeometry(), scene());
    const content = f.view.derivedContent('r');
    expect(content?.children).toEqual(['a', 'g']);
    expect(content?.scaled(2, 3)).toEqual([{ path: RP.radius, value: 150 }]); // start at 12 o'clock: along y
    expect(derivedContent({ stage: f.view }, 'r')).toBeDefined();
    for (const node of ['a', 'g', 'plain', 'r~1', 'r~1^g', 'nope']) expect(f.view.derivedContent(node), node).toBeUndefined();
    expect(derivedContent({ stage: f.view.base }, 'r')).toBeUndefined();
  });
});
