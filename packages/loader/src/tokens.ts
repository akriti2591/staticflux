/**
 * DI tokens of @staticflux/loader. Ports (gate, isolation policy, facts, profile, env)
 * have default units in `units.ts`; apps/other packages re-bind them
 * (`bind(unit, { precedence: 'app' })`) — e.g. the gate package binds `ChunkGateToken`.
 */
import { token } from '@staticflux/core';
import type { WarmupAdvisor, TimerFn } from './advisor.js';
import type { BootPlan, BootPlanRun, ProfileLike, RunBootPlanOptions } from './boot-plan.js';
import type { LoaderDocument, LoaderIsolationPolicy } from './dom.js';
import type { ChunkGate, ChunkLoader, ResourceTimingLike } from './loader.js';
import type { SfManifest } from './manifest.js';
import type { IntersectionObserverFactory, SpeculationEngine, SpeculationRule } from './speculation.js';
import type { Importer, LoadStrategy } from './strategies.js';
import type { IdleScheduler, Warmup, WarmupFacts } from './warmup.js';
import type { Result } from '@staticflux/core';

/** Browser seams of the loader (all injectable for tests and workers). */
export interface LoaderEnv {
  readonly document: LoaderDocument | undefined;
  readonly importer: Importer;
  readonly idle: IdleScheduler;
  readonly timer: TimerFn;
  readonly resourceTiming: (url: string) => ResourceTimingLike | undefined;
  readonly intersectionObserver: IntersectionObserverFactory | undefined;
}

export interface BootPlanner {
  readonly plans: readonly BootPlan[];
  /** Plan for the current profile (R12.10). */
  current(): Result<BootPlan>;
  run(options?: Omit<RunBootPlanOptions, 'loader' | 'profile'>): Promise<Result<BootPlanRun>>;
}

/** The build manifest (`sf-manifest.json`). Provide with `manifestUnit(manifest)`. */
export const ChunkManifestToken = /* @__PURE__ */ token('loader/manifest').type<SfManifest>();
export const LoaderEnvToken = /* @__PURE__ */ token('loader/env').type<LoaderEnv>();
/** Gating hook consulted before any fetch (I-8). The gate package binds it. */
export const ChunkGateToken = /* @__PURE__ */ token('loader/chunk-gate').type<ChunkGate>();
/** `crossorigin` policy for injected tags (R11.16b). */
export const LoaderIsolationPolicyToken = /* @__PURE__ */ token('loader/isolation-policy').type<LoaderIsolationPolicy>();
/** Network/device facts reader (bind from platform facts). */
export const WarmupFactsToken = /* @__PURE__ */ token('loader/warmup-facts').type<() => WarmupFacts>();
/** Current app profile reader (bind from platform `AppProfileSource.current`). */
export const LoaderProfileToken = /* @__PURE__ */ token('loader/profile').type<() => ProfileLike | undefined>();
/** Strategy for local chunks (default dynamic import). */
export const LoadStrategyToken = /* @__PURE__ */ token('loader/load-strategy').type<LoadStrategy>();
/** Optional strategy for federated (`remote`) chunks; the first contribution is used. */
export const RemoteStrategyToken = /* @__PURE__ */ token('loader/remote-strategy').multi<LoadStrategy>();
/** Optional warmup advisors (R19.5); the first contribution is used. */
export const WarmupAdvisorsToken = /* @__PURE__ */ token('loader/warmup-advisors').multi<WarmupAdvisor>();
export const SpeculationRulesToken = /* @__PURE__ */ token('loader/speculation-rules').multi<SpeculationRule>();
export const BootPlansToken = /* @__PURE__ */ token('loader/boot-plans').multi<BootPlan>();

export const ChunkLoaderToken = /* @__PURE__ */ token('loader/chunk-loader').type<ChunkLoader>();
export const WarmupToken = /* @__PURE__ */ token('loader/warmup').type<Warmup>();
export const SpeculationEngineToken = /* @__PURE__ */ token('loader/speculation-engine').type<SpeculationEngine>();
export const BootPlannerToken = /* @__PURE__ */ token('loader/boot-planner').type<BootPlanner>();
