// @vitest-environment node
/**
 * B10a on real elements (B1 fixtures, real Wasm): skew and pivot gestures, flip on a negative resize, transform mode
 * (one undo step for the whole session, Escape writes nothing), the keyboard paths through the shortcut registry, locks
 * and nested elements.
 */
import { createShortcutRegistry } from '@staticflux/a11y';
import { createScope, ok } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import { P } from '../elements/components.js';
import { pageTransform } from '../elements/layout.js';
import { applyAffine } from '../elements/resolve.js';
import { createToolController, GESTURES, MODE_BEHAVIOURS, PRESS_GESTURES, refreshOverlay, SINKS } from './gesture.js';
import { bindToolShortcuts, CanvasToolsShortcutScope, createToolCommands, FLIP_LABELS, TRANSFORM_MODE_KEYMAP, TransformModeShortcutScope } from './keyboard.js';
import { authoringBuilt, createToolFixture, human, shape, unwrap } from './testing/fixtures.js';
import { applyTransform, createPreview, createTransformMode, TRANSFORM_LABEL, TransformSessionLifecycle } from './transform-mode.js';
import { moveValues, PIVOT_HANDLE } from './transform.js';

const sq = (id: string, x: number, y: number, size = 50, extra: Record<string, unknown> = {}, parent = 'p1', kind = 'shape') =>
  shape(id, { [P.x]: x, [P.y]: y, [P.w]: size, [P.h]: size, [P.fills]: [{ paint: '#ff0000' }], ...extra }, parent, kind);

describe('tables (rule 4)', () => {
  it('every behaviour maps every press target to a gesture; the session picks the sink and the behaviour', () => {
    for (const table of Object.values(PRESS_GESTURES)) for (const kind of Object.values(table)) expect(GESTURES[kind]).toBeDefined();
    expect(PRESS_GESTURES.select['skew-handle']).toBe('skew');
    expect(PRESS_GESTURES.transform.empty).toBe('rotate');
    expect(MODE_BEHAVIOURS).toEqual({ idle: undefined, active: 'transform' });
    expect(Object.keys(SINKS)).toEqual([...TransformSessionLifecycle.states]);
    expect(TRANSFORM_MODE_KEYMAP.map((b) => b.keys[0])).toEqual(['Enter', 'Escape']);
    expect(TransformModeShortcutScope.parent?.id).toBe(CanvasToolsShortcutScope.id);
  });
});

