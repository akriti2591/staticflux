/**
 * Blob store errors (`SF-BLOB-*`). Everything in this package returns these as
 * values; nothing throws for an expected failure. Apps map them to their own
 * user-facing codes (Instaflow: `IF-STORE-*`, DOCUMENT-FORMAT §10).
 */
import { defineError, isSfError, type SfError } from '@staticflux/core';

export const BlobQuotaError = defineError(
  'SF-BLOB-001',
  'quota',
  'The storage quota was exceeded; the write was rejected and nothing was published.',
  'Free space (empty the trash, then run GC), call `requestPersistence()` so the browser does not evict, or move the workspace to a folder. Check `estimateStorage()` before large imports.',
);

export const BlobDigestMismatchError = defineError(
  'SF-BLOB-002',
  'validation',
  'An object does not match its digest; it was moved to quarantine and is no longer served.',
  'The bytes were changed outside the store (a folder edited by another program, disk corruption). Re-import the original, or restore the object from another copy; `details.quarantined` names the quarantine path.',
);

export const BlobHeadConflictError = defineError(
  'SF-BLOB-003',
  'conflict',
  'Head compare-and-swap conflict: the head generation changed since it was read.',
  'Re-read the head, re-apply your change to it and retry (`heads.update()` does this). `details.current` holds the generation found.',
);

export const BlobPermissionError = defineError(
  'SF-BLOB-004',
  'forbidden',
  'Write permission for the folder was lost; the store is read-only until permission is granted again.',
  'Call `mirror.regrant()` from a user gesture (a button click) to ask for permission again; reads keep working from the OPFS copy meanwhile.',
);

export const BlobNotFoundError = defineError(
  'SF-BLOB-005',
  'not-found',
  'No object with this digest (or no file with this name) exists in the store.',
  'Show a placeholder and offer to relink the original. A blob referenced by live content should never be missing: check that GC roots include every live head.',
);

export const BlobAbortedError = defineError(
  'SF-BLOB-006',
  'aborted',
  'The blob store operation was aborted; nothing was published.',
  'Usually expected (scope disposal, user cancel). Do not retry aborted work.',
);

export const BlobIoError = defineError(
  'SF-BLOB-007',
  'unavailable',
  'The file system rejected a read or write.',
  'Inspect `cause` and `details.op`/`details.path`. Transient errors (a file busy in another context) can be retried; a persistent failure means the backend is unusable, so degrade to read-only.',
);

export const BlobInvalidInputError = defineError(
  'SF-BLOB-008',
  'validation',
  'Invalid input: a malformed digest, an out-of-bounds range, an empty name or an oversized record.',
  'Digests are `sha256:` plus 64 lowercase hex characters; ranges are `{ start, end }` with 0 <= start <= end <= size; names have no `/`.',
);

export const BlobUnavailableError = defineError(
  'SF-BLOB-009',
  'unavailable',
  'A required browser API is missing (OPFS, sync access handles, Web Locks, `FileSystemFileHandle.move`).',
  'Feature-detect with `detectOpfs()` before creating an OPFS store. Sync access handles exist only in dedicated workers; use `writeMode: "writable"` elsewhere. Chrome desktop supports everything this package needs.',
);

export const BlobHeadTornError = defineError(
  'SF-BLOB-010',
  'validation',
  'A head file could not be decoded (bad JSON or checksum); it was not written by an atomic swap.',
  'Heads are only replaced by temp file + `move()`, so a torn head means something wrote it in place. Restore it from the folder mirror or a backup; do not CAS over it blindly.',
);

export const BlobZipError = defineError(
  'SF-BLOB-011',
  'validation',
  'The input is not a valid zip bundle (missing end of central directory, bad signature, CRC mismatch, or a wrong first `mimetype` entry).',
  'Check the file is the bundle you expect; a truncated download also fails this way. `details.reason` says which check failed.',
);

export const BlobZipUnsupportedError = defineError(
  'SF-BLOB-012',
  'invariant',
  'The zip uses a feature this reader/writer does not support (zip64, encryption, multi-disk, or a method other than STORED/DEFLATE).',
  'Bundles are limited to 65,535 entries and 4 GiB per entry and in total. Split very large exports, or keep large media out of the bundle.',
);

export const BlobDisposedError = defineError(
  'SF-BLOB-013',
  'invariant',
  'The store, journal, leader or mirror was used after `dispose()`.',
  'Create these in the owning scope and stop using them once the scope is disposed.',
);

export const BlobNotLeaderError = defineError(
  'SF-BLOB-014',
  'invariant',
  'A write that only the leader may perform was attempted by a follower (journal append, compaction, head swap of Latest).',
  'Send the write through `leader.commit()`; the leader applies it and acknowledges it. Only the leader session opens the journal.',
);

function errorName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value)) return undefined;
  const name = (value as { name: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/** True for the quota errors browsers throw (`QuotaExceededError`, legacy code 22). */
export function isQuotaExceeded(value: unknown): boolean {
  if (errorName(value) === 'QuotaExceededError') return true;
  if (typeof value === 'object' && value !== null && 'code' in value) return (value as { code: unknown }).code === 22;
  return false;
}

/** Normalize anything a file system call threw into an `SF-BLOB-*` error. */
export function toBlobError(value: unknown, op: string, path?: string): SfError {
  if (isSfError(value)) return value;
  const details = path === undefined ? { op } : { op, path };
  const name = errorName(value);
  if (name === 'AbortError') return BlobAbortedError({ cause: value, details });
  if (isQuotaExceeded(value)) return BlobQuotaError({ cause: value, details });
  if (name === 'NotAllowedError' || name === 'SecurityError') return BlobPermissionError({ cause: value, details });
  if (name === 'NotFoundError') return BlobNotFoundError({ cause: value, details });
  const message = value instanceof Error ? value.message : String(value);
  return BlobIoError({ cause: value, details, message: `File system ${op} failed${path === undefined ? '' : ` on ${path}`}: ${message}` });
}

/** `SF-BLOB-006` when `signal` is aborted, else undefined. */
export function abortedError(signal: AbortSignal | undefined): SfError | undefined {
  return signal?.aborted === true ? BlobAbortedError({ cause: signal.reason }) : undefined;
}
