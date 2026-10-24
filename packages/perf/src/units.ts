/**
 * DI units for @staticflux/perf. Opting in is one line: register `...perfUnits`
 * (R17.19: framework spans feed the journey tracker automatically). Re-bind ports
 * (`PerfEnvToken`, `ScriptAttributionToken`, `PerfDeviceTierToken`) as needed and
 * contribute budgets with `markBudgetUnit(...)`.
 */
import { contribution, unit, type UnitDefinition } from '@staticflux/core';
import { createBudgetEvaluator, DEFAULT_MARK_BUDGETS, type MarkBudget } from './budgets.js';
import { createConformance, createViolationCollector } from './conformance.js';
import {
  createForcedLayoutDetector,
  createInputLatencyTracker,
  createLayoutShiftTracker,
  createLongFrameDetector,
  createMemorySampler,
  createRenderCounter,
} from './detectors.js';
import { browserPerfEnv } from './env.js';
import { createJourneyTracker } from './journey.js';
import { createFeatureMarks } from './marks.js';
import {
  BudgetEvaluatorToken,
  ConformanceToken,
  FeatureMarksToken,
  ForcedLayoutDetectorToken,
  InputLatencyTrackerToken,
  JourneyTrackerToken,
  LayoutShiftTrackerToken,
  LongFrameDetectorToken,
  MarkBudgetsToken,
  MemorySamplerToken,
  PerfDeviceTierToken,
  PerfEnvToken,
  RenderCounterToken,
  ScriptAttributionToken,
  ViolationCollectorToken,
} from './tokens.js';

export const perfEnvUnit = unit({
  id: 'perf/env-unit',
  provides: PerfEnvToken,
  scope: 'app',
  create: () => browserPerfEnv(),
  description: 'Browser clock, rAF, timers and PerformanceObserver (feature-detected entry types).',
});

export const noScriptAttributionUnit = unit({
  id: 'perf/no-script-attribution-unit',
  provides: ScriptAttributionToken,
  scope: 'app',
  create: () => () => undefined,
  description: 'Default: no URL → chunk attribution. Bind the loader `chunkAttributor(manifest)`.',
});

export const midTierUnit = unit({
  id: 'perf/mid-tier-unit',
  provides: PerfDeviceTierToken,
  scope: 'app',
  create: () => () => 'mid' as const,
  description: 'Default device tier for budgets. Bind platform `device.tier`.',
});

export const conformanceUnit = unit({
  id: 'perf/conformance-unit',
  provides: ConformanceToken,
  scope: 'app',
  create: (_deps, ctx) => createConformance({ telemetry: ctx.telemetry }),
  description: 'Conformance stream: typed `violation` events (R17.22).',
});

export const violationCollectorUnit = unit({
  id: 'perf/violation-collector-unit',
  provides: ViolationCollectorToken,
  scope: 'app',
  create: (_deps, ctx) => {
    const collector = createViolationCollector();
    ctx.scope.defer(ctx.telemetry.addSink(collector));
    return collector;
  },
  description: 'Collects violations from every subsystem for devtools and CI baselines.',
});

export const journeyTrackerUnit = unit({
  id: 'perf/journey-tracker-unit',
  provides: JourneyTrackerToken,
  scope: 'app',
  create: (_deps, ctx) => {
    const tracker = createJourneyTracker({ telemetry: ctx.telemetry });
    ctx.scope.defer(ctx.telemetry.addSink(tracker));
    return tracker;
  },
  description: 'One journey per navigation from telemetry spans (R17.5).',
});

export const layoutShiftTrackerUnit = unit({
  id: 'perf/layout-shift-tracker-unit',
  provides: LayoutShiftTrackerToken,
  scope: 'app',
  deps: { required: { env: PerfEnvToken, conformance: ConformanceToken } },
  create: ({ env, conformance }, ctx) => {
    const tracker = createLayoutShiftTracker({ env, conformance, telemetry: ctx.telemetry });
    ctx.scope.defer(() => tracker.dispose());
    return tracker;
  },
});

export const featureMarksUnit = unit({
  id: 'perf/feature-marks-unit',
  provides: FeatureMarksToken,
  scope: 'app',
  deps: { required: { env: PerfEnvToken, shifts: LayoutShiftTrackerToken } },
  create: ({ env, shifts }, ctx) => {
    const marks = createFeatureMarks({ env, telemetry: ctx.telemetry });
    ctx.scope.defer(shifts.onShift((feature) => marks.layoutShift(feature)));
    ctx.scope.defer(() => marks.dispose());
    return marks;
  },
  description: 'Feature marks (placeholderShown … complete), labelled with their method (R17.10).',
});

