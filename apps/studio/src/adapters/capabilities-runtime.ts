/**
 * Adapter: @staticflux/capabilities activation port → @staticflux/runtime feature host.
 * Activation runs after authorization + confirmation, so a denied capability never
 * loads its feature's chunk (I-8). The feature is touched for LRU while in use.
 */
import { err, ok, unit } from '@staticflux/core';
import { type FeatureActivationPort, FeatureActivationPortToken } from '@staticflux/capabilities';
import { FeatureHostToken, type FeatureId } from '@staticflux/runtime';

export const featureActivationPortUnit = unit({
  id: 'studio/feature-activation-port-unit',
  provides: FeatureActivationPortToken,
  scope: 'app',
  deps: { required: { host: FeatureHostToken } },
  create: ({ host }): FeatureActivationPort => ({
    async ensureActive(featureId, signal) {
      const id = featureId as FeatureId;
      if (!host.has(id)) return ok(undefined);
      const activated = await host.activate(id, signal);
      if (!activated.ok) return err(activated.error);
      host.touch(id);
      return ok({ release: () => host.touch(id) });
    },
  }),
  description: 'Capabilities ensure their owning feature is active (feature host).',
});
