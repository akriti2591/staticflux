/**
 * Storage port. Async so an IndexedDB/OPFS adapter implements the same
 * interface (archives, large drafts); the built-ins are memory and Web Storage.
 * Web Storage is feature-detected with a write probe: Safari private mode,
 * sandboxed iframes (embedded hosts) and disabled storage throw on access, and
 * those scopes degrade to memory (reported in `degraded`).
 */
import { defineError, err, ok, type Result } from '@staticflux/core';
import type { SnapshotEnvelope } from './envelope.js';
import type { HandoffScope } from './slot.js';

export const StorageFailedError = defineError(
  'SF-HANDOFF-006',
  'unavailable',
  'The handoff storage rejected a read or write (quota, disabled storage, serialization).',
  'Keep handoff payloads small (ids, not documents); large snapshots belong in an IndexedDB-backed storage.',
);

export interface HandoffStorage {
  /** e.g. `memory`, `session-storage`, `local-storage`, `indexeddb`. */
  readonly kind: string;
  /** Survives a reload. */
  readonly durable: boolean;
  /** Raw stored value (`undefined` when absent). Validated by the store. */
  read(key: string): Promise<Result<unknown>>;
  write(key: string, envelope: SnapshotEnvelope): Promise<Result<void>>;
  remove(key: string): Promise<Result<void>>;
  keys(): Promise<Result<readonly string[]>>;
}

export interface HandoffStorages {
  readonly memory: HandoffStorage;
  readonly tab: HandoffStorage;
  readonly origin: HandoffStorage;
  /** Scopes that fell back to memory because their storage is unavailable. */
  readonly degraded: readonly HandoffScope[];
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** In-memory storage. Values are cloned on write and read, like a real storage. */
export function createMemoryStorage(kind = 'memory'): HandoffStorage {
  const entries = new Map<string, SnapshotEnvelope>();
  return {
    kind,
    durable: false,
    async read(key) {
      const value = entries.get(key);
      return ok(value === undefined ? undefined : clone(value));
    },
    async write(key, envelope) {
      try {
        entries.set(key, clone(envelope));
        return ok();
      } catch (error) {
        return err(StorageFailedError({ cause: error, message: `Handoff payload for "${key}" is not cloneable.` }));
      }
    },
    async remove(key) {
      entries.delete(key);
      return ok();
    },
    async keys() {
      return ok([...entries.keys()]);
    },
  };
}

export const STORAGE_PREFIX = 'sf-handoff:';

/** Adapter over a Web Storage area (session/local). Keys are prefixed. */
export function createWebStorage(storage: Storage, kind: string): HandoffStorage {
  const full = (key: string): string => `${STORAGE_PREFIX}${key}`;
  return {
    kind,
    durable: true,
    async read(key) {
      let raw: string | null;
      try {
        raw = storage.getItem(full(key));
      } catch (error) {
        return err(StorageFailedError({ cause: error }));
      }
      if (raw === null) return ok(undefined);
      try {
        return ok(JSON.parse(raw) as unknown);
      } catch {
        return ok(raw); // not JSON: the store rejects it as malformed and removes it
      }
    },
    async write(key, envelope) {
      try {
        storage.setItem(full(key), JSON.stringify(envelope));
        return ok();
      } catch (error) {
        return err(StorageFailedError({ cause: error, message: `Could not write handoff entry "${key}": ${String(error)}` }));
      }
    },
    async remove(key) {
      try {
        storage.removeItem(full(key));
        return ok();
      } catch (error) {
        return err(StorageFailedError({ cause: error }));
      }
    },
    async keys() {
      try {
        const out: string[] = [];
        for (let i = 0; i < storage.length; i += 1) {
          const name = storage.key(i);
          if (name?.startsWith(STORAGE_PREFIX) === true) out.push(name.slice(STORAGE_PREFIX.length));
        }
        return ok(out);
      } catch (error) {
        return err(StorageFailedError({ cause: error }));
      }
    },
  };
}

/** Return the storage area if it can be read and written, else undefined. */
export function probeWebStorage(get: () => Storage | null | undefined): Storage | undefined {
  try {
    const storage = get();
    if (storage === null || storage === undefined) return undefined;
    const probe = `${STORAGE_PREFIX}__probe__`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}

/** Detect storages from globals; unavailable areas degrade to memory. */
export function detectHandoffStorages(global: typeof globalThis = globalThis): HandoffStorages {
  const memory = createMemoryStorage();
  const session = probeWebStorage(() => global.sessionStorage);
  const local = probeWebStorage(() => global.localStorage);
  const degraded: HandoffScope[] = [];
  if (session === undefined) degraded.push('tab');
  if (local === undefined) degraded.push('origin');
  const tab = session === undefined ? createMemoryStorage('memory(tab)') : createWebStorage(session, 'session-storage');
  const origin = local === undefined ? createMemoryStorage('memory(origin)') : createWebStorage(local, 'local-storage');
  return { memory, tab, origin, degraded };
}

/** All-memory storages (embedded hosts without storage, tests). */
export function memoryHandoffStorages(): HandoffStorages {
  return { memory: createMemoryStorage(), tab: createMemoryStorage('memory(tab)'), origin: createMemoryStorage('memory(origin)'), degraded: ['tab', 'origin'] };
}
