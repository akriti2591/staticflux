// @vitest-environment node
// #43: images survive save → reopen. A placed image, an image fill on a shape and the page's Background image are
// saved (Latest and the library flushed), then the design is opened again over the same store and blobs (what a
// reload does): the document still names the image, the blob is still there, and its pixels reach the render side
// again (an upload batch with the decoded bytes), in both topologies.
import { createScope, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import type { LibraryEntry } from '../library/library-doc.js';
import { DEFAULT_SEQUENCING_SETTINGS } from '../sequencing/topology.js';
import { StudioIds } from '../spec/studio-ids.js';
import { SceneMirror } from '../workers/mirrors.js';
import { dragEvents, inProcessWorkers, inputWriter, until } from '../workers/test-helpers.js';
import { openStudioWorkspace, type StudioWorkspace } from './document.js';
import type { RecordingRaster } from './element-port.js';
import { createStudioApp, type StudioApp } from './studio-app.js';
import { authoringBuilt, lendDom, manualTimers, person, scriptedTextInput, unwrap } from './test-helpers.js';

/** The decoder's pixels: 40 × 20, every byte PIXEL (so an upload batch is recognisable by a run of them). */
const PIXEL = 0xc8;
const W = 40;
const H = 20;

/** True when a batch drawn on `raster` carries the decoded RGBA (an image upload the render side can draw). */
const uploaded = (raster: RecordingRaster | undefined): boolean =>
  raster?.batches.some((batch) => {
    let run = 0;
    for (const byte of batch) {
      run = byte === PIXEL ? run + 1 : 0;
      if (run >= W * H * 4) return true;
    }
    return false;
  }) === true;

describe.skipIf(!authoringBuilt).each(['colocated', 'split'] as const)('images survive save and reopen (#43): %s', (topology) => {
  it('a placed image, a shape’s image fill and the page Background image are drawn again after a reopen', { timeout: 60_000 }, async () => {
    const asset = `as_reopen_${topology}`;
    const boot = async (workspace: StudioWorkspace, name: string) => {
      const scope = createScope(name);
      const dom = lendDom();
      const surface = dom.document.createElement('div');
      dom.document.body.append(surface);
      const workers = inProcessWorkers();
      const app = unwrap(
        await createStudioApp({
          workspace,
          document: { asset, title: 'Reopen', create: { pages: 1 } },
          storage: null,
          person,
          workers: { settings: { ...DEFAULT_SEQUENCING_SETTINGS, topology }, spawn: () => workers.spawn(), assets: { manifest: 'memory://manifest', fonts: [] } },
          textInput: { kind: 'hidden-textarea', create: () => ok(scriptedTextInput()) },
          library: { decoder: { decode: async () => ok({ width: W, height: H, data: new Uint8Array(W * H * 4).fill(PIXEL) }) } },
          handoff: () => ok({ canvas: { width: 0, height: 0 }, transfer: [] }),
          timers: manualTimers(),
          scope,
        }),
      );
      unwrap(await app.canvas.start(surface as never, scope.signal));
      await until(() => app.tab?.page === 'p1', 'page 1 open');
      return { app, workers, scope };
    };
    const imagePaints = (app: StudioApp): { readonly page: boolean; readonly kinds: readonly string[] } => ({
      page: (app.mirrors.view(SceneMirror).read('pageFill')?.fills ?? []).some((f) => (f.paint as { kind?: string }).kind === 'image'),
      kinds: app.scene.layers.map((l) => l.kind ?? '').sort(),
    });

    // Session 1: the image is in the library (bytes in the workspace's blob store first), then used three ways.
    const signal = new AbortController().signal;
    const first = unwrap(await openStudioWorkspace({ signal }));
    const one = await boot(first, 'reopen-1');
    const content = unwrap(await first.blobs.put(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), { mime: 'image/png' }));
    const entry = unwrap(one.app.library.add({ asset: 'as_photo' as LibraryEntry['asset'], kind: 'image', title: 'Photo', createdAt: '2026-10-28T00:00:00.000Z', content, mime: 'image/png' }));
    unwrap(await one.app.place(entry, signal)); // ⌘⇧K / paste: a placed image element
    unwrap(one.app.studio.selectTool(StudioIds.tool.shape));
    await until(() => one.app.view?.tool === StudioIds.tool.shape, 'shape tool');
    inputWriter(one.app.workers.input)(dragEvents([300, 300], [380, 360]));
    await until(() => one.app.tab?.view.selection.length === 1 && one.app.scene.selection?.kind === 'shape', 'rectangle drawn');
    expect(unwrap(await one.app.workers.editor.request('imageFill', { entry, target: { to: 'selection' } }))).toHaveProperty('filled');
    unwrap(await one.app.workers.editor.request('imageFill', { entry, target: { to: 'page' } }));
    await until(() => imagePaints(one.app).page, 'the page background is the image');
    one.workers.draw();
    expect(uploaded(one.workers.rasters[0])).toBe(true); // drawn in the session that added it
    unwrap(await one.app.flush()); // the save: Latest durable in the store
    unwrap(await first.library.doc.flush(signal)); // and the library entry
    await one.scope.dispose();

    // Session 2 (the reload): a fresh workspace over the same store and blobs.
    const second = unwrap(await openStudioWorkspace({ signal, store: first.store, blobs: first.blobs }));
    expect(unwrap(await second.blobs.get(content, { signal })).length).toBe(7); // the bytes are still stored
    const two = await boot(second, 'reopen-2');
    await until(() => imagePaints(two.app).page, 'the page background still names the image');
    expect(imagePaints(two.app).kinds).toEqual(['image', 'rectangle']);
    await until(() => {
      two.workers.draw();
      return uploaded(two.workers.rasters[0]);
    }, 'the image pixels reach the render side after the reopen');
    await two.scope.dispose();
  });
});
