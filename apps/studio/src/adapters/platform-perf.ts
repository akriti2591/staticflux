/**
 * Adapter: @staticflux/platform device facts → @staticflux/perf tiered budgets (R12.7).
 */
import { unit } from '@staticflux/core';
import { PlatformFactsToken } from '@staticflux/platform';
import { PerfDeviceTierToken } from '@staticflux/perf';

export const platformDeviceTierUnit = unit({
  id: 'studio/platform-device-tier-unit',
  provides: PerfDeviceTierToken,
  scope: 'app',
  deps: { required: { facts: PlatformFactsToken } },
  create:
    ({ facts }) =>
    () =>
      facts.device.tier,
  description: 'Mark budgets per device tier.',
});
