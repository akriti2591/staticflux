import { defineError } from '@staticflux/core';

export const AiUnavailableError = defineError(
  'SF-AI-001',
  'unavailable',
  'No model is available for this AI task on this device/provider.',
  'Gate the feature on the AI availability facts (`provider.facts`); AI is never on the critical path, so degrade to the non-AI path.',
);

export const AiUserActivationRequiredError = defineError(
  'SF-AI-002',
  'unavailable',
  'Starting the model download needs a user gesture.',
  'Call `provider.prepare(task)` from a click/keypress handler (Chrome requires user activation when availability is `downloadable`).',
);

export const InvalidDecisionError = defineError(
  'SF-AI-003',
  'validation',
  'The decision model returned probabilities that do not fit the closed option set.',
  'Return one finite, non-negative probability per option (array in option order, or a record keyed by option); unknown options are ignored.',
);

export const AiProviderFailedError = defineError(
  'SF-AI-004',
  'unknown',
  'The AI provider failed while running the request.',
  'Inspect `cause`. Treat AI as optional: show the non-AI fallback and let the user retry.',
);

export const InvalidModelOutputError = defineError(
  'SF-AI-005',
  'validation',
  'The model output could not be parsed into the expected shape.',
  'Constrain the output (JSON schema / responseConstraint) or retry; never trust free-form model output as structured data.',
);
