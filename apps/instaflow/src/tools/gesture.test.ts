// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { createToolController, GESTURES, PRESS_GESTURES, pruneSelection, selectionBox, TOOL_BEHAVIOURS, ToolGestureLifecycle } from './gesture.js';
import { authoringBuilt, createToolFixture, human, shape, unwrap } from './testing/fixtures.js';

const sq = (id: string, x: number, y: number, size = 50, extra: Record<string, unknown> = {}, parent = 'p1', kind = 'shape') =>
  shape(id, { [P.x]: x, [P.y]: y, [P.w]: size, [P.h]: size, [P.fills]: [{ paint: '#ff0000' }], ...extra }, parent, kind);

describe('gesture tables (rule 4: data, not branches)', () => {
  it('maps every behaviour × press target to a gesture strategy', () => {
    for (const table of Object.values(PRESS_GESTURES)) for (const kind of Object.values(table)) expect(GESTURES[kind]).toBeDefined();
    expect(TOOL_BEHAVIOURS[StudioIds.tool.select]).toBe('select');
    expect(TOOL_BEHAVIOURS[StudioIds.tool.hand]).toBe('hand');
    expect(PRESS_GESTURES.hand.element).toBe('pan');
    expect(ToolGestureLifecycle.transitions.pressed?.move).toBe('moving');
  });
});

