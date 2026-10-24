import { type AnyToken, bind, createInjector, createTelemetry, unit } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import {
  applicableBudget,
  BudgetEvaluatorToken,
  browserPerfEnv,
  createBudgetEvaluator,
  createConformance,
  createJourneyTracker,
  createViolationCollector,
  DEFAULT_MARK_BUDGETS,
  defineMarkBudget,
  featureMarkMetrics,
  FeatureMarksToken,
  ForcedLayoutDetectorToken,
  InputLatencyTrackerToken,
  JourneyTrackerToken,
  type JourneySummary,
  LayoutShiftTrackerToken,
  LongFrameDetectorToken,
  markBudgetUnit,
  MemorySamplerToken,
  PerfDeviceTierToken,
  type PerfEnv,
  PerfEnvToken,
  perfUnits,
  RenderCounterToken,
  ViolationCollectorToken,
} from './index.js';

const summary = (start: JourneySummary['classification']['start'], marks: JourneySummary['marks']): JourneySummary => ({
  id: 'journey-1',
  route: '/studio/doc/42',
  startedAt: 0,
  endedAt: 3_000,
  duration: 3_000,
  outcome: 'complete',
  classification: { start, activation: 'fresh', code: 'network', data: 'network' },
  phases: [],
  marks,
  spans: [],
});

describe('runtime budgets (R17.12)', () => {
  it('defaults follow R12.7 cold/warm timing; specific budgets win over `*`', () => {
    expect(applicableBudget(DEFAULT_MARK_BUDGETS, 'studio', 'first-render', 'mid', 'cold')?.maxMs).toBe(1_800);
    expect(applicableBudget(DEFAULT_MARK_BUDGETS, 'studio', 'first-render', 'mid', 'soft')?.maxMs).toBe(500);
    expect(applicableBudget(DEFAULT_MARK_BUDGETS, 'studio', 'interactive', 'low', 'warm')?.maxMs).toBe(700);
    expect(applicableBudget(DEFAULT_MARK_BUDGETS, 'studio', 'complete', 'mid', 'cold')).toBeUndefined();
    const budgets = [
      ...DEFAULT_MARK_BUDGETS,
      defineMarkBudget({ feature: 'studio', mark: 'first-render', maxMs: 2_500, tiers: ['low'], reason: 'heavy editor on low-end' }),
    ];
    expect(applicableBudget(budgets, 'studio', 'first-render', 'low', 'cold')?.maxMs).toBe(2_500);
    expect(applicableBudget(budgets, 'studio', 'first-render', 'high', 'cold')?.maxMs).toBe(1_800);
    expect(applicableBudget(budgets, 'chat', 'first-render', 'low', 'cold')?.maxMs).toBe(1_800);
  });

  it('evaluates journeys and emits SF-PERF-002 violations with the method and tier', () => {
    const telemetry = createTelemetry();
    const collector = createViolationCollector();
    telemetry.addSink(collector);
    const conformance = createConformance({ telemetry });
    let tier: 'low' | 'mid' | 'high' = 'mid';
    const evaluator = createBudgetEvaluator({ budgets: DEFAULT_MARK_BUDGETS, conformance, tier: () => tier });
    const ok = evaluator.evaluate(summary('cold', { studio: { 'first-render': { value: 1_200, method: 'commit+frame' } } }));
    expect(ok).toEqual([]);
    const over = evaluator.evaluate(
      summary('warm', {
        studio: { 'first-render': { value: 900, method: 'element-timing' }, interactive: { value: 650, method: 'framework-default' } },
      }),
    );
    expect(over).toEqual([{ feature: 'studio', mark: 'first-render', valueMs: 900, budgetMs: 500, journey: 'journey-1', start: 'warm', tier: 'mid' }]);
    expect(collector.violations[0]).toMatchObject({ code: 'SF-PERF-002', feature: 'studio', details: { method: 'element-timing', tier: 'mid' } });
    tier = 'low';
    expect(createBudgetEvaluator({ budgets: [] }).evaluate(summary('cold', { a: { complete: { value: 9_999, method: 'x' } } }))).toEqual([]);
  });

  it('attaches to a journey tracker', () => {
    let t = 0;
    const telemetry = createTelemetry({ now: () => t, random: () => 0.5 });
    const collector = createViolationCollector();
    telemetry.addSink(collector);
    const tracker = createJourneyTracker({ telemetry });
    telemetry.addSink(tracker);
    const evaluator = createBudgetEvaluator({ budgets: DEFAULT_MARK_BUDGETS, conformance: createConformance({ telemetry }) });
    const off = evaluator.attach(tracker);
    tracker.begin({ start: 'soft' });
    t = 800;
    telemetry.record(featureMarkMetrics['first-render'], 800, { feature: 'settings', method: 'commit+frame', at: 800 });
    telemetry.record(featureMarkMetrics.complete, 900, { feature: 'settings', method: 'framework-default', at: 900 });
    expect(collector.violations.map((v) => v.code)).toEqual(['SF-PERF-002']);
    off();
  });
});

