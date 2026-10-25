/** Lens DI tokens and the context the editor provides (type-only imports). */
import { token } from '@staticflux/core';
import type { PartChange } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import type { LensContributionId } from '../spec/contributions.js';
import type { CameraPort, LensController } from './controller.js';
import type { Viewport } from './lens-feature.js';
import type { LensFeatureRegistry } from './lens-features.js';
import type { StoryWriter, StoryWriterOptions } from './story.js';
import type { StructureSource } from './structure.js';

/** What the editor (B0 / Studio) provides in the open document's scope. */
export interface LensContext {
  /** The open document (commits story edits). */
  readonly doc: StoryWriterOptions['doc'];
  /** Its loaded root part. */
  readonly root: StructureSource & { observe(listener: (change: PartChange) => void): () => void };
  /** The mounted lens (reactive: `() => studio.lens?.id`). */
  readonly lens: () => LensContributionId | undefined;
  readonly viewport: () => Viewport;
  readonly camera: CameraPort;
  readonly actor: () => Actor;
}

export interface LensServices {
  readonly controller: LensController;
  readonly story: StoryWriter;
}

export const LensContextToken = /* @__PURE__ */ token('instaflow/lens-context').type<LensContext>();
export const LensFeatureRegistryToken = /* @__PURE__ */ token('instaflow/lens-feature-registry').type<LensFeatureRegistry>();
export const LensServicesToken = /* @__PURE__ */ token('instaflow/lens-services').type<LensServices>();
export const LensControllerToken = /* @__PURE__ */ token('instaflow/lens-controller').type<LensController>();
export const StoryWriterToken = /* @__PURE__ */ token('instaflow/story-writer').type<StoryWriter>();
