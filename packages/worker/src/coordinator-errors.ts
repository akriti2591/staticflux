/**
 * Error catalog for the multi-tab coordinator (R11.9). Codes continue the
 * `SF-WK-*` series after the channel errors (SF-WK-019 … SF-WK-026).
 */
import { defineError } from '@staticflux/core';

export const CoordinatorStoppedError = defineError(
  'SF-WK-027',
  'aborted',
  'The tab coordinator was stopped (disposed) before the operation completed.',
  'Expected during shutdown. Create calls from a scope that outlives the coordinator, or check `coordinator.role !== "stopped"`.',
);

export const UnknownCoordinatedResourceError = defineError(
  'SF-WK-028',
  'not-found',
  'The tab coordinator does not own a resource with this replica definition.',
  'Add an `ownedResource(definition, create)` for it to `createTabCoordinator({ owned })` (and to the SharedWorker host).',
);

export const CoordinatorTransportError = defineError(
  'SF-WK-029',
  'unavailable',
  'The requested coordinator transport is not available (no SharedWorker, or it failed to connect).',
  "Use `transport: 'auto'` so the coordinator falls back to Web Locks leader election over BroadcastChannel.",
);

export const StaleTermError = defineError(
  'SF-WK-030',
  'conflict',
  'A cross-tab message from an older leadership term was dropped.',
  'Usually self-healing (the sender learns the new term and re-handshakes). If it repeats, check that every tab runs the same coordinator id.',
);
