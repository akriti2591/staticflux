/**
 * DI tokens and units for @staticflux/ai.
 *
 *   createInjector({ units: [...aiUnits, modelProviderContribution(remoteUnit…)] })
 *
 * `ModelProviderToken` is the router over every contributed provider
 * (`ModelProvidersToken`, ordered). Consumers: the model advisor tier
 * (`createModelAdvisor({ model: provider })`), i18n translator fallback,
 * features (gate on `provider.facts`). Availability is probed in the
 * background after the router is ready — never on the boot path.
 */
import { contribution, ok, token, unit } from '@staticflux/core';
import { createBrowserAiProvider } from './browser.js';
import { createMockProvider, type MockProviderOptions } from './mock.js';
import { AiMetrics, type ModelProvider } from './provider.js';
import { createModelRouter } from './router.js';

export const ModelProvidersToken = token('ai/model-providers').multi<ModelProvider>();
export const ModelProviderToken = token('ai/model-provider').type<ModelProvider>();

export const browserAiProviderUnit = contribution({
  id: 'ai/browser-built-in-provider',
  provides: ModelProvidersToken,
  scope: 'app',
  order: 0,
  informs: Object.values(AiMetrics),
  create: (_deps, ctx) => {
    const provider = createBrowserAiProvider({ telemetry: ctx.telemetry });
    ctx.scope.defer(() => provider.dispose());
    return provider;
  },
  description: 'Chrome built-in AI (feature-detected; unavailable elsewhere).',
});

export const modelRouterUnit = unit({
  id: 'ai/model-router-unit',
  provides: ModelProviderToken,
  scope: 'app',
  deps: { required: { providers: ModelProvidersToken } },
  create: ({ providers }) => createModelRouter({ providers }),
  // Background probe: availability facts fill in later; readiness never waits on AI.
  init: (router, ctx) => {
    void router.probe(ctx.signal);
    return ok();
  },
  description: 'Routes AI tasks to the first capable provider; merged reactive availability facts.',
});

/** One-line opt-in: browser built-in provider + router. */
export const aiUnits = [browserAiProviderUnit, modelRouterUnit] as const;

/** Contribute a provider instance (created by `create`), disposed with the app scope. */
export function modelProviderContribution(id: `${string}/${string}`, create: () => ModelProvider, order = 100) {
  return contribution({
    id,
    provides: ModelProvidersToken,
    scope: 'app',
    order,
    create: (_deps, ctx) => {
      const provider = create();
      ctx.scope.defer(() => provider.dispose());
      return provider;
    },
  });
}

/** Mock provider unit (tests, example app). */
export function mockModelProviderUnit(options: MockProviderOptions = {}, order = 50) {
  return modelProviderContribution('ai/mock-provider', () => createMockProvider(options), order);
}