function quietEnv(): PerfEnv {
  return {
    now: () => 0,
    raf: () => () => undefined,
    timer: () => () => undefined,
    observer: undefined,
    supportedEntryTypes: [],
  };
}

const envUnit = unit({ id: 'test/env', provides: PerfEnvToken, scope: 'app', create: () => quietEnv() });
const tierUnit = unit({ id: 'test/tier', provides: PerfDeviceTierToken, scope: 'app', create: () => () => 'low' as const });

describe('perf units', () => {
  it('opt-in with one line: journey tracker and collector listen to telemetry; budgets contributed', async () => {
    let t = 0;
    const telemetry = createTelemetry({ now: () => t, random: () => 0.5 });
    const injector = createInjector({
      telemetry,
      units: [
        ...perfUnits,
        bind(envUnit, { precedence: 'app' }),
        bind(tierUnit, { precedence: 'app' }),
        markBudgetUnit(defineMarkBudget({ feature: 'studio', mark: 'complete', maxMs: 100 })),
      ],
    });
    const services: readonly AnyToken[] = [FeatureMarksToken, LongFrameDetectorToken, ForcedLayoutDetectorToken, LayoutShiftTrackerToken, RenderCounterToken, InputLatencyTrackerToken, MemorySamplerToken];
    for (const tokenOf of services) {
      expect((await injector.get(tokenOf)).ok).toBe(true);
    }
    const evaluator = await injector.get(BudgetEvaluatorToken);
    expect(evaluator.ok).toBe(true);
    const tracker = await injector.get(JourneyTrackerToken);
    const collector = await injector.get(ViolationCollectorToken);
    if (!tracker.ok || !collector.ok) throw new Error('units failed');
    const boot = telemetry.span('app.boot', { subsystem: 'runtime/app', level: 'critical' });
    t = 50;
    boot.end();
    t = 200;
    telemetry.record(featureMarkMetrics.complete, 200, { feature: 'studio', method: 'framework-default', at: 200 });
    expect(tracker.value.history[0]?.outcome).toBe('complete');
    expect(collector.value.violations.map((v) => [v.code, v.feature])).toEqual([['SF-PERF-002', 'studio']]);

    const shifts = await injector.get(LayoutShiftTrackerToken);
    const marks = await injector.get(FeatureMarksToken);
    if (shifts.ok && marks.ok) shifts.value.report('studio', 0.01);
    await injector.dispose();
  });

  it('browser env is feature-detected (happy-dom)', () => {
    const env = browserPerfEnv();
    expect(typeof env.now()).toBe('number');
    const cancel = env.raf(() => undefined);
    cancel();
    env.timer(() => undefined, 1)();
    expect(Array.isArray(env.supportedEntryTypes)).toBe(true);
  });
});
