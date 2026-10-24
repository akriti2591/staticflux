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

export const PerfEnvToken = /* @__PURE__ */ token('perf/env').type<PerfEnv>();
/** Script URL → logical chunk id (bind the loader's `chunkAttributor(manifest)`). */
export const ScriptAttributionToken = /* @__PURE__ */ token('perf/script-attribution').type<(url: string) => string | undefined>();
/** Device tier reader for tiered budgets (bind platform facts `device.tier`). */
export const PerfDeviceTierToken = /* @__PURE__ */ token('perf/device-tier').type<() => DeviceTier>();
/** Mark budgets contributed by apps/features (defaults: R12.7). */
export const MarkBudgetsToken = /* @__PURE__ */ token('perf/mark-budgets').multi<MarkBudget>();

export const ConformanceToken = /* @__PURE__ */ token('perf/conformance').type<Conformance>();
export const ViolationCollectorToken = /* @__PURE__ */ token('perf/violation-collector').type<ViolationCollector>();
export const JourneyTrackerToken = /* @__PURE__ */ token('perf/journey-tracker').type<JourneyTracker>();
export const FeatureMarksToken = /* @__PURE__ */ token('perf/feature-marks').type<FeatureMarks>();
export const LongFrameDetectorToken = /* @__PURE__ */ token('perf/long-frame-detector').type<LongFrameDetector>();
export const ForcedLayoutDetectorToken = /* @__PURE__ */ token('perf/forced-layout-detector').type<ForcedLayoutDetector>();
export const LayoutShiftTrackerToken = /* @__PURE__ */ token('perf/layout-shift-tracker').type<LayoutShiftTracker>();
export const RenderCounterToken = /* @__PURE__ */ token('perf/render-counter').type<RenderCounter>();
export const InputLatencyTrackerToken = /* @__PURE__ */ token('perf/input-latency-tracker').type<InputLatencyTracker>();
export const MemorySamplerToken = /* @__PURE__ */ token('perf/memory-sampler').type<MemorySampler>();
export const BudgetEvaluatorToken = /* @__PURE__ */ token('perf/budget-evaluator').type<BudgetEvaluator>();
