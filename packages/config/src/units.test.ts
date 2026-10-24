import { createInjector, token, unit, unwrap, variant } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  configUnits,
  createFlagBinder,
  createFlagResolver,
  createStaticLayer,
  defineFlag,
  EvaluationContextToken,
  evaluationContextUnit,
  FlagBinderToken,
  flagDefinitionUnits,
  FlagHooksToken,
  FlagResolverToken,
  flagResolverUnit,
  hookUnit,
  layerUnit,
  flagType,
  staticContext,
  type FlagHook,
} from './index.js';

const OnboardingVariant = defineFlag({
  key: 'onboarding/variant',
  type: flagType.enum(['A', 'B']),
  default: 'A',
  owner: 'team-onboarding',
  preAuthSafe: true,
  description: 'Onboarding flow experiment.',
});
const AiSuggestions = defineFlag({
  key: 'studio/ai-suggestions',
  type: flagType.boolean(),
  default: false,
  owner: 'team-studio',
  preAuthSafe: false,
  description: 'Inline AI suggestions.',
});

interface OnboardingFlow {
  readonly name: string;
}
const OnboardingFlowToken = token('onboarding/flow').type<OnboardingFlow>();
const flowA = unit({ id: 'onboarding/flow-a', provides: OnboardingFlowToken, scope: 'app', create: () => ({ name: 'A' }) });
const flowB = unit({ id: 'onboarding/flow-b', provides: OnboardingFlowToken, scope: 'app', create: () => ({ name: 'B' }) });

interface Suggester {
  readonly enabled: boolean;
}
const SuggesterToken = token('studio/suggester').type<Suggester>();
const noSuggest = unit({ id: 'studio/no-suggester', provides: SuggesterToken, scope: 'app', create: () => ({ enabled: false }) });
const aiSuggest = unit({ id: 'studio/ai-suggester', provides: SuggesterToken, scope: 'app', create: () => ({ enabled: true }) });

describe('experiment variant bindings (R8.4, P4)', () => {
  it('feature code injects the token; the binding layer picks the variant', async () => {
    const binder = createFlagBinder();
    const experiment = createStaticLayer({ id: 'exp/onboarding', layer: 'experiment', identityBound: false, values: { 'onboarding/variant': 'B' } });
    const injector = createInjector({
      units: [
        ...configUnits({ binder, layers: [experiment], flags: [OnboardingVariant] }),
        flowA,
        ...binder.variants({ flag: OnboardingVariant, of: OnboardingFlowToken, variants: { B: flowB } }),
      ],
    });
    expect((await injector.resolveCritical()).ok).toBe(true);
    expect(binder.attached).toBe(true);
    expect(unwrap(await injector.get(OnboardingFlowToken)).name).toBe('B');
    expect(unwrap(await injector.get(FlagBinderToken))).toBe(binder);
    // Variant is fixed for the scope: a later flag change applies in a new scope.
    experiment.set(OnboardingVariant, 'A');
    expect(unwrap(await injector.get(OnboardingFlowToken)).name).toBe('B');
    const child = injector.child('session', 'next-session');
    expect(unwrap(await child.get(OnboardingFlowToken)).name).toBe('B'); // app-scoped unit lives in app injector
    await injector.dispose();
    expect(binder.attached).toBe(false);
  });

  it('boolean flags bind with true/false keys; default binding remains when unmatched', async () => {
    const binder = createFlagBinder();
    const local = createStaticLayer({ id: 'dev/local', layer: 'local', values: { 'studio/ai-suggestions': true } });
    const injector = createInjector({
      units: [
        ...configUnits({ binder, layers: [local], context: staticContext({}, true) }),
        noSuggest,
        ...binder.variants({ flag: AiSuggestions, of: SuggesterToken, variants: { true: aiSuggest } }),
      ],
    });
    await injector.resolveCritical();
    expect(unwrap(await injector.get(SuggesterToken)).enabled).toBe(true);

    const binder2 = createFlagBinder();
    const off = createInjector({
      units: [...configUnits({ binder: binder2 }), noSuggest, ...binder2.variants({ flag: AiSuggestions, of: SuggesterToken, variants: { true: aiSuggest } })],
    });
    await off.resolveCritical();
    expect(unwrap(await off.get(SuggesterToken)).enabled).toBe(false);
  });

  it('is() composes with core variant(); unattached reads use the default and report SF-CFG-005', () => {
    const onUnattached = vi.fn();
    const binder = createFlagBinder({ onUnattached });
    const when = binder.is(OnboardingVariant, 'A');
    expect(when()).toBe(true);
    expect(onUnattached).toHaveBeenCalledWith(expect.objectContaining({ code: 'SF-CFG-005' }));
    const binding = variant({ of: OnboardingFlowToken, unit: flowB, when: binder.is(OnboardingVariant, 'B') });
    expect(binding.when?.()).toBe(false);
    const resolver = createFlagResolver({ providers: [createStaticLayer({ id: 'a', layer: 'app', values: { 'onboarding/variant': 'B' } })] });
    const detach = binder.attach(resolver);
    expect(binding.when?.()).toBe(true);
    const other = createFlagResolver();
    const detachOther = binder.attach(other);
    detach(); // stale detach is ignored
    expect(binder.attached).toBe(true);
    detachOther();
    expect(binder.attached).toBe(false);
    expect(binder.variants({ flag: OnboardingVariant, of: OnboardingFlowToken, variants: {}, source: 'x' })).toEqual([]);
    const labelled = binder.variants({ flag: OnboardingVariant, of: OnboardingFlowToken, variants: { B: flowB } });
    expect(labelled[0]?.source).toBe('flag:onboarding/variant=B');
  });

  it('rejects variant units that provide a different token (compile time)', () => {
    const binder = createFlagBinder();
    binder.variants({
      flag: OnboardingVariant,
      of: OnboardingFlowToken,
      // @ts-expect-error aiSuggest provides studio/suggester, not onboarding/flow
      variants: { B: aiSuggest },
    });
    expect(true).toBe(true);
  });
});