describe.skipIf(!authoringBuilt)('the select tool', () => {
  it('click, Shift+click, Mod+click deep select, click on empty, double click to enter', async () => {
    const f = await createToolFixture([sq('a', 0, 0), sq('b', 100, 0), shape('g', {}, 'p1', 'group'), sq('c', 200, 0, 50, {}, 'g')]);
    const tool = createToolController(f.tools);
    const click = (x: number, y: number, mods: { shift?: boolean; mod?: boolean; clicks?: number } = {}) => {
      unwrap(tool.pointer({ phase: 'down', x, y, ...mods }));
      return unwrap(tool.pointer({ phase: 'up', x, y, ...mods }));
    };
    expect(click(10, 10)).toEqual({ kind: 'selection', selection: ['a'] });
    expect(f.view.overlay.handles).toHaveLength(12);
    click(110, 10, { shift: true });
    expect(f.view.selection).toEqual(['a', 'b']);
    click(110, 10, { shift: true });
    expect(f.view.selection).toEqual(['a']);
    click(10, 10);
    expect(f.view.selection).toEqual(['a']);
    click(220, 20);
    expect(f.view.selection).toEqual(['g']);
    click(220, 20, { mod: true });
    expect(f.view.selection).toEqual(['c']);
    click(500, 500);
    expect(f.view.selection).toEqual([]);
    click(220, 20, { clicks: 2 });
    expect(f.view.context).toBe('g');
    expect(f.view.selection).toEqual(['c']);
    click(600, 600);
    expect(f.view.context).toBe('p1');
    // Pressing an element of a multi-selection keeps the selection (to drag them all); releasing selects just it.
    f.view.select(['a', 'b']);
    unwrap(tool.pointer({ phase: 'down', x: 10, y: 10 }));
    expect(f.view.selection).toEqual(['a', 'b']);
    unwrap(tool.pointer({ phase: 'up', x: 10, y: 10 }));
    expect(f.view.selection).toEqual(['a']);
    expect(f.undo.history(human.id).undo).toHaveLength(0);
  });

  it('a drag is a preview in the session layer, then exactly one undo step; snapping shows guides; Mod disables it', async () => {
    const f = await createToolFixture([sq('a', 0, 0), sq('b', 200, 300)]);
    const tool = createToolController(f.tools);
    unwrap(tool.pointer({ phase: 'down', x: 25, y: 25 }));
    expect(tool.state).toBe('pressed');
    unwrap(tool.pointer({ phase: 'move', x: 26, y: 26 }));
    expect(tool.state).toBe('pressed');
    for (const x of [60, 100, 140, 172]) unwrap(tool.pointer({ phase: 'move', x, y: 125 }));
    expect(tool.state).toBe('moving');
    // a's right edge (50 + 147 = 197) snaps to b's left edge (200).
    expect(f.stage.value('a', P.x)).toBe(150);
    expect(f.part.node('a')?.props[P.x] ?? 0).toBe(0);
    expect(f.view.overlay.guides).toContainEqual(expect.objectContaining({ kind: 'line', axis: 'x', value: 200, line: 'edge' }));
    unwrap(tool.pointer({ phase: 'move', x: 172, y: 125, mod: true }));
    expect(f.stage.value('a', P.x)).toBe(147);
    expect(f.view.overlay.guides).toEqual([]);
    const done = unwrap(tool.pointer({ phase: 'up', x: 172, y: 125 }));
    expect(done).toEqual({ kind: 'committed', label: 'Move', ops: 2 });
    expect(tool.state).toBe('idle');
    expect(f.session.opinions('a')).toBeUndefined();
    expect(f.stage.value('a', P.x)).toBe(147);
    expect(f.stage.value('a', P.y)).toBe(100);
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    // Shift locks the axis.
    unwrap(tool.pointer({ phase: 'down', x: 170, y: 120 }));
    unwrap(tool.pointer({ phase: 'move', x: 190, y: 125, shift: true }));
    unwrap(tool.pointer({ phase: 'up', x: 190, y: 125, shift: true }));
    expect([f.stage.value('a', P.x), f.stage.value('a', P.y)]).toEqual([167, 100]);
    expect(f.undo.history(human.id).undo).toHaveLength(2);
  });

  it('Escape and pointercancel commit nothing and restore the preview', async () => {
    const f = await createToolFixture([sq('a', 0, 0)]);
    const tool = createToolController(f.tools);
    unwrap(tool.pointer({ phase: 'down', x: 10, y: 10 }));
    unwrap(tool.pointer({ phase: 'move', x: 300, y: 300 }));
    expect(f.stage.value('a', P.x)).toBe(290);
    expect(tool.cancel()).toEqual({ kind: 'cancelled' });
    expect(f.stage.value('a', P.x) ?? 0).toBe(0);
    expect(tool.state).toBe('idle');
    unwrap(tool.pointer({ phase: 'down', x: 10, y: 10 }));
    unwrap(tool.pointer({ phase: 'move', x: 300, y: 300 }));
    expect(unwrap(tool.pointer({ phase: 'cancel', x: 0, y: 0 }))).toEqual({ kind: 'cancelled' });
    expect(tool.cancel()).toEqual({ kind: 'none' });
    expect(f.undo.history(human.id).undo).toHaveLength(0);
  });

  it('resizes and rotates through the round handles (Shift snaps rotation to 15°)', async () => {
    const f = await createToolFixture([sq('a', 0, 0)]);
    const tool = createToolController(f.tools);
    unwrap(tool.pointer({ phase: 'down', x: 25, y: 25 }));
    unwrap(tool.pointer({ phase: 'up', x: 25, y: 25 }));
    unwrap(tool.pointer({ phase: 'down', x: 50, y: 50 }));
    unwrap(tool.pointer({ phase: 'move', x: 80, y: 71 }));
    expect(tool.state).toBe('resizing');
    expect(unwrap(tool.pointer({ phase: 'up', x: 80, y: 71 }))).toMatchObject({ kind: 'committed', label: 'Resize' });
    expect([f.stage.value('a', P.w), f.stage.value('a', P.h)]).toEqual([80, 71]);
    const handle = f.view.overlay.handles.find((h) => h.id === 'rotate-se');
    expect(handle).toBeDefined();
    const c = selectionBox(f.tools);
    const cx = ((c?.minX ?? 0) + (c?.maxX ?? 0)) / 2;
    const cy = ((c?.minY ?? 0) + (c?.maxY ?? 0)) / 2;
    const r = Math.hypot((handle?.x ?? 0) - cx, (handle?.y ?? 0) - cy);
    const a0 = Math.atan2((handle?.y ?? 0) - cy, (handle?.x ?? 0) - cx);
    unwrap(tool.pointer({ phase: 'down', x: handle?.x ?? 0, y: handle?.y ?? 0 }));
    const a1 = a0 + (37 * Math.PI) / 180;
    unwrap(tool.pointer({ phase: 'move', x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1), shift: true }));
    expect(tool.state).toBe('rotating');
    unwrap(tool.pointer({ phase: 'up', x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1), shift: true }));
    expect(f.stage.value('a', P.rotation)).toBeCloseTo(30, 9);
    const after = selectionBox(f.tools);
    expect(((after?.minX ?? 0) + (after?.maxX ?? 0)) / 2).toBeCloseTo(cx, 6);
    expect(f.undo.history(human.id).undo).toHaveLength(2);
  });

  it('marquee selects live (Shift adds, Alt needs containment); cancel restores the selection', async () => {
    const f = await createToolFixture([sq('a', 100, 100), sq('b', 200, 100), sq('c', 400, 400)]);
    const tool = createToolController(f.tools);
    f.view.select(['c']);
    unwrap(tool.pointer({ phase: 'down', x: 90, y: 90 }));
    unwrap(tool.pointer({ phase: 'move', x: 160, y: 160 }));
    expect(tool.state).toBe('marqueeing');
    expect(f.view.selection).toEqual(['a']);
    expect(f.view.overlay.marquee).toEqual({ minX: 90, minY: 90, maxX: 160, maxY: 160 });
    unwrap(tool.pointer({ phase: 'move', x: 220, y: 160 }));
    expect(f.view.selection).toEqual(['a', 'b']);
    unwrap(tool.pointer({ phase: 'move', x: 220, y: 160, alt: true }));
    expect(f.view.selection).toEqual(['a']);
    expect(unwrap(tool.pointer({ phase: 'up', x: 220, y: 160, alt: true }))).toEqual({ kind: 'selection', selection: ['a'] });
    expect(f.view.overlay.marquee).toBeUndefined();
    unwrap(tool.pointer({ phase: 'down', x: 390, y: 390, shift: true }));
    unwrap(tool.pointer({ phase: 'move', x: 460, y: 460, shift: true }));
    expect(f.view.selection).toEqual(['a', 'c']);
    tool.cancel();
    expect(f.view.selection).toEqual(['a']);
  });

  it('hand tool pans (drag and arrow-free wheel), Mod+wheel zooms about the pointer; hover outlines', async () => {
    const f = await createToolFixture([sq('a', 0, 0)]);
    const tool = createToolController(f.tools);
    unwrap(tool.pointer({ phase: 'move', x: 10, y: 10 }));
    expect(f.view.hover).toBe('a');
    expect(f.view.overlay.hover?.node).toBe('a');
    unwrap(tool.pointer({ phase: 'move', x: 500, y: 500 }));
    expect(f.view.hover).toBeUndefined();
    f.view.setTool(StudioIds.tool.hand);
    unwrap(tool.pointer({ phase: 'down', x: 10, y: 10 }));
    unwrap(tool.pointer({ phase: 'move', x: 60, y: 30 }));
    expect(tool.state).toBe('panning');
    unwrap(tool.pointer({ phase: 'up', x: 60, y: 30 }));
    expect(f.view.camera).toEqual({ tx: 50, ty: 20, zoom: 1 });
    expect(f.view.selection).toEqual([]);
    unwrap(tool.pointer({ phase: 'down', x: 10, y: 10 }));
    unwrap(tool.pointer({ phase: 'move', x: 90, y: 90 }));
    tool.cancel();
    expect(f.view.camera).toEqual({ tx: 50, ty: 20, zoom: 1 });
    unwrap(tool.wheel({ x: 0, y: 0, dx: 10, dy: 0 }));
    expect(f.view.camera.tx).toBe(40);
    unwrap(tool.wheel({ x: 100, y: 100, dx: 0, dy: -69.31471805599453, mod: true }));
    expect(f.view.camera.zoom).toBeCloseTo(2, 9);
  });

  it('respects locks, reports gesture misuse (IF-TOOL-001) and vanished targets (IF-TOOL-004)', async () => {
    const f = await createToolFixture([sq('a', 0, 0), sq('l', 100, 0, 50, { [P.lockScope]: 'position' })]);
    const tool = createToolController(f.tools);
    const up = tool.pointer({ phase: 'up', x: 0, y: 0 });
    expect(!up.ok && up.error.code).toBe('IF-TOOL-001');
    unwrap(tool.pointer({ phase: 'down', x: 110, y: 10 }));
    const twice = tool.pointer({ phase: 'down', x: 110, y: 10 });
    expect(!twice.ok && twice.error.code).toBe('IF-TOOL-001');
    expect(f.view.selection).toEqual(['l']);
    const locked = tool.pointer({ phase: 'move', x: 300, y: 300 });
    expect(!locked.ok && locked.error.code).toBe('IF-TOOL-002');
    expect(tool.state).toBe('idle');
    expect(f.stage.value('l', P.x)).toBe(100);
    unwrap(tool.pointer({ phase: 'down', x: 10, y: 10 }));
    unwrap(tool.pointer({ phase: 'move', x: 200, y: 200 }));
    f.seed([{ op: 'delete', node: 'a' }]);
    const gone = tool.pointer({ phase: 'up', x: 200, y: 200 });
    expect(!gone.ok && gone.error.code).toBe('IF-TOOL-004');
    expect(f.view.selection).toEqual([]);
    expect(f.undo.history(human.id).undo).toHaveLength(0);
    f.view.select(['ghost', 'l']);
    pruneSelection(f.tools);
    expect(f.view.selection).toEqual(['l']);
  });
});
