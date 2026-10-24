import { createInjector, ok, token, unit } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  AdvisorEnvironmentToken,
  AdvisorServiceToken,
  AdvisorStorageToken,
  advisorContribution,
  advisorFor,
  advisorUnits,
  browserAdvisorEnvironment,
  createMemoryAdvisorStorage,
  defineDecisionPoint,
  type MarkovModel,
  markovAdvisorUnits,
} from './index.js';

const NextRoute = defineDecisionPoint({
  id: 'router/next-route',
  purpose: 'warmup',
  options: ['home', 'studio', 'billing'] as const,
  latency: 'sync',
  heuristic: () => 'home',
});
const NextRouteModelToken = token('test/next-route-model').type<MarkovModel>();

describe('advisor units', () => {
  it('one-line opt-in resolves a working service with contributed advisors', async () => {
    const injector = createInjector({
      units: [
        ...advisorUnits,
        advisorContribution(advisorFor(NextRoute, { id: 'fixed', tier: 'heuristic', latency: 'sync', advise: () => ok({ distribution: { billing: 1 } }) })),
      ],
    });
    const service = await injector.get(AdvisorServiceToken);
    if (!service.ok) throw service.error;
    expect(service.value.decide(NextRoute, undefined)).toMatchObject({ choice: 'billing', advisor: 'fixed' });
    await injector.dispose();
  });

  it('markov units load persisted history and answer once trained', async () => {
    const storage = createMemoryAdvisorStorage({
      'advisors/next-route': { version: 1, transitions: { home: { studio: 5, billing: 1 } }, last: 'home' },
    });
    const storageUnit = unit({ id: 'test/storage', provides: AdvisorStorageToken, scope: 'app', create: () => storage });
    const injector = createInjector({
      units: [
        ...advisorUnits,
        storageUnit,
        ...markovAdvisorUnits({
          id: 'router/next-route-markov',
          point: NextRoute,
          modelToken: NextRouteModelToken,
          storageKey: 'advisors/next-route',
          from: (q: { route: string }) => q.route,
        }),
      ],
    });
    const service = await injector.get(AdvisorServiceToken);
    if (!service.ok) throw service.error;
    expect(service.value.decide(NextRoute, { route: 'home' })).toMatchObject({ choice: 'studio', tier: 'statistical' });
    const model = await injector.get(NextRouteModelToken);
    if (!model.ok) throw model.error;
    model.value.observe('billing');
    expect(model.value.count('home')).toBe(7);
  });

  it('environment port can be replaced (platform facts adapter)', async () => {
    const remoteOnly = advisorFor(NextRoute, { id: 'remote', tier: 'remote', latency: 'sync', advise: () => ok({ distribution: { studio: 1 } }) });
    const envUnit = unit({
      id: 'test/env',
      provides: AdvisorEnvironmentToken,
      scope: 'app',
      create: () => ({ read: () => ({ lowEndDevice: false, saveData: false, allowRemote: true }) }),
    });
    const injector = createInjector({
      units: [
        ...advisorUnits,
        envUnit,
        advisorContribution(remoteOnly),
      ],
    });
    const service = await injector.get(AdvisorServiceToken);
    if (!service.ok) throw service.error;
    expect(service.value.decide(NextRoute, undefined).advisor).toBe('remote');
  });

  it('browser environment feature-detects navigator hints', () => {
    expect(browserAdvisorEnvironment(undefined).read()).toEqual({ lowEndDevice: false, saveData: false, slowNetwork: false, allowRemote: false });
    expect(
      browserAdvisorEnvironment({ deviceMemory: 1, connection: { saveData: true, effectiveType: '2g' } }).read(),
    ).toEqual({ lowEndDevice: true, saveData: true, slowNetwork: true, allowRemote: false });
    expect(browserAdvisorEnvironment({ hardwareConcurrency: 2 }).read().lowEndDevice).toBe(true);
    expect(browserAdvisorEnvironment({ hardwareConcurrency: 8, deviceMemory: 8 }).read().lowEndDevice).toBe(false);
  });
});
