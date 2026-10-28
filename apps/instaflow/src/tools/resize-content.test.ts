// @vitest-environment node
// #54 / #66: resizing an element whose outline does not come from its box (a vector's path, a boolean's or a group's
// children) scales that outline; the box hugs it; Shift and Alt work as for shapes; the numeric W/H do the same; one
// undo step restores everything.
import { ok } from '@staticflux/core';
import type { Box } from '@staticflux/document/spatial-index';
import type { PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { boundsIn, elementBounds, pageTransform } from '../elements/layout.js';
import { multiply, resolveElement } from '../elements/resolve.js';
import { numericValues } from './free-transform.js';
import { createToolController } from './gesture.js';
import { authoringBuilt, createToolFixture, human, shape, unwrap } from './testing/fixtures.js';
import { applyTransform } from './transform-mode.js';
import { captureTransform, frameBox, moveValues, type ResizeHandleId, resizedBounds, type ResizeOptions, resizeValues, selectionFrame, transformWrites, valuesToOps } from './transform.js';

const signal = new AbortController().signal;
const FILL = [{ paint: '#ff0000' }];
const rect = (id: string, x: number, y: number, w: number, h: number, parent = 'p1', extra: Record<string, unknown> = {}): PartOp =>
  shape(id, { [P.x]: x, [P.y]: y, [P.w]: w, [P.h]: h, [P.fills]: FILL, ...extra }, parent);
/** A triangle filling its 100 × 50 box (a flattened shape's path). */
const TRIANGLE = 'M0 0L100 0L50 50Z';
const operands = (parent: string): PartOp[] => [rect('a', 100, 100, 100, 100, parent), rect('b', 150, 150, 100, 100, parent)];

/** The kinds whose outline is not their box: node `k` in each. */
const KINDS: Readonly<Record<string, readonly PartOp[]>> = {
  path: [shape('k', { [P.x]: 100, [P.y]: 100, [P.w]: 100, [P.h]: 50, [P.path]: TRIANGLE, [P.fills]: FILL }, 'p1', 'vector')],
  union: [shape('k', { [P.boolean]: 'union', [P.fills]: FILL }, 'p1', 'group'), ...operands('k')],
  subtract: [shape('k', { [P.boolean]: 'subtract', [P.fills]: FILL }, 'p1', 'group'), ...operands('k')],
  intersect: [shape('k', { [P.boolean]: 'intersect', [P.fills]: FILL }, 'p1', 'group'), ...operands('k')],
  exclude: [shape('k', { [P.boolean]: 'exclude', [P.fills]: FILL }, 'p1', 'group'), ...operands('k')],
  group: [shape('k', {}, 'p1', 'group'), ...operands('k')],
};

const GESTURES: readonly { readonly handle: ResizeHandleId; readonly dx: number; readonly dy: number; readonly options: ResizeOptions }[] = [
  { handle: 'se', dx: 40, dy: 30, options: {} },
  { handle: 'nw', dx: -30, dy: 20, options: {} },
  { handle: 'e', dx: 50, dy: 0, options: {} },
  { handle: 's', dx: 0, dy: -20, options: {} },
  { handle: 'se', dx: 60, dy: 10, options: { aspect: true } },
  { handle: 'e', dx: 30, dy: 0, options: { aspect: true } },
  { handle: 'se', dx: 20, dy: 10, options: { fromCenter: true } },
  { handle: 'n', dx: 0, dy: -15, options: { fromCenter: true } },
  { handle: 'nw', dx: -20, dy: -5, options: { aspect: true, fromCenter: true } },
];

const geometry = (f: Awaited<ReturnType<typeof createToolFixture>>, node: string): Box => unwrap(elementBounds(f.ctx, node)).geometry;

function expectBox(actual: Box | undefined, expected: Box, digits = 6): void {
  expect(actual).toBeDefined();
  expect(actual?.minX).toBeCloseTo(expected.minX, digits);
  expect(actual?.minY).toBeCloseTo(expected.minY, digits);
  expect(actual?.maxX).toBeCloseTo(expected.maxX, digits);
  expect(actual?.maxY).toBeCloseTo(expected.maxY, digits);
}

/** Every stored value of the nodes (what undo must restore). */
const snapshot = (f: Awaited<ReturnType<typeof createToolFixture>>, nodes: readonly string[]): unknown => nodes.map((n) => f.part.node(n)?.props);

describe.skipIf(!authoringBuilt)('resizing paths, booleans and groups scales their outline (#54, #66)', () => {
  for (const [kind, ops] of Object.entries(KINDS)) {
    it(`${kind}: corner and edge handles, Shift and Alt, scale the outline about the fixed point; the box hugs it; undo restores`, async () => {
      for (const g of GESTURES) {
        const f = await createToolFixture(ops);
        const nodes = ['k', ...f.stage.children('k')];
        const stored = snapshot(f, nodes);
        const before = geometry(f, 'k');
        // The frame hugs the outline before any edit.
        expectBox(unwrap(selectionFrame(f.ctx, ['k']))?.bounds, before);
        const start = unwrap(captureTransform(f.ctx, ['k']));
        const values = resizeValues(start, g.handle, g.dx, g.dy, g.options);
        unwrap(commitEdit(f.tools.target, human, 'Resize', ok(valuesToOps(start, values))));
        const expected = resizedBounds(before, g.handle, g.dx, g.dy, g.options);
        expectBox(geometry(f, 'k'), expected);
        expectBox(unwrap(selectionFrame(f.ctx, ['k']))?.bounds, expected);
        expect(f.undo.history(human.id).undo).toHaveLength(1);
        unwrap(await f.undo.undo(human, signal));
        expect(snapshot(f, nodes)).toEqual(stored);
        expectBox(geometry(f, 'k'), before, 9);
      }
    });
  }

  it('a group scales its children proportionally (nested groups too), inside an offset parent', async () => {
    const f = await createToolFixture([
      shape('fr', { [P.x]: 50, [P.y]: 40, [P.w]: 800, [P.h]: 600 }, 'p1', 'frame'),
      shape('k', {}, 'fr', 'group'),
      rect('a', 0, 0, 100, 50, 'k'),
      shape('k2', {}, 'k', 'group'),
      rect('c', 100, 50, 100, 50, 'k2'),
    ]);
    const before = geometry(f, 'k');
    expectBox(before, { minX: 50, minY: 40, maxX: 250, maxY: 140 });
    const start = unwrap(captureTransform(f.ctx, ['k']));
    unwrap(commitEdit(f.tools.target, human, 'Resize', ok(valuesToOps(start, resizeValues(start, 'se', 200, 100)))));
    // Twice the size from the top-left: every child doubles and keeps its place in the group.
    expectBox(geometry(f, 'k'), { minX: 50, minY: 40, maxX: 450, maxY: 240 });
    expectBox(geometry(f, 'a'), { minX: 50, minY: 40, maxX: 250, maxY: 140 });
    expectBox(geometry(f, 'c'), { minX: 250, minY: 140, maxX: 450, maxY: 240 });
    // The group itself stays where it is (its children took the scale); sizes changed, not scale factors (strokes and
    // corners keep their widths).
    expect([f.stage.value('k', P.x), f.stage.value('k', P.y), f.stage.value('k2', P.x), f.stage.value('k2', P.y)]).toEqual([undefined, undefined, undefined, undefined]);
    expect([f.stage.value('a', P.w), f.stage.value('a', P.h), f.stage.value('c', P.w), f.stage.value('c', P.h)]).toEqual([200, 100, 200, 100]);
    expect(f.stage.value('a', P.scaleX)).toBeUndefined();
  });

  it('a rotated group and a rotated path resize in their own axes: the opposite corner stays, the box hugs', async () => {
    for (const ops of [
      [shape('k', { [P.x]: 300, [P.y]: 200, [P.rotation]: 30 }, 'p1', 'group'), rect('a', 0, 0, 100, 50, 'k'), rect('b', 100, 50, 100, 50, 'k')],
      [shape('k', { [P.x]: 300, [P.y]: 200, [P.w]: 100, [P.h]: 50, [P.rotation]: 30, [P.path]: TRIANGLE, [P.fills]: FILL }, 'p1', 'vector')],
    ]) {
      const f = await createToolFixture(ops);
      const start = unwrap(captureTransform(f.ctx, ['k']));
      const [tl, tr, , bl] = start.frame.corners;
      const w0 = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
      const h0 = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
      const r = (30 * Math.PI) / 180;
      // 20 units along the element's x axis and 10 along its y axis.
      const values = resizeValues(start, 'se', 20 * Math.cos(r) - 10 * Math.sin(r), 20 * Math.sin(r) + 10 * Math.cos(r));
      unwrap(commitEdit(f.tools.target, human, 'Resize', ok(valuesToOps(start, values))));
      const after = unwrap(selectionFrame(f.ctx, ['k']));
      const [atl, atr, , abl] = after?.corners ?? start.frame.corners;
      expect(atl[0]).toBeCloseTo(tl[0], 6);
      expect(atl[1]).toBeCloseTo(tl[1], 6);
      expect(Math.hypot(atr[0] - atl[0], atr[1] - atl[1])).toBeCloseTo(w0 + 20, 6);
      expect(Math.hypot(abl[0] - atl[0], abl[1] - atl[1])).toBeCloseTo(h0 + 10, 6);
      expect(after?.rotation).toBeCloseTo(30, 6);
      // The box hugs the outline in its own axes: the outline's bounds in a page turned by −30° are the frame's size.
      const turned = multiply([Math.cos(-r), Math.sin(-r), -Math.sin(-r), Math.cos(-r), 0, 0], pageTransform(f.ctx, 'k'));
      const own = unwrap(boundsIn(f.ctx, 'k', turned));
      expect((own?.maxX ?? 0) - (own?.minX ?? 0)).toBeCloseTo(w0 + 20, 6);
      expect((own?.maxY ?? 0) - (own?.minY ?? 0)).toBeCloseTo(h0 + 10, 6);
    }
  });

  it('a drag on a handle previews the scaled outline live, then commits one undo step (Shift and Alt by pointer)', async () => {
    for (const kind of ['path', 'union', 'group']) {
      for (const mods of [{}, { shift: true }, { alt: true }]) {
        const f = await createToolFixture(KINDS[kind] ?? []);
        const tool = createToolController(f.tools);
        const before = geometry(f, 'k');
        const stored = snapshot(f, ['k', ...f.stage.children('k')]);
        unwrap(tool.pointer({ phase: 'down', x: (before.minX + before.maxX) / 2, y: (before.minY + before.maxY) / 2 }));
        unwrap(tool.pointer({ phase: 'up', x: (before.minX + before.maxX) / 2, y: (before.minY + before.maxY) / 2 }));
        expect(f.view.selection).toEqual(['k']);
        unwrap(tool.pointer({ phase: 'down', x: before.maxX, y: before.maxY, ...mods }));
        unwrap(tool.pointer({ phase: 'move', x: before.maxX + 20, y: before.maxY + 5, mod: true, ...mods }));
        unwrap(tool.pointer({ phase: 'move', x: before.maxX + 40, y: before.maxY + 10, mod: true, ...mods }));
        expect(tool.state).toBe('resizing');
        const options = { aspect: 'shift' in mods, fromCenter: 'alt' in mods };
        const expected = resizedBounds(before, 'se', 40, 10, options);
        // Live: the preview already shows the scaled outline; nothing is written yet.
        expectBox(geometry(f, 'k'), expected);
        expect(snapshot(f, ['k', ...f.stage.children('k')])).toEqual(stored);
        const done = unwrap(tool.pointer({ phase: 'up', x: before.maxX + 40, y: before.maxY + 10, mod: true, ...mods }));
        expect(done).toMatchObject({ kind: 'committed', label: 'Resize' });
        expectBox(geometry(f, 'k'), expected);
        expect(f.undo.history(human.id).undo).toHaveLength(1);
        for (const n of ['k', ...f.stage.children('k')]) expect(f.session.opinions(n)).toBeUndefined();
      }
    }
  });

  it('the numeric W and H scale the outline from the top-left (linked keeps the ratio), and escape-cancelled sessions leave it', async () => {
    for (const kind of ['path', 'subtract', 'group']) {
      const f = await createToolFixture(KINDS[kind] ?? []);
      f.view.select(['k']);
      const { mode: _mode, ...host } = f.tools;
      const before = geometry(f, 'k');
      const w0 = before.maxX - before.minX;
      const h0 = before.maxY - before.minY;
      unwrap(applyTransform(host, 'Resize', (s) => numericValues(s, { field: 'w', value: 300 })));
      expectBox(geometry(f, 'k'), { minX: before.minX, minY: before.minY, maxX: before.minX + 300, maxY: before.maxY });
      unwrap(applyTransform(host, 'Resize', (s) => numericValues(s, { field: 'h', value: 2 * h0, linked: true })));
      expectBox(geometry(f, 'k'), { minX: before.minX, minY: before.minY, maxX: before.minX + 600, maxY: before.minY + 2 * h0 });
      unwrap(await f.undo.undo(human, signal));
      unwrap(await f.undo.undo(human, signal));
      expectBox(geometry(f, 'k'), { minX: before.minX, minY: before.minY, maxX: before.minX + w0, maxY: before.maxY }, 9);
      // In a transform session the steps stack as previews; Escape leaves everything as it was, Enter applies one step.
      const mode = f.tools.mode;
      if (mode === undefined) throw new Error('no transform mode');
      unwrap(mode.enter());
      unwrap(applyTransform(f.tools, 'Resize', (s) => numericValues(s, { field: 'w', value: 2 * w0 })));
      unwrap(applyTransform(f.tools, 'Resize', (s) => numericValues(s, { field: 'h', value: 2 * h0 })));
      expectBox(geometry(f, 'k'), { minX: before.minX, minY: before.minY, maxX: before.minX + 2 * w0, maxY: before.minY + 2 * h0 });
      unwrap(mode.cancel());
      expectBox(geometry(f, 'k'), before, 9);
      unwrap(mode.enter());
      unwrap(applyTransform(f.tools, 'Resize', (s) => numericValues(s, { field: 'w', value: 2 * w0 })));
      unwrap(applyTransform(f.tools, 'Resize', (s) => numericValues(s, { field: 'h', value: 2 * h0 })));
      unwrap(mode.commit());
      expectBox(geometry(f, 'k'), { minX: before.minX, minY: before.minY, maxX: before.minX + 2 * w0, maxY: before.minY + 2 * h0 });
      for (const n of ['k', ...f.stage.children('k')]) expect(f.session.opinions(n)).toBeUndefined();
    }
  });

  it('frameBox and transformWrites: the frame box of a group; commits write changes only, previews everything they reach', async () => {
    const f = await createToolFixture([...(KINDS['group'] ?? []), ...(KINDS['path'] ?? []).map((op) => ({ ...op, node: 'v' }) as PartOp), shape('empty', {}, 'p1', 'group')]);
    const group = resolveElement(f.stage, 'k', f.ctx.kit);
    if (group === undefined) throw new Error('no group');
    expect(unwrap(frameBox(f.ctx, group))).toMatchObject({ x: 100, y: 100, w: 150, h: 150, rotation: 0 });
    const empty = resolveElement(f.stage, 'empty', f.ctx.kit);
    if (empty === undefined) throw new Error('no empty group');
    expect(unwrap(frameBox(f.ctx, empty))).toBe(empty.box);
    const start = unwrap(captureTransform(f.ctx, ['k', 'v']));
    // A move: the group's own x (no child), the vector's x; a preview also rewrites y, the path and every child.
    const moved = moveValues(start, 10, 0);
    expect(transformWrites(start, moved).map((w) => `${w.node} ${w.path}`)).toEqual(['k spatial.x', 'v spatial.x']);
    const shown = transformWrites(start, moved, 'shown').map((w) => `${w.node} ${w.path}`);
    expect(shown).toEqual(expect.arrayContaining(['k spatial.x', 'k spatial.y', 'a spatial.w', 'b spatial.x', 'v spatial.x', 'v spatial.y', `v ${P.path}`]));
    expect(transformWrites(start, moved, 'shown').find((w) => w.node === 'v' && w.path === P.path)?.value).toBe(TRIANGLE);
    // Values for a node outside the start are written as given.
    expect(transformWrites(start, [{ node: 'other', x: 1, y: 2 }])).toEqual([
      { node: 'other', path: P.x, value: 1 },
      { node: 'other', path: P.y, value: 2 },
    ]);
  });
});
