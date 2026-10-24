/**
 * App-level errors (catalog codes `SF-STUDIO-NNN`). Package errors keep their own codes.
 */
import { defineError } from '@staticflux/core';

export const ReadOnlyDocumentError = defineError(
  'SF-STUDIO-001',
  'unavailable',
  'The document is read-only because the document worker is unavailable.',
  'Wait for the worker to recover (the app is `degraded`), or reload; edits are disabled meanwhile.',
);

export const DocumentWorkerGaveUpError = defineError(
  'SF-STUDIO-002',
  'unavailable',
  'The document worker crashed too often and was given up.',
  'Check the worker logs (forwarded telemetry, subsystem `worker/supervisor`); reinitialize the app to retry.',
);

export const NoDocumentOpenError = defineError(
  'SF-STUDIO-003',
  'invariant',
  'A document capability ran while no document is open.',
  'Open a document (/studio/doc/:id) before invoking document capabilities.',
);
