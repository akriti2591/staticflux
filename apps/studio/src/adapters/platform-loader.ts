/**
 * Adapter: @staticflux/platform facts → @staticflux/loader ports (R12.3, R12.10).
 * Warmup backs off on offline / save-data / slow networks / low-tier devices, and
 * profile-scoped chunks resolve against the current app profile key.
 */
import { unit } from '@staticflux/core';
import { LoaderProfileToken, WarmupFactsToken, type WarmupFacts } from '@staticflux/loader';
import { AppProfileToken, PlatformFactsToken } from '@staticflux/platform';

export const platformWarmupFactsUnit = unit({
  id: 'studio/platform-warmup-facts-unit',
  provides: WarmupFactsToken,
  scope: 'app',
  deps: { required: { facts: PlatformFactsToken } },
  create:
    ({ facts }) =>
    (): WarmupFacts => {
      const network = facts.network;
      return { online: network.online, saveData: network.saveData, effectiveType: network.effectiveType, deviceTier: facts.device.tier };
    },
  description: 'Network/device facts for warmup backoff.',
});

export const platformLoaderProfileUnit = unit({
  id: 'studio/platform-loader-profile-unit',
  provides: LoaderProfileToken,
  scope: 'app',
  deps: { required: { profile: AppProfileToken } },
  create:
    ({ profile }) =>
    () =>
      profile.current,
  description: 'Current app profile for profile-scoped chunks and boot plans.',
});
