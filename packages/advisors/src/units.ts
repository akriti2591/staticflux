/**
 * DI tokens and units for @staticflux/advisors.
 *
 *   createInjector({ units: [...advisorUnits, ...markovAdvisorUnits({ … }), advisorContribution(myAdvisor)] })
 *
 * Bind `AdvisorEnvironmentToken` to an adapter over platform facts (device tier,
 * save-data, battery, network, remote opt-in) and `AdvisorStorageToken` to a
 * user-data slice adapter. Defaults: browser feature detection and memory.
 */
import { contribution, ok, type Token, type TokenId, token, unit } from '@staticflux/core';
import type { Advisor } from './advisor.js';
import type { DecisionPoint, DecisionPointId } from './decision.js';
import { AdvisorMetrics, type AdvisorEnvironment, type AdvisorService, createAdvisorService } from './service.js';
import { type AdvisorStoragePort, createMarkovAdvisor, createMarkovModel, createMemoryAdvisorStorage, type MarkovModel } from './statistical.js';

export interface AdvisorEnvironmentPort {
  /** Read current facts; reactive sources are fine (read on every decision). */
  read(): AdvisorEnvironment;
}

export const AdvisorsToken = /* @__PURE__ */ token('advisors/advisors').multi<Advisor>();
export const AdvisorEnvironmentToken = /* @__PURE__ */ token('advisors/environment').type<AdvisorEnvironmentPort>();
export const AdvisorStorageToken = /* @__PURE__ */ token('advisors/storage').type<AdvisorStoragePort>();
export const AdvisorServiceToken = /* @__PURE__ */ token('advisors/service').type<AdvisorService>();

interface NavigatorHints {
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
  readonly connection?: { readonly saveData?: boolean; readonly effectiveType?: string };
}

/**
 * Feature-detected environment (Chromium exposes deviceMemory/connection; Safari
 * and Firefox do not — missing hints mean "not downgraded"). Remote stays off.
 */
export function browserAdvisorEnvironment(nav: NavigatorHints | undefined = globalThis.navigator as NavigatorHints | undefined): AdvisorEnvironmentPort {
  return {
    read() {
      const memory = nav?.deviceMemory;
      const cores = nav?.hardwareConcurrency;
      const effectiveType = nav?.connection?.effectiveType;
      return {
        lowEndDevice: (typeof memory === 'number' && memory <= 2) || (typeof cores === 'number' && cores <= 2),
        saveData: nav?.connection?.saveData === true,
        slowNetwork: effectiveType === 'slow-2g' || effectiveType === '2g',
        allowRemote: false,
      };
    },
  };
}

export const browserAdvisorEnvironmentUnit = unit({
  id: 'advisors/browser-environment-unit',
  provides: AdvisorEnvironmentToken,
  scope: 'app',
  create: () => browserAdvisorEnvironment(),
  description: 'Default environment from navigator hints. Replace with a platform-facts adapter.',
});

export const memoryAdvisorStorageUnit = unit({
  id: 'advisors/memory-storage-unit',
  provides: AdvisorStorageToken,
  scope: 'app',
  create: () => createMemoryAdvisorStorage(),
  description: 'Default: history lives in memory only. Replace with a user-data slice adapter.',
});

export const advisorServiceUnit = unit({
  id: 'advisors/service-unit',
  provides: AdvisorServiceToken,
  scope: 'app',
  deps: { required: { advisors: AdvisorsToken, environment: AdvisorEnvironmentToken } },
  informs: Object.values(AdvisorMetrics),
  create: ({ advisors, environment }, ctx) => {
    const service = createAdvisorService({ advisors, environment: () => environment.read(), telemetry: ctx.telemetry });
    ctx.scope.defer(() => service.dispose());
    return service;
  },
  description: 'Decision points consult advisors here (time-boxed, clamped, cached, traced). Never for authorization.',
});

/** One-line opt-in. */
export const advisorUnits = [browserAdvisorEnvironmentUnit, memoryAdvisorStorageUnit, advisorServiceUnit] as const;

/** Contribute an advisor plugin. */
export function advisorContribution(advisor: Advisor, order?: number) {
  return contribution({
    id: `advisors/${advisor.id}`,
    provides: AdvisorsToken,
    scope: 'app',
    ...(order === undefined ? {} : { order }),
    create: () => advisor,
  });
}

export interface MarkovAdvisorUnitsConfig<Q, O extends string, Id extends DecisionPointId, M extends TokenId> {
  /** Advisor id (also the unit id prefix). */
  readonly id: `${string}/${string}`;
  readonly point: DecisionPoint<Q, O, Id>;
  /** Token under which the model is provided (feed it with `model.observe(state)`, e.g. on route commit). */
  readonly modelToken: Token<MarkovModel, M>;
  readonly storageKey: string;
  readonly from: (question: Q) => string;
  readonly minObservations?: number;
  readonly maxStates?: number;
}

/** A persisted Markov model unit + the statistical advisor contribution using it. */
/* @__NO_SIDE_EFFECTS__ */
export function markovAdvisorUnits<Q, O extends string, Id extends DecisionPointId, M extends TokenId>(
  config: MarkovAdvisorUnitsConfig<Q, O, Id, M>,
) {
  const modelUnit = unit({
    id: `${config.id}-model`,
    provides: config.modelToken,
    scope: 'app',
    deps: { required: { storage: AdvisorStorageToken } },
    create: ({ storage }) =>
      createMarkovModel({ storage, key: config.storageKey, ...(config.maxStates === undefined ? {} : { maxStates: config.maxStates }) }),
    // History is a hint: a failed load leaves an empty model and is not a unit failure.
    init: async (model, ctx) => {
      await model.load(ctx.signal);
      return ok();
    },
  });
  const advisorUnit = contribution({
    id: `${config.id}-advisor`,
    provides: AdvisorsToken,
    scope: 'app',
    deps: { required: { model: config.modelToken } },
    create: (deps) =>
      createMarkovAdvisor(config.point, {
        id: config.id,
        model: (deps as unknown as { readonly model: MarkovModel }).model,
        from: config.from,
        ...(config.minObservations === undefined ? {} : { minObservations: config.minObservations }),
      }),
  });
  return [modelUnit, advisorUnit] as const;
}