export const longFrameDetectorUnit = unit({
  id: 'perf/long-frame-detector-unit',
  provides: LongFrameDetectorToken,
  scope: 'app',
  deps: { required: { env: PerfEnvToken, attribute: ScriptAttributionToken, conformance: ConformanceToken } },
  create: ({ env, attribute, conformance }, ctx) => {
    const detector = createLongFrameDetector({ env, attribute, conformance, telemetry: ctx.telemetry });
    ctx.scope.defer(() => detector.dispose());
    return detector;
  },
});

export const forcedLayoutDetectorUnit = unit({
  id: 'perf/forced-layout-detector-unit',
  provides: ForcedLayoutDetectorToken,
  scope: 'app',
  deps: { required: { env: PerfEnvToken, conformance: ConformanceToken } },
  create: ({ env, conformance }, ctx) => createForcedLayoutDetector({ env, conformance, telemetry: ctx.telemetry }),
  description: 'Dev: forced synchronous layout detector (measured reads + optional DOM instrumentation).',
});

export const renderCounterUnit = unit({
  id: 'perf/render-counter-unit',
  provides: RenderCounterToken,
  scope: 'app',
  deps: { required: { env: PerfEnvToken, conformance: ConformanceToken } },
  create: ({ env, conformance }, ctx) => createRenderCounter({ now: () => env.now(), conformance, telemetry: ctx.telemetry }),
});

export const inputLatencyTrackerUnit = unit({
  id: 'perf/input-latency-tracker-unit',
  provides: InputLatencyTrackerToken,
  scope: 'app',
  deps: { required: { env: PerfEnvToken, conformance: ConformanceToken } },
  create: ({ env, conformance }, ctx) => {
    const tracker = createInputLatencyTracker({ env, conformance, telemetry: ctx.telemetry });
    ctx.scope.defer(() => tracker.dispose());
    return tracker;
  },
});

export const memorySamplerUnit = unit({
  id: 'perf/memory-sampler-unit',
  provides: MemorySamplerToken,
  scope: 'app',
  deps: { required: { env: PerfEnvToken } },
  create: ({ env }, ctx) => {
    const sampler = createMemorySampler({ env, telemetry: ctx.telemetry });
    ctx.scope.defer(() => sampler.dispose());
    return sampler;
  },
});

export const budgetEvaluatorUnit = unit({
  id: 'perf/budget-evaluator-unit',
  provides: BudgetEvaluatorToken,
  scope: 'app',
  deps: { required: { budgets: MarkBudgetsToken, tier: PerfDeviceTierToken, conformance: ConformanceToken, tracker: JourneyTrackerToken } },
  create: ({ budgets, tier, conformance, tracker }, ctx) => {
    const evaluator = createBudgetEvaluator({ budgets: [...(budgets as readonly MarkBudget[]), ...DEFAULT_MARK_BUDGETS], tier, conformance });
    ctx.scope.defer(evaluator.attach(tracker));
    return evaluator;
  },
  description: 'Evaluates mark budgets (contributed + R12.7 defaults) on every journey.',
});

/** Contribute a mark budget (feature/tier/start specific budgets win over defaults). */
export function markBudgetUnit(budget: MarkBudget): UnitDefinition<readonly MarkBudget[], Record<never, never>, 'perf/mark-budgets'> {
  return contribution({
    id: `perf/budget-${budget.feature}-${budget.mark}` as `perf/${string}`,
    provides: MarkBudgetsToken,
    scope: 'app',
    create: () => budget,
  });
}

/** All default perf units. */
export const perfUnits = [
  perfEnvUnit,
  noScriptAttributionUnit,
  midTierUnit,
  conformanceUnit,
  violationCollectorUnit,
  journeyTrackerUnit,
  layoutShiftTrackerUnit,
  featureMarksUnit,
  longFrameDetectorUnit,
  forcedLayoutDetectorUnit,
  renderCounterUnit,
  inputLatencyTrackerUnit,
  memorySamplerUnit,
  budgetEvaluatorUnit,
] as const;
