// @vitest-environment node
// #68: dragging or rotating a boolean that is repeated (Intersect, then Grid repeat) must not recompute the boolean
// in the Wasm module on every pointer move: a move or a rotation changes transforms only, and derived outlines are
// cached by their inputs. Edits to what the outline is made of (an operand, the op, the repeat count or spacing)
// still show. Counts calls that reach the authoring Wasm (no timing).
import { createScope, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { booleanGroup, commitEdit, setBooleanOp } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { createGeometry } from '../elements/geometry.js';
import { boundsIn, elementBounds, localOutline } from '../elements/layout.js';
import { resolveElement } from '../elements/resolve.js';
import { countingWasm, loadAuthoringWasm } from '../elements/testing/fixtures.js';
import { commitRepeatEdit, makeRepeat, newRepeatParams, setRepeat } from '../repeat/actions.js';
import { wrapperId } from '../repeat/stage.js';
import { toScreen } from '../tools/view-state.js';
import { attachCanvasRender, createCanvasPipes, createElementSceneSide } from './canvas-pipeline.js';
import { openCanvasTab } from './canvas-tab.js';
import { createElementRenderPort, createRecordingRaster } from './element-port.js';
import { authoringBuilt, createStudioFixture, manualTimers, person, unwrap } from './test-helpers.js';

const ellipse = (node: string, x: number, y: number, size: number) => ({
  op: 'create' as const,
  node,
  kind: 'shape',
  parent: 'p1',
  props: { [P.x]: x, [P.y]: y, [P.w]: size, [P.h]: size, [P.shape]: 'ellipse', [P.fills]: [{ paint: '#ff5c39' }] },
});

async function setup(options: { readonly repeat: boolean } = { repeat: true }) {
  const counter = countingWasm(await loadAuthoringWasm());
  const f = await createStudioFixture({ geometry: createGeometry(counter.wasm) });
  const scope = createScope('tab');
  const pipes = unwrap(createCanvasPipes({ medium: 'local' }));
  scope.defer(() => pipes.close());
  const side = createElementSceneSide();
  // Accessibility projections coalesce per frame, as in the editor worker (`a11ySchedule`: its frame callback).
  let frameQueue: (() => void)[] = [];
  const render = unwrap(await attachCanvasRender({ pipes: pipes.endpoints, port: createElementRenderPort({ side, raster: createRecordingRaster() }), side, signal: scope.signal }));
  const tab = unwrap(
    await openCanvasTab({
      tab: 't1',
      document: f.document,
      page: 'p1',
      fonts: f.fonts,
      publisher: pipes.publisher,
      viewport: { width: 1000, height: 800 },
      actor: () => person,
      tool: () => 'instaflow/select',
      announcer: { announce: () => undefined },
      timers: manualTimers(),
      schedule: (fn) => fn(),
      a11ySchedule: (fn) => void frameQueue.push(fn),
      scope,
    }),
  );
  const target = f.document.target('p1');
  // A circle with a smaller circle inside it, intersected, then (the owner's case) repeated on a 3 × 3 grid.
  unwrap(commitEdit(target, person, 'Seed', ok([ellipse('outer', 100, 100, 200), ellipse('inner', 150, 150, 100)])));
  const ctx = f.document.context();
  const ops = unwrap(booleanGroup(ctx, ['outer', 'inner'], 'intersect'));
  const bool = (ops[0] as { node: string }).node;
  unwrap(commitEdit(target, person, 'Intersect', ok(ops)));
  const rops = options.repeat ? unwrap(makeRepeat(f.document.context(), [bool], newRepeatParams('grid'))) : [];
  const repeat = options.repeat ? (rops[0] as { node: string }).node : bool;
  if (options.repeat) unwrap(commitRepeatEdit(target, person, 'Grid repeat', ok(rops)));
  /** One frame: the accessibility projection, then the render side draws. */
  const draw = (): void => {
    const queued = frameQueue;
    frameQueue = [];
    for (const fn of queued) fn();
    render.render.update('arrival');
  };
  draw();
  return { f, tab, counter, bool, repeat, draw, scope };
}

type Rig = Awaited<ReturnType<typeof setup>>;

/** Pointer gestures on the rig's tab; each returns the Wasm calls of its moves after the first one. */
function gestures({ tab, counter, draw }: Rig) {
  const at = (x: number, y: number): readonly [number, number] => toScreen(tab.view.camera, x, y);
  /** Pointer moves after the first one of a gesture: what reached the Wasm module. */
  const gesture = (start: { x: number; y: number }, step: (i: number) => { x: number; y: number }, moves = 12): Readonly<Record<string, number>> => {
    unwrap(tab.pointer({ phase: 'down', ...start }));
    unwrap(tab.pointer({ phase: 'move', ...step(1) }));
    draw();
    counter.reset();
    for (let i = 2; i <= moves; i++) {
      unwrap(tab.pointer({ phase: 'move', ...step(i) }));
      draw();
    }
    const calls = { ...counter.calls };
    unwrap(tab.pointer({ phase: 'up', ...step(moves) }));
    draw();
    return calls;
  };
  const drag = (x: number, y: number) => gesture({ x, y }, (i) => ({ x: x + 3 * i, y: y + 2 * i }));
  /** Rotate by the zone just outside the selection frame's top-right corner, around its centre. */
  const rotate = () => {
    const corners = tab.view.overlay.frame?.corners ?? [];
    expect(corners).toHaveLength(4);
    const [sx, sy] = at(corners.reduce((s, c) => s + c[0], 0) / 4, corners.reduce((s, c) => s + c[1], 0) / 4);
    const [tx, ty] = at(corners[1]?.[0] ?? 0, corners[1]?.[1] ?? 0);
    const radius = Math.hypot(tx - sx, ty - sy) + 10;
    const a0 = Math.atan2(ty - sy, tx - sx);
    const point = (a: number) => ({ x: sx + Math.cos(a) * radius, y: sy + Math.sin(a) * radius });
    return gesture(point(a0), (i) => point(a0 + 0.04 * i));
  };
  return { at, drag, rotate };
}

describe.skipIf(!authoringBuilt)('derived geometry during a drag (#68)', () => {
  it('dragging or rotating an Intersect + Grid repeat (the repeat or its source) never re-runs the boolean per move', { timeout: 60_000 }, async () => {
    const rig = await setup();
    const { f, tab, counter, bool, repeat, draw } = rig;
    expect(f.document.view.children(repeat)).toHaveLength(9);
    const { at, drag, rotate } = gestures(rig);
    const value = (node: string, path: string) => Number(f.document.view.value(node, path) ?? 0);

    // A press inside the inner circle selects the repeat; drag it, then rotate it.
    const [x0, y0] = at(200, 200);
    const startX = value(repeat, P.x);
    let calls = drag(x0, y0);
    expect(tab.view.selection).toEqual([repeat]);
    expect(value(repeat, P.x) - startX).toBeGreaterThan(10);
    expect(calls['boolean_op'] ?? 0).toBe(0);
    expect(calls['shape_outline'] ?? 0).toBe(0);
    calls = rotate();
    expect(Math.abs(value(repeat, P.rotation))).toBeGreaterThan(10);
    expect(calls['boolean_op'] ?? 0).toBe(0);
    expect(calls['shape_outline'] ?? 0).toBe(0);

    // The source (the boolean inside the repeat, as Layers selects it) previewed the way a drag does (session layer):
    // all nine copies move and turn, and still no boolean runs.
    for (let i = 1; i <= 12; i++) {
      f.document.session.set(bool, P.x, 100 + 5 * i);
      f.document.session.set(bool, P.rotation, 3 * i);
      tab.publish();
      draw();
      if (i === 1) counter.reset();
    }
    expect(unwrap(elementBounds(f.document.context(), `${wrapperId(repeat, 4)}^${bool}`)).transform).not.toEqual([1, 0, 0, 1, 0, 0]);
    expect(counter.calls['boolean_op'] ?? 0).toBe(0);
    expect(counter.calls['shape_outline'] ?? 0).toBe(0);
    f.document.session.clear();
  });

  it('dragging or rotating an Intersect alone never re-runs the boolean per move (a rotation re-places its operands)', { timeout: 60_000 }, async () => {
    const rig = await setup({ repeat: false });
    const { f, tab, bool } = rig;
    const { at, drag, rotate } = gestures(rig);
    const value = (node: string, path: string) => Number(f.document.view.value(node, path) ?? 0);
    const [x0, y0] = at(200, 200);
    const startX = value(bool, P.x);
    let calls = drag(x0, y0);
    expect(tab.view.selection).toEqual([bool]);
    expect(value(bool, P.x) - startX).toBeGreaterThan(10);
    expect(calls['boolean_op'] ?? 0).toBe(0);
    calls = rotate();
    expect(Math.abs(value(bool, P.rotation))).toBeGreaterThan(10);
    expect(calls['boolean_op'] ?? 0).toBe(0);
    expect(calls['shape_outline'] ?? 0).toBe(0);
  });

  it('editing an operand, the boolean op, or the repeat count or spacing still updates the derived geometry', async () => {
    const { f, bool, repeat } = await setup();
    const target = f.document.target('p1');
    const ctx = f.document.context();
    const view = f.document.view;
    const outline = (node: string) => unwrap(boundsIn(ctx, node, [1, 0, 0, 1, 0, 0]));
    const copy = `${wrapperId(repeat, 4)}^${bool}`; // the middle instance's copy of the boolean
    const copyBox = () => unwrap(elementBounds(ctx, copy)).geometry;
    // Intersect of the circles is the inner circle (100 wide); the middle copy sits one cell (+ gap) away.
    expect(outline(bool)?.maxX).toBeCloseTo(250, 3);
    expect(copyBox().maxX - copyBox().minX).toBeCloseTo(100, 3);

    // An operand: the inner circle grows to 140 → the intersection does too, in the source and every copy.
    unwrap(commitEdit(target, person, 'Grow', ok([{ op: 'set', node: 'inner', path: P.w, value: 140 }, { op: 'set', node: 'inner', path: P.h, value: 140 }])));
    expect(outline(bool)?.maxX).toBeCloseTo(290, 3);
    expect(copyBox().maxX - copyBox().minX).toBeCloseTo(140, 3);
    const resolved = resolveElement(view, copy, f.document.kit);
    expect(resolved === undefined ? 0 : unwrap(localOutline(ctx, resolved)).verbs.length).toBeGreaterThan(0);

    // The op: union reaches the outer circle (200 wide).
    unwrap(commitEdit(target, person, 'Union', setBooleanOp(ctx, bool, 'union')));
    expect(outline(bool)?.maxX).toBeCloseTo(300, 3);
    expect(copyBox().maxX - copyBox().minX).toBeCloseTo(200, 3);

    // The repeat count and spacing.
    const before = copyBox().minX;
    unwrap(commitRepeatEdit(target, person, 'Spacing', setRepeat(ctx, repeat, { gapX: 66 }), (n) => view.params(n)));
    expect(copyBox().minX - before).toBeCloseTo(50, 3); // the gap grew from 16 to 66
    unwrap(commitRepeatEdit(target, person, 'Count', setRepeat(ctx, repeat, { rows: 1, columns: 2 }), (n) => view.params(n)));
    expect(view.children(repeat)).toHaveLength(2);
  });
});
