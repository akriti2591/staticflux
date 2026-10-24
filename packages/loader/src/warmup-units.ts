/**
 * Warmup (likely tier) and speculation (speculative tier) units. Separate from `units.ts`:
 * both engines run after core-ready, so apps register them from a post-boot chunk.
 */
import { contribution, unit, type UnitDefinition } from '@staticflux/core';
import type { WarmupAdvisor } from './advisor.js';
import { createSpeculationEngine, type SpeculationRule } from './speculation.js';
import { ChunkLoaderToken, LoaderEnvToken, SpeculationEngineToken, SpeculationRulesToken, WarmupAdvisorsToken, WarmupFactsToken, WarmupToken } from './tokens.js';
import { createWarmup } from './warmup.js';

export const warmupUnit = unit({
  id: 'loader/warmup-unit',
  provides: WarmupToken,
  scope: 'app',
  deps: { required: { loader: ChunkLoaderToken, env: LoaderEnvToken, facts: WarmupFactsToken, advisors: WarmupAdvisorsToken } },
  create: ({ loader, env, facts, advisors }, ctx) => {
    const [advisor] = advisors as readonly WarmupAdvisor[];
    const warmup = createWarmup({
      loader,
      idle: env.idle,
      facts,
      timer: env.timer,
      telemetry: ctx.telemetry,
      ...(advisor === undefined ? {} : { advisor }),
    });
    ctx.scope.defer(() => warmup.dispose());
    return warmup;
  },
  description: 'Likely tier: idle-time background loading, advisor-ranked, network/device aware.',
});

export const speculationEngineUnit = unit({
  id: 'loader/speculation-engine-unit',
  provides: SpeculationEngineToken,
  scope: 'app',
  deps: {
    required: { loader: ChunkLoaderToken, env: LoaderEnvToken, facts: WarmupFactsToken, rules: SpeculationRulesToken, advisors: WarmupAdvisorsToken },
  },
  create: ({ loader, env, facts, rules, advisors }, ctx) => {
    const [advisor] = advisors as readonly WarmupAdvisor[];
    const engine = createSpeculationEngine({
      loader,
      rules: rules as readonly SpeculationRule[],
      facts,
      timer: env.timer,
      telemetry: ctx.telemetry,
      intersectionObserver: env.intersectionObserver,
      ...(advisor === undefined ? {} : { advisor }),
    });
    ctx.scope.defer(() => engine.dispose());
    return engine;
  },
  description: 'Speculative tier: declarative intent rules with eagerness levels.',
});

/** Contribute a speculation rule. */
/* @__NO_SIDE_EFFECTS__ */
export function speculationRuleUnit(
  rule: SpeculationRule,
): UnitDefinition<readonly SpeculationRule[], Record<never, never>, 'loader/speculation-rules'> {
  return contribution({ id: `loader/rule-${rule.id}` as `loader/${string}`, provides: SpeculationRulesToken, scope: 'app', create: () => rule });
}
