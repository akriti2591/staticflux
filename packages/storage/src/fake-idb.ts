/**
 * A small in-memory IndexedDB implementing the `Idb*Like` interfaces with the
 * semantics the adapter relies on: async requests, versioned opens with
 * `upgradeneeded`, `versionchange` to other connections, transactions that
 * auto-commit when idle and abort atomically on error, key ranges and cursors.
 * For tests (happy-dom has no IndexedDB) and non-browser hosts. Not a full IDB.
 */
import { cloneValue, utf8Bytes } from './base.js';
import type {
  IdbCursorLike,
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbHandler,
  IdbKeyRangeLike,
  IdbObjectStoreLike,
  IdbOpenRequestLike,
  IdbRequestLike,
  IdbTransactionLike,
} from './indexeddb.js';

interface FakeRange {
  readonly lower: string | undefined;
  readonly upper: string | undefined;
  readonly lowerOpen: boolean;
  readonly upperOpen: boolean;
}

interface FakeDatabaseState {
  version: number;
  readonly stores: Map<string, Map<string, unknown>>;
  readonly connections: Set<IdbDatabaseLike & { closed: boolean }>;
}

export type FakeIdbOp = 'open' | 'get' | 'put' | 'delete' | 'clear' | 'count' | 'cursor' | 'commit';

export interface FakeIndexedDb extends IdbFactoryLike {
  readonly keyRange: IdbKeyRangeLike;
  readonly databases: ReadonlyMap<string, { readonly version: number; readonly stores: ReadonlyMap<string, ReadonlyMap<string, unknown>> }>;
  /** Fail the next `times` operations of kind `op`. */
  failNext(op: FakeIdbOp, times?: number): void;
  /** Total bytes (JSON) allowed across all databases; exceeding puts fail with QuotaExceededError. */
  quotaBytes: number | undefined;
  readonly opens: number;
}

function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

const defer = (fn: () => void): void => {
  queueMicrotask(fn);
};

function makeRequest<T>(): IdbRequestLike<T> & { result: T; error: unknown; succeed(value: T): void; fail(error: unknown): void } {
  const req = {
    result: undefined as T,
    error: null as unknown,
    onsuccess: null as IdbHandler,
    onerror: null as IdbHandler,
    succeed(value: T) {
      req.result = value;
      req.onsuccess?.({ target: req });
    },
    fail(error: unknown) {
      req.error = error;
      req.onerror?.({ target: req });
    },
  };
  return req;
}

function inFakeRange(key: string, range: unknown): boolean {
  if (range === undefined || range === null) return true;
  const r = range as FakeRange;
  if (r.lower !== undefined && (r.lowerOpen ? key <= r.lower : key < r.lower)) return false;
  if (r.upper !== undefined && (r.upperOpen ? key >= r.upper : key > r.upper)) return false;
  return true;
}

