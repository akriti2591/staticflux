// @vitest-environment node
// B1's fixtures need Node's file system (the Wasm loader); the DOM comes from a separate happy-dom window.
import { createShortcutRegistry, type Timers } from '@staticflux/a11y';
import type { RunContext } from '@staticflux/capabilities';
import { createScope } from '@staticflux/core';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import { createToolController } from '../tools/gesture.js';
import { bindToolShortcuts, CanvasToolsShortcutScope, createToolCommands } from '../tools/keyboard.js';
import { authoringBuilt, createToolFixture, shape, unwrap } from '../tools/testing/fixtures.js';
import { createCanvasA11y, describeCanvas } from './canvas-a11y.js';
import { a11yContributionUnits, a11yCapabilityImplementations, describeCanvasCapability, describeHudAction } from './contributions.js';

const fill = [{ paint: '#ff5c39' }];
const sq = (id: string, x: number, y: number, extra: Record<string, unknown> = {}, parent = 'p1') => shape(id, { [P.x]: x, [P.y]: y, [P.w]: 50, [P.h]: 50, [P.fills]: fill, ...extra }, parent);

const timers = (): Timers & { flush(): void } => {
  const due = new Map<number, () => void>();
  let id = 0;
  return {
    set: (fn) => (due.set((id += 1), fn), id),
    clear: (h) => due.delete(h as number),
    flush: () => {
      for (const [k, fn] of [...due]) {
        due.delete(k);
        fn();
      }
    },
  };
};

