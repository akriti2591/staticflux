// @vitest-environment node
// B1's geometry and B2's text Wasm load from the file system; the canvas surface is a lent happy-dom element.
import { ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { P } from '../elements/components.js';
import type { LibraryEntry } from '../library/library-doc.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { createRecordingRaster } from './element-port.js';
import { createStudioApp } from './studio-app.js';
import { authoringBuilt, createStudioFixture, lendDom, manualTimers, person, unwrap } from './test-helpers.js';

const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(condition(), what).toBe(true);
};

describe.skipIf(!authoringBuilt)('the Studio app composition (B8)', () => {
  it('runs M1b end to end: canvas tab, scope follows the selection, HUD repeat, milestone, Place, pages', async () => {
    const f = await createStudioFixture({ pages: 2 });
    const dom = lendDom();
    const surface = dom.document.createElement('div');
    dom.document.body.append(surface);
    const raster = createRecordingRaster();
    const decoder = { decode: async () => ok({ width: 40, height: 20, data: new Uint8Array(40 * 20 * 4).fill(200) }) };
    const app = unwrap(
      await createStudioApp({
        workspace: f.workspace,
        doc: f.document.doc,
        title: 'Flyer',
        geometry: f.document.geometry,
        fonts: f.fonts,
        person,
        raster: async () => ok(raster),
        library: { decoder },
        timers: manualTimers(),
        schedule: (fn) => fn(),
        scope: f.scope,
      }),
    );
    expect(app.studio.spec?.id).toBe('instaflow/studio');
    expect(app.studio.port.groups()['panel@dock']).toContain('panel:instaflow/milestones');
    const session = unwrap(await app.canvas.start(surface, f.signal));
    const tab = app.tab;
    if (tab === undefined) throw new Error('no tab');
    expect(tab.page).toBe('p1');

    // Draw a rectangle with the Shape tool (Studio's toolbar picks the tool).
    unwrap(app.studio.selectTool(StudioIds.tool.shape));
    await until(() => tab.view.tool === StudioIds.tool.shape, 'tool follows the toolbar');
    unwrap(tab.pointer({ phase: 'down', x: 100, y: 100 }));
    unwrap(tab.pointer({ phase: 'move', x: 160, y: 150 }));
    unwrap(tab.pointer({ phase: 'up', x: 200, y: 180 }));
    const rect = tab.view.selection[0] as string;
    expect(app.studio.activeTool).toBe(StudioIds.tool.select);

    // The spec's scope follows the selection: the selection's HUD actions and inspectors mount.
    await until(() => app.studio.spec?.scope.kind === 'selection', 'selection scope');
    expect(app.studio.port.groups()['hud@default']).toContain('hud:instaflow/repeat-radial');
    expect(app.studio.port.groups()['panel@inspector']).toEqual(expect.arrayContaining(['panel:instaflow/appearance', 'panel:instaflow/repeat']));

    // A HUD click runs the capability on the selection: a live radial repeat (one undo step).
    unwrap(await app.runHudAction('instaflow/repeat-radial'));
    // In the repeat view the source sits in instance wrapper `R~0` of the repeat group `R`.
    const wrapper = f.document.view.read(rect)?.parent as string;
    const group = f.document.view.read(wrapper)?.parent as string;
    expect(f.document.view.params(group)?.kind).toBe('radial');
    expect(app.spoken.at(-1)).toBe('Radial repeat done');
    // Describe speaks what is selected (B6 capability through the same pipeline).
    tab.view.select([group]);
    unwrap(await app.runHudAction('instaflow/describe-canvas'));
    expect(app.spoken.at(-1)).toMatch(/repeat/i);
    // A placeholder action says it arrives later instead of failing.
    unwrap(await app.runHudAction(StudioIds.hud.rewrite));
    expect(app.spoken.at(-1)).toContain('later');

    // The Milestone button creates a milestone (B5 capability).
    unwrap(await app.createMilestone('First draft'));
    expect(app.spoken.at(-1)).toBe('Milestone created: First draft');

    // Place: the library host hook uploads the pixels and adds an image element with an image fill.
    const content = unwrap(await f.workspace.blobs.put(new Uint8Array([1, 2, 3]), { mime: 'image/png' }));
    const entry = { asset: 'as_photo', kind: 'image', title: 'Photo', createdAt: '', folder: '', favorite: false, tags: [], content, mime: 'image/png', renditions: {} } as unknown as LibraryEntry;
    unwrap(await app.place(entry, f.signal));
    const image = tab.view.selection[0] as string;
    expect(f.document.view.read(image)?.kind).toBe('image');
    expect([f.document.view.value(image, P.w), f.document.view.value(image, P.h)]).toEqual([40, 20]);

    // The Pages panel's lens controller moves the canvas to page 2.
    unwrap(app.lens.goTo('p2'));
    await until(() => app.tab?.page === 'p2', 'page 2 shown');

    await session.stop();
    expect(app.tab).toBeUndefined();
    dom.restore();
    await f.scope.dispose();
  });
});
