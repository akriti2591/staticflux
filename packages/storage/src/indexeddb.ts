/**
 * IndexedDB adapter: one object store per namespace inside a shared database,
 * native key ranges for `seek`, one readwrite transaction per `batch` (atomic).
 * Other tabs are notified over BroadcastChannel (when present).
 *
 * Written against the minimal structural `Idb*Like` interfaces below so it can
 * be driven by the real `indexedDB` or by `createFakeIndexedDb()` in tests
 * (happy-dom has no IndexedDB). Missing IndexedDB (some webviews, Firefox
 * private mode on old versions) → `err(SF-STORE-002)` at creation; failures to
 * open → `SF-STORE-002` per operation (the connection is retried next call).
 *
 * Adding a namespace to an existing database needs a version upgrade; the
 * adapter reopens with `version + 1` and closes on `versionchange` so other
 * connections never block it.
 */
import { createMachine, defineMachine, err, ok, type Result } from '@staticflux/core';
import { effectiveBounds, storeFromDriver } from './base.js';
import { StoreUnavailableError } from './errors.js';
import { createChangeBroadcast } from './broadcast.js';
import { type AsyncStore, type BroadcastChannelFactory, type Entry, globalBroadcastFactory } from './types.js';

// ---------------------------------------------------------------- minimal IDB shapes

export type IdbHandler = ((event: unknown) => void) | null;

export interface IdbRequestLike<T = unknown> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: IdbHandler;
  onerror: IdbHandler;
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: IdbHandler;
  onblocked: IdbHandler;
}

export interface IdbCursorLike {
  readonly key: unknown;
  readonly value: unknown;
  continue(): void;
}

export interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike;
  put(value: unknown, key: string): IdbRequestLike;
  delete(key: string): IdbRequestLike;
  clear(): IdbRequestLike;
  count(key?: string): IdbRequestLike<number>;
  openCursor(range?: unknown, direction?: 'next' | 'prev'): IdbRequestLike<IdbCursorLike | null>;
}

export interface IdbTransactionLike {
  readonly error: unknown;
  objectStore(name: string): IdbObjectStoreLike;
  abort(): void;
  oncomplete: IdbHandler;
  onerror: IdbHandler;
  onabort: IdbHandler;
}

export interface IdbDatabaseLike {
  readonly version: number;
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(names: string, mode: 'readonly' | 'readwrite'): IdbTransactionLike;
  close(): void;
  onversionchange: IdbHandler;
}

export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

export interface IdbKeyRangeLike {
  bound(lower: string, upper: string, lowerOpen?: boolean, upperOpen?: boolean): unknown;
  lowerBound(lower: string, open?: boolean): unknown;
  upperBound(upper: string, open?: boolean): unknown;
}

// ---------------------------------------------------------------- connection lifecycle