describe.skipIf(!authoringBuilt)('B10a gestures', () => {
  it('Mod-drag on a side handle skews (one undo step, Shift snaps); Mod on a corner still resizes without snapping', async () => {
    const f = await createToolFixture([sq('a', 100, 100, 100)]);
    const tool = createToolController(f.tools);
    f.view.select(['a']);
    refreshOverlay(f.tools);
    unwrap(tool.pointer({ phase: 'down', x: 150, y: 100, mod: true })); // the top handle
    for (const x of [160, 170, 175]) unwrap(tool.pointer({ phase: 'move', x, y: 100, mod: true }));
    expect(tool.state).toBe('skewing');
    expect(f.part.node('a')?.props[P.skewX]).toBeUndefined(); // a preview only
    expect(unwrap(tool.pointer({ phase: 'up', x: 175, y: 100, mod: true }))).toMatchObject({ kind: 'committed', label: 'Skew' });
    expect(f.stage.value('a', P.skewX)).toBeCloseTo((-Math.atan(25 / 100) * 180) / Math.PI, 6);
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    // Shift: 15° steps (of the edge's lean, the existing skew included).
    unwrap(tool.pointer({ phase: 'down', x: 150 + 25 - 25, y: 200, mod: true })); // the bottom handle (bottom edge did not move)
    unwrap(tool.pointer({ phase: 'move', x: 170, y: 200, mod: true, shift: true }));
    unwrap(tool.pointer({ phase: 'up', x: 170, y: 200, mod: true, shift: true }));
    expect(Math.abs((f.stage.value('a', P.skewX) as number) / 15 - Math.round((f.stage.value('a', P.skewX) as number) / 15))).toBeLessThan(1e-6);
    expect(f.undo.history(human.id).undo).toHaveLength(2);
  });

  it('a resize past the opposite edge flips the element (one undo step)', async () => {
    const f = await createToolFixture([sq('a', 100, 100, 100)]);
    const tool = createToolController(f.tools);
    f.view.select(['a']);
    refreshOverlay(f.tools);
    unwrap(tool.pointer({ phase: 'down', x: 200, y: 150 })); // the east handle
    for (const x of [150, 100, 60]) unwrap(tool.pointer({ phase: 'move', x, y: 150 }));
    unwrap(tool.pointer({ phase: 'up', x: 60, y: 150 }));
    expect(f.stage.value('a', P.flipX)).toBe(true);
    expect(f.stage.value('a', P.w)).toBeCloseTo(40, 6);
    expect(f.stage.value('a', P.x)).toBeCloseTo(60, 6); // spans 60…100: the west edge stayed at 100
    expect(f.undo.history(human.id).undo).toHaveLength(1);
  });

  it('drags the pivot (snapping to reference points), rotates about it, Alt-click resets it; a new selection drops it', async () => {
    const f = await createToolFixture([sq('a', 100, 100, 100), sq('b', 400, 100)]);
    const tool = createToolController(f.tools);
    const k = createToolCommands(f.tools);
    f.view.select(['a']);
    unwrap(k.transform()); // transform mode shows the pivot handle
    expect(f.view.overlay.handles.find((h) => h.id === PIVOT_HANDLE)).toMatchObject({ x: 150, y: 150 });
    unwrap(tool.pointer({ phase: 'down', x: 150, y: 150 }));
    for (const [x, y] of [
      [130, 130],
      [101, 102],
    ] as const)
      unwrap(tool.pointer({ phase: 'move', x, y }));
    expect(tool.state).toBe('pivoting');
    unwrap(tool.pointer({ phase: 'up', x: 101, y: 102 }));
    expect(f.view.pivot).toEqual([0, 0]); // snapped to the top-left corner
    unwrap(k.cancelTransform());
    expect(f.view.overlay.handles.some((h) => h.id === PIVOT_HANDLE)).toBe(true); // a moved pivot stays visible
    unwrap(k.rotateBy(90));
    const t = pageTransform(f.ctx, 'a');
    expect(applyAffine(t, 0, 0)[0]).toBeCloseTo(100, 6); // the pivot corner did not move
    expect(applyAffine(t, 0, 0)[1]).toBeCloseTo(100, 6);
    unwrap(tool.pointer({ phase: 'down', x: 100, y: 100, alt: true }));
    unwrap(tool.pointer({ phase: 'up', x: 100, y: 100, alt: true }));
    expect(f.view.pivot).toBeUndefined();
    expect(f.view.overlay.handles.some((h) => h.id === PIVOT_HANDLE)).toBe(false);
    f.view.setPivot([1, 1]);
    f.view.select(['a']); // the same set keeps it
    expect(f.view.pivot).toEqual([1, 1]);
    f.view.select(['b']);
    expect(f.view.pivot).toBeUndefined();
  });
});

