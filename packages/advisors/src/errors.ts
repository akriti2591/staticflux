import { defineError } from '@staticflux/core';

export const AdvisorTimeoutError = defineError(
  'SF-ADV-001',
  'timeout',
  'An advisor did not answer within its time box.',
  'Expected under load; the deterministic default was used. Move the point to a slower latency class only with a reason.',
);

export const InvalidDistributionError = defineError(
  'SF-ADV-002',
  'validation',
  'An advisor returned no usable probability mass over the declared options.',
  'Return finite, non-negative probabilities keyed by the decision point options; unknown options are ignored.',
);

export const InsufficientDataError = defineError(
  'SF-ADV-003',
  'unavailable',
  'The statistical advisor has too little history for this question.',
  'Expected for new users; the default heuristic answers until enough observations exist.',
);

export const AdvisorStorageError = defineError(
  'SF-ADV-004',
  'unavailable',
  'Advisor history could not be read or written.',
  'History is a performance hint only; the advisor restarts empty. Check the storage port (user-data slice) for the cause.',
);

export const CorruptHistoryError = defineError(
  'SF-ADV-005',
  'validation',
  'Stored advisor history has an unknown shape or version.',
  'The history was reset to empty. Bump the snapshot version and add a migration when changing the stored shape.',
);

export const UnsupportedPointError = defineError(
  'SF-ADV-006',
  'invariant',
  'The advisor was asked about a decision point it does not support.',
  'Check `advisor.supports(point)` before calling; the advisor service does this automatically.',
);
