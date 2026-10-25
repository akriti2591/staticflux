/**
 * The lens feature registry: one `LensFeature` per lens id, contributed through a multi token like
 * every other editor contribution. Lenses without an arrangement of their own (Pixel, Timeline, Flow
 * in M1b) use the fallback — the Canvas feature (D19: lenses on top of the infinite canvas). The lookup
 * is data; nothing branches on the lens.
 */
import { contribution, err, ok, type Result, token } from '@staticflux/core';
import type { LensContributionId } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import { LensFeatureRegistryError } from './errors.js';
import type { LensFeature } from './lens-feature.js';

export const LensFeaturesToken = /* @__PURE__ */ token('instaflow/lens-features').multi<LensFeature>();

/* @__NO_SIDE_EFFECTS__ */
export function lensFeatureContribution(feature: LensFeature) {
  return contribution({ id: `${feature.lens}-feature`, provides: LensFeaturesToken, scope: 'app', create: () => feature, description: `Lens feature for ${feature.lens}.` });
}

export interface LensFeatureRegistry {
  /** The feature for a lens (its own, or the fallback's). */
  feature(lens: LensContributionId): LensFeature;
  /** Lenses with a feature of their own. */
  readonly lenses: readonly LensContributionId[];
  readonly fallback: LensContributionId;
}

/** Build the registry; duplicates or a missing fallback are IF-LIB-012. */
export function createLensFeatureRegistry(features: readonly LensFeature[], fallback: LensContributionId = StudioIds.lens.canvas): Result<LensFeatureRegistry> {
  const byLens = new Map<LensContributionId, LensFeature>();
  for (const feature of features) {
    if (byLens.has(feature.lens)) return err(LensFeatureRegistryError({ message: `Two lens features claim ${feature.lens}.`, details: { lens: feature.lens } }));
    byLens.set(feature.lens, feature);
  }
  const fallbackFeature = byLens.get(fallback);
  if (fallbackFeature === undefined) return err(LensFeatureRegistryError({ message: `The fallback lens ${fallback} has no feature.`, details: { lens: fallback } }));
  return ok({ feature: (lens) => byLens.get(lens) ?? fallbackFeature, lenses: [...byLens.keys()], fallback });
}
