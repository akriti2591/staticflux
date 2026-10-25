// @vitest-environment node
// B1's geometry and B2's text Wasm load from the file system. B9: the tab is DOM-free (it runs in the editor worker);
// its pipes, render side and text host are wired here in one realm.
import { createShortcutRegistry } from '@staticflux/a11y';
import { createScope, ok, type Scope } from '@staticflux/core';
import type { ClientRect } from '@staticflux/surface/text-input';
import { describe, expect, it } from 'vitest';
import type { CanvasSnapshot } from '../a11y/projection.js';
import { commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { createTextOps, readTextBlock } from '../text/rich-text.js';
import { CanvasToolsShortcutScope, TransformModeShortcutScope } from '../tools/keyboard.js';
import { toScreen } from '../tools/view-state.js';
import { attachCanvasRender, type CanvasRender, createCanvasPipes, createElementSceneSide, decodeSceneRecord } from './canvas-pipeline.js';
import { type CanvasTab, OVERLAY_FIRST_ID, openCanvasTab } from './canvas-tab.js';
import { createElementRenderPort, createRecordingRaster, type RecordingRaster } from './element-port.js';
import type { TextExitReason, TextHostPort } from './text-editing.js';
import { authoringBuilt, createStudioFixture, manualTimers, person, scriptedTextInput, type StudioFixture, unwrap } from './test-helpers.js';

const rect = (node: string, x: number, y: number) => ({ op: 'create' as const, node, kind: 'shape', parent: 'p1', props: { [P.x]: x, [P.y]: y, [P.w]: 100, [P.h]: 100, [P.fills]: [{ paint: '#ff5c39' }] } });

/** What each record the render side applied carried (sections present). */
interface SeenRecord {
  readonly projection: boolean;
  readonly overlay: number;
  readonly ir: boolean;
}

interface Rig {
  readonly tab: CanvasTab;
  readonly render: CanvasRender;
  readonly raster: RecordingRaster;
  readonly records: SeenRecord[];
  readonly snapshots: CanvasSnapshot[];
  readonly host: { readonly opened: string[]; readonly placed: ClientRect[]; readonly closed: TextExitReason[]; readonly inputs: ReturnType<typeof scriptedTextInput>[] };
  readonly labels: number[];
  readonly spoken: string[];
  readonly timers: ReturnType<typeof manualTimers>;
  readonly scope: Scope;
  draw(): void;
}

async function rig(f: StudioFixture, options: { tool: () => `${string}/${string}`; selectTool?: (tool: `${string}/${string}`) => void; shortcuts?: ReturnType<typeof createShortcutRegistry> }): Promise<Rig> {
  const scope = createScope('tab');
  const pipes = unwrap(createCanvasPipes({ medium: 'local' }));
  scope.defer(() => pipes.close());
  const side = createElementSceneSide();
  const records: SeenRecord[] = [];
  const apply = side.adapter.apply.bind(side.adapter);
  const spy = { ...side, adapter: { ...side.adapter, apply: (store: never, payload: Uint8Array, kind: 'delta' | 'snapshot') => {
    const r = unwrap(decodeSceneRecord(payload));
    records.push({ projection: r.projection.length > 0, overlay: r.overlay.length, ir: r.ir.length > 0 });
    return apply(store, payload, kind);
  } } };
  const raster = createRecordingRaster();
  const render = unwrap(await attachCanvasRender({ pipes: pipes.endpoints, port: createElementRenderPort({ side: spy, raster }), side: spy, signal: scope.signal }));
  const host = { opened: [] as string[], placed: [] as ClientRect[], closed: [] as TextExitReason[], inputs: [] as ReturnType<typeof scriptedTextInput>[] };
  const textHost: TextHostPort = {
    open(node) {
      host.opened.push(node);
      const input = scriptedTextInput();
      host.inputs.push(input);
      return ok(input);
    },
    place: (r) => void host.placed.push(r),
    close: (reason) => void host.closed.push(reason),
  };
  const snapshots: CanvasSnapshot[] = [];
  const labels: number[] = [];
  const spoken: string[] = [];
  const timers = manualTimers();
  const tab = unwrap(
    await openCanvasTab({
      tab: 't1',
      document: f.document,
      page: 'p1',
      fonts: f.fonts,
      publisher: pipes.publisher,
      viewport: { width: 1000, height: 800 },
      actor: () => person,
      tool: options.tool,
      ...(options.selectTool === undefined ? {} : { selectTool: options.selectTool }),
      ...(options.shortcuts === undefined ? {} : { shortcuts: options.shortcuts }),
      textHost,
      announcer: { announce: (m) => spoken.push(m) },
      timers,
      schedule: (fn) => fn(),
      onSnapshot: (s) => snapshots.push(s),
      onLabels: (l) => labels.push(l.length),
      scope,
    }),
  );
  return { tab, render, raster, records, snapshots, host, labels, spoken, timers, scope, draw: () => void render.render.update('arrival') };
}

describe.skipIf(!authoringBuilt)('canvas tab in the editor module: B3 tools, creation tools, B2 text and B6, over the pipes (B8, B9)', () => {
  it('draws a rectangle, snaps it with guides, types text through the host port, posts accessibility snapshots; one undo step each', async () => {
    const f = await createStudioFixture();
    let tool = 'instaflow/shape' as `${string}/${string}`;
    const registry = createShortcutRegistry({ isMac: false });
    const r = await rig(f, {
      tool: () => tool,
      selectTool: (next) => {
        tool = next;
        r.tab.view.setTool(next);
      },
      shortcuts: registry,
    });
    const { tab } = r;
    registry.activate(CanvasToolsShortcutScope, r.scope);
    const at = (x: number, y: number): readonly [number, number] => toScreen(tab.view.camera, x, y);
    expect(tab.view.camera.zoom).toBeLessThan(1); // the page is fitted
    r.draw();
    expect(r.render.render.stats.draws).toBe(1);
    expect(r.records[0]?.overlay).toBe(2); // the first snapshot carries the page edge and the (empty) overlay

    // Shape tool: drag draws a rectangle (marquee preview), one create = one undo step, then Select is back.
    const a = at(100, 100);
    unwrap(tab.pointer({ phase: 'down', x: a[0], y: a[1] }));
    unwrap(tab.pointer({ phase: 'move', x: at(200, 180)[0], y: at(200, 180)[1] }));
    expect(tab.view.overlay.marquee?.minX).toBeCloseTo(100, 6);
    const created = unwrap(tab.pointer({ phase: 'up', x: at(300, 250)[0], y: at(300, 250)[1] }));
    expect(created).toMatchObject({ kind: 'created', label: 'Draw rectangle' });
    const node = tab.view.selection[0] as string;
    expect(f.document.view.read(node)?.kind).toBe('shape');
    expect(f.document.view.value(node, P.w)).toBeCloseTo(200, 0);
    expect(tool).toBe('instaflow/select');
    expect(r.snapshots.at(-1)?.ids).toContain(node);

    // Select tool: drag another rectangle next to it; the smart guide shows, the labels go out, the top edge snaps.
    unwrap(commitEdit(f.document.target('p1'), person, 'Seed', ok([rect('b', 600, 103)])));
    r.draw();
    const before = r.records.length;
    unwrap(tab.pointer({ phase: 'down', x: at(650, 150)[0], y: at(650, 150)[1] }));
    unwrap(tab.pointer({ phase: 'move', x: at(655, 149)[0], y: at(655, 149)[1] }));
    unwrap(tab.pointer({ phase: 'move', x: at(660, 148)[0], y: at(660, 148)[1] }));
    expect(tab.view.overlay.guides.length).toBeGreaterThan(0);
    r.draw();
    // During the drag, every record that moves content also carries the overlay that frames it (one frame, E-2).
    const during = r.records.slice(before);
    expect(during.length).toBeGreaterThan(0);
    for (const rec of during.filter((x) => x.projection)) expect(rec.overlay).toBeGreaterThan(0);
    const [tl] = tab.view.overlay.frame?.corners ?? [];
    expect(tl?.[0]).toBeCloseTo(f.document.view.value('b', P.x) as number, 6);
    unwrap(tab.pointer({ phase: 'up', x: at(660, 148)[0], y: at(660, 148)[1] }));
    expect(f.document.view.value('b', P.y)).toBe(100);
    expect(r.snapshots.at(-1)?.ids.length).toBe(2);

    // Text tool: click places a text element and opens the host; typing commits text and grows the box.
    tool = 'instaflow/text';
    tab.view.setTool(tool);
    const t = at(100, 500);
    unwrap(tab.pointer({ phase: 'down', x: t[0], y: t[1] }));
    unwrap(tab.pointer({ phase: 'up', x: t[0], y: t[1] }));
    const text = tab.view.selection[0] as string;
    expect(tab.editing?.node).toBe(text);
    expect(r.host.opened).toEqual([text]);
    const input = r.host.inputs.at(-1) as ReturnType<typeof scriptedTextInput>;
    input.emit({ kind: 'insert', text: 'Hello', range: [0, 0] });
    expect(unwrap(readTextBlock(f.document.part('p1') as never, text)).text).toBe('Hello');
    expect(f.document.view.value(text, P.w) as number).toBeGreaterThan(50);
    // The host is placed over the box in surface px (main adds the surface's client offset).
    const placed = r.host.placed.at(-1) as ClientRect;
    expect(placed.x).toBeCloseTo(t[0], 0);
    expect(placed.width).toBeGreaterThan(20);
    // Control bounds are surface px too (no client offset on the editor side).
    expect(input.controlBounds.at(-1)?.x).toBeCloseTo(t[0], 0);
    input.emit({ kind: 'key', key: 'Escape', shift: false, mod: false, alt: false });
    expect(tab.editing).toBeUndefined();
    expect(r.host.closed).toEqual(['escape']);
    expect(input.disposed).toBe(true);
    expect(tab.text.nodes).toContain(text);
    r.draw();
    expect(r.records.some((x) => x.ir)).toBe(true); // glyph runs went on the IR section

    // Keys from the ring reach the canvas shortcuts on the editor's registry: Delete, then Mod+Z.
    tab.view.select([node]);
    const key = (k: string, mods: { ctrlKey?: boolean } = {}) => registry.handle({ key: k, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: null, preventDefault: () => undefined, ...mods } as unknown as KeyboardEvent);
    expect(key('Delete')).toBe(true);
    expect(f.document.view.read(node)).toBeUndefined();
    expect(key('z', { ctrlKey: true })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.document.view.read(node)?.kind).toBe('shape');

    // Duplicate keeps the rich text (B2 handoff fix) and offsets the copy; one undo step takes it back.
    tab.view.select([text]);
    unwrap(tab.duplicateSelection());
    const copy = tab.view.selection[0] as string;
    expect(unwrap(readTextBlock(f.document.part('p1') as never, copy)).text).toBe('Hello');
    expect(f.document.view.value(copy, P.x)).toBe((f.document.view.value(text, P.x) as number) + 24);
    unwrap(await tab.undo());
    expect(f.document.view.read(copy)).toBeUndefined();

    // The announcer spoke about the selection (debounced, polite).
    r.timers.flush();
    expect(r.spoken.length).toBeGreaterThan(0);
    r.draw();
    expect(r.render.render.stats.drawFailures).toBe(0);
    expect(r.render.render.stats.payloadErrors).toBe(0);
    expect(r.raster.presents).toBeGreaterThan(0);
    await r.scope.dispose();
    await f.scope.dispose();
  });

  it('drag on the Shape tool with Shift draws a square; a click places the default size; double click edits text', async () => {
    const f = await createStudioFixture();
    const r = await rig(f, { tool: () => 'instaflow/shape' });
    const { tab } = r;
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

    // A text element is hit across its box: a double click inside it (not on its edge) edits it.
    unwrap(f.document.commitOps('p1', person, 'Text', unwrap(createTextOps({ node: 'tx', parent: 'p1', text: 'Edit me', props: { [P.x]: 100, [P.y]: 900, [P.w]: 400, [P.h]: 80, 'text.box': 'fixed' } }))));
    tab.view.setTool('instaflow/select');
    const inside = at(300, 940);
    unwrap(tab.pointer({ phase: 'down', x: inside[0], y: inside[1] }));
    unwrap(tab.pointer({ phase: 'up', x: inside[0], y: inside[1] }));
    unwrap(tab.pointer({ phase: 'down', x: inside[0], y: inside[1], clicks: 2 }));
    expect(tab.editing?.node).toBe('tx');
    // The release of that press is not an error (the controller never saw the press).
    expect(tab.pointer({ phase: 'up', x: inside[0], y: inside[1] }).ok).toBe(true);
    await r.scope.dispose();
    await f.scope.dispose();
  });

  it('a page switch attaches the next page: the publisher snapshots it; the overlay ids stay above the content', async () => {
    const f = await createStudioFixture({ pages: 2 });
    const scope = createScope('tabs');
    const pipes = unwrap(createCanvasPipes({ medium: 'local' }));
    const side = createElementSceneSide();
    const raster = createRecordingRaster();
    const render = unwrap(await attachCanvasRender({ pipes: pipes.endpoints, port: createElementRenderPort({ side, raster }), side, signal: scope.signal }));
    const open = async (page: string, s: Scope) =>
      unwrap(await openCanvasTab({ tab: 't1', document: f.document, page, fonts: f.fonts, publisher: pipes.publisher, viewport: { width: 1000, height: 800 }, actor: () => person, tool: () => 'instaflow/select', announcer: { announce: () => undefined }, timers: manualTimers(), schedule: (fn) => fn(), scope: s }));
    unwrap(commitEdit(f.document.target('p1'), person, 'Seed', ok([rect('a', 40, 40)])));
    const first = createScope('p1');
    await open('p1', first);
    render.render.update('arrival');
    expect(render.render.scene.count).toBe(1);
    const resnapshots = render.render.stats.resnapshots;
    await first.dispose();
    expect(pipes.publisher.attached).toBe(false);
    const second = createScope('p2');
    await open('p2', second);
    render.render.update('arrival');
    expect(render.render.scene.count).toBe(0); // p2 is empty: the snapshot replaced the scene
    expect(render.render.stats.resnapshots).toBeGreaterThanOrEqual(resnapshots);
    expect(OVERLAY_FIRST_ID).toBeGreaterThan(1 << 29);
    await second.dispose();
    render.stop();
    pipes.close();
    await scope.dispose();
    await f.scope.dispose();
  });

  it('B10a: Mod+T activates the transform-mode scope on the editor registry; Enter applies, undo cancels a session; the pivot travels in the overlay', async () => {
    const f = await createStudioFixture();
    const registry = createShortcutRegistry({ isMac: false });
    const r = await rig(f, { tool: () => 'instaflow/select', shortcuts: registry });
    registry.activate(CanvasToolsShortcutScope, r.scope);
    unwrap(commitEdit(f.document.target('p1'), person, 'Seed', ok([rect('a', 100, 100)])));
    r.tab.view.select(['a']);
    const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => registry.handle({ key: k, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: null, preventDefault: () => undefined, ...mods } as unknown as KeyboardEvent);
    const undoDepth = (): number => f.document.undo.history(person.id).undo.length;
    const u0 = undoDepth();
    expect(key('t', { ctrlKey: true })).toBe(true);
    expect(r.tab.tools.mode?.state).toBe('active');
    expect(registry.activeScopes).toContain(TransformModeShortcutScope.id);
    // The pivot handle and the thick frame are part of the overlay the record carries.
    r.draw();
    expect(r.tab.view.overlay.handles.some((h) => h.kind === 'pivot')).toBe(true);
    expect(r.records.at(-1)?.overlay).toBeGreaterThan(0);
    key('ArrowRight');
    key('H', { shiftKey: true });
    expect(f.document.view.value('a', P.flipX)).toBe(true); // a preview
    expect(undoDepth()).toBe(u0);
    expect(key('Enter')).toBe(true);
    expect(r.tab.tools.mode?.state).toBe('idle');
    expect(registry.activeScopes).not.toContain(TransformModeShortcutScope.id);
    expect(undoDepth()).toBe(u0 + 1);
    expect(f.document.view.value('a', P.x)).toBe(101);
    // Undo during a session cancels the session only.
    key('t', { ctrlKey: true });
    key('ArrowRight');
    unwrap(await r.tab.undo());
    expect(r.tab.tools.mode?.state).toBe('idle');
    expect(f.document.view.value('a', P.x)).toBe(101);
    expect(undoDepth()).toBe(u0 + 1);
    await r.scope.dispose();
    await f.scope.dispose();
  });
});
