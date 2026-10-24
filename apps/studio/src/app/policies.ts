/**
 * Gate policies (R6.8–R6.18) — data, compiled to decision tables by the gate.
 * Client gating is UX, not security (R6.16): the mock backend re-checks plan and
 * credits on every request it serves.
 */
import { all, because, definePolicy, definePolicySet, fact, flagFact, GateFacts, type PolicySet } from '@staticflux/gate';
import { AiSuggestionsFlag, CreditsMeter } from './contracts.js';

/** Route/feature/slot resource ids (typed values; plugins read them from `requires.gate`). */
export const GateIds = {
  studioRoute: 'route:/studio',
  studioFeature: 'feature:studio',
  aiPanelSlot: 'studio/ai-panel',
  expertWorkspace: 'workspace:studio/expert',
} as const;

export const AiSuggestionsFact = flagFact<boolean>(AiSuggestionsFlag.key);

export const studioPolicies: PolicySet = definePolicySet('studio/policies', [
  definePolicy({
    id: 'studio/route-requires-login',
    resource: { level: 'route', ids: [GateIds.studioRoute] },
    when: fact(GateFacts.authenticated).truthy(),
    deny: { reason: 'login' },
    description: '/studio/* needs a signed-in user.',
  }),
  definePolicy({
    id: 'studio/feature-requires-login',
    resource: { level: 'feature', ids: [GateIds.studioFeature] },
    when: fact(GateFacts.authenticated).truthy(),
    deny: { reason: 'login' },
  }),
  // Pro capability: summarize (upgrade upsell for free users).
  definePolicy({
    id: 'studio/summarize-pro',
    resource: { level: 'capability', ids: ['studio/summarize'] },
    when: fact(GateFacts.plan).eq('pro'),
    deny: { reason: 'upgrade', meta: { plan: 'pro' } },
  }),
  // insert-image: pro plan for free, or pay credits.
  definePolicy({
    id: 'studio/insert-image-pro',
    resource: { level: 'capability', ids: ['agent/insert-image'] },
    when: because(fact(GateFacts.plan).eq('pro'), 'upgrade', { plan: 'pro' }),
  }),
  definePolicy({
    id: 'studio/insert-image-credits',
    resource: { level: 'capability', ids: ['agent/insert-image'] },
    when: fact(GateFacts.authenticated).truthy(),
    cost: { meter: CreditsMeter, amount: 2 },
  }),
  // Agents act for the user with narrower delegation (R6.17): they always pay credits.
  definePolicy({
    id: 'studio/agent-insert-image',
    subjects: ['agent'],
    resource: { level: 'capability', ids: ['agent/insert-image'] },
    when: fact(GateFacts.authenticated).truthy(),
    cost: { meter: CreditsMeter, amount: 2 },
  }),
  definePolicy({
    id: 'studio/agent-insert-text',
    subjects: ['agent'],
    resource: { level: 'capability', ids: ['studio/insert-text'] },
    when: fact(GateFacts.authenticated).truthy(),
  }),
  definePolicy({
    id: 'studio/agent-clear',
    subjects: ['agent'],
    resource: { level: 'capability', ids: ['studio/clear-document'] },
    when: fact(GateFacts.authenticated).truthy(),
  }),
  definePolicy({
    id: 'studio/ai-panel-slot',
    resource: { level: 'ui-slot', ids: [GateIds.aiPanelSlot] },
    when: all(because(fact(AiSuggestionsFact).truthy(), 'unavailable'), because(fact(GateFacts.entitlements).has('ai'), 'upgrade')),
  }),
  definePolicy({
    id: 'studio/expert-workspace',
    resource: { level: 'workspace', ids: [GateIds.expertWorkspace] },
    when: fact(GateFacts.authenticated).truthy(),
    deny: { reason: 'login' },
  }),
]);
