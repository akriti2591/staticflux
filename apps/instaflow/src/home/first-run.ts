/**
 * First run (B11c; HOME-FILES §1.4) and the storage facts Home shows (§4): no tour, no questionnaire. The first visit to
 * `/` shows one welcome card (`Keep my designs on this device` asks `navigator.storage.persist()` on the gesture, which
 * Chrome grants more readily than at boot) and a one-line hint under the formats row. The seen state lives in
 * `instaflow/ui/first-run` on this device; Settings › General › `Reset hints` clears it.
 *
 * `StoragePort` is the platform's `navigator.storage` (structurally), injectable for tests.
 */

export const FIRST_RUN_KEY = 'instaflow/ui/first-run';

/** What this device remembers about the first run. */
export interface FirstRunState {
  /** The welcome card was answered or dismissed (it is gone on the next visit). */
  readonly seen: boolean;
}

export function readFirstRun(storage: Pick<Storage, 'getItem'> | undefined): FirstRunState {
  try {
    return { seen: storage?.getItem(FIRST_RUN_KEY) === 'seen' };
  } catch {
    // Unreadable storage: treat the device as seen, so the card never nags on every visit.
    return { seen: true };
  }
}

export function markFirstRunSeen(storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(FIRST_RUN_KEY, 'seen');
  } catch {
    // A convenience only.
  }
}

/** Forget the first run (Settings › General › Reset hints). */
export function resetFirstRun(storage: Pick<Storage, 'removeItem'> | undefined): void {
  try {
    storage?.removeItem(FIRST_RUN_KEY);
  } catch {
    // A convenience only.
  }
}

/** Structurally `navigator.storage` (what Home asks). */
export interface StoragePort {
  estimate?(): Promise<{ readonly usage?: number; readonly quota?: number }>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

/** What Home's footer and Settings › Storage show. */
export interface StorageFacts {
  /** Bytes used by this origin (undefined: the browser does not say). */
  readonly usage: number | undefined;
  readonly quota: number | undefined;
  /** The browser promised not to clear this workspace under storage pressure. */
  readonly persisted: boolean | undefined;
}

export function browserStorage(): StoragePort | undefined {
  return (globalThis as { navigator?: { storage?: StoragePort } }).navigator?.storage;
}

/** Read the facts (each one tolerant: a failing call leaves its fact unknown). */
export async function readStorageFacts(port: StoragePort | undefined): Promise<StorageFacts> {
  const estimate = await port?.estimate?.().catch(() => undefined);
  const persisted = await port?.persisted?.().catch(() => undefined);
  return { usage: estimate?.usage, quota: estimate?.quota, persisted };
}

/** Ask for persistent storage (call from a click: the gesture matters). False when refused or unavailable. */
export async function requestPersistence(port: StoragePort | undefined): Promise<boolean> {
  try {
    return (await port?.persist?.()) === true;
  } catch {
    return false;
  }
}

/** `1 234 567` bytes → `1.2 MB` (decimal units, one decimal from MB up; the locale's number format). */
export function formatBytes(bytes: number, locale?: string): string {
  const UNITS: readonly (readonly [string, number])[] = [
    ['GB', 1e9],
    ['MB', 1e6],
    ['KB', 1e3],
  ];
  for (const [unit, size] of UNITS) {
    if (bytes >= size) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 'KB' ? 0 : 1 }).format(bytes / size)} ${unit}`;
  }
  return `${new Intl.NumberFormat(locale).format(Math.max(0, Math.round(bytes)))} B`;
}