export function createFakeIndexedDb(): FakeIndexedDb {
  const databases = new Map<string, FakeDatabaseState>();
  const failures = new Map<FakeIdbOp, number>();
  let opens = 0;
  const shouldFail = (op: FakeIdbOp): boolean => {
    const left = failures.get(op) ?? 0;
    if (left <= 0) return false;
    failures.set(op, left - 1);
    return true;
  };
  const totalBytes = (): number => {
    let total = 0;
    for (const db of databases.values()) for (const store of db.stores.values()) for (const [k, v] of store) total += utf8Bytes(k) + utf8Bytes(JSON.stringify(v) ?? '');
    return total;
  };

  const keyRange: IdbKeyRangeLike = {
    bound: (lower, upper, lowerOpen = false, upperOpen = false) => {
      if (lower > upper) throw domError('DataError', 'lower > upper');
      return { lower, upper, lowerOpen, upperOpen } satisfies FakeRange;
    },
    lowerBound: (lower, open = false) => ({ lower, upper: undefined, lowerOpen: open, upperOpen: false }) satisfies FakeRange,
    upperBound: (upper, open = false) => ({ lower: undefined, upper, lowerOpen: false, upperOpen: open }) satisfies FakeRange,
  };

  const fake: FakeIndexedDb = {
    keyRange,
    databases,
    quotaBytes: undefined,
    get opens() {
      return opens;
    },
    failNext(op, times = 1) {
      failures.set(op, times);
    },
    open(name, version) {
      opens += 1;
      const req = makeRequest<IdbDatabaseLike>() as ReturnType<typeof makeRequest<IdbDatabaseLike>> & IdbOpenRequestLike;
      req.onupgradeneeded = null;
      req.onblocked = null;
      defer(() => {
        if (shouldFail('open')) {
          req.fail(domError('UnknownError', 'injected open failure'));
          return;
        }
        let state = databases.get(name);
        const current = state?.version ?? 0;
        const target = version ?? Math.max(current, 1);
        if (target < current) {
          req.fail(domError('VersionError', `Requested version ${target} < ${current}`));
          return;
        }
        if (state === undefined) {
          state = { version: 0, stores: new Map(), connections: new Set() };
          databases.set(name, state);
        }
        const db = connection(state);
        if (target > current) {
          for (const other of state.connections) if (other !== db && !other.closed) other.onversionchange?.({ type: 'versionchange' });
          state.version = target;
          upgrading = true;
          req.result = db;
          try {
            req.onupgradeneeded?.({ target: req });
          } finally {
            upgrading = false;
          }
        }
        req.succeed(db);
      });
      return req;
    },
  };

  let upgrading = false;

  function connection(state: FakeDatabaseState): IdbDatabaseLike & { closed: boolean } {
    const db: IdbDatabaseLike & { closed: boolean } = {
      closed: false,
      get version() {
        return state.version;
      },
      objectStoreNames: { contains: (storeName: string) => state.stores.has(storeName) },
      onversionchange: null,
      createObjectStore(storeName) {
        if (!upgrading) throw domError('InvalidStateError', 'createObjectStore outside upgrade');
        state.stores.set(storeName, new Map());
        return {};
      },
      close() {
        db.closed = true;
        state.connections.delete(db);
      },
      transaction(storeName, mode) {
        if (db.closed) throw domError('InvalidStateError', 'The database connection is closing.');
        const data = state.stores.get(storeName);
        if (data === undefined) throw domError('NotFoundError', `No object store "${storeName}"`);
        return transaction(data, mode);
      },
    };
    state.connections.add(db);
    return db;
  }

  function transaction(data: Map<string, unknown>, mode: 'readonly' | 'readwrite'): IdbTransactionLike {
    let stage: Map<string, unknown> | undefined;
    let pending = 0;
    let finished = false;
    const view = (): Map<string, unknown> => stage ?? data;
    const writable = (): Map<string, unknown> => {
      if (mode !== 'readwrite') throw domError('ReadOnlyError', 'Transaction is read-only');
      stage ??= new Map(data);
      return stage;
    };
    const tx: IdbTransactionLike & { error: unknown } = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort() {
        if (finished) throw domError('InvalidStateError', 'Transaction finished');
        finished = true;
        stage = undefined;
        tx.error ??= domError('AbortError', 'Transaction aborted');
        defer(() => tx.onabort?.({ target: tx }));
      },
      objectStore: () => store,
    };
    const scheduleCommit = (): void => {
      setTimeout(() => {
        if (finished || pending > 0) return;
        finished = true;
        if (shouldFail('commit')) {
          stage = undefined;
          tx.error = domError('UnknownError', 'injected commit failure');
          tx.onabort?.({ target: tx });
          return;
        }
        if (stage !== undefined) {
          data.clear();
          for (const [k, v] of stage) data.set(k, v);
        }
        tx.oncomplete?.({ target: tx });
      }, 0);
    };
    const issue = <T>(op: FakeIdbOp, work: () => T): IdbRequestLike<T> => {
      if (finished) throw domError('TransactionInactiveError', 'Transaction is not active');
      const req = makeRequest<T>();
      pending += 1;
      defer(() => {
        pending -= 1;
        if (finished) return;
        let value: T;
        try {
          if (shouldFail(op)) throw domError('UnknownError', `injected ${op} failure`);
          value = work();
        } catch (error) {
          req.fail(error);
          if (!finished) {
            finished = true;
            stage = undefined;
            tx.error = error;
            tx.onerror?.({ target: tx });
          }
          return;
        }
        req.succeed(value);
        if (pending === 0) scheduleCommit();
      });
      return req;
    };
    const store: IdbObjectStoreLike = {
      get: (key) => issue('get', () => (view().has(key) ? cloneValue(view().get(key)) : undefined)),
      count: (key) => issue('count', () => (key === undefined ? view().size : view().has(key) ? 1 : 0)),
      put(value, key) {
        const copy = cloneValue(value); // DataCloneError is synchronous, like real IndexedDB
        return issue('put', () => {
          const target = writable();
          if (fake.quotaBytes !== undefined) {
            const bytes = totalBytes() + utf8Bytes(key) + utf8Bytes(JSON.stringify(copy) ?? '');
            if (bytes > fake.quotaBytes) throw domError('QuotaExceededError', 'quota exceeded');
          }
          target.set(key, copy);
          return key;
        });
      },
      delete: (key) =>
        issue('delete', () => {
          writable().delete(key);
          return undefined;
        }),
      clear: () =>
        issue('clear', () => {
          writable().clear();
          return undefined;
        }),
      openCursor(range, direction = 'next') {
        const keys = [...view().keys()].filter((k) => inFakeRange(k, range)).sort();
        if (direction === 'prev') keys.reverse();
        let index = 0;
        const req = issue<IdbCursorLike | null>('cursor', () => next());
        const next = (): IdbCursorLike | null => {
          const key = keys[index];
          if (key === undefined) return null;
          return {
            key,
            value: cloneValue(view().get(key)),
            continue() {
              index += 1;
              pending += 1;
              defer(() => {
                pending -= 1;
                if (finished) return;
                (req as ReturnType<typeof makeRequest<IdbCursorLike | null>>).succeed(next());
                if (pending === 0) scheduleCommit();
              });
            },
          };
        };
        return req;
      },
    };
    // a transaction with no requests still completes
    defer(() => {
      if (pending === 0) scheduleCommit();
    });
    return tx;
  }

  return fake;
}
