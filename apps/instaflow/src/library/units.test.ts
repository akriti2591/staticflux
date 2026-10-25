import { createInjector, createScope, ok, unit } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createEditorRegistries } from '../spec/registries.js';
import { validateSpec } from '@staticflux/shell/spec';
import { editDocumentCapability, proposeSpecCapability } from '../spec/capabilities.js';
import { gateSpecDecide } from '../spec/gate.js';
import { toShellSpec } from '../spec/registries.js';
import { editorGate } from '../spec/testing/fixtures.js';
import { StudioIds, studioHudActions, studioLenses, studioPanels, studioTools } from '../spec/studio-contributions.js';
import { studioSpec } from '../spec/studio-spec.js';
import { libraryContributionUnits, libraryPanel } from './contributions.js';
import { entryCreateOps, LIBRARY_PART } from './library-doc.js';
import { pngImageEncoder, scaleThumbnailRenderer } from './thumbnails.js';
import { fakeImageBytes, fakeImageDecoder, fileOf, libraryFixture, nextAssetId, priya, signal, unwrap } from './test-helpers.js';
import { type LibraryContext, LibraryContextToken, LibraryPanelModelToken, LibraryServicesToken } from './tokens.js';
import { createLibraryServices, libraryServicesUnit, libraryUnits } from './units.js';

async function context(): Promise<LibraryContext> {
  const fixture = await libraryFixture();
  return {
    document: fixture.document,
    blobs: fixture.blobs,
    actor: () => priya,
    newAssetId: nextAssetId,
    host: { pickFiles: async () => ok([]), place: async () => ok() },
    decoder: fakeImageDecoder(),
    renderer: scaleThumbnailRenderer(),
    encoder: pngImageEncoder(),
  };
}

describe('createLibraryServices', () => {
  it('wires ingest to the rendition queue, resumes missing renditions and disposes with the scope', async () => {
    const ctx = await context();
    // An entry from an "earlier session" without a thumbnail.
    const ref = unwrap(await ctx.blobs.put(fakeImageBytes(20, 10), { mime: 'image/png' }));
    unwrap(ctx.document.doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Seed' }, { [LIBRARY_PART]: entryCreateOps({ asset: 'as_old', kind: 'image', title: 'Old', createdAt: '2026-01-01T00:00:00.000Z', content: ref }) }));
    const scope = createScope('workspace');
    const services = createLibraryServices(ctx, scope);
    const imported = unwrap(await services.ingest.ingest(fileOf('new.png', 'image/png', fakeImageBytes(30, 30)), { signal }));
    expect(imported.entry.media).toMatchObject({ width: 30, height: 30 }); // default image probe through the decoder
    unwrap(await services.renditions.idle(signal));
    expect(services.library.entry('as_old')?.renditions.thumbnail).toBeDefined();
    expect(services.library.entry(imported.entry.asset)?.renditions.thumbnail).toBeDefined();
    await scope.dispose();
    expect(services.library.rename('as_old', 'x').ok).toBe(false);
  });
});

describe('library units and contributions', () => {
  it('resolve from a LibraryContext in a feature scope', async () => {
    const ctx = await context();
    const app = createInjector({ units: [unit({ id: 'test/library-context', provides: LibraryContextToken, scope: 'app', create: () => ctx }), ...libraryUnits, ...libraryContributionUnits] });
    const injector = app.child('feature', 'workspace');
    const services = unwrap(await injector.get(LibraryServicesToken));
    expect(unwrap(await injector.get(LibraryPanelModelToken))).toBe(services.panel);
    expect(libraryServicesUnit.scope).toBe('feature');
    await app.dispose();
  });

  it('the Assets panel replaces B0’s placeholder under the same id and Studio’s spec still validates', async () => {
    expect(libraryPanel.id).toBe(StudioIds.panel.assets);
    expect(libraryPanel.placements).toEqual(['dock']);
    const panels = [...studioPanels.filter((p) => p.id !== StudioIds.panel.assets), libraryPanel];
    const registries = unwrap(createEditorRegistries({ lenses: studioLenses, tools: studioTools, panels, hud: studioHudActions, capabilities: [proposeSpecCapability, editDocumentCapability] }));
    expect(registries.panel(StudioIds.panel.assets)).toBe(libraryPanel);
    expect(studioSpec.panels.some((p) => p.panel === StudioIds.panel.assets)).toBe(true);
    expect((await validateSpec(toShellSpec(studioSpec), registries.vocabulary, { decide: gateSpecDecide(editorGate('pro').gate) })).ok).toBe(true);
    const duplicate = createEditorRegistries({ lenses: studioLenses, tools: studioTools, panels: [...studioPanels, libraryPanel], hud: studioHudActions, capabilities: [proposeSpecCapability, editDocumentCapability] });
    expect(!duplicate.ok && duplicate.error.code).toBe('IF-SPEC-002');
    const body = libraryPanel.render({ density: 'pro', lens: StudioIds.lens.canvas, scope: 'asset' }) as { strings: readonly string[] };
    expect(body.strings.join('')).toContain('<if-library-panel>');
    expect(customElements.get('if-library-panel')).toBeDefined();
  });
});
