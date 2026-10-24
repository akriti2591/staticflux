/**
 * Adapter: @staticflux/capabilities denials → @staticflux/router routable upsell.
 * UI-initiated invocations go through `CapabilityInvokerToken`: an `upgrade` denial
 * opens `/d/upgrade` (R13.9 "denied → upsell surface"); other results pass through.
 * Agents invoke the registry directly (their denials are reported in the chat).
 */
import { type Result, token, unit } from '@staticflux/core';
import { type AnyCapability, type CapabilityInput, type CapabilityOutput, CapabilityRegistryToken } from '@staticflux/capabilities';
import { RouterToken } from '@staticflux/router';
import { UpgradeDialog } from '../app/routes.js';

export interface CapabilityInvoker {
  invoke<C extends AnyCapability>(capability: C, input: CapabilityInput<C>, options?: { readonly signal?: AbortSignal; readonly channel?: string }): Promise<Result<CapabilityOutput<C>>>;
}
export const CapabilityInvokerToken = token('studio/capability-invoker').type<CapabilityInvoker>();

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
