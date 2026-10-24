/**
 * localStorage / sessionStorage adapters. Values go through a string codec
 * (JSON by default) under a key prefix, so `clear()` only removes this store's
 * entries. Availability is probed with a write (Safari private mode, sandboxed
 * iframes and disabled storage throw on access) → `err(SF-STORE-002)`.
 *
 * Batches are atomic: previous values are captured and restored if any write
 * fails (quota). localStorage reports other tabs' writes via `storage` events.
 */
import { err, ok, type Result } from '@staticflux/core';
import { storeFromDriver } from './base.js';
import { type Codec, jsonCodec } from './codec.js';
import { StoreUnavailableError } from './errors.js';
import type { AsyncStore, Entry, StoreChange } from './types.js';

/** The subset of `Storage` the adapter uses. */
export interface WebStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The subset of a `StorageEvent` the adapter reads. */
export interface StorageEventLike {
  readonly key: string | null;
  readonly newValue: string | null;
  readonly storageArea: unknown;
}

export interface StorageEventSource {
  addEventListener(type: 'storage', listener: (event: StorageEventLike) => void): void;
  removeEventListener(type: 'storage', listener: (event: StorageEventLike) => void): void;
}

export type WebStorageArea = 'local' | 'session';

export interface WebStorageStoreOptions<V> {
  readonly area: WebStorageArea;
  /** Injectable storage area (default `globalThis.localStorage` / `sessionStorage`). */
  readonly storage?: WebStorageLike | null;
  /** Key prefix (default `sf:`). */
  readonly prefix?: string;
  readonly codec?: Codec<V, string>;
  /** Source of `storage` events (default `globalThis` when it has addEventListener). */
  readonly events?: StorageEventSource | null;
}

export const WEB_STORAGE_PREFIX = 'sf:';

/** Return the storage area if it can be read and written, else undefined. */
export function probeWebStorage(get: () => WebStorageLike | null | undefined): WebStorageLike | undefined {
  try {
    const storage = get();
    if (storage === null || storage === undefined) return undefined;
    const probe = `${WEB_STORAGE_PREFIX}__probe__`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}

function defaultArea(area: WebStorageArea): WebStorageLike | undefined {
  const g = globalThis as { localStorage?: WebStorageLike; sessionStorage?: WebStorageLike };
  return area === 'local' ? g.localStorage : g.sessionStorage;
}

function defaultEvents(): StorageEventSource | undefined {
  const g = globalThis as Partial<StorageEventSource>;
  return typeof g.addEventListener === 'function' ? (globalThis as unknown as StorageEventSource) : undefined;
}

export function createWebStorageStore<V = unknown>(options: WebStorageStoreOptions<V>): Result<AsyncStore<V>> {
  const backend = options.area === 'local' ? 'local-storage' : 'session-storage';
  const storage = probeWebStorage(() => (options.storage === undefined ? defaultArea(options.area) : options.storage));
  if (storage === undefined) {
    return err(StoreUnavailableError({ message: `${options.area}Storage is not available.`, details: { backend } }));
  }
  const prefix = options.prefix ?? WEB_STORAGE_PREFIX;
  const codec = options.codec ?? jsonCodec<V>();
  const full = (key: string): string => `${prefix}${key}`;
  const ownKeys = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const name = storage.key(i);
      if (name !== null && name.startsWith(prefix)) out.push(name.slice(prefix.length));
    }
    return out;
  };
  const read = (key: string): Result<V | undefined> => {
    const raw = storage.getItem(full(key));
    return raw === null ? ok(undefined) : codec.decode(raw, key);
  };
  const events = options.events === undefined ? defaultEvents() : (options.events ?? undefined);
  const crossTab = options.area === 'local' && events !== undefined;

  return ok(
    storeFromDriver<V>({
      id: backend,
      capabilities: { atomicBatch: true, ordered: false, crossTabEvents: crossTab, persistent: options.area === 'local', ttl: false },
      get: read,
      has: (key) => ok(storage.getItem(full(key)) !== null),
      set(key, value) {
        const encoded = codec.encode(value, key);
        if (!encoded.ok) return encoded;
        storage.setItem(full(key), encoded.value);
        return ok();
      },
      delete(key) {
        storage.removeItem(full(key));
        return ok();
      },
      clear() {
        for (const key of ownKeys()) storage.removeItem(full(key));
        return ok();
      },
      entries() {
        const out: Entry<V>[] = [];
        for (const key of ownKeys()) {
          const value = read(key);
          if (!value.ok) return value;
          if (value.value !== undefined) out.push([key, value.value]);
        }
        return ok(out);
      },
      batch(ops) {
        const encoded: { key: string; raw: string | null }[] = [];
        for (const op of ops) {
          if (op.type === 'delete') {
            encoded.push({ key: op.key, raw: null });
            continue;
          }
          const value = codec.encode(op.value, op.key);
          if (!value.ok) return value;
          encoded.push({ key: op.key, raw: value.value });
        }
        const previous = new Map<string, string | null>();
        for (const { key } of encoded) if (!previous.has(key)) previous.set(key, storage.getItem(full(key)));
        try {
          for (const { key, raw } of encoded) {
            if (raw === null) storage.removeItem(full(key));
            else storage.setItem(full(key), raw);
          }
        } catch (error) {
          for (const [key, raw] of previous) {
            try {
              if (raw === null) storage.removeItem(full(key));
              else storage.setItem(full(key), raw);
            } catch {
              // best-effort rollback; restoring never grows usage beyond the original
            }
          }
          throw error;
        }
        return ok();
      },
      listen(emit) {
        if (!crossTab || events === undefined) return () => undefined;
        const onStorage = (event: StorageEventLike): void => {
          if (event.storageArea !== storage) return;
          if (event.key === null) {
            emit({ type: 'clear', origin: 'external' });
            return;
          }
          if (!event.key.startsWith(prefix)) return;
          const key = event.key.slice(prefix.length);
          if (event.newValue === null) {
            emit({ type: 'delete', key, origin: 'external' });
            return;
          }
          const decoded = codec.decode(event.newValue, key);
          const change: StoreChange<V> = decoded.ok
            ? { type: 'set', key, value: decoded.value, origin: 'external' }
            : { type: 'set', key, origin: 'external' };
          emit(change);
        };
        events.addEventListener('storage', onStorage);
        return () => events.removeEventListener('storage', onStorage);
      },
    }),
  );
}

export function createLocalStorageStore<V = unknown>(options: Omit<WebStorageStoreOptions<V>, 'area'> = {}): Result<AsyncStore<V>> {
  return createWebStorageStore<V>({ ...options, area: 'local' });
}

export function createSessionStorageStore<V = unknown>(options: Omit<WebStorageStoreOptions<V>, 'area'> = {}): Result<AsyncStore<V>> {
  return createWebStorageStore<V>({ ...options, area: 'session' });
}
