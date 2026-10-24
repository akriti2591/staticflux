/**
 * DI units for @staticflux/loader. Register `...loaderUnits` plus `manifestUnit(manifest)`;
 * re-bind any port with `bind(unit, { precedence: 'app' })` (the gate package binds
 * `ChunkGateToken`, platform binds facts/profile, the isolation unit binds the policy).
 * Warmup + speculation units are in `warmup-units.ts` (post-boot; not bundled with the loader).
 */
import { contribution, err, ok, unit, type UnitDefinition } from '@staticflux/core';
import { defaultIdleScheduler, defaultIntersectionObserver, defaultTimer, NOMINAL_WARMUP_FACTS } from './defaults.js';
import { runBootPlan, selectBootPlan, type BootPlan } from './boot-plan.js';
import { defaultDocument, noIsolationPolicy } from './dom.js';
import { NoBootPlanError } from './errors.js';
import { allowAllChunks, createChunkLoader, defaultResourceTiming } from './loader.js';
import type { SfManifest } from './manifest.js';
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
  WarmupFactsToken,
} from './tokens.js';
import { speculationEngineUnit, warmupUnit } from './warmup-units.js';

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
/* @__NO_SIDE_EFFECTS__ */
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

/** Contribute a boot plan. */
/* @__NO_SIDE_EFFECTS__ */
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
