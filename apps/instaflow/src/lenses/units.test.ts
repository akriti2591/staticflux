import { createInjector, createScope, unit } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { StudioIds } from '../spec/studio-contributions.js';
import { pagesLensFeature } from './pages-lens.js';
import { compositionDoc, priya, unwrap } from './test-helpers.js';
import { type LensContext, LensContextToken, LensControllerToken, LensFeatureRegistryToken, LensServicesToken, StoryWriterToken } from './tokens.js';
import { createLensServices, lensFeatureUnits, lensServicesUnit, lensUnits } from './units.js';
import { createLensFeatureRegistry } from './lens-features.js';
import { canvasLensFeature } from './canvas-lens.js';

async function context(): Promise<LensContext> {
  const { doc, root } = await compositionDoc([{ id: 'p1' }, { id: 'p2' }]);
  return { doc, root, lens: () => StudioIds.lens.pages, viewport: () => ({ width: 800, height: 600 }), camera: { show: () => undefined }, actor: () => priya };
}

describe('createLensServices', () => {
  it('builds the controller and story writer over one document; disposed with the scope', async () => {
    const ctx = await context();
    const scope = createScope('document');
    const services = createLensServices(ctx, unwrap(createLensFeatureRegistry([pagesLensFeature, canvasLensFeature])), scope);
    unwrap(services.story.movePage('p2', 0));
    expect(services.controller.arrangement()?.frames.map((f) => f.page)).toEqual(['p2', 'p1']);
    await scope.dispose();
  });
});

describe('lens units', () => {
  it('resolve the registry (app) and the services (feature) from a LensContext', async () => {
    const ctx = await context();
    const app = createInjector({ units: [unit({ id: 'test/lens-context', provides: LensContextToken, scope: 'app', create: () => ctx }), ...lensUnits] });
    const registry = unwrap(await app.get(LensFeatureRegistryToken));
    expect(registry.feature(StudioIds.lens.pages)).toBe(pagesLensFeature);
    const injector = app.child('feature', 'document');
    const services = unwrap(await injector.get(LensServicesToken));
    expect(unwrap(await injector.get(LensControllerToken))).toBe(services.controller);
    expect(unwrap(await injector.get(StoryWriterToken))).toBe(services.story);
    expect(lensServicesUnit.scope).toBe('feature');
    expect(lensFeatureUnits).toHaveLength(2);
    await app.dispose();
  });

  it('a duplicate lens feature fails the registry unit', async () => {
    const app = createInjector({ units: [...lensUnits, ...lensFeatureUnits.slice(0, 1)] });
    expect((await app.get(LensFeatureRegistryToken)).ok).toBe(false);
    await app.dispose();
  });
});
