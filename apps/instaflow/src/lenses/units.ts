/**
 * DI for the lenses:
 *
 *   LensFeaturesToken (multi: Pages, Canvas; more lenses contribute their own) → LensFeatureRegistryToken (app)
 *   LensContextToken (open document, root part, mounted lens, viewport, camera, actor; from the editor)
 *   → LensServicesToken (controller + story writer; feature scope, disposed with the document)
 *   → LensControllerToken, StoryWriterToken (the Pages panel)
 */
import { type Scope, unit, type UnitDefinition } from '@staticflux/core';
import { canvasLensFeature } from './canvas-lens.js';
import { createLensController, type LensController } from './controller.js';
import { createLensFeatureRegistry, lensFeatureContribution, type LensFeatureRegistry, LensFeaturesToken } from './lens-features.js';
import { pagesLensFeature } from './pages-lens.js';
import { createStoryWriter, type StoryWriter } from './story.js';
import { structureFeed } from './structure.js';
import {
  type LensContext,
  LensContextToken,
  LensControllerToken,
  LensFeatureRegistryToken,
  type LensServices,
  LensServicesToken,
  StoryWriterToken,
} from './tokens.js';

/** Build the controller and story writer for one open document; disposed with `scope`. */
export function createLensServices(context: LensContext, features: LensFeatureRegistry, scope: Scope): LensServices {
  const structure = structureFeed(context.root);
  const controller = createLensController({ features, lens: context.lens, structure, viewport: context.viewport, camera: context.camera });
  const story = createStoryWriter({ doc: context.doc, structure: () => structure.read(), actor: context.actor });
  scope.defer(() => controller.dispose());
  return { controller, story };
}

export const lensFeatureRegistryUnit: UnitDefinition<LensFeatureRegistry, { required: { features: typeof LensFeaturesToken } }, 'instaflow/lens-feature-registry'> = /* @__PURE__ */ unit({
  id: 'instaflow/lens-feature-registry',
  provides: LensFeatureRegistryToken,
  scope: 'app',
  deps: { required: { features: LensFeaturesToken } },
  create: ({ features }) => {
    const registry = createLensFeatureRegistry(features);
    if (!registry.ok) throw registry.error;
    return registry.value;
  },
  description: 'One arrangement, focus and overview per lens; Canvas is the fallback (B4, D19).',
});

export const lensServicesUnit: UnitDefinition<LensServices, { required: { context: typeof LensContextToken; features: typeof LensFeatureRegistryToken } }, 'instaflow/lens-services'> = /* @__PURE__ */ unit({
  id: 'instaflow/lens-services',
  provides: LensServicesToken,
  scope: 'feature',
  deps: { required: { context: LensContextToken, features: LensFeatureRegistryToken } },
  create: ({ context, features }, ctx) => createLensServices(context, features, ctx.scope),
  description: 'The lens controller (arrangement, page navigation, camera requests) and story edits for the open document (B4).',
});

export const lensControllerUnit: UnitDefinition<LensController, { required: { services: typeof LensServicesToken } }, 'instaflow/lens-controller'> = /* @__PURE__ */ unit({
  id: 'instaflow/lens-controller',
  provides: LensControllerToken,
  scope: 'feature',
  deps: { required: { services: LensServicesToken } },
  create: ({ services }) => services.controller,
});

export const storyWriterUnit: UnitDefinition<StoryWriter, { required: { services: typeof LensServicesToken } }, 'instaflow/story-writer'> = /* @__PURE__ */ unit({
  id: 'instaflow/story-writer',
  provides: StoryWriterToken,
  scope: 'feature',
  deps: { required: { services: LensServicesToken } },
  create: ({ services }) => services.story,
});

/** The Pages and Canvas lens features (per-mode features, contributed like any other). */
export const lensFeatureUnits = [/* @__PURE__ */ lensFeatureContribution(pagesLensFeature), /* @__PURE__ */ lensFeatureContribution(canvasLensFeature)] as const;

/** Everything the lenses register (the context unit comes from the editor). */
export const lensUnits = [...lensFeatureUnits, lensFeatureRegistryUnit, lensServicesUnit, lensControllerUnit, storyWriterUnit] as const;
