// @vitest-environment node
// #76: resizing a repeat (grid, radial, mirror; also a repeat of a boolean) scales it like a group: the source and its
// spacing scale with the box, the count stays, what the drag shows is what stays on release, and one undo step
// restores everything. The numeric W/H do the same.
import { createScope, ok } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { authoringBuilt, createStudioFixture, person, unwrap } from '../app/test-helpers.js';
import { booleanGroup, commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { elementBounds } from '../elements/layout.js';
import { RP, type RepeatKind } from '../repeat/components.js';
import { commitRepeatEdit, makeRepeat, newRepeatParams } from '../repeat/actions.js';
import { numericValues } from './free-transform.js';
import { createToolController, refreshOverlay, type ToolSession } from './gesture.js';
import { createElementIndex } from './hit-test.js';
import { applyTransform, createTransformMode } from './transform-mode.js';
import { captureTransform, type ResizeHandleId, resizedBounds, type ResizeOptions, resizeValues, valuesToOps } from './transform.js';
import { createViewState } from './view-state.js';

const FILL = [{ paint: '#ff5c39' }];
const create = (node: string, props: Record<string, unknown>, kind = 'shape', parent = 'p1'): PartOp => ({ op: 'create', node, kind, parent, props } as PartOp);

/**
 * A 100 × 50 rectangle at (200, 300) repeated with `kind`'s defaults; or (`boolean`, the owner's case) an Intersect of
 * two overlapping squares, grid-repeated (squares: a boolean of curves is exact only to the Wasm's flattening tolerance).
 */
async function setup(kind: RepeatKind | 'boolean') {
  const f = await createStudioFixture();
  const target = f.document.target('p1');
  let source: NodeId = 'r';
  if (kind === 'boolean') {
    const square = (node: string, x: number, y: number): PartOp => create(node, { [P.x]: x, [P.y]: y, [P.w]: 120, [P.h]: 120, [P.fills]: FILL });
    unwrap(commitEdit(target, person, 'Seed', ok([square('outer', 200, 300), square('inner', 260, 340)])));
    const ops = unwrap(booleanGroup(f.document.context(), ['outer', 'inner'], 'intersect'));
    source = (ops[0] as { node: string }).node;
    unwrap(commitEdit(target, person, 'Intersect', ok(ops)));
  } else {
    unwrap(commitEdit(target, person, 'Seed', ok([create('r', { [P.x]: 200, [P.y]: 300, [P.w]: 100, [P.h]: 50, [P.fills]: FILL })])));
  }
  const rops = unwrap(makeRepeat(f.document.context(), [source], newRepeatParams(kind === 'boolean' ? 'grid' : kind)));
  const repeat = (rops[0] as { node: string }).node;
  unwrap(commitRepeatEdit(target, person, 'Repeat', ok(rops)));
  const ctx = f.document.context();
  const scope = createScope('resize-repeat');
  const index = createElementIndex(ctx, 'p1', scope);
  const view = createViewState({ tab: 't1', root: 'p1', viewport: { width: 1600, height: 1600 } });
  const base = { ctx, target, session: f.document.session, index, view, actor: () => person };
  const tools: ToolSession = { ...base, mode: createTransformMode(base, scope) };
  const nodes = [repeat, ...f.document.view.sourceChildren(repeat), ...(kind === 'boolean' ? ['outer', 'inner'] : [])];
  const props = (): unknown => nodes.map((n) => f.document.part('p1')?.node(n)?.props);
  const bounds = (): Box => unwrap(elementBounds(ctx, repeat)).geometry;
  const instances = (): number => f.document.view.children(repeat).length;
  return { f, ctx, tools, repeat, source, props, bounds, instances };
}

function expectBox(actual: Box, expected: Box, digits = 6): void {
  expect(actual.minX).toBeCloseTo(expected.minX, digits);
  expect(actual.minY).toBeCloseTo(expected.minY, digits);
  expect(actual.maxX).toBeCloseTo(expected.maxX, digits);
  expect(actual.maxY).toBeCloseTo(expected.maxY, digits);
}

const GESTURES: readonly { readonly handle: ResizeHandleId; readonly dx: number; readonly dy: number; readonly options: ResizeOptions }[] = [
  { handle: 'se', dx: 60, dy: 40, options: {} },
  { handle: 'nw', dx: -40, dy: 30, options: {} },
  { handle: 'e', dx: 80, dy: 0, options: {} },
  { handle: 's', dx: 0, dy: -30, options: {} },
  { handle: 'se', dx: 90, dy: 10, options: { aspect: true } },
  { handle: 'w', dx: -50, dy: 0, options: { aspect: true } },
  { handle: 'se', dx: 30, dy: 20, options: { fromCenter: true } },
  { handle: 'n', dx: 0, dy: -25, options: { fromCenter: true } },
  { handle: 'nw', dx: -30, dy: -10, options: { aspect: true, fromCenter: true } },
];

/**
 * Where the whole repeat lands is the resized frame exactly when the scale is an affine image of the repeat: a grid
 * and a vertical mirror for any scale, a radial only for a uniform one (a circle stays a circle).
 */
const exact = (kind: RepeatKind | 'boolean', options: ResizeOptions): boolean => kind !== 'radial' || options.aspect === true;

const KINDS = ['grid', 'radial', 'mirror', 'boolean'] as const;

describe.skipIf(!authoringBuilt)('resizing a repeat scales it like a group (#76)', () => {
  for (const kind of KINDS) {
    it(`${kind}: corner and edge handles, Shift and Alt: the size persists, the count stays, undo restores`, async () => {
      for (const g of GESTURES) {
        const { f, ctx, repeat, props, bounds, instances } = await setup(kind);
        const stored = props();
        const before = bounds();
        const count = instances();
        const start = unwrap(captureTransform(ctx, [repeat]));
        expectBox(start.frame.bounds, before);
        const values = resizeValues(start, g.handle, g.dx, g.dy, g.options);
        unwrap(commitEdit(f.document.target('p1'), person, 'Resize', ok(valuesToOps(start, values))));
        const after = bounds();
        const expected = resizedBounds(before, g.handle, g.dx, g.dy, g.options);
        if (exact(kind, g.options)) expectBox(after, expected);
        else expect(Math.abs(after.maxX - after.minX - (before.maxX - before.minX)) + Math.abs(after.maxY - after.minY - (before.maxY - before.minY))).toBeGreaterThan(1);
        expect(instances()).toBe(count);
        expect(f.document.undo.history(person.id).undo[0]?.label).toBe('Resize');
        const steps = f.document.undo.history(person.id).undo.length;
        unwrap(await f.document.undo.undo(person, f.signal));
        expect(f.document.undo.history(person.id).undo).toHaveLength(steps - 1);
        expect(props()).toEqual(stored);
        expectBox(bounds(), before, 9);
      }
    });
  }

  it('the spacing scales with the source: grid gaps and offsets, the radial radius, the mirror offset', async () => {
    const grid = await setup('grid');
    unwrap(commitRepeatEdit(grid.f.document.target('p1'), person, 'Offsets', ok([
      { op: 'set', node: grid.repeat, path: RP.rowOffset, value: 10 },
      { op: 'set', node: grid.repeat, path: RP.columnOffset, value: 6 },
    ])));
    const gp = grid.f.document.view.params(grid.repeat);
    if (gp?.kind !== 'grid') throw new Error('not a grid');
    let start = unwrap(captureTransform(grid.ctx, [grid.repeat]));
    const w0 = start.frame.bounds.maxX - start.frame.bounds.minX;
    const h0 = start.frame.bounds.maxY - start.frame.bounds.minY;
    unwrap(commitEdit(grid.f.document.target('p1'), person, 'Resize', ok(valuesToOps(start, resizeValues(start, 'se', w0, h0 / 2)))));
    expect(grid.f.document.view.params(grid.repeat)).toMatchObject({ rows: gp.rows, columns: gp.columns, gapX: gp.gapX * 2, gapY: gp.gapY * 1.5, rowOffset: 20, columnOffset: 9, brickShift: gp.brickShift });
    expect(grid.f.document.view.value('r', P.w)).toBeCloseTo(200, 9);
    expect(grid.f.document.view.value('r', P.h)).toBeCloseTo(75, 9);

    const radial = await setup('radial');
    const rp = radial.f.document.view.params(radial.repeat);
    if (rp?.kind !== 'radial') throw new Error('not radial');
    start = unwrap(captureTransform(radial.ctx, [radial.repeat]));
    unwrap(commitEdit(radial.f.document.target('p1'), person, 'Resize', ok(valuesToOps(start, resizeValues(start, 'se', 10, 10, { aspect: true, fromCenter: true })))));
    // A uniform scale: the radius scales by the frame's factor.
    const k = (radial.bounds().maxX - radial.bounds().minX) / (start.frame.bounds.maxX - start.frame.bounds.minX);
    expect(radial.f.document.view.params(radial.repeat)).toMatchObject({ count: rp.count, sweep: rp.sweep, startAngle: rp.startAngle, radius: expect.closeTo(rp.radius * k, 9) });

    const mirror = await setup('mirror');
    unwrap(commitRepeatEdit(mirror.f.document.target('p1'), person, 'Offset', ok([{ op: 'set', node: mirror.repeat, path: RP.offset, value: 20 }])));
    start = unwrap(captureTransform(mirror.ctx, [mirror.repeat]));
    const mw = start.frame.bounds.maxX - start.frame.bounds.minX;
    unwrap(commitEdit(mirror.f.document.target('p1'), person, 'Resize', ok(valuesToOps(start, resizeValues(start, 'e', mw, 0)))));
    expect(mirror.f.document.view.params(mirror.repeat)).toMatchObject({ axis: 'vertical', offset: expect.closeTo(40, 9) });
  });

  it('a drag on a handle shows the scaled repeat live, and on release the same size stays as one undo step (Shift and Alt by pointer)', async () => {
    for (const kind of KINDS) {
      for (const mods of [{}, { shift: true }, { alt: true }]) {
        const { f, tools, repeat, source, props, bounds } = await setup(kind);
        const tool = createToolController(tools);
        tools.view.select([repeat]);
        refreshOverlay(tools);
        const before = bounds();
        const stored = props();
        const steps = f.document.undo.history(person.id).undo.length;
        unwrap(tool.pointer({ phase: 'down', x: before.maxX, y: before.maxY, ...mods }));
        unwrap(tool.pointer({ phase: 'move', x: before.maxX + 20, y: before.maxY + 10, mod: true, ...mods }));
        unwrap(tool.pointer({ phase: 'move', x: before.maxX + 50, y: before.maxY + 20, mod: true, ...mods }));
        expect(tool.state).toBe('resizing');
        const shown = bounds();
        expect(props()).toEqual(stored);
        const done = unwrap(tool.pointer({ phase: 'up', x: before.maxX + 50, y: before.maxY + 20, mod: true, ...mods }));
        expect(done).toMatchObject({ kind: 'committed', label: 'Resize' });
        // What the drag showed is what stays.
        expectBox(bounds(), shown);
        expect(shown.maxX - shown.minX).toBeGreaterThan(before.maxX - before.minX + 1);
        const options = { aspect: 'shift' in mods, fromCenter: 'alt' in mods };
        if (exact(kind, options)) expectBox(bounds(), resizedBounds(before, 'se', 50, 20, options));
        expect(f.document.undo.history(person.id).undo).toHaveLength(steps + 1);
        for (const n of [repeat, source]) expect(f.document.session.opinions(n)).toBeUndefined();
        unwrap(await f.document.undo.undo(person, f.signal));
        expect(props()).toEqual(stored);
      }
    }
  });

  it('the numeric W and H resize the repeat from the top-left (linked keeps the ratio); undo restores', async () => {
    for (const kind of KINDS) {
      const { f, tools, repeat, props, bounds } = await setup(kind);
      tools.view.select([repeat]);
      const { mode: _mode, ...host } = tools;
      const before = bounds();
      const stored = props();
      const w0 = before.maxX - before.minX;
      const h0 = before.maxY - before.minY;
      unwrap(applyTransform(host, 'Resize', (s) => numericValues(s, { field: 'w', value: 2 * w0, linked: true })));
      expectBox(bounds(), { minX: before.minX, minY: before.minY, maxX: before.minX + 2 * w0, maxY: before.minY + 2 * h0 });
      if (kind !== 'radial') {
        unwrap(applyTransform(host, 'Resize', (s) => numericValues(s, { field: 'h', value: 3 * h0 })));
        expectBox(bounds(), { minX: before.minX, minY: before.minY, maxX: before.minX + 2 * w0, maxY: before.minY + 3 * h0 });
        unwrap(await f.document.undo.undo(person, f.signal));
      }
      unwrap(await f.document.undo.undo(person, f.signal));
      expect(props()).toEqual(stored);
      expectBox(bounds(), before, 9);
    }
  });
});
