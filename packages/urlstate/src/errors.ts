import { defineError } from '@staticflux/core';

/** Invariant I-13. */
export const IntentNotExecutableError = defineError(
  'SF-URL-001',
  'forbidden',
  'An intent from the URL tried to auto-execute, but its policy is prefill-only.',
  'Use the intent to prefill UI and let the user confirm. Mark the intent `safe: true` only for side-effect-free actions (e.g. opening a panel), after review.',
);

export const UrlKeyCollisionError = defineError(
  'SF-URL-002',
  'conflict',
  'Two URL declarations use the same query key.',
  'Query keys are a shared namespace: rename one (prefix with the package, e.g. `chat-prompt`) or reuse the single declaration.',
);

export const InvalidUrlValueError = defineError(
  'SF-URL-003',
  'validation',
  'A URL parameter value could not be parsed by its codec.',
  'Expected for hand-edited URLs: the default value is used and the bad parameter is removed. Check links that generate this URL.',
);

export const DialogPathError = defineError(
  'SF-URL-004',
  'validation',
  'A dialog path is malformed or contains more than one routable dialog.',
  'Use `<feature-path>/d/<key>` or `/d/<key>` with a kebab-case key; stack further dialogs as non-routable surfaces.',
);

export const UnsyncableBindingError = defineError(
  'SF-URL-005',
  'validation',
  'This URL part kind cannot be bound by the URL-sync service.',
  'Only `view` and `sticky` params sync to stores; `path` belongs to the router, `dialog` to messaging, `intent` to the intent service and `hidden` to handoff.',
);
