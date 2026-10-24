/**
 * Every error the data layer returns. Codes are stable (`SF-DATA-NNN`) and
 * listed in AGENTS.md. Transport failures are mapped onto core `ErrorKind`s so
 * retry/breaker/messaging policies can decide on `kind` alone.
 */
import { defineError, type ErrorDefinition, type SfError } from '@staticflux/core';

// ---------------------------------------------------------------- epochs / pause (I-10, R4.6)

export const StaleEpochError = defineError(
  'SF-DATA-001',
  'aborted',
  'A response arrived for an older app epoch and was discarded (I-10).',
  'Expected after refresh/session change. Do not retry; active resources refetch automatically in the new epoch.',
);

export const TransportPausedError = defineError(
  'SF-DATA-002',
  'unavailable',
  'The request was rejected because the transport is paused.',
  'Mark read endpoints `idempotent: true` (they queue by default), or retry the mutation explicitly after resume.',
);

export const UnsupportedOperationError = defineError(
  'SF-DATA-003',
  'invariant',
  'The selected transport does not support this operation (request vs stream).',
  'Route the endpoint to a transport that supports it via `endpoint.transport`, e.g. SSE/WebSocket for streams.',
);

export const NoRouteError = defineError(
  'SF-DATA-004',
  'not-found',
  'The mock transport has no route for this endpoint.',
  'Register a handler with `mock.route(endpoint, handler)` (or `mock.stream`) before calling it.',
);

export const DecodeError = defineError(
  'SF-DATA-005',
  'validation',
  'The response body could not be decoded or did not match the endpoint schema.',
  'Check the backend contract; the endpoint `response`/`chunk` schema describes what the client expects.',
);

export const NoTransportError = defineError(
  'SF-DATA-006',
  'invariant',
  'No transport is bound for the endpoint\'s transport slot.',
  'Pass the slot in `createDataClient({ transports: [[slot, transport]] })` or bind a unit for it.',
);

export const TransportUnavailableError = defineError(
  'SF-DATA-007',
  'unavailable',
  'The transport\'s browser API (EventSource, WebSocket, fetch) is not available here.',
  'Feature-detected: inject the constructor/factory, or bind a different transport for this slot.',
);

// ---------------------------------------------------------------- HTTP / network mapping

export const NetworkError = defineError(
  'SF-DATA-010',
  'network',
  'The request failed at the network level (offline, DNS, CORS, connection reset).',
  'Usually transient; the client retries idempotent requests. Show offline UI if it persists.',
);
export const RequestTimeoutError = defineError(
  'SF-DATA-011',
  'timeout',
  'The server or gateway timed out (408/504).',
  'Retried automatically for idempotent requests; consider streaming or paging large responses.',
);
export const UnauthenticatedError = defineError(
  'SF-DATA-012',
  'auth',
  'The server rejected the credentials (401).',
  'Let the auth package refresh the session; requests are re-issued after the epoch bump.',
);
export const ForbiddenError = defineError(
  'SF-DATA-013',
  'forbidden',
  'The server refused the request (403).',
  'The user lacks the permission server-side; client gating is UX only. Show an upsell/denied surface.',
);
export const NotFoundError = defineError(
  'SF-DATA-014',
  'not-found',
  'The resource does not exist (404/410).',
  'Show an empty/not-found state; do not retry.',
);
export const InvalidRequestError = defineError(
  'SF-DATA-015',
  'validation',
  'The server rejected the request as invalid (400/422).',
  'Validate input with the endpoint schema before sending; inspect `details.body` for the server message.',
);
export const ConflictError = defineError(
  'SF-DATA-016',
  'conflict',
  'The server reported a conflict (409/412).',
  'Refetch and rebase the change, or surface a conflict resolver.',
);
export const ServerUnavailableError = defineError(
  'SF-DATA-017',
  'unavailable',
  'The server is unavailable (5xx).',
  'Transient; retried for idempotent requests and counted by the endpoint circuit breaker.',
);
export const RateLimitedError = defineError(
  'SF-DATA-018',
  'rate',
  'The server rate-limited the request (429).',
  'Back off; `details.retryAfterMs` carries the server hint when present.',
);
export const HttpError = defineError(
  'SF-DATA-019',
  'unknown',
  'The server returned an unexpected status.',
  'Inspect `details.status`; map new statuses in `errorForStatus` if they are part of the contract.',
);

export interface StatusErrorDetails {
  readonly status: number;
  readonly endpoint: string;
  readonly retryAfterMs?: number;
  readonly body?: unknown;
}

/** Map an HTTP-like status code to a typed SfError (kind drives retry/breaker policy). */
export function errorForStatus(details: StatusErrorDetails): SfError {
  const { status } = details;
  const definition: ErrorDefinition =
    status === 401
      ? UnauthenticatedError
      : status === 403
        ? ForbiddenError
        : status === 404 || status === 410
          ? NotFoundError
          : status === 400 || status === 422
            ? InvalidRequestError
            : status === 409 || status === 412
              ? ConflictError
              : status === 429
                ? RateLimitedError
                : status === 408 || status === 504
                  ? RequestTimeoutError
                  : status >= 500
                    ? ServerUnavailableError
                    : HttpError;
  const extra: Record<string, unknown> = { status, endpoint: details.endpoint };
  if (details.retryAfterMs !== undefined) extra.retryAfterMs = details.retryAfterMs;
  if (details.body !== undefined) extra.body = details.body;
  return definition({ message: `${definition.summary} [${details.endpoint} → ${status}]`, details: extra });
}

