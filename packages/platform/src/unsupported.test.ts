import { createInjector, createScope, unwrap } from '@staticflux/core';
import { defineBootPlan, selectBootPlan } from '@staticflux/loader';
import { describe, expect, it } from 'vitest';
import {
  AppProfileToken,
  AsyncFactLaneToken,
  asyncFactLaneUnit,
  BaselineVerdictToken,
  baselineVerdictUnit,
  BUILT_IN_DETECTORS,
  BUILT_IN_HOST_MODES,
  type BaselineVerdict,
  createAppProfile,
  createAsyncFactLane,
  createFakePlatformEnv,
  createPlatformFacts,
  defineAsyncFact,
  detectMode,
  HostModesToken,
  platformUnits,
  UNSUPPORTED_HOST_MODE,
  unsupportedBootPlan,
  unsupportedHostMode,
  unsupportedUnits,
} from './index.js';

const unsupported: BaselineVerdict = {
  baseline: 'app',
  status: 'unsupported',
  missing: [{ id: 'api:webGpu', label: 'WebGPU', code: 'APP-PLAT-001', fix: 'Use Chrome.', reason: 'absent' }],
  pending: [],
  codes: ['APP-PLAT-001'],
};
const supported: BaselineVerdict = { baseline: 'app', status: 'supported', missing: [], pending: [], codes: [] };

/** An app's regular plans, including a form-factor-only one that must not catch unsupported profiles. */
const appPlans = [
  defineBootPlan({ id: 'fallback', critical: ['feature:shell'] }),
  defineBootPlan({ id: 'desktop', match: { formFactors: ['expanded'] }, critical: ['feature:editor'] }),
  defineBootPlan({ id: 'web-desktop', match: { hostModes: ['web'], formFactors: ['expanded', 'medium'] }, critical: ['feature:editor'] }),
];
const plans = [...appPlans, defineBootPlan(unsupportedBootPlan({ chunk: 'feature:unsupported' }))];

describe('unsupportedHostMode', () => {
  it('detects exactly when the verdict is unsupported, above every built-in', () => {
    const mode = unsupportedHostMode(unsupported);
    expect(mode).toMatchObject({ id: UNSUPPORTED_HOST_MODE, historyStrategy: 'memory', shellPreset: 'unsupported' });
    expect(mode.detect(createFakePlatformEnv())).toBe(true);
    expect(unsupportedHostMode(supported).detect(createFakePlatformEnv())).toBe(false);
    expect(Math.max(...BUILT_IN_HOST_MODES.map((m) => m.priority))).toBeLessThan(mode.priority);
    expect(mode.description).toContain('APP-PLAT-001');
    expect(Object.values(mode.capabilities).every((v) => v === false)).toBe(true);
  });

  it('the inline detector picks it before boot; otherwise detection is unchanged', () => {
    const env = createFakePlatformEnv({ width: 1400, embedded: true });
    expect(detectMode(env, { detectors: [unsupportedHostMode(unsupported), ...BUILT_IN_DETECTORS] }).hostMode).toBe('unsupported');
    expect(detectMode(env, { detectors: [unsupportedHostMode(supported), ...BUILT_IN_DETECTORS] }).hostMode).toBe('embed-iframe');
  });

  it('the app profile is unsupported:<form> with every capability off', () => {
    const env = createFakePlatformEnv({ width: 1400, globals: { indexedDB: {} } });
    const scope = createScope('test');
    const facts = createPlatformFacts({ env, scope });
    const profile = unwrap(createAppProfile({ env, facts, scope, hostModes: [...BUILT_IN_HOST_MODES, unsupportedHostMode(unsupported)] }));
    expect(profile.current.key).toBe('unsupported:expanded');
    expect(facts.capabilities.indexedDB).toBe(true);
    expect(profile.has('indexedDB')).toBe(false);
  });
});

