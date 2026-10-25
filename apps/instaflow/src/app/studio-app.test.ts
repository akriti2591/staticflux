// @vitest-environment node
// B1's geometry and B2's text Wasm load from the file system; the canvas surface is a lent happy-dom element. B9: the
// editor and render modules run in in-process "workers" (the browser's host code on in-memory ports), in both
// topologies; input goes through A5's ring.
import { createScope, ok, type Result } from '@staticflux/core';
import { inMemorySpawner } from '@staticflux/worker';
import { InputCode } from '@staticflux/surface';
import { describe, expect, it } from 'vitest';
import type { ExportFile } from '../export/formats.js';
import { hostExportWorker } from '../export/host.js';
import { createExportFixture, exportBuilt } from '../export/testing/test-helpers.js';
import type { LibraryEntry } from '../library/library-doc.js';
import { DEFAULT_SEQUENCING_SETTINGS } from '../sequencing/topology.js';
import { StudioIds } from '../spec/studio-ids.js';
import { AppearanceMirror, StoryMirror } from '../workers/mirrors.js';
import { dragEvents, inProcessWorkers, inputWriter, until } from '../workers/test-helpers.js';
import { openStudioWorkspace } from './document.js';
import { createStudioApp } from './studio-app.js';
import { authoringBuilt, lendDom, manualTimers, person, scriptedTextInput, unwrap } from './test-helpers.js';

