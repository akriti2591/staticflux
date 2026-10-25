/**
 * Quota facts and persistence (IF-3.11, D8). Browser storage is best-effort
 * until `navigator.storage.persist()` is granted (S6's throwaway profile had
 * `persisted: false`), so apps request persistence on the first project and
 * check the estimate before large writes.
 */
import { err, ok, type Result } from '@staticflux/core';
import { BlobQuotaError, BlobUnavailableError, toBlobError } from './errors.js';
import type { DirectoryHandleLike } from './fs.js';

export interface StorageManagerLike {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ readonly usage?: number; readonly quota?: number }>;
  getDirectory?(): Promise<DirectoryHandleLike>;
}

/** `navigator.storage` when present. */
export function detectStorageManager(): StorageManagerLike | undefined {
  const storage = (globalThis as unknown as { navigator?: { storage?: StorageManagerLike } }).navigator?.storage;
  return storage ?? undefined;
}

export interface PersistenceResult {
  readonly persisted: boolean;
  /** True when this call asked the browser (it was not persisted before). */
  readonly requested: boolean;
}

/** Ask for persistent storage unless already granted. Never throws. */
export async function requestPersistence(storage: StorageManagerLike | undefined = detectStorageManager()): Promise<Result<PersistenceResult>> {
  if (storage?.persist === undefined) return err(BlobUnavailableError({ message: '`navigator.storage.persist()` is not available.' }));
  try {
    if (storage.persisted !== undefined && (await storage.persisted())) return ok({ persisted: true, requested: false });
    return ok({ persisted: await storage.persist(), requested: true });
  } catch (cause) {
    return err(toBlobError(cause, 'persist'));
  }
}

export interface QuotaFacts {
  readonly usage: number;
  readonly quota: number;
  /** `quota - usage`, never negative. */
  readonly available: number;
  /** `usage / quota` (0 when the quota is unknown). */
  readonly ratio: number;
  readonly persisted: boolean;
}

/** Usage, quota and persistence in one read. */
export async function estimateStorage(storage: StorageManagerLike | undefined = detectStorageManager()): Promise<Result<QuotaFacts>> {
  if (storage?.estimate === undefined) return err(BlobUnavailableError({ message: '`navigator.storage.estimate()` is not available.' }));
  try {
    const estimate = await storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    const persisted = storage.persisted === undefined ? false : await storage.persisted();
    return ok({ usage, quota, available: Math.max(0, quota - usage), ratio: quota > 0 ? usage / quota : 0, persisted });
  } catch (cause) {
    return err(toBlobError(cause, 'estimate'));
  }
}

/**
 * Pre-flight a write of `bytes`: `SF-BLOB-001` when it would leave less than
 * `reserve` bytes (default 64 MiB) free. A pass is advisory: the write itself
 * can still hit the quota.
 */
export function checkQuota(facts: QuotaFacts, bytes: number, reserve = 64 * 1024 * 1024): Result<void> {
  if (facts.quota === 0 || bytes + reserve <= facts.available) return ok();
  return err(
    BlobQuotaError({
      message: `Writing ${bytes} bytes would leave less than ${reserve} bytes of the ${facts.quota}-byte quota.`,
      details: { bytes, available: facts.available, quota: facts.quota, reserve },
    }),
  );
}