describe.skipIf(!authoringBuilt)('transform mode (LIFECYCLES §36)', () => {
  it('stages every step as a preview; Enter commits them as one undo step', async () => {
    const f = await createToolFixture([sq('a', 100, 100, 100)]);
    const tool = createToolController(f.tools);
    const k = createToolCommands(f.tools);
    f.view.select(['a']);
    expect(unwrap(k.transform())).toEqual({ kind: 'mode', state: 'active' });
    expect(unwrap(k.transform())).toEqual({ kind: 'mode', state: 'active' }); // already active: a no-op
    expect(f.view.overlay.transforming).toBe(true);
    // A move drag (away from the pivot in the centre), a nudge, a flip and a numeric edit — all previews.
    unwrap(tool.pointer({ phase: 'down', x: 120, y: 120 }));
    unwrap(tool.pointer({ phase: 'move', x: 140, y: 120, mod: true }));
    expect(unwrap(tool.pointer({ phase: 'up', x: 140, y: 120, mod: true }))).toEqual({ kind: 'staged', label: 'Move' });
    expect(unwrap(k.nudge(0, 5))).toEqual({ kind: 'staged', label: 'Nudge' });
    unwrap(k.flip('vertical'));
    unwrap(k.numeric({ field: 'rotation', value: 30 }));
    expect([f.stage.value('a', P.x), f.stage.value('a', P.flipY), f.stage.value('a', P.rotation)]).toEqual([120, true, 30]);
    expect(f.part.node('a')?.props[P.x]).toBe(100); // nothing written yet
    expect(f.undo.history(human.id).undo).toHaveLength(0);
    // Outside the frame a press rotates in transform mode.
    unwrap(tool.pointer({ phase: 'down', x: 400, y: 170 }));
    unwrap(tool.pointer({ phase: 'move', x: 400, y: 300 }));
    expect(tool.state).toBe('rotating');
    expect(tool.cancel()).toEqual({ kind: 'cancelled' }); // a cancelled step restores what was staged
    expect(f.stage.value('a', P.rotation)).toBe(30);
    expect(unwrap(k.commitTransform())).toEqual({ kind: 'committed', label: TRANSFORM_LABEL, ops: expect.any(Number) });
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    expect(f.part.node('a')?.props[P.flipY]).toBe(true);
    expect(f.session.opinions('a')).toBeUndefined();
    expect(f.view.overlay.transforming).toBeUndefined();
    const idle = k.commitTransform();
    expect(!idle.ok && idle.error.code).toBe('IF-XF-002');
    // One undo puts everything back.
    unwrap(await f.undo.undo(human, new AbortController().signal));
    expect([f.stage.value('a', P.x), f.stage.value('a', P.flipY), f.stage.value('a', P.rotation)]).toEqual([100, undefined, undefined]);
  });

  it('Escape cancels the whole session (nothing written); a new selection commits it; the scope end cancels it', async () => {
    const f = await createToolFixture([sq('a', 100, 100, 100), sq('b', 400, 100), sq('l', 600, 100, 50, { [P.lockScope]: 'position' })]);
    const k = createToolCommands(f.tools);
    f.view.select(['a']);
    unwrap(k.transform());
    unwrap(k.nudge(10, 0));
    expect(unwrap(k.cancelTransform())).toEqual({ kind: 'cancelled' });
    expect(f.stage.value('a', P.x)).toBe(100);
    expect(f.undo.history(human.id).undo).toHaveLength(0);
    unwrap(k.transform());
    unwrap(k.nudge(10, 0));
    f.view.select(['b']); // picking another element applies the session
    expect(f.tools.mode?.state).toBe('idle');
    expect(f.part.node('a')?.props[P.x]).toBe(110);
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    // Locked elements: nothing to transform; with a movable one they stay put.
    f.view.select(['l']);
    const locked = k.transform();
    expect(!locked.ok && locked.error.code).toBe('IF-TOOL-002');
    f.view.select(['b', 'l']);
    unwrap(k.transform());
    unwrap(k.flip('horizontal'));
    unwrap(k.commitTransform());
    expect(f.part.node('l')?.props[P.flipX]).toBeUndefined();
    expect(f.part.node('b')?.props[P.flipX]).toBe(true);
    // A mode on its own scope cancels when the scope ends (page switch).
    const scope = createScope('mode');
    const mode = createTransformMode(f.tools, scope);
    f.view.select(['a']);
    unwrap(mode.enter());
    mode.preview.show(moveValues(unwrap((await import('./transform.js')).captureTransform(f.ctx, ['a'])), 5, 0));
    await scope.dispose();
    expect(mode.state).toBe('idle');
    expect(f.session.opinions('a')).toBeUndefined();
    const stray = mode.cancel();
    expect(!stray.ok && stray.error.code).toBe('IF-XF-002');
  });

  it('applyTransform commits at once without a session; createPreview clears what it showed', async () => {
    const f = await createToolFixture([sq('a', 0, 0)]);
    f.view.select(['a']);
    const host = { ...f.tools, mode: undefined };
    expect(unwrap(applyTransform(host, 'Move', (s) => moveValues(s, 3, 0)))).toEqual({ kind: 'committed', label: 'Move', ops: 1 });
    expect(unwrap(applyTransform(host, 'Move', (s) => moveValues(s, 0, 0)))).toEqual({ kind: 'none' });
    const bad = applyTransform(host, 'Move', () => ({ ok: false, error: { code: 'IF-XF-001' } }) as never);
    expect(!bad.ok && bad.error.code).toBe('IF-XF-001');
    const preview = createPreview(f.session);
    preview.show([{ node: 'a', x: 9, y: 9, skewX: 10, flipX: true }]);
    expect([f.stage.value('a', P.skewX), f.stage.value('a', P.flipX)]).toEqual([10, true]);
    preview.clear();
    expect(f.session.opinions('a')).toBeUndefined();
  });
});