describe('config DI units', () => {
  it('resolver unit wires layers, definitions, hooks and context; initializes providers in init', async () => {
    const hook: FlagHook = { after: vi.fn() };
    const initialize = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const remote = { ...createStaticLayer({ id: 'remote/x', layer: 'remote', values: { 'studio/ai-suggestions': true } }), initialize };
    const injector = createInjector({
      units: [
        flagResolverUnit({ initTimeoutMs: 500, domain: 'studio' }),
        evaluationContextUnit(staticContext({ targetingKey: 'u1' }, true)),
        layerUnit(remote),
        ...flagDefinitionUnits([AiSuggestions, OnboardingVariant]),
        hookUnit('test/hook', hook),
      ],
    });
    const resolver = unwrap(await injector.get(FlagResolverToken));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(resolver.ready).toBe(true);
    expect(resolver.value(AiSuggestions)).toBe(true);
    expect(resolver.flags().map((f) => f.key)).toEqual(['studio/ai-suggestions', 'onboarding/variant']);
    expect(hook.after).toHaveBeenCalled();
    expect(unwrap(await injector.get(FlagHooksToken))).toEqual([hook]);
    expect(unwrap(await injector.get(EvaluationContextToken)).authenticated).toBe(true);
    await injector.dispose();
    expect(resolver.providers()[0]?.status).toBe('disposed');
  });

  it("configUnits({ context: 'app-provided' }) expects the app's context unit", async () => {
    const appContext = unit({
      id: 'app/flag-context',
      provides: EvaluationContextToken,
      scope: 'app',
      create: () => staticContext({ targetingKey: 'from-session' }, true),
    });
    const injector = createInjector({ units: [...configUnits({ context: 'app-provided', domain: 'd', initTimeoutMs: 10 }), appContext] });
    const resolver = unwrap(await injector.get(FlagResolverToken));
    expect(resolver.value(AiSuggestions)).toBe(false);
    const missing = createInjector({ units: [...configUnits({ context: 'app-provided' })] });
    expect((await missing.get(FlagResolverToken)).ok).toBe(false);
  });
});