/** Connection lifecycle of the IndexedDB adapter (mirror in docs/LIFECYCLES.md). */
export const IdbConnectionMachine = defineMachine({
  id: 'storage/idb-connection',
  initial: 'closed',
  states: ['closed', 'opening', 'open', 'failed', 'disposed'],
  transitions: {
    closed: { open: 'opening', dispose: 'disposed' },
    opening: { opened: 'open', fail: 'failed', dispose: 'disposed' },
    open: { versionchange: 'closed', dispose: 'disposed' },
    failed: { open: 'opening', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});
export type IdbConnectionState = (typeof IdbConnectionMachine.states)[number];

export interface IndexedDbStoreOptions {
  /** Object store name (one per namespace). */
  readonly namespace: string;
  /** Database name (default `staticflux`). */
  readonly dbName?: string;
  /** Injectable factory (default `globalThis.indexedDB`). */
  readonly indexedDB?: IdbFactoryLike | null;
  /** Injectable `IDBKeyRange` (default `globalThis.IDBKeyRange`). */
  readonly keyRange?: IdbKeyRangeLike | null;
  /** Cross-tab notifications (default global BroadcastChannel; `null` disables). */
  readonly broadcast?: BroadcastChannelFactory | null;
}

export interface IndexedDbStore<V> extends AsyncStore<V> {
  readonly connection: IdbConnectionState;
}

function requestResult<T>(req: IdbRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IdbTransactionLike, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbortSignal = (): void => {
      try {
        tx.abort();
      } catch {
        // already finished
      }
    };
    signal?.addEventListener('abort', onAbortSignal, { once: true });
    const settle = (error?: unknown): void => {
      signal?.removeEventListener('abort', onAbortSignal);
      if (error === undefined) resolve();
      else reject(error);
    };
    tx.oncomplete = () => settle();
    tx.onerror = () => settle(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () =>
      settle(signal?.aborted === true ? Object.assign(new Error('aborted'), { name: 'AbortError' }) : (tx.error ?? new Error('IndexedDB transaction aborted')));
  });
}

export function createIndexedDbStore<V = unknown>(options: IndexedDbStoreOptions): Result<IndexedDbStore<V>> {
  const g = globalThis as { indexedDB?: IdbFactoryLike; IDBKeyRange?: IdbKeyRangeLike };
  const factory = options.indexedDB === undefined ? g.indexedDB : (options.indexedDB ?? undefined);
  const keyRange = options.keyRange === undefined ? g.IDBKeyRange : (options.keyRange ?? undefined);
  if (factory === undefined || typeof factory.open !== 'function' || keyRange === undefined) {
    return err(StoreUnavailableError({ message: 'IndexedDB is not available.', details: { backend: 'indexeddb' } }));
  }
  const dbName = options.dbName ?? 'staticflux';
  const ns = options.namespace;
  const machine = createMachine(IdbConnectionMachine);
  let connecting: Promise<IdbDatabaseLike> | undefined;
  let database: IdbDatabaseLike | undefined;

  const openDb = (version?: number): Promise<IdbDatabaseLike> =>
    new Promise<IdbDatabaseLike>((resolve, reject) => {
      const req = version === undefined ? factory.open(dbName) : factory.open(dbName, version);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(ns)) req.result.createObjectStore(ns);
      };
      req.onblocked = () => undefined; // other connections close on versionchange; keep waiting
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });

  const connect = async (): Promise<IdbDatabaseLike> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        let db = await openDb();
        if (!db.objectStoreNames.contains(ns)) {
          const next = db.version + 1;
          db.close();
          db = await openDb(next);
        }
        return db;
      } catch (error) {
        // VersionError: another namespace upgraded concurrently; retry from the current version
        if ((error as { name?: unknown } | null)?.name !== 'VersionError') throw error;
        lastError = error;
      }
    }
    throw lastError;
  };

  const db = (): Promise<IdbDatabaseLike> => {
    if (database !== undefined) return Promise.resolve(database);
    if (connecting !== undefined) return connecting;
    machine.send('open');
    connecting = connect().then(
      (opened) => {
        connecting = undefined;
        if (machine.is('disposed')) {
          opened.close();
          throw StoreUnavailableError({ message: 'IndexedDB store was disposed.', details: { backend: 'indexeddb' } });
        }
        database = opened;
        machine.send('opened');
        opened.onversionchange = () => {
          opened.close();
          database = undefined;
          if (machine.is('open')) machine.send('versionchange');
        };
        return opened;
      },
      (error: unknown) => {
        connecting = undefined;
        if (!machine.is('disposed')) machine.send('fail');
        throw StoreUnavailableError({ cause: error, message: `Could not open IndexedDB "${dbName}".`, details: { backend: 'indexeddb', op: 'open' } });
      },
    );
    return connecting;
  };

  const run = async <T>(
    mode: 'readonly' | 'readwrite',
    signal: AbortSignal | undefined,
    body: (store: IdbObjectStoreLike) => Promise<T> | T,
  ): Promise<Result<T>> => {
    const opened = await db();
    const tx = opened.transaction(ns, mode);
    const done = transactionDone(tx, signal);
    let value: T;
    try {
      value = await body(tx.objectStore(ns));
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      done.catch(() => undefined);
      throw error;
    }
    await done;
    return ok(value);
  };

  const range = (lower: string | undefined, upper: string | undefined): unknown => {
    if (lower !== undefined && upper !== undefined) return keyRange.bound(lower, upper, false, true);
    if (lower !== undefined) return keyRange.lowerBound(lower);
    if (upper !== undefined) return keyRange.upperBound(upper, true);
    return undefined;
  };

  const broadcastFactory = options.broadcast === undefined ? globalBroadcastFactory() : (options.broadcast ?? undefined);
  const broadcast = createChangeBroadcast<V>(broadcastFactory, `sf-store:${dbName}/${ns}`);

  const store = storeFromDriver<V>({
    id: 'indexeddb',
    capabilities: { atomicBatch: true, ordered: true, crossTabEvents: broadcast.available, persistent: true, ttl: false },
    get: (key, signal) => run('readonly', signal, async (s) => (await requestResult(s.get(key))) as V | undefined),
    has: (key, signal) => run('readonly', signal, async (s) => (await requestResult(s.count(key))) > 0),
    set: (key, value, _ttl, signal) =>
      run('readwrite', signal, (s) => {
        s.put(value, key);
      }),
    delete: (key, signal) =>
      run('readwrite', signal, (s) => {
        s.delete(key);
      }),
    clear: (signal) =>
      run('readwrite', signal, (s) => {
        s.clear();
      }),
    batch: (ops, signal) =>
      run('readwrite', signal, (s) => {
        for (const op of ops) {
          if (op.type === 'set') s.put(op.value, op.key);
          else s.delete(op.key);
        }
      }),
    entries(seek, signal) {
      const { lower, upper } = effectiveBounds(seek);
      if (lower !== undefined && upper !== undefined && lower >= upper) return ok([]);
      return run('readonly', signal, (s) =>
        new Promise<Entry<V>[]>((resolve, reject) => {
          const out: Entry<V>[] = [];
          const req = s.openCursor(range(lower, upper), seek.reverse === true ? 'prev' : 'next');
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor === null || (seek.limit !== undefined && out.length >= seek.limit)) {
              resolve(out);
              return;
            }
            out.push([String(cursor.key), cursor.value as V]);
            cursor.continue();
          };
          req.onerror = () => reject(req.error ?? new Error('IndexedDB cursor failed'));
        }),
      );
    },
    afterChange: (change) => broadcast.publish(change),
    listen: (emit) => broadcast.listen(emit),
    dispose() {
      machine.send('dispose');
      database?.close();
      database = undefined;
      broadcast.close();
    },
  });
  return ok(
    Object.defineProperty(store, 'connection', { get: () => machine.state, enumerable: true }) as IndexedDbStore<V>,
  );
}

