import { defineError } from '@staticflux/core';

export const InvalidFlagValueError = defineError(
  'SF-CFG-001',
  'validation',
  'A layer supplied a value that does not match the flag schema.',
  'Fix the value in the layer (remote config, storage, URL) or the flag schema; the resolver falls through to lower layers meanwhile.',
);

export const DuplicateFlagKeyError = defineError(
  'SF-CFG-002',
  'invariant',
  'Two different flag declarations use the same key.',
  'Declare each flag once in its owner package contracts file and import that declaration everywhere.',
);

export const ProviderInitFailedError = defineError(
  'SF-CFG-003',
  'unavailable',
  'A flag provider failed to initialize (or timed out).',
  'Values from this provider are skipped; lower layers and package defaults apply. Check the provider endpoint/credentials.',
);

export const ProviderContextChangeFailedError = defineError(
  'SF-CFG-004',
  'unavailable',
  'A flag provider failed to reconcile a new evaluation context.',
  'The provider keeps serving its last cached values; check the provider and retry on the next context change.',
);

export const FlagBinderNotAttachedError = defineError(
  'SF-CFG-005',
  'invariant',
  'A flag-driven variant binding was evaluated before the flag resolver was attached.',
  'Register `flagBinder.unit` (critical) so the binder attaches during boot; until then flags read their package default.',
);

export const ProviderEvaluationError = defineError(
  'SF-CFG-006',
  'unavailable',
  'A flag provider returned an error while evaluating a flag.',
  'Inspect `details.errorCode`; the resolver falls through to lower layers. Fix the flag in the provider or its targeting rules.',
);

export const UnknownFlagKeyError = defineError(
  'SF-CFG-007',
  'validation',
  'A flag key is not declared.',
  'Use a key from a `defineFlag` declaration (register its package flags via `flagDefinitionUnits`).',
);

export const RemoteConfigLoadError = defineError(
  'SF-CFG-008',
  'network',
  'Loading remote flag values failed.',
  'The remote layer keeps its previous values (or none); lower layers apply. Check the endpoint and retry policy.',
);
