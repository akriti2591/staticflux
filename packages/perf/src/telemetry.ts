/**
 * Telemetry of @staticflux/perf: subsystems and declared metrics. Verbosity is the
 * core level system (`telemetry.setLevel('perf/render', 'verbose')`) — no new levels.
 * Detectors check `telemetry.enabled(subsystem, level)` and stay dormant when off.
 */
import { metric, type Subsystem } from '@staticflux/core';

export const PERF_SUBSYSTEMS = {
  journey: 'perf/journey',
  marks: 'perf/marks',
  frames: 'perf/frames',
  layout: 'perf/layout',
  render: 'perf/render',
  input: 'perf/input',
  memory: 'perf/memory',
  conformance: 'perf/conformance',
  budgets: 'perf/budgets',
} as const satisfies Record<string, Subsystem>;

/**
 * Feature marks (R17.7), framework-measured. Mark keys are camelCase everywhere
 * (manifests, readiness signals, budgets, journey summaries); the telemetry metric
 * ids / event names stay `feature/first-render` / `feature.first-render`.
 */
export const FEATURE_MARKS = ['placeholderShown', 'firstRender', 'largestRender', 'interactive', 'complete'] as const;
export type FeatureMark = (typeof FEATURE_MARKS)[number];

/**
 * @deprecated kebab-case mark names, accepted for one release (normalized by
 * `normalizeFeatureMark`). Use the camelCase `FeatureMark`.
 */
export type LegacyFeatureMark = 'placeholder-shown' | 'first-render' | 'largest-render';
/** A mark name as accepted by APIs during the deprecation window. */
export type FeatureMarkInput = FeatureMark | LegacyFeatureMark;

const LEGACY_FEATURE_MARKS: Readonly<Record<LegacyFeatureMark, FeatureMark>> = {
  'placeholder-shown': 'placeholderShown',
  'first-render': 'firstRender',
  'largest-render': 'largestRender',
};

/** Canonical (camelCase) form of a mark name; maps the deprecated kebab-case aliases. */
export function normalizeFeatureMark(mark: FeatureMarkInput): FeatureMark {
  return (LEGACY_FEATURE_MARKS as Readonly<Record<string, FeatureMark>>)[mark] ?? (mark as FeatureMark);
}

/** Declared mark metrics, one per feature mark (attrs: feature, method, at). */
export const featureMarkMetrics = {
  placeholderShown: /* @__PURE__ */ metric.mark('feature/placeholder-shown', { description: 'feature.placeholder-shown: feature skeleton painted.' }),
  firstRender: /* @__PURE__ */ metric.mark('feature/first-render', { description: 'feature.first-render: first content render committed and painted.' }),
  largestRender: /* @__PURE__ */ metric.mark('feature/largest-render', { description: 'feature.largest-render: largest element of the feature painted.' }),
  interactive: /* @__PURE__ */ metric.mark('feature/interactive', { description: 'feature.interactive: handlers attached, render deps ready.' }),
  complete: /* @__PURE__ */ metric.mark('feature/complete', { description: 'feature.complete: deps + initial resources settled + layout stable.' }),
} as const satisfies Record<FeatureMark, unknown>;

export const perfMetrics = {
  journeyDuration: /* @__PURE__ */ metric.histogram('perf/journey-duration', { unit: 'ms', description: 'Journey start → end (attrs: start, outcome).' }),
  phaseDuration: /* @__PURE__ */ metric.histogram('perf/phase-duration', { unit: 'ms', description: 'Journey phase total (attrs: phase, start).' }),
  longFrame: /* @__PURE__ */ metric.histogram('perf/long-frame', { unit: 'ms', description: 'Long animation frame / long task (attrs: type, chunk, feature).' }),
  forcedLayout: /* @__PURE__ */ metric.counter('perf/forced-layout', { description: 'Forced synchronous layouts (attrs: component).' }),
  layoutShift: /* @__PURE__ */ metric.histogram('perf/layout-shift', { description: 'Layout shift value per feature subtree (attrs: feature).' }),
  renders: /* @__PURE__ */ metric.counter('perf/renders', { description: 'Component renders (attrs: component, feature). Emitted at verbose.' }),
  inputLatency: /* @__PURE__ */ metric.histogram('perf/input-latency', { unit: 'ms', description: 'Input to next paint (attrs: event, method).' }),
  memory: /* @__PURE__ */ metric.gauge('perf/memory', { unit: 'MB', description: 'Sampled JS heap size.' }),
  violations: /* @__PURE__ */ metric.counter('perf/violations', { description: 'Conformance violations (attrs: code).' }),
} as const;