describe.skipIf(!authoringBuilt)('B10a keys through the shortcut registry', () => {
  it('Shift+H / Shift+V flip (one undo step each); Mod+T enters, Enter applies, Escape cancels only while active', async () => {
    const f = await createToolFixture([sq('a', 0, 0), shape('fr', { [P.x]: 100, [P.y]: 100, [P.w]: 200, [P.h]: 200, [P.rotation]: 30 }, 'p1', 'frame'), sq('c', 10, 10, 40, {}, 'fr')]);
    const k = createToolCommands(f.tools);
    const registry = createShortcutRegistry({ isMac: false });
    const scope = createScope('keys');
    const outcomes: unknown[] = [];
    unwrap(bindToolShortcuts(registry, k, scope, (r) => outcomes.push(r.ok ? r.value.kind : r.error.code)));
    registry.activate(CanvasToolsShortcutScope, scope);
    // The tab activates the mode's scope while a session is active (canvas-tab.ts); do the same here.
    let deactivate: (() => void) | undefined;
    vi.stubGlobal('HTMLElement', class {});
    const key = (init: { key: string; shiftKey?: boolean; ctrlKey?: boolean }) => {
      const handled = registry.handle({ type: 'keydown', code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, repeat: false, target: null, preventDefault: () => undefined, ...init } as unknown as KeyboardEvent);
      deactivate?.();
      deactivate = f.tools.mode?.state === 'active' ? registry.activate(TransformModeShortcutScope, scope) : undefined;
      return handled;
    };
    // A nested child of a rotated frame flips along its own axes and twice returns exactly.
    f.view.select(['c']);
    const before = pageTransform(f.ctx, 'c');
    expect(key({ key: 'H', shiftKey: true })).toBe(true);
    expect(f.stage.value('c', P.flipX)).toBe(true);
    expect(f.undo.history(human.id).undo.at(-1)?.label).toBe(FLIP_LABELS.horizontal);
    key({ key: 'H', shiftKey: true });
    pageTransform(f.ctx, 'c').forEach((v, i) => expect(v).toBeCloseTo(before[i] as number, 9));
    key({ key: 'V', shiftKey: true });
    expect(f.stage.value('c', P.flipY)).toBe(true);
    expect(f.undo.history(human.id).undo).toHaveLength(3);
    f.view.select(['a']);
    expect(key({ key: 'T', ctrlKey: true })).toBe(true);
    expect(f.tools.mode?.state).toBe('active');
    key({ key: 'ArrowRight' });
    key({ key: 'Enter' });
    expect(f.tools.mode?.state).toBe('idle');
    expect(f.part.node('a')?.props[P.x]).toBe(1);
    key({ key: 'T', ctrlKey: true });
    key({ key: 'ArrowRight' });
    key({ key: 'Escape' });
    expect(f.tools.mode?.state).toBe('idle');
    expect(f.view.selection).toEqual(['a']); // Escape cancelled the session; it did not clear the selection
    expect(f.stage.value('a', P.x)).toBe(1);
    key({ key: 'Escape' }); // no session: the canvas scope's Escape clears the selection
    expect(f.view.selection).toEqual([]);
    expect(outcomes).toEqual(['committed', 'committed', 'committed', 'mode', 'staged', 'committed', 'mode', 'staged', 'cancelled', 'selection']);
    await scope.dispose();
    vi.unstubAllGlobals();
  });

  it('commands without a transform mode report IF-XF-002; skew by keys commits one step', async () => {
    const f = await createToolFixture([sq('a', 0, 0)]);
    const k = createToolCommands({ ...f.tools, mode: undefined });
    f.view.select(['a']);
    const r = k.transform();
    expect(!r.ok && r.error.code).toBe('IF-XF-002');
    expect(unwrap(k.skewBy(20, 0))).toMatchObject({ kind: 'committed', label: 'Skew' });
    expect(f.stage.value('a', P.skewX)).toBeCloseTo(20, 9);
    expect(ok(undefined).ok).toBe(true);
  });
});