describe.skipIf(!authoringBuilt).each(['colocated', 'split'] as const)('the Studio app over its workers (B8, B9): %s', (topology) => {
  it('runs M1b end to end: canvas, input through the ring, scope follows the selection, HUD repeat, milestone, Place, pages', { timeout: 60_000 }, async () => {
    // Heavy: Wasm, two documents, fonts, workers on ports (4 shared cores).
    const scope = createScope('studio-test');
    const signal = scope.signal;
    const workspace = unwrap(await openStudioWorkspace({ signal }));
    const dom = lendDom();
    const surface = dom.document.createElement('div');
    dom.document.body.append(surface);
    const workers = inProcessWorkers();
    const inputs: ReturnType<typeof scriptedTextInput>[] = [];
    // C1: an in-process export worker over the Node toolchain (real composition and writers; rasters recorded).
    const exportEnv = exportBuilt ? (await createExportFixture()).env : undefined;
    const delivered: ExportFile[][] = [];
    const app = unwrap(
      await createStudioApp({
        workspace,
        document: { asset: `as_app_${topology}`, title: 'Flyer', create: { pages: 2 } },
        person,
        workers: { settings: { ...DEFAULT_SEQUENCING_SETTINGS, topology }, spawn: () => workers.spawn(), assets: { manifest: 'memory://manifest', fonts: [] } },
        ...(exportEnv === undefined
          ? {}
          : {
              exporter: {
                spawn: () => inMemorySpawner((port) => hostExportWorker({ port, env: { load: async () => ok(exportEnv) } }), { clone: false }),
                deliver: async (files: readonly ExportFile[]): Promise<Result<void>> => {
                  delivered.push([...files]);
                  return ok();
                },
              },
            }),
        textInput: {
          kind: 'hidden-textarea',
          create: () => {
            const input = scriptedTextInput();
            inputs.push(input);
            return ok(input);
          },
        },
        library: { decoder: { decode: async () => ok({ width: 40, height: 20, data: new Uint8Array(40 * 20 * 4).fill(200) }) } },
        handoff: () => ok({ canvas: { width: 0, height: 0 }, transfer: [] }),
        timers: manualTimers(),
        scope,
      }),
    );
    expect(app.workers.plan.topology).toBe(topology);
    expect(app.workers.workers.length).toBe(topology === 'split' ? 2 : 1);
    expect(app.studio.spec?.id).toBe('instaflow/studio');
    expect(app.studio.port.groups()['panel@dock']).toContain('panel:instaflow/milestones');
    expect(app.workers.started.capabilities).toContain('instaflow/repeat-radial');
    expect(app.workers.started.pages).toEqual(['p1', 'p2']);
    const inspect = async () => {
      const r = await app.inspect();
      return r.ok ? r.value : undefined;
    };
    const session = unwrap(await app.canvas.start(surface as never, signal));
    await until(() => app.tab?.page === 'p1', 'page 1 open');
    expect(workers.rasters.length).toBe(1); // the render module drew into the handed-off canvas
    // The Pages panel's structure came across (the lens controller on main reads it).
    await until(() => app.mirrors.view(StoryMirror).read('structure')?.ok === true, 'structure mirrored');
    await until(() => app.lens.current() === 'p1', 'lens starts on the shown page');

    // Draw a rectangle with the Shape tool: the toolbar picks the tool, pointer input goes through A5's ring.
    unwrap(app.studio.selectTool(StudioIds.tool.shape));
    await until(() => app.view?.tool === StudioIds.tool.shape, 'tool follows the toolbar');
    const push = inputWriter(app.workers.input);
    push(dragEvents([100, 100], [200, 180]));
    await until(() => app.tab?.view.selection.length === 1, 'rectangle selected');
    const rect = app.tab?.view.selection[0] as string;
    expect((await app.element(rect))?.kind).toBe('shape');
    await until(() => app.studio.activeTool === StudioIds.tool.select, 'the toolbar is handed back');
    workers.draw();
    expect(workers.rasters[0]?.presents).toBeGreaterThan(0);

    // The spec's scope follows the selection: the selection's HUD actions and inspectors mount, and the appearance
    // inspector's model is mirrored from the editor.
    await until(() => app.studio.spec?.scope.kind === 'selection', 'selection scope');
    expect(app.studio.port.groups()['hud@default']).toContain('hud:instaflow/repeat-radial');
    expect(app.studio.port.groups()['panel@inspector']).toEqual(expect.arrayContaining(['panel:instaflow/appearance', 'panel:instaflow/repeat']));
    await until(() => app.mirrors.view(AppearanceMirror).read('model')?.node === rect, 'appearance model mirrored');
    unwrap(await app.mirrors.view(AppearanceMirror).call('apply', { op: 'set', path: 'spatial.opacity', value: 0.5 }));

    // A HUD click runs the capability (validated and gated here, run in the editor): a live radial repeat.
    unwrap(await app.runHudAction('instaflow/repeat-radial'));
    expect(app.spoken.at(-1)).toBe('Radial repeat done');
    const wrapper = (await app.element(rect))?.parent as string;
    expect((await app.element(wrapper))?.parent).toBeDefined();
    // Describe speaks what is selected (B6 capability through the same pipeline).
    unwrap(await app.runHudAction('instaflow/describe-canvas'));
    expect(app.spoken.at(-1)).toBeTruthy();
    // A placeholder action says it arrives later instead of failing.
    unwrap(await app.runHudAction(StudioIds.hud.rewrite));
    expect(app.spoken.at(-1)).toContain('later');

    // Keys through the ring: Escape clears the selection (a canvas shortcut run by the editor).
    push([{ t: InputCode.keyDown, key: 'Escape', code: 'Escape' }]);
    await until(() => app.tab?.view.selection.length === 0, 'Escape cleared the selection');

    // Text: a click with the Text tool opens the host on main (TextInput port); typing commits in the editor.
    unwrap(app.studio.selectTool(StudioIds.tool.text));
    await until(() => app.view?.tool === StudioIds.tool.text, 'text tool');
    push([{ t: InputCode.pointerDown, x: 120, y: 420, b: 1 }, { t: InputCode.pointerUp, x: 120, y: 420 }]);
    await until(() => app.canvas.text?.host !== undefined, 'text host open');
    expect(app.canvas.text?.host?.getAttribute('role')).toBe('textbox');
    const input = inputs.at(-1) as ReturnType<typeof scriptedTextInput>;
    input.emit({ kind: 'insert', text: 'Hi', range: [0, 0] });
    await until(async () => (await inspect())?.editing?.text === 'Hi', 'typed through the port');
    await until(() => input.controlBounds.length > 0, 'control bounds came back');
    input.emit({ kind: 'key', key: 'Escape', shift: false, mod: false, alt: false });
    await until(() => app.canvas.text?.host === undefined && app.tab?.editing === undefined, 'editing ended');

    // The Milestone button creates a milestone (B5 capability in the editor, store writes through the port).
    unwrap(await app.createMilestone('First draft'));
    expect(app.spoken.at(-1)).toBe('Milestone created: First draft');

    // Place: the library (main, store side) asks the editor; the editor reads the blob through the store port.
    const content = unwrap(await workspace.blobs.put(new Uint8Array([1, 2, 3]), { mime: 'image/png' }));
    const entry = { asset: 'as_photo', kind: 'image', title: 'Photo', createdAt: '', folder: '', favorite: false, tags: [], content, mime: 'image/png', renditions: {} } as unknown as LibraryEntry;
    unwrap(await app.place(entry, signal));
    await until(() => app.tab?.view.selection.length === 1, 'image selected');
    const image = await app.element(app.tab?.view.selection[0] as string);
    expect([image?.kind, image?.w, image?.h]).toEqual(['image', 40, 20]);

    // C1: export from a frozen snapshot in the export worker; the document gains nothing (D10).
    if (exportEnv !== undefined) {
      const before = (await inspect())?.elements.length;
      unwrap(await app.exportDesign({ format: 'pdf', scale: 2, transparent: false, scope: 'pages' }));
      unwrap(await app.exportDesign({ format: 'png', scale: 1, transparent: false, scope: 'page' }));
      expect(delivered.map((files) => files.map((f) => f.name))).toEqual([['Flyer.pdf'], ['Flyer.png']]);
      const pdf = delivered[0]?.[0]?.bytes as Uint8Array;
      expect(new TextDecoder().decode(pdf.subarray(0, 8))).toBe('%PDF-1.7');
      // Both pages; the shapes and text drawn above sit off the page (negative x), so the page shows the image only.
      expect(new TextDecoder('latin1').decode(pdf)).toContain('/Count 2');
      expect([...(delivered[1]?.[0]?.bytes.subarray(1, 4) ?? [])]).toEqual([0x50, 0x4e, 0x47]);
      expect(app.exports?.status.kind).toBe('done');
      expect(app.spoken.at(-1)).toBe('Exported Flyer.png');
      expect((await inspect())?.elements.length).toBe(before);
    }

    // The Pages panel's lens controller moves the canvas to page 2.
    unwrap(app.lens.goTo('p2'));
    await until(() => app.tab?.page === 'p2', 'page 2 shown');
    expect((await inspect())?.elements.length).toBe(0);

    const metrics = unwrap(await app.metrics());
    expect(metrics.render?.drawFailures).toBe(0);
    expect(metrics.editor?.inputs).toBeGreaterThan(4);
    await session.stop();
    expect(app.tab).toBeUndefined();
    await scope.dispose();
    dom.restore();
  });
});
