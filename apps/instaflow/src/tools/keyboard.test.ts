// @vitest-environment node
import { checkShortcuts, createShortcutRegistry, defineShortcut } from '@staticflux/a11y';
import { createScope } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import { P } from '../elements/components.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { ARROW_ACTIONS, bindToolShortcuts, CanvasToolsShortcutScope, createToolCommands, NUDGE, PAN_STEP, TOOL_KEYMAP } from './keyboard.js';
import { authoringBuilt, createToolFixture, human, shape, unwrap } from './testing/fixtures.js';

const sq = (id: string, x: number, y: number, extra: Record<string, unknown> = {}, parent = 'p1', kind = 'shape') =>
  shape(id, { [P.x]: x, [P.y]: y, [P.w]: 50, [P.h]: 50, [P.fills]: [{ paint: '#ff0000' }], ...extra }, parent, kind);

describe('the tool keymap (no Wasm)', () => {
  it('has unique ids, valid combos and no conflicts within its scope', () => {
    const defs = TOOL_KEYMAP.map((b) => defineShortcut({ id: b.id, keys: b.keys, scope: CanvasToolsShortcutScope, description: b.description }));
    expect(new Set(TOOL_KEYMAP.map((b) => b.id)).size).toBe(TOOL_KEYMAP.length);
    expect(checkShortcuts(defs).filter((i) => i.severity === 'error')).toEqual([]);
    expect(TOOL_KEYMAP.find((b) => b.id === 'instaflow/arrow-left-large')?.keys).toEqual(['Shift+ArrowLeft']);
    expect(TOOL_KEYMAP.find((b) => b.id === 'instaflow/resize-up')?.keys).toEqual(['Mod+Alt+ArrowUp']);
    expect(ARROW_ACTIONS).toEqual({ select: 'nudge', hand: 'pan' });
    expect(CanvasToolsShortcutScope.parent?.id).toBe('instaflow/studio');
  });
});