describe('unsupported boot plan selection', () => {
  const profileFor = (verdict: BaselineVerdict, width: number): { key: string; hostMode: string; formFactor: string } => {
    const detected = detectMode(createFakePlatformEnv({ width }), { detectors: [unsupportedHostMode(verdict), ...BUILT_IN_DETECTORS] });
    return { key: `${detected.hostMode}:${detected.formFactor}`, hostMode: detected.hostMode, formFactor: detected.formFactor };
  };

  it.each([400, 700, 1400])('failed baseline → the unsupported plan at width %i (beats form-factor-only plans)', (width) => {
    const plan = unwrap(selectBootPlan(plans, profileFor(unsupported, width)));
    expect(plan.id).toBe('unsupported');
    expect(plan.critical).toEqual(['feature:unsupported']);
    expect(plan.eager).toEqual([]);
    expect(plan.preload).toEqual([]);
    expect(plan.shellPreset).toBe('unsupported');
  });

  it('passing baseline → the regular plans', () => {
    expect(unwrap(selectBootPlan(plans, profileFor(supported, 1400))).id).toBe('web-desktop');
    expect(unwrap(selectBootPlan(plans, profileFor(supported, 400))).id).toBe('fallback');
  });

  it('the plan input is loader-compatible data; chunk and form factors are optional', () => {
    expect(unsupportedBootPlan()).toMatchObject({ id: 'unsupported', critical: [], match: { hostModes: ['unsupported'], formFactors: ['compact', 'medium', 'expanded'] } });
    expect(unsupportedBootPlan({ formFactors: ['expanded'] }).match.formFactors).toEqual(['expanded']);
    expect(Object.isFrozen(unsupportedBootPlan())).toBe(true);
  });
});

describe('unsupported preset units', () => {
  it('unsupportedUnits() registers the verdict and the host mode next to platformUnits()', async () => {
    const env = createFakePlatformEnv({ width: 1300 });
    const initial = detectMode(env, { detectors: [unsupportedHostMode(unsupported), ...BUILT_IN_DETECTORS] });
    const injector = createInjector({ units: [...platformUnits({ initial }, env), ...unsupportedUnits(unsupported)] });
    expect((await injector.resolveCritical()).ok).toBe(true);
    expect(unwrap(await injector.get(AppProfileToken)).current.key).toBe('unsupported:expanded');
    expect(unwrap(await injector.get(BaselineVerdictToken))).toBe(unsupported);
    expect(unwrap(await injector.get(HostModesToken))[0]?.id).toBe('unsupported');
    await injector.dispose();
  });

  it('baselineVerdictUnit provides the verdict alone', async () => {
    const injector = createInjector({ units: [baselineVerdictUnit(supported)] });
    expect(unwrap(await injector.get(BaselineVerdictToken)).status).toBe('supported');
  });
});

describe('asyncFactLaneUnit', () => {
  it('creates a lane in the unit scope and starts declared facts without blocking', async () => {
    const fact = defineAsyncFact({ id: 'test/unit-fact', probe: async () => 'ready' });
    const env = createFakePlatformEnv();
    const injector = createInjector({ units: [...platformUnits({}, env), asyncFactLaneUnit({ facts: [fact] })] });
    const lane = unwrap(await injector.get(AsyncFactLaneToken));
    expect(lane.facts).toEqual([fact]);
    await expect.poll(() => lane.read(fact).state).toBe('settled');
    await injector.dispose();
    expect(lane.read(fact).state).toBe('disposed');
  });

  it('reuses a pre-boot lane and can skip start()', async () => {
    const fact = defineAsyncFact({ id: 'test/unit-reuse', probe: async () => 1 });
    const env = createFakePlatformEnv();
    const preBoot = createAsyncFactLane({ env, scope: createScope('pre-boot'), facts: [fact], schedule: () => {} });
    const injector = createInjector({ units: [...platformUnits({}, env), asyncFactLaneUnit({ lane: preBoot, start: false })] });
    expect(unwrap(await injector.get(AsyncFactLaneToken))).toBe(preBoot);
    expect(preBoot.read(fact).state).toBe('idle');
  });
});