// ---------------------------------------------------------------- resources

export const BatchResultMissingError = defineError(
  'SF-DATA-020',
  'invariant',
  'The batch loader returned no result for a requested key.',
  'A batch function must return one entry per key, in the same order as `keys` (DataLoader contract).',
);

export const ResourceDisposedError = defineError(
  'SF-DATA-021',
  'aborted',
  'The resource handle was disposed.',
  'Expected when the owning scope ends; do not use a handle after disposal (I-12).',
);

// ---------------------------------------------------------------- schema

export const SchemaValidationError = defineError(
  'SF-DATA-030',
  'validation',
  'A value does not match its schema.',
  'Fix the producer; `details.path` and `details.expected` say where and what was expected.',
);

export const NotCloneableError = defineError(
  'SF-DATA-031',
  'validation',
  'A value is not structured-clone-safe (functions, class instances, DOM nodes, proxies).',
  'Store plain data only (objects, arrays, strings, numbers, booleans, null). Keep behaviour in actions.',
);

// ---------------------------------------------------------------- stores (R9.5, I-9)

export const UnknownActionError = defineError(
  'SF-DATA-040',
  'validation',
  'The intent names an action the store does not declare.',
  'Intents must use names from the store definition `actions`; check the storeId and the replica/owner versions.',
);
export const PatchGapError = defineError(
  'SF-DATA-041',
  'conflict',
  'A patch message does not follow the replica\'s current version (gap or duplicate).',
  'Request a fresh snapshot from the owner (`owner.getSnapshot()` / `patchesSince`), then resume applying patches.',
);
export const EpochMismatchError = defineError(
  'SF-DATA-042',
  'conflict',
  'A patch message belongs to a different epoch than the replica.',
  'Resnapshot: replicas follow the owner\'s epoch only through a snapshot.',
);
export const StoreSchemaVersionError = defineError(
  'SF-DATA-043',
  'conflict',
  'A snapshot or patch has a different store schema version.',
  'Owner and replica must run the same store definition version; reload the stale side or migrate the snapshot.',
);
export const ActionFailedError = defineError(
  'SF-DATA-044',
  'invariant',
  'A store action threw; its changes were rolled back.',
  'Actions must be synchronous, deterministic and only touch the draft. Inspect `cause`.',
);
export const DraftRevokedError = defineError(
  'SF-DATA-045',
  'invariant',
  'A store draft was used after its action finished.',
  'Do not keep references to `draft` objects; perform all changes inside the action body.',
);
export const InvalidPatchError = defineError(
  'SF-DATA-046',
  'validation',
  'A patch operation is not applicable to the current state.',
  'Patches must be applied in version order to the state they were recorded against.',
);
export const PatchHistoryExpiredError = defineError(
  'SF-DATA-047',
  'conflict',
  'The requested version is older than the owner\'s patch ring buffer.',
  'Send a full snapshot instead (`getSnapshot()`).',
);

/** Invariant I-9 — replicas never mutate; writes are intents to the owner. Shared with @staticflux/worker. */
export const ReplicaWriteError = defineError(
  'SF-WK-002',
  'invariant',
  'A replica store cannot mutate; writes must be sent as intents to the owner (I-9).',
  'Create the replica with an intent `sink`, or perform the write on the owner thread.',
);

// ---------------------------------------------------------------- user-data slices (R9.8–R9.12)

export const SliceKeyCollisionError = defineError(
  'SF-DATA-050',
  'invariant',
  'Two different slice definitions use the same key.',
  'Slice keys are namespaced per feature (`feature/name`); rename one, or import the single shared definition.',
);
export const SliceMigrationError = defineError(
  'SF-DATA-051',
  'validation',
  'A persisted slice could not be migrated; defaults were used instead.',
  'Add or fix the migration for `details.from` → `details.to`. The stored value is left untouched until the next write.',
);
export const SliceBudgetError = defineError(
  'SF-DATA-052',
  'quota',
  'The slice value exceeds its storage budget; the write was rejected.',
  'Store less (ids instead of objects, trim history) or raise `budgetBytes` with a documented reason.',
);
export const SliceNotReadyError = defineError(
  'SF-DATA-053',
  'invariant',
  'The slice is not ready for this operation.',
  'Await `slice.whenReady()` before writing; check `slice.state`.',
);
export const StorageBackendError = defineError(
  'SF-DATA-054',
  'unavailable',
  'The user-data storage backend failed.',
  'Values stay in memory and are retried on the next flush. Check quota/private-mode restrictions.',
);
export const StorageUnavailableError = defineError(
  'SF-DATA-055',
  'unavailable',
  'The requested storage backend is not available in this environment.',
  'Feature-detected (e.g. Safari private mode, embedded webviews). Fall back to the memory backend.',
);
export const RemoteSyncError = defineError(
  'SF-DATA-056',
  'network',
  'Remote sync of user-data slices failed; changes stay queued locally.',
  'Offline-first: nothing to do; the next flush or `sync()` retries.',
);
