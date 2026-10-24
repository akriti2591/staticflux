/** Errors raised by testkit helpers (thrown — test helpers fail the test loudly). */
import { defineError } from '@staticflux/core';

export const TestBootFailedError = defineError(
  'SF-TEST-001',
  'invariant',
  '`bootTestApp` could not boot the app.',
  'Inspect `cause` (usually a missing provider or a failing critical unit) and add the unit or an override.',
);

export const TestResolveFailedError = defineError(
  'SF-TEST-002',
  'invariant',
  'A token requested through a testkit helper did not resolve.',
  'Register a unit (or an override) that provides the token; see `cause` for the injector error.',
);

export const UnexpectedViolationsError = defineError(
  'SF-TEST-003',
  'invariant',
  'The code under test emitted conformance `violation` events.',
  'Fix the reported violations (each carries a code and a fix), or assert them explicitly with `violations()`.',
);

export const RunawayTimersError = defineError(
  'SF-TEST-004',
  'invariant',
  '`runAll` exceeded its iteration limit (a timer keeps rescheduling itself).',
  'Use `advance(ms)` for intervals and self-rescheduling timers, or raise `limit` with a reason.',
);

export const SpanAssertionError = defineError(
  'SF-TEST-005',
  'invariant',
  'A span structure assertion failed.',
  'Compare against `formatSpanTree()` output; check the `parent` option where the child span is started.',
);
