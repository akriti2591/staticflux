/**
 * Devtools error catalog (`SF-DEV-NNN`). Devtools never fail the app: these are
 * returned from controls/inspectors and shown in the panel.
 */
import { defineError } from '@staticflux/core';

export const InvalidDebugFlagError = defineError(
  'SF-DEV-001',
  'validation',
  'The `sf-debug` flag contains entries that are not `<subsystem>:<level>`.',
  'Use `?sf-debug=core/di:verbose,router/*:debug` (subsystem `area/name`, `area/*` or `*`; level off|critical|standard|verbose|debug). A bare level applies to every subsystem.',
);

export const SourceNotBoundError = defineError(
  'SF-DEV-002',
  'unavailable',
  'The devtools source this view or control needs is not bound.',
  'Pass it to `installDevtools({ … })` (gate, supervisor, featureHost, journeys, stores) or call `devtools.bind({ … })` once it exists. With an injector, sources already resolved by the app are bound automatically.',
);

export const PanelLoadFailedError = defineError(
  'SF-DEV-003',
  'unavailable',
  'The devtools panel module failed to load or define its custom element.',
  'Check that `@staticflux/devtools/panel` is reachable by the bundler (it is a separate chunk) and that no other element is registered as `sf-devtools`.',
);

export const NoDomError = defineError(
  'SF-DEV-004',
  'unavailable',
  'The devtools overlay needs a DOM (document + customElements) and none is available.',
  'Run the overlay only in the browser main thread; workers and SSR can use the collector (`createDevtools`) without the panel.',
);
