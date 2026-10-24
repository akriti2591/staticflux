/**
 * Error catalog for @staticflux/gate (`SF-GATE-NNN`).
 * Reminder (R6.16): a client-side gate error is a UX signal, never an authorization result.
 */
import { defineError } from '@staticflux/core';

export const GatedOutError = defineError(
  'SF-GATE-001',
  'forbidden',
  'A gate denied this resource (forbidden or upgrade required). Gated-out chunks are never fetched (I-8).',
  'Check `gate.explain(level, id, action)` for the determining policy; show the denied/upsell state instead of loading the resource.',
);

export const LoginRequiredError = defineError(
  'SF-GATE-002',
  'auth',
  'A gate denied this resource because the subject is not logged in.',
  'Route through login (keep the deep link as `returnTo`); the decision re-evaluates when session facts change.',
);

export const QuotaExceededError = defineError(
  'SF-GATE-003',
  'quota',
  'A meter does not cover the cost of this action.',
  'Show the low-balance / upsell surface. The server balance is authoritative; refresh it with `meter.setServerState()`.',
);

export const RateLimitedError = defineError(
  'SF-GATE-004',
  'rate',
  'A rate meter is exhausted for the current window.',
  'Wait until the window resets (`details.retryAt`); do not retry in a loop.',
);

export const GateUnavailableError = defineError(
  'SF-GATE-005',
  'unavailable',
  'The resource is unavailable on this platform, host, region or configuration.',
  'Hide the entry point; check platform/host facts in `gate.explain()`.',
);

export const InvalidPolicyError = defineError(
  'SF-GATE-010',
  'validation',
  'A policy (default or remote override) is malformed.',
  'Fix the policy JSON: see `details.path`. Remote overrides are rejected as a whole; the previous table stays active.',
);

export const DuplicatePolicyError = defineError(
  'SF-GATE-011',
  'validation',
  'Two policies in the same layer share an id.',
  'Policy ids must be unique per layer (`pkg/name`). Use a remote override with the same id to replace a default.',
);

export const ReservationStateError = defineError(
  'SF-GATE-020',
  'invariant',
  'The reservation is not in a state that allows this operation.',
  'Only `reserved` reservations can be committed or released (docs/LIFECYCLES.md §11). Check `reservation.state` first.',
);

export const UnknownMeterError = defineError(
  'SF-GATE-021',
  'validation',
  'The meter is not registered.',
  'Register the meter definition (MeterDefinitionsToken) before reserving against it.',
);
