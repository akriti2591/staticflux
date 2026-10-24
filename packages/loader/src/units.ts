/**
 * DI units for @staticflux/loader. Register `...loaderUnits` plus `manifestUnit(manifest)`;
 * re-bind any port with `bind(unit, { precedence: 'app' })` (the gate package binds
 * `ChunkGateToken`, platform binds facts/profile, the isolation unit binds the policy).
 */
import { contribution, err, ok, unit, type UnitDefinition } from '@staticflux/core';
import { defaultTimer, type WarmupAdvisor } from './advisor.js';
import { runBootPlan, selectBootPlan, type BootPlan } from './boot-plan.js';
import { defaultDocument, noIsolationPolicy } from './dom.js';
import { NoBootPlanError } from './errors.js';
import { allowAllChunks, createChunkLoader, defaultResourceTiming } from './loader.js';
import type { SfManifest } from './manifest.js';
import { createSpeculationEngine, defaultIntersectionObserver, type SpeculationRule } from './speculation.js';
import { dynamicImportStrategy, nativeImporter } from './strategies.js';
import {
  BootPlannerToken,
  BootPlansToken,
  ChunkGateToken,
  ChunkLoaderToken,
  ChunkManifestToken,
  type LoaderEnv,
  LoaderEnvToken,
  LoaderIsolationPolicyToken,
  LoaderProfileToken,
  LoadStrategyToken,
  RemoteStrategyToken,
  SpeculationEngineToken,
  SpeculationRulesToken,
  WarmupAdvisorsToken,
  WarmupFactsToken,
  WarmupToken,
} from './tokens.js';
import { createWarmup, defaultIdleScheduler, NOMINAL_WARMUP_FACTS } from './warmup.js';

/** Browser defaults, feature-detected. */
export function browserLoaderEnv(): LoaderEnv {
  return {
    document: defaultDocument(),
    importer: nativeImporter,
    idle: defaultIdleScheduler,
    timer: defaultTimer,
    resourceTiming: defaultResourceTiming,
    intersectionObserver: defaultIntersectionObserver(),
  };
}

/** Provide the build manifest (fetched/inlined at boot). */
export function manifestUnit(manifest: SfManifest): UnitDefinition<SfManifest, Record<never, never>, 'loader/manifest'> {
  return unit({ id: 'loader/manifest-unit', provides: ChunkManifestToken, scope: 'app', create: () => manifest });
}

export const loaderEnvUnit = unit({
  id: 'loader/env-unit',
  provides: LoaderEnvToken,
  scope: 'app',
  create: () => browserLoaderEnv(),
  description: 'Browser seams (document, import(), idle, timers, resource timing, IntersectionObserver).',
});

export const allowAllChunkGateUnit = unit({
  id: 'loader/allow-all-gate-unit',
  provides: ChunkGateToken,
  scope: 'app',
  create: () => allowAllChunks,
  description: 'Default chunk gate (allow all). The gate package binds the real decision lookup (R6.12).',
});

export const noIsolationPolicyUnit = unit({
  id: 'loader/no-isolation-policy-unit',
  provides: LoaderIsolationPolicyToken,
  scope: 'app',
  create: () => noIsolationPolicy,
  description: 'No-op isolation policy (isolation off): no `crossorigin` attribute.',
});

export const nominalWarmupFactsUnit = unit({
  id: 'loader/nominal-warmup-facts-unit',
  provides: WarmupFactsToken,
  scope: 'app',
  create: () => () => NOMINAL_WARMUP_FACTS,
  description: 'Nominal network/device facts. Bind platform facts for saveData/2g/low-tier backoff.',
});

export const noProfileUnit = unit({
  id: 'loader/no-profile-unit',
  provides: LoaderProfileToken,
  scope: 'app',
  create: () => () => undefined,
  description: 'No app profile (every chunk serves every profile). Bind platform AppProfileSource.',
});

export const dynamicImportStrategyUnit = unit({
  id: 'loader/dynamic-import-strategy-unit',
  provides: LoadStrategyToken,
  scope: 'app',
  deps: { required: { env: LoaderEnvToken } },
  create: ({ env }) => dynamicImportStrategy(env.importer),
});

export const chunkLoaderUnit = unit({
  id: 'loader/chunk-loader-unit',
  provides: ChunkLoaderToken,
  scope: 'app',
  deps: {
    required: {
      manifest: ChunkManifestToken,
      env: LoaderEnvToken,
      gate: ChunkGateToken,
      isolation: LoaderIsolationPolicyToken,
      profile: LoaderProfileToken,
      strategy: LoadStrategyToken,
      remote: RemoteStrategyToken,
    },
  },
  create: ({ manifest, env, gate, isolation, profile, strategy, remote }, ctx) => {
    const [remoteStrategy] = remote;
    return createChunkLoader({
      manifest,
      telemetry: ctx.telemetry,
      strategy,
      ...(remoteStrategy === undefined ? {} : { remoteStrategy }),
      canLoad: gate,
      isolation,
      document: env.document,
      profile: () => profile()?.key,
      resourceTiming: env.resourceTiming,
    });
  },
  description: 'Logical chunk loader: gate → profile → modulepreload deps → strategy, deduped and retried.',
});

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

export const bootPlannerUnit = unit({
  id: 'loader/boot-planner-unit',
  provides: BootPlannerToken,
  scope: 'app',
  deps: { required: { loader: ChunkLoaderToken, plans: BootPlansToken, profile: LoaderProfileToken } },
  create: ({ loader, plans, profile }, ctx) => {
    const all = plans as readonly BootPlan[];
    const current = (): ReturnType<typeof selectBootPlan<BootPlan>> => {
      const p = profile();
      if (p === undefined) {
        const fallback = all.find((plan) => plan.match === undefined);
        return fallback === undefined ? err(NoBootPlanError({ message: 'No app profile and no fallback boot plan.' })) : ok(fallback);
      }
      return selectBootPlan(all, p);
    };
    return {
      plans: all,
      current,
      async run(options = {}) {
        const plan = current();
        if (!plan.ok) return plan;
        const key = profile()?.key;
        return runBootPlan(plan.value, { ...options, loader, telemetry: options.telemetry ?? ctx.telemetry, ...(key === undefined ? {} : { profile: key }) });
      },
    };
  },
  description: 'Selects the boot plan for the current profile and runs it (R12.10).',
});

/** Contribute a speculation rule. */
export function speculationRuleUnit(
  rule: SpeculationRule,
): UnitDefinition<readonly SpeculationRule[], Record<never, never>, 'loader/speculation-rules'> {
  return contribution({ id: `loader/rule-${rule.id}` as `loader/${string}`, provides: SpeculationRulesToken, scope: 'app', create: () => rule });
}

/** Contribute a boot plan. */
export function bootPlanUnit(plan: BootPlan): UnitDefinition<readonly BootPlan[], Record<never, never>, 'loader/boot-plans'> {
  return contribution({ id: `loader/boot-plan-${plan.id}` as `loader/${string}`, provides: BootPlansToken, scope: 'app', create: () => plan });
}

/** All default loader units (everything except the manifest). */
export const loaderUnits = [
  loaderEnvUnit,
  allowAllChunkGateUnit,
  noIsolationPolicyUnit,
  nominalWarmupFactsUnit,
  noProfileUnit,
  dynamicImportStrategyUnit,
  chunkLoaderUnit,
  warmupUnit,
  speculationEngineUnit,
  bootPlannerUnit,
] as const;