describe.skipIf(!authoringBuilt)('keyboard paths', () => {
  it('nudges 1 and 10 (one undo step per key), resizes and rotates; locked elements stay', async () => {
    const f = await createToolFixture([sq('a', 0, 0), sq('l', 100, 0, { [P.lockScope]: 'position' })]);
    const k = createToolCommands(f.tools);
    const none = k.nudge(1, 0);
    expect(!none.ok && none.error.code).toBe('IF-TOOL-002');
    f.view.select(['a', 'l']);
    expect(unwrap(k.arrow('right', false))).toEqual({ kind: 'committed', label: 'Nudge', ops: 1 });
    expect(unwrap(k.arrow('down', true))).toMatchObject({ kind: 'committed' });
    expect([f.stage.value('a', P.x), f.stage.value('a', P.y), f.stage.value('l', P.x)]).toEqual([NUDGE.step, NUDGE.large, 100]);
    expect(f.undo.history(human.id).undo).toHaveLength(2);
    f.view.select(['a']);
    unwrap(k.resizeBy(10, 0));
    expect([f.stage.value('a', P.w), f.stage.value('a', P.x)]).toEqual([60, 1]);
    unwrap(k.rotateBy(15));
    expect(f.stage.value('a', P.rotation)).toBe(15);
    expect(f.undo.history(human.id).undo).toHaveLength(4);
    expect(unwrap(k.nudge(0, 0))).toEqual({ kind: 'none' });
  });

  it('Tab cycles, Mod+Shift+Arrow extends, Mod+A selects all, Enter / Shift+Enter go in and out, Escape clears', async () => {
    const f = await createToolFixture([sq('a', 0, 0), shape('g', {}, 'p1', 'group'), sq('c', 200, 0, {}, 'g'), sq('d', 300, 0, {}, 'g'), sq('z', 500, 0, { [P.lockScope]: 'all' })]);
    const k = createToolCommands(f.tools);
    unwrap(k.selectSibling(1, false));
    expect(f.view.selection).toEqual(['a']);
    unwrap(k.selectSibling(1, false));
    expect(f.view.selection).toEqual(['g']);
    unwrap(k.selectSibling(1, false));
    expect(f.view.selection).toEqual(['a']);
    unwrap(k.selectSibling(-1, false));
    expect(f.view.selection).toEqual(['g']);
    unwrap(k.enter());
    expect([f.view.context, ...f.view.selection]).toEqual(['g', 'c']);
    unwrap(k.selectSibling(1, true));
    expect(f.view.selection).toEqual(['c', 'd']);
    unwrap(k.selectAll());
    expect(f.view.selection).toEqual(['c', 'd']);
    unwrap(k.selectParent());
    expect([f.view.context, ...f.view.selection]).toEqual(['p1', 'g']);
    expect(unwrap(k.selectParent())).toEqual({ kind: 'none' });
    unwrap(k.selectAll());
    expect(f.view.selection).toEqual(['a', 'g']);
    expect(f.view.overlay.frame).toBeDefined();
    unwrap(k.escape());
    expect(f.view.selection).toEqual([]);
    expect(f.view.overlay.frame).toBeUndefined();
    expect(unwrap(k.enter())).toEqual({ kind: 'none' });
  });

  it('zooms by steps, to 100 %, to fit; the hand tool pans with the arrows', async () => {
    const f = await createToolFixture([sq('a', 0, 0), sq('b', 450, 350)]);
    const k = createToolCommands(f.tools);
    unwrap(k.zoomStep(1));
    expect(f.view.camera.zoom).toBe(1.5);
    unwrap(k.zoomStep(-1));
    unwrap(k.zoomStep(-1));
    expect(f.view.camera.zoom).toBe(0.75);
    unwrap(k.zoomTo(1));
    expect(f.view.camera.zoom).toBe(1);
    unwrap(k.fitAll());
    expect(f.view.camera.zoom).toBeCloseTo(Math.min((1000 - 96) / 500, (800 - 96) / 400), 9);
    expect(unwrap(k.fitSelection())).toEqual({ kind: 'none' });
    f.view.select(['a']);
    unwrap(k.fitSelection());
    expect(f.view.camera.zoom).toBeCloseTo((800 - 96) / 50, 9);
    f.view.setTool(StudioIds.tool.hand);
    const before = f.view.camera;
    unwrap(k.arrow('left', false));
    expect(f.view.camera.tx).toBe(before.tx + PAN_STEP);
    expect(f.undo.history(human.id).undo).toHaveLength(0);
  });

  it('registers every binding in the canvas scope and dispatches through the shortcut registry', async () => {
    const f = await createToolFixture([sq('a', 0, 0)]);
    const k = createToolCommands(f.tools);
    const registry = createShortcutRegistry({ isMac: false });
    const scope = createScope('keys');
    const outcomes: unknown[] = [];
    unwrap(bindToolShortcuts(registry, k, scope, (r) => outcomes.push(r.ok ? r.value.kind : r.error.code)));
    registry.activate(CanvasToolsShortcutScope, scope);
    expect(registry.list().filter((s) => s.scope === CanvasToolsShortcutScope.id)).toHaveLength(TOOL_KEYMAP.length);
    f.view.select(['a']);
    vi.stubGlobal('HTMLElement', class {});
    // A minimal keydown (the registry reads key, code, modifiers, target and preventDefault).
    const key = (init: { key: string; shiftKey?: boolean }) =>
      registry.handle({ type: 'keydown', code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, repeat: false, target: null, preventDefault: () => undefined, ...init } as unknown as KeyboardEvent);
    expect(key({ key: 'ArrowRight' })).toBe(true);
    expect(key({ key: 'ArrowRight', shiftKey: true })).toBe(true);
    expect(f.stage.value('a', P.x)).toBe(11);
    expect(key({ key: 'Escape' })).toBe(true);
    expect(f.view.selection).toEqual([]);
    expect(outcomes).toEqual(['committed', 'committed', 'selection']);
    await scope.dispose();
    expect(registry.list().filter((s) => s.scope === CanvasToolsShortcutScope.id)).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
