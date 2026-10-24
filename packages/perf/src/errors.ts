/**
 * Error/violation catalog of @staticflux/perf (`SF-PERF-NNN`). Violations on the
 * conformance stream (R17.22) use these codes; agents look them up instead of guessing.
 */
import { defineError } from '@staticflux/core';

export const ForcedLayoutViolation = defineError(
  'SF-PERF-001',
  'invariant',
  'A layout read happened after a DOM write in the same frame (forced synchronous layout).',
  'Move the read into `scheduler.measure()` and the write into `scheduler.mutate()` (R12.15); never interleave reads and writes.',
);

export const BudgetExceededViolation = defineError(
  'SF-PERF-002',
  'invariant',
  'A feature mark exceeded its runtime budget.',
  'Open the journey trace: the phase critical path names the slow span (chunk, unit init, resource). Defer it or make it cheaper; raising a budget needs a reviewed reason (R12.8).',
);

export const RenderStormViolation = defineError(
  'SF-PERF-003',
  'invariant',
  'A component re-rendered too often within a short window (render storm).',
  'Read fewer observables in render, batch updates (`batch()`), or move derived values into `derived()` (R12.14).',
);

export const LayoutShiftViolation = defineError(
  'SF-PERF-004',
  'invariant',
  'A feature subtree shifted layout (placeholder size differs from content, or shift score over threshold).',
  'Give the placeholder the final size (size-stable skeletons, R12.19) or reserve space with CSS `contain-intrinsic-size`/aspect-ratio.',
);

export const LongFrameViolation = defineError(
  'SF-PERF-005',
  'invariant',
  'A long animation frame / long task exceeded the frame budget.',
  'Chunk the work with `yieldToMain()` or move it to a worker (R12.18); the violation names the chunk/feature from LoAF script attribution.',
);

export const NewViolationsError = defineError(
  'SF-PERF-006',
  'validation',
  'New conformance violations were found compared to the baseline.',
  'Fix the listed violations (each carries its own code and fix); only update the baseline for accepted, reviewed exceptions.',
);

export const SlowInteractionViolation = defineError(
  'SF-PERF-007',
  'invariant',
  'Input-to-next-paint latency exceeded its budget.',
  'Keep event handlers short: update state, let the scheduler render, and defer non-visual work (`postTask("idle")`).',
);

export const InvalidBaselineError = defineError(
  'SF-PERF-008',
  'validation',
  'The violation baseline is malformed or has an unsupported format.',
  'Regenerate it with `collector.baseline()` (format `sf-violations/1`).',
);
