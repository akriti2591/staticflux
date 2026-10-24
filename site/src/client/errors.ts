/** Site error catalog entries (stable codes + fixes, like every StaticFlux error). */
import { defineError } from '@staticflux/core';

export const UnknownIslandError = defineError(
  'SF-SITE-001',
  'not-found',
  'An island marker names a chunk the site does not declare.',
  'Declare the chunk in site/src/client/chunks.ts and give it an `entry` module.',
);

export const MissingInjectorError = defineError(
  'SF-SITE-002',
  'invariant',
  'An island hydrated without an injector.',
  'Start the hydrator with `hydrator.start(root, { injector })` so each island gets a feature-level child injector.',
);

export const ClipboardUnavailableError = defineError(
  'SF-SITE-003',
  'unavailable',
  'The Clipboard API is not available here.',
  'Select the code and copy it manually (Ctrl/Cmd+C); the clipboard needs a secure context and a user gesture.',
);