describe.skipIf(!authoringBuilt)('canvas accessibility layer: focus path over B3’s keyboard paths', () => {
  it('Tab, Enter, Shift+Enter and Escape move the selection and the DOM focus together; changes are spoken politely', async () => {
    const f = await createToolFixture([sq('a', 0, 0, { name: 'Logo' }), shape('g', { name: 'Card' }, 'p1', 'group'), sq('c', 200, 0, { name: 'Photo' }, 'g'), sq('d', 300, 0, {}, 'g')]);
    const window = new Window();
    const document = window.document as unknown as Document;
    // The shortcut registry checks "typing in a field" with DOM classes; lend it this window's.
    const lent = ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'] as const;
    for (const name of lent) Object.assign(globalThis, { [name]: window[name] });
    document.body.innerHTML = '<div id="surface" tabindex="0" role="application" aria-label="Canvas surface"></div>';
    const host = document.getElementById('surface') as HTMLElement;
    const scope = createScope('tab');
    const registry = createShortcutRegistry({ isMac: false });
    unwrap(bindToolShortcuts(registry, createToolCommands(f.tools), scope));
    registry.activate(CanvasToolsShortcutScope, scope);
    registry.attach(document, scope);
    const spoken: string[] = [];
    const clock = timers();
    const controller = createToolController(f.tools);
    const a11y = unwrap(createCanvasA11y({ ...f.tools, host, document, announcer: { announce: (m) => spoken.push(m) }, timers: clock, gesture: controller, schedule: (fn) => fn(), scope }));
    const active = (): string | null => (document.activeElement as Element | null)?.getAttribute('data-sf-a11y-id') ?? (document.activeElement === host ? 'surface' : null);
    const press = (key: string, shift = false): void => {
      document.activeElement?.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true, composed: true }) as unknown as Event);
    };

    host.focus();
    expect(a11y.mount.layer.size).toBe(4);
    press('Tab');
    expect(f.view.selection).toEqual(['a']);
    expect(active()).toBe('a');
    press('Tab');
    expect([f.view.selection, active()]).toEqual([['g'], 'g']);
    clock.flush();
    expect(spoken.at(-1)).toBe('Card, group, selected');
    press('Enter');
    expect([f.view.selection, f.view.context, active()]).toEqual([['c'], 'g', 'c']);
    clock.flush();
    expect(spoken.at(-1)).toBe('Inside Card. Photo, rectangle, selected');
    press('Tab', true);
    expect(active()).toBe('d');
    press('Enter', true);
    expect([f.view.selection, active()]).toEqual([['g'], 'g']);
    press('Escape');
    expect([f.view.selection, active()]).toEqual([[], 'surface']);
    clock.flush();
    expect(spoken.at(-1)).toBe('Selection cleared');

    // A screen reader's virtual cursor focusing a node selects it.
    (a11y.mount.layer.element('a') as HTMLElement).focus();
    expect(f.view.selection).toEqual(['a']);
    // Arrow keys still nudge (one undo step) and the node follows.
    press('ArrowRight');
    expect(f.stage.value('a', P.x)).toBe(1);
    expect(a11y.mount.layer.element('a')?.style.left).toBe('1px');

    expect(unwrap(a11y.describe('selection')).text).toBe('Logo, rectangle');
    expect(unwrap(a11y.describe('visible'))).toEqual({ text: '4 elements in view; Logo (rectangle); Card (group); Photo (rectangle); Rectangle (rectangle)', count: 4 });
    expect(unwrap(describeCanvas({ ...f.tools, view: { ...f.view, root: f.view.root, selection: [], context: 'p1', camera: f.view.camera, viewport: f.view.viewport } }, 'selection')).text).toBe('Nothing selected');
    await scope.dispose();
    for (const name of lent) Reflect.deleteProperty(globalThis, name);
    expect(host.children.length).toBe(0);
    expect(a11y.projector.state).toBe('disposed');
  });

  it('a press on an element does not re-select it through focus: Shift-click adds and removes, and it stays (#53)', async () => {
    const f = await createToolFixture([sq('a', 0, 0), sq('b', 100, 0)]);
    const window = new Window();
    const document = window.document as unknown as Document;
    document.body.innerHTML = '<div id="surface" tabindex="0" role="application" aria-label="Canvas surface"></div>';
    const host = document.getElementById('surface') as HTMLElement;
    const scope = createScope('tab');
    const controller = createToolController(f.tools);
    const clock = timers();
    // The projection reaches the DOM after the press, as it does from the editor worker.
    const flushes: (() => void)[] = [];
    const a11y = unwrap(createCanvasA11y({ ...f.tools, host, document, announcer: { announce: () => undefined }, timers: clock, gesture: controller, schedule: (fn) => flushes.push(fn), scope }));
    const node = (id: string): HTMLElement => a11y.mount.layer.element(id) as HTMLElement;
    // What a browser does for a click on an element: the press lands on its projected node (focusable, it takes the
    // pointer), Studio focuses the surface in `pointerdown`, the tool controller selects, then `mousedown`'s default
    // action (unless prevented) focuses the node under the pointer; the release follows.
    const click = (id: string, x: number, y: number, shift = false): void => {
      const init = { bubbles: true, composed: true, shiftKey: shift, button: 0 };
      node(id).dispatchEvent(new window.PointerEvent('pointerdown', init) as unknown as Event);
      host.focus();
      unwrap(controller.pointer({ phase: 'down', x, y, shift }));
      if (node(id).dispatchEvent(new window.MouseEvent('mousedown', { ...init, cancelable: true }) as unknown as Event)) node(id).focus();
      unwrap(controller.pointer({ phase: 'up', x, y, shift }));
      node(id).dispatchEvent(new window.PointerEvent('pointerup', init) as unknown as Event);
      for (const flush of flushes.splice(0)) flush();
      clock.flush();
    };

    click('a', 25, 25);
    expect(f.view.selection).toEqual(['a']);
    click('b', 125, 25, true);
    expect(f.view.selection).toEqual(['a', 'b']);
    // Shift-click on a selected element removes it; a plain click still replaces.
    click('a', 25, 25, true);
    expect(f.view.selection).toEqual(['b']);
    click('a', 25, 25, true);
    expect(f.view.selection).toEqual(['b', 'a']);
    click('b', 125, 25);
    expect(f.view.selection).toEqual(['b']);
    // Assistive technology focusing a node (no press) still selects it.
    node('a').focus();
    expect(f.view.selection).toEqual(['a']);
    await scope.dispose();
  });

  it('contributes the describe-canvas capability (agents and the HUD) with a clear error without a canvas', async () => {
    const f = await createToolFixture([sq('a', 0, 0, { name: 'Logo' })]);
    f.view.select(['a']);
    const [impl] = a11yCapabilityImplementations({ canvas: () => ({ describe: (what) => describeCanvas(f.tools, what) }) });
    const run = { signal: new AbortController().signal } as RunContext;
    expect(unwrap(await impl!.run({ what: 'selection' }, run))).toEqual({ text: 'Logo, rectangle', count: 1 });
    const [none] = a11yCapabilityImplementations({ canvas: () => undefined });
    const missing = await none!.run({ what: 'visible' }, run);
    expect(!missing.ok && missing.error.code).toBe('IF-A11Y-003');
    const aborted = new AbortController();
    aborted.abort();
    const stopped = await impl!.run({ what: 'selection' }, { signal: aborted.signal } as RunContext);
    expect(!stopped.ok && stopped.error.code).toBe('SF-CORE-002');
    expect(describeCanvasCapability).toMatchObject({ id: 'instaflow/describe-canvas', exposeToAgents: true, destructive: false });
    expect(describeHudAction).toMatchObject({ capability: 'instaflow/describe-canvas', tone: 'more' });
    expect(a11yContributionUnits({ canvas: () => undefined })).toHaveLength(3);
  });
});
