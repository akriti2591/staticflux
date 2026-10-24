/**
 * Adapter: @staticflux/config → @staticflux/gate. Flag values become gate facts
 * (`flag:<key>`), so policies like "ui-slot:studio/ai-panel requires flag +
 * entitlement" stay declarative and feature code never reads flags (R8.4).
 */
import { contribution } from '@staticflux/core';
import { FlagResolverToken } from '@staticflux/config';
import { FactSourcesToken, reactiveFactSource } from '@staticflux/gate';
import { AiSuggestionsFlag } from '../app/contracts.js';
import { AiSuggestionsFact } from '../app/policies.js';

export const flagFactsUnit = contribution({
  id: 'studio/flag-facts-unit',
  provides: FactSourcesToken,
  scope: 'app',
  deps: { required: { flags: FlagResolverToken } },
  create: ({ flags }, ctx) =>
    reactiveFactSource('studio/flag-facts', [{ fact: AiSuggestionsFact, read: () => flags.value(AiSuggestionsFlag) }], ctx.scope),
  description: 'Feature flags as gate facts.',
});
