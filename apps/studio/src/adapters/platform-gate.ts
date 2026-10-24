/**
 * Adapter: @staticflux/platform → @staticflux/gate facts (form factor, host mode,
 * effective capabilities), so policies can target modes without feature code
 * branching on them (R18.5).
 */
import { contribution } from '@staticflux/core';
import { FactSourcesToken, GateFacts, reactiveFactSource } from '@staticflux/gate';
import { AppProfileToken } from '@staticflux/platform';

export const platformFactsGateUnit = contribution({
  id: 'studio/platform-facts-gate-unit',
  provides: FactSourcesToken,
  scope: 'app',
  deps: { required: { profile: AppProfileToken } },
  create: ({ profile }, ctx) =>
    reactiveFactSource(
      'studio/platform-facts',
      [
        { fact: GateFacts.formFactor, read: () => profile.current.formFactor },
        { fact: GateFacts.host, read: () => profile.current.hostMode },
        {
          fact: GateFacts.platform,
          read: () =>
            Object.entries(profile.capabilities)
              .filter(([, value]) => value === true)
              .map(([name]) => name),
        },
      ],
      ctx.scope,
    ),
  description: 'App profile + effective capabilities as gate facts.',
});
