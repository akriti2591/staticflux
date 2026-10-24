/**
 * Adapter: @staticflux/capabilities denials → @staticflux/router routable upsell.
 * UI-initiated invocations go through `CapabilityInvokerToken`: an `upgrade` denial
 * opens `/d/upgrade` (R13.9 "denied → upsell surface"); other results pass through.
 * Agents invoke the registry directly (their denials are reported in the chat).
 */
import { unit } from '@staticflux/core';
import { CapabilityRegistryToken } from '@staticflux/capabilities';
import { RouterToken } from '@staticflux/router';
import { type CapabilityInvoker, CapabilityInvokerToken } from '../app/contracts.js';
import { UpgradeDialog } from '../app/routes.js';

// The token lives in contracts.ts (boot code names it; this unit loads with the capabilities chunk).
export { type CapabilityInvoker, CapabilityInvokerToken } from '../app/contracts.js';

export const upsellInvokerUnit = unit({
  id: 'studio/upsell-invoker-unit',
  provides: CapabilityInvokerToken,
  scope: 'app',
  deps: { required: { registry: CapabilityRegistryToken, router: RouterToken } },
  create: ({ registry, router }): CapabilityInvoker => ({
    async invoke(capability, input, options = {}) {
      const result = await registry.invoke(capability, input, {
        subject: 'user',
        origin: { channel: options.channel ?? 'ui/button' },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!result.ok && result.error.details['reason'] === 'upgrade') await router.openDialogRoute(UpgradeDialog);
      return result;
    },
  }),
  description: 'User capability calls with upgrade upsell on denial.',
});
