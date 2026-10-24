/**
 * Storage backends for user-data slices (R9.9): memory → IndexedDB → remote
 * sync contract. Backends store `SliceRecord`s under opaque string keys.
 * IndexedDB is feature-detected (Safari private mode, some webviews and
 * test environments lack it) and degrades to memory.
 */
import { AbortedError, err, ok, type Result, sleep } from '@staticflux/core';
import { NetworkError, StorageBackendError, StorageUnavailableError } from './errors.js';
import type { SliceRecord } from './slices.js';

export interface RecordPut {
  readonly key: string;
  readonly record: SliceRecord;
}

/** Local persistence. Writes are batched by the caller: one `write` per flush. */
export interface SliceBackend {
  readonly id: string;
  get(keys: readonly string[]): Promise<Result<Readonly<Record<string, SliceRecord>>>>;
  write(puts: readonly RecordPut[], deletes: readonly string[]): Promise<Result<void>>;
  keys(prefix: string): Promise<Result<readonly string[]>>;
}

/** Remote sync contract (backend mocked; R9.9). */
export interface RemoteSyncPort {
  pull(keys: readonly string[], signal: AbortSignal): Promise<Result<Readonly<Record<string, SliceRecord>>>>;
  push(puts: readonly RecordPut[], signal: AbortSignal): Promise<Result<void>>;
}

// ---------------------------------------------------------------- memory

export interface MemoryBackend extends SliceBackend {
  readonly records: ReadonlyMap<string, SliceRecord>;
  /** Fail the next `times` operations (tests). */
  failNext(times?: number): void;
}

export function createMemoryBackend(initial: Readonly<Record<string, SliceRecord>> = {}): MemoryBackend {
  const records = new Map<string, SliceRecord>(Object.entries(initial));
  let failures = 0;
  const failing = (): boolean => {
    if (failures <= 0) return false;
    failures -= 1;
    return true;
  };
  return {
    id: 'memory',
    records,
    failNext(times = 1) {
      failures = times;
    },
    get(keys) {
      if (failing()) return Promise.resolve(err(StorageBackendError({ details: { backend: 'memory', op: 'get' } })));
      const out: Record<string, SliceRecord> = {};
      for (const key of keys) {
        const record = records.get(key);
        if (record !== undefined) out[key] = structuredCloneSafe(record);
      }
      return Promise.resolve(ok(out));
    },
    write(puts, deletes) {
      if (failing()) return Promise.resolve(err(StorageBackendError({ details: { backend: 'memory', op: 'write' } })));
      for (const put of puts) records.set(put.key, structuredCloneSafe(put.record));
      for (const key of deletes) records.delete(key);
      return Promise.resolve(ok());
    },
    keys(prefix) {
      return Promise.resolve(ok([...records.keys()].filter((k) => k.startsWith(prefix))));
    },
  };
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------- IndexedDB

export interface IndexedDbBackendOptions {
  /** Injectable for tests; default `globalThis.indexedDB`. */
  readonly indexedDB?: IDBFactory;
  readonly dbName?: string;
  readonly storeName?: string;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** IndexedDB backend; `err(SF-DATA-055)` when IndexedDB is not available. */
export function createIndexedDbBackend(options: IndexedDbBackendOptions = {}): Result<SliceBackend> {
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (factory === undefined || typeof factory.open !== 'function') {
    return err(StorageUnavailableError({ message: 'IndexedDB is not available.', details: { backend: 'indexeddb' } }));
  }
  const dbName = options.dbName ?? 'staticflux-user-data';
  const storeName = options.storeName ?? 'slices';
  let opened: Promise<IDBDatabase> | undefined;
  const db = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    }).catch((error: unknown) => {
      opened = undefined;
      throw error;
    });
    return opened;
  };
  const fail = (op: string, error: unknown): Result<never> => err(StorageBackendError({ cause: error, details: { backend: 'indexeddb', op } }));
  return ok({
    id: 'indexeddb',
    async get(keys) {
      try {
        const tx = (await db()).transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const values = await Promise.all(keys.map((key) => request(store.get(key) as IDBRequest<SliceRecord | undefined>)));
        const out: Record<string, SliceRecord> = {};
        keys.forEach((key, i) => {
          const value = values[i];
          if (value !== undefined) out[key] = value;
        });
        return ok(out);
      } catch (error) {
        return fail('get', error);
      }
    },
    async write(puts, deletes) {
      try {
        const tx = (await db()).transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        for (const put of puts) store.put(put.record, put.key);
        for (const key of deletes) store.delete(key);
        await done(tx);
        return ok();
      } catch (error) {
        return fail('write', error);
      }
    },
    async keys(prefix) {
      try {
        const tx = (await db()).transaction(storeName, 'readonly');
        const all = await request(tx.objectStore(storeName).getAllKeys());
        return ok(all.map(String).filter((k) => k.startsWith(prefix)));
      } catch (error) {
        return fail('keys', error);
      }
    },
  });
}

/** Best available local backend: IndexedDB when present, else memory (`degraded: true`). */
export function detectLocalBackend(options: IndexedDbBackendOptions = {}): { readonly backend: SliceBackend; readonly degraded: boolean } {
  const idb = createIndexedDbBackend(options);
  return idb.ok ? { backend: idb.value, degraded: false } : { backend: createMemoryBackend(), degraded: true };
}

// ---------------------------------------------------------------- mock remote sync

export interface MockRemoteSync extends RemoteSyncPort {
  readonly records: ReadonlyMap<string, SliceRecord>;
  /** Simulate a write from another device. */
  put(key: string, record: SliceRecord): void;
  failNext(times?: number): void;
  setOffline(offline: boolean): void;
  readonly pulls: number;
  readonly pushes: number;
}

export function createMockRemoteSync(options: { readonly latencyMs?: number } = {}): MockRemoteSync {
  const records = new Map<string, SliceRecord>();
  let failures = 0;
  let offline = false;
  let pulls = 0;
  let pushes = 0;
  const gate = async (signal: AbortSignal): Promise<Result<void>> => {
    const slept = await sleep(options.latencyMs ?? 0, signal);
    if (!slept.ok) return slept;
    if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
    if (offline) return err(NetworkError({ details: { remote: 'user-data', offline: true } }));
    if (failures > 0) {
      failures -= 1;
      return err(NetworkError({ details: { remote: 'user-data', injected: true } }));
    }
    return ok();
  };
  return {
    records,
    get pulls() {
      return pulls;
    },
    get pushes() {
      return pushes;
    },
    put(key, record) {
      records.set(key, structuredCloneSafe(record));
    },
    failNext(times = 1) {
      failures = times;
    },
    setOffline(value) {
      offline = value;
    },
    async pull(keys, signal) {
      pulls += 1;
      const opened = await gate(signal);
      if (!opened.ok) return opened;
      const out: Record<string, SliceRecord> = {};
      for (const key of keys) {
        const record = records.get(key);
        if (record !== undefined) out[key] = structuredCloneSafe(record);
      }
      return ok(out);
    },
    async push(puts, signal) {
      pushes += 1;
      const opened = await gate(signal);
      if (!opened.ok) return opened;
      for (const put of puts) records.set(put.key, structuredCloneSafe(put.record));
      return ok();
    },
  };
}
