/**
 * DI tokens of @staticflux/perf. Ports (env, attribution, device tier) have default
 * units; apps re-bind them with `bind(unit, { precedence: 'app' })`.
 */
import { token } from '@staticflux/core';
import type { BudgetEvaluator, DeviceTier, MarkBudget } from './budgets.js';
import type { Conformance, ViolationCollector } from './conformance.js';
import type {
  ForcedLayoutDetector,
  InputLatencyTracker,
  LayoutShiftTracker,
  LongFrameDetector,
  MemorySampler,
  RenderCounter,
} from './detectors.js';
import type { PerfEnv } from './env.js';
import type { JourneyTracker } from './journey.js';
import type { FeatureMarks } from './marks.js';

export const PerfEnvToken = token('perf/env').type<PerfEnv>();
/** Script URL → logical chunk id (bind the loader's `chunkAttributor(manifest)`). */
export const ScriptAttributionToken = token('perf/script-attribution').type<(url: string) => string | undefined>();
/** Device tier reader for tiered budgets (bind platform facts `device.tier`). */
export const PerfDeviceTierToken = token('perf/device-tier').type<() => DeviceTier>();
/** Mark budgets contributed by apps/features (defaults: R12.7). */
export const MarkBudgetsToken = token('perf/mark-budgets').multi<MarkBudget>();

export const ConformanceToken = token('perf/conformance').type<Conformance>();
export const ViolationCollectorToken = token('perf/violation-collector').type<ViolationCollector>();
export const JourneyTrackerToken = token('perf/journey-tracker').type<JourneyTracker>();
export const FeatureMarksToken = token('perf/feature-marks').type<FeatureMarks>();
export const LongFrameDetectorToken = token('perf/long-frame-detector').type<LongFrameDetector>();
export const ForcedLayoutDetectorToken = token('perf/forced-layout-detector').type<ForcedLayoutDetector>();
export const LayoutShiftTrackerToken = token('perf/layout-shift-tracker').type<LayoutShiftTracker>();
export const RenderCounterToken = token('perf/render-counter').type<RenderCounter>();
export const InputLatencyTrackerToken = token('perf/input-latency-tracker').type<InputLatencyTracker>();
export const MemorySamplerToken = token('perf/memory-sampler').type<MemorySampler>();
export const BudgetEvaluatorToken = token('perf/budget-evaluator').type<BudgetEvaluator>();
