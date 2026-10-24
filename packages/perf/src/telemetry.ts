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

/** Feature marks (R17.7), framework-measured. */
export const FEATURE_MARKS = ['placeholder-shown', 'first-render', 'largest-render', 'interactive', 'complete'] as const;
export type FeatureMark = (typeof FEATURE_MARKS)[number];

/** Declared mark metrics, one per feature mark (attrs: feature, method, at). */
export const featureMarkMetrics = {
  'placeholder-shown': metric.mark('feature/placeholder-shown', { description: 'feature.placeholder-shown: feature skeleton painted.' }),
  'first-render': metric.mark('feature/first-render', { description: 'feature.first-render: first content render committed and painted.' }),
  'largest-render': metric.mark('feature/largest-render', { description: 'feature.largest-render: largest element of the feature painted.' }),
  interactive: metric.mark('feature/interactive', { description: 'feature.interactive: handlers attached, render deps ready.' }),
  complete: metric.mark('feature/complete', { description: 'feature.complete: deps + initial resources settled + layout stable.' }),
} as const satisfies Record<FeatureMark, unknown>;

export const perfMetrics = {
  journeyDuration: metric.histogram('perf/journey-duration', { unit: 'ms', description: 'Journey start → end (attrs: start, outcome).' }),
  phaseDuration: metric.histogram('perf/phase-duration', { unit: 'ms', description: 'Journey phase total (attrs: phase, start).' }),
  longFrame: metric.histogram('perf/long-frame', { unit: 'ms', description: 'Long animation frame / long task (attrs: type, chunk, feature).' }),
  forcedLayout: metric.counter('perf/forced-layout', { description: 'Forced synchronous layouts (attrs: component).' }),
  layoutShift: metric.histogram('perf/layout-shift', { description: 'Layout shift value per feature subtree (attrs: feature).' }),
  renders: metric.counter('perf/renders', { description: 'Component renders (attrs: component, feature). Emitted at verbose.' }),
  inputLatency: metric.histogram('perf/input-latency', { unit: 'ms', description: 'Input to next paint (attrs: event, method).' }),
  memory: metric.gauge('perf/memory', { unit: 'MB', description: 'Sampled JS heap size.' }),
  violations: metric.counter('perf/violations', { description: 'Conformance violations (attrs: code).' }),
} as const;
