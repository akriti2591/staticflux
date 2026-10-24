/**
 * Error catalog for @staticflux/worker (`SF-WK-*`). Every error has a stable
 * code and a concrete fix; see docs/LIFECYCLES.md §3 and invariant I-9.
 */
import { defineError } from '@staticflux/core';

export const InvalidEnvelopeError = defineError(
  'SF-WK-001',
  'validation',
  'A message on a worker port is not a valid envelope, or its payload fails the protocol schema.',
  'Send messages only through a Link / protocol client; check the schema of the channel and message named in `details`.',
);

/** SF-WK-002 (I-9) is defined once in core; aliased here for worker call sites. */
export { ReplicaWriteError, ReplicaWriteError as ReplicaMutationError } from '@staticflux/core';

export const HandshakeTimeoutError = defineError(
  'SF-WK-003',
  'timeout',
  'The worker did not complete the handshake in time.',
  'Check that the worker script loads and calls `runWorker()`; raise `handshakeTimeoutMs` only with a documented reason.',
);

export const WorkerCrashedError = defineError(
  'SF-WK-004',
  'unavailable',
  'The worker crashed while a non-idempotent request was in flight; the request was not retried.',
  'Declare the request `idempotent: true` in its protocol if a retry is safe, or re-check state and retry explicitly.',
);

export const WorkerFailedError = defineError(
  'SF-WK-005',
  'unavailable',
  'The worker exceeded its restart intensity and was given up; its declared fallback is active.',
  'Inspect the crash causes (`worker/supervisor` telemetry). The app stays degraded until `restart()` succeeds.',
);

export const RequestTimeoutError = defineError(
  'SF-WK-006',
  'timeout',
  'A cross-thread request was not answered in time.',
  'Make the handler cheaper or stream partial results via events; raise `timeoutMs` only with a documented reason.',
);

export const EpochMismatchError = defineError(
  'SF-WK-007',
  'conflict',
  'Replication epoch or version mismatch; the replica must resnapshot.',
  'Usually self-healing (the replica re-handshakes). If it repeats, check that one owner publishes the store.',
);

export const NoHandlerError = defineError(
  'SF-WK-008',
  'not-found',
  'No handler is registered on the other side for this channel or message.',
  'Register the handler (`runWorker({ handlers })`, `server.handle()`, `publisher.attach()`) before the peer sends to it.',
);

export const PortClosedError = defineError(
  'SF-WK-009',
  'aborted',
  'The link was closed before the message was answered.',
  'Expected during respawn/shutdown. Supervised requests marked idempotent are retried automatically.',
);

export const WorkerNotRunningError = defineError(
  'SF-WK-010',
  'unavailable',
  'The worker is not running (draining or terminated); the request was rejected.',
  'Call `start()` first, or check `worker.state` before sending requests.',
);

export const BrokerDeniedError = defineError(
  'SF-WK-011',
  'forbidden',
  'The token broker refused the brokered call.',
  'Only call operations the broker allows; never send credentials from a worker — the owning side attaches them.',
);

export const SecretReplicationError = defineError(
  'SF-WK-012',
  'invariant',
  'A core context contained raw credentials; they were stripped before replication (R11.7).',
  'Remove tokens from the context value (use the token broker), or declare `allowSecrets: true` with a reviewed reason.',
);

export const WorkerUnsupportedError = defineError(
  'SF-WK-013',
  'unavailable',
  'The requested worker kind is not available in this environment.',
  'Provide a fallback spawner (e.g. dedicated worker or in-thread) — SharedWorker and module workers are not universal.',
);

export const UnknownIntentError = defineError(
  'SF-WK-014',
  'validation',
  'The owner does not know the requested intent action.',
  'Check the intent name against the replica definition; owners must handle every declared intent.',
);

export const SpawnFailedError = defineError(
  'SF-WK-015',
  'unavailable',
  'The worker could not be spawned.',
  'Check the worker URL/bundle and CSP `worker-src`; the supervisor retries with backoff up to its restart intensity.',
);

export const InvalidPatchError = defineError(
  'SF-WK-016',
  'validation',
  'A patch could not be applied (bad path or operation).',
  'Patches must use paths that exist in the snapshot; a replica that hits this resnapshots automatically.',
);

export const WorkerUnresponsiveError = defineError(
  'SF-WK-017',
  'timeout',
  'The worker missed too many heartbeats and was treated as crashed.',
  'Move long synchronous work off the message loop (chunk it and yield); heartbeats need the loop to turn.',
);

export const ProtocolMismatchError = defineError(
  'SF-WK-018',
  'invariant',
  'The worker speaks a different protocol (id or version) than the supervisor.',
  'Deploy the worker bundle together with the main bundle; bump protocol versions on breaking changes.',
);
