// @vitest-environment node
// B1's geometry and B2's text Wasm load from the file system; the DOM comes from a separate happy-dom window.
import { createShortcutRegistry } from '@staticflux/a11y';
import { createScope, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { readTextBlock } from '../text/rich-text.js';
import { toScreen } from '../tools/view-state.js';
import { openCanvasTab } from './canvas-tab.js';
import { createRecordingRaster } from './element-port.js';
import { authoringBuilt, createStudioFixture, lendDom, manualTimers, person, scriptedTextInput, unwrap } from './test-helpers.js';

const rect = (node: string, x: number, y: number) => ({ op: 'create' as const, node, kind: 'shape', parent: 'p1', props: { [P.x]: x, [P.y]: y, [P.w]: 100, [P.h]: 100, [P.fills]: [{ paint: '#ff5c39' }] } });

describe.skipIf(!authoringBuilt)('canvas tab: B3 tools, creation tools, B2 text and B6 on the live canvas', () => {
  it('draws a rectangle, snaps it with guides, types text, and the accessibility layer follows; one undo step each', async () => {
    const f = await createStudioFixture();
    const dom = lendDom();
    dom.document.body.innerHTML = '<div id="surface" tabindex="0" role="application" aria-label="Canvas surface"></div>';
    const surface = dom.document.getElementById('surface') as HTMLElement;
    const scope = createScope('tab');
    const registry = createShortcutRegistry({ isMac: false });
    registry.attach(dom.document, scope);
    let tool = 'instaflow/shape' as `${string}/${string}`;
    const raster = createRecordingRaster();
    const inputs: ReturnType<typeof scriptedTextInput>[] = [];
    const spoken: string[] = [];
    const timers = manualTimers();
    const tab = unwrap(
      await openCanvasTab({
        tab: 't1',
        document: f.document,
        page: 'p1',
        fonts: f.fonts,
        surface,
        raster,
        overlay: raster,
        viewport: { width: 1000, height: 800 },
        actor: () => person,
        tool: () => tool,
        selectTool: (next) => {
          tool = next;
          tab.view.setTool(next);
        },
        shortcuts: registry,
        textInput: () => {
          const input = scriptedTextInput();
          inputs.push(input);
          return ok(input);
        },
        announcer: { announce: (m) => spoken.push(m) },
        timers,
        schedule: (fn) => fn(),
        scope,
      }),
    );
    const at = (x: number, y: number): readonly [number, number] => toScreen(tab.view.camera, x, y);
    const drag = (from: readonly [number, number], to: readonly [number, number], mods: { shift?: boolean } = {}) => {
      const a = at(...from);
      const b = at(...to);
      unwrap(tab.pointer({ phase: 'down', x: a[0], y: a[1], ...mods }));
      unwrap(tab.pointer({ phase: 'move', x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, ...mods }));
      unwrap(tab.pointer({ phase: 'move', x: b[0], y: b[1], ...mods }));
      return tab.pointer({ phase: 'up', x: b[0], y: b[1], ...mods });
    };
    expect(tab.view.camera.zoom).toBeLessThan(1); // the page is fitted

    // Shape tool: drag draws a rectangle (marquee preview), one create = one undo step, then Select is back.
    const a = at(100, 100);
    unwrap(tab.pointer({ phase: 'down', x: a[0], y: a[1] }));
    unwrap(tab.pointer({ phase: 'move', x: at(200, 180)[0], y: at(200, 180)[1] }));
    expect(tab.view.overlay.marquee?.minX).toBeCloseTo(100, 6);
    expect(tab.view.overlay.marquee?.maxY).toBeCloseTo(180, 6);
    const created = unwrap(tab.pointer({ phase: 'up', x: at(300, 250)[0], y: at(300, 250)[1] }));
    expect(created).toMatchObject({ kind: 'created', label: 'Draw rectangle' });
    const node = tab.view.selection[0] as string;
    expect(f.document.view.read(node)?.kind).toBe('shape');
    expect(f.document.view.value(node, P.w)).toBeCloseTo(200, 0);
    expect(tool).toBe('instaflow/select');
    expect(tab.a11y.mount.layer.size).toBe(1);

    // Select tool: drag another rectangle next to it; the smart guide shows and snaps the top edge.
    unwrap(commitEdit(f.document.target('p1'), person, 'Seed', ok([rect('b', 600, 103)])));
    unwrap(tab.pointer({ phase: 'down', x: at(650, 150)[0], y: at(650, 150)[1] }));
    unwrap(tab.pointer({ phase: 'move', x: at(655, 149)[0], y: at(655, 149)[1] }));
    unwrap(tab.pointer({ phase: 'move', x: at(660, 148)[0], y: at(660, 148)[1] }));
    expect(tab.view.overlay.guides.length).toBeGreaterThan(0);
    unwrap(tab.pointer({ phase: 'up', x: at(660, 148)[0], y: at(660, 148)[1] }));
    expect(f.document.view.value('b', P.y)).toBe(100);
    expect(tab.a11y.mount.layer.size).toBe(2);

    // Text tool: click places a text element and starts editing; typing commits text and grows the box.
    tool = 'instaflow/text';
    tab.view.setTool(tool);
    const t = at(100, 500);
    unwrap(tab.pointer({ phase: 'down', x: t[0], y: t[1] }));
    unwrap(tab.pointer({ phase: 'up', x: t[0], y: t[1] }));
    const text = tab.view.selection[0] as string;
    expect(tab.editing?.node).toBe(text);
    const host = tab.editing?.host as HTMLElement;
    expect([host.getAttribute('role'), host.getAttribute('aria-multiline')]).toEqual(['textbox', 'true']);
    const input = inputs.at(-1) as ReturnType<typeof scriptedTextInput>;
    input.emit({ kind: 'insert', text: 'Hello', range: [0, 0] });
    expect(unwrap(readTextBlock(f.document.part('p1') as never, text)).text).toBe('Hello');
    expect(f.document.view.value(text, P.w) as number).toBeGreaterThan(50);
    expect(f.document.view.value(text, P.h) as number).toBeGreaterThan(30);
    input.emit({ kind: 'key', key: 'Escape', shift: false, mod: false, alt: false });
    expect(tab.editing).toBeUndefined();
    expect(input.disposed).toBe(true);
    expect(tab.text.nodes).toContain(text);

    // Undo takes back the typing (text and box size in one step), then the text element itself.
    unwrap(await tab.undo());
    expect(unwrap(readTextBlock(f.document.part('p1') as never, text)).text).toBe('');
    // The announcer spoke about the selection (debounced, polite).
    timers.flush();
    expect(spoken.length).toBeGreaterThan(0);
    // Delete removes the selection as one step.
    tab.view.select([node]);
    unwrap(tab.deleteSelection());
    expect(f.document.view.read(node)).toBeUndefined();
    unwrap(await tab.undo());
    expect(f.document.view.read(node)?.kind).toBe('shape');

    expect(raster.presents).toBeGreaterThan(0);
    await scope.dispose();
    expect(surface.children.length).toBe(0);
    dom.restore();
    await f.scope.dispose();
  });

  it('drag on the Shape tool with Shift draws a square; a click places the default size', async () => {
    const f = await createStudioFixture();
    const dom = lendDom();
    const surface = dom.document.createElement('div');
    dom.document.body.append(surface);
    const scope = createScope('tab');
    const raster = createRecordingRaster();
    const tab = unwrap(
      await openCanvasTab({ tab: 't1', document: f.document, page: 'p1', fonts: f.fonts, surface, raster, overlay: raster, viewport: { width: 1000, height: 800 }, actor: () => person, tool: () => 'instaflow/shape', announcer: { announce: () => undefined }, timers: manualTimers(), schedule: (fn) => fn(), scope }),
    );
    const at = (x: number, y: number) => toScreen(tab.view.camera, x, y);
    unwrap(tab.pointer({ phase: 'down', x: at(0, 0)[0], y: at(0, 0)[1], shift: true }));
    unwrap(tab.pointer({ phase: 'move', x: at(300, 120)[0], y: at(300, 120)[1], shift: true }));
    unwrap(tab.pointer({ phase: 'up', x: at(300, 120)[0], y: at(300, 120)[1], shift: true }));
    const square = tab.view.selection[0] as string;
    expect([f.document.view.value(square, P.w), f.document.view.value(square, P.h)].map((v) => Math.round(v as number))).toEqual([300, 300]);
    tab.view.setTool('instaflow/frame');
    unwrap(tab.pointer({ phase: 'down', x: at(500, 500)[0], y: at(500, 500)[1] }));
    unwrap(tab.pointer({ phase: 'up', x: at(500, 500)[0], y: at(500, 500)[1] }));
    const frame = tab.view.selection[0] as string;
    expect(f.document.view.read(frame)?.kind).toBe('frame');
    expect([f.document.view.value(frame, P.w), f.document.view.value(frame, P.h)]).toEqual([400, 300]);
    await scope.dispose();
    dom.restore();
    await f.scope.dispose();
  });
});
