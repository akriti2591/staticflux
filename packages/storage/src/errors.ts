/**
 * Storage errors (`SF-STORE-*`). Every adapter and middleware returns these as
 * values; nothing in this package throws for an expected failure.
 */
import { defineError, isSfError, type SfError } from '@staticflux/core';

export const StoreQuotaError = defineError(
  'SF-STORE-001',
  'quota',
  'The storage quota or a configured budget was exceeded; the write was rejected.',
  'Store less (ids instead of documents, trim history), purge expired entries (`purgeExpired()`), or move large values to IndexedDB/OPFS. Raise a `withBudget` limit only with a documented reason.',
);

export const StoreUnavailableError = defineError(
  'SF-STORE-002',
  'unavailable',
  'The storage backend is not available in this environment.',
  'Feature-detected (Safari private mode, sandboxed iframes, disabled cookies, missing OPFS). Use `fallback([...])` or `detectLocalStore()` so the app degrades to memory and reports it.',
);

export const StoreCorruptError = defineError(
  'SF-STORE-003',
  'validation',
  'A stored value could not be decoded (bad JSON, wrong envelope, failed decryption or failed migration).',
  'The entry was written by something else, by an older/newer format, or with a different key. Delete it, or add a migration to the envelope codec.',
);

export const StoreAbortedError = defineError(
  'SF-STORE-004',
  'aborted',
  'The storage operation was aborted.',
  'Usually expected (scope disposal, navigation). Do not retry aborted work.',
);

export const StoreUnsupportedError = defineError(
  'SF-STORE-005',
  'invariant',
  'The backend does not support this operation or option.',
  'Check `store.capabilities` first; wrap the store with the middleware that adds the feature (e.g. `withTtl()` for `ttlMs`).',
);

export const StoreInvalidInputError = defineError(
  'SF-STORE-006',
  'validation',
  'Invalid key or value: keys are non-empty strings and values must be defined and structured-clone-safe.',
  'Use `delete(key)` instead of storing `undefined`; store plain data (no functions, DOM nodes or class instances).',
);

export const StoreDisposedError = defineError(
  'SF-STORE-007',
  'invariant',
  'The store was used after `dispose()`.',
  'Create stores in the owning scope and stop using them once the scope is disposed.',
);

export const StoreIoError = defineError(
  'SF-STORE-008',
  'unavailable',
  'The storage backend rejected a read or write.',
  'Inspect `cause` and `details.backend`/`details.op`. Transient failures can be retried by the caller; persistent ones should degrade via `fallback([...])`.',
);

function errorName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value)) return undefined;
  const name = (value as { name: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/** True for the quota errors browsers throw (Chrome/Safari `QuotaExceededError`, old Firefox `NS_ERROR_DOM_QUOTA_REACHED`). */
export function isQuotaError(value: unknown): boolean {
  const name = errorName(value);
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code: unknown }).code;
    return code === 22 || code === 1014;
  }
  return false;
}

/** Normalize anything a backend threw into a `SF-STORE-*` error. */
export function toStoreError(value: unknown, backend: string, op: string): SfError {
  if (isSfError(value)) return value;
  const details = { backend, op };
  const name = errorName(value);
  if (name === 'AbortError') return StoreAbortedError({ cause: value, details });
  if (isQuotaError(value)) return StoreQuotaError({ cause: value, details });
  if (name === 'DataCloneError') return StoreInvalidInputError({ cause: value, details, message: 'The value is not structured-clone-safe.' });
  if (name === 'SecurityError' || name === 'InvalidStateError') return StoreUnavailableError({ cause: value, details });
  const message = value instanceof Error ? value.message : String(value);
  return StoreIoError({ cause: value, details, message: `Storage backend "${backend}" failed on ${op}: ${message}` });
}
