/**
 * The shared base every adapter is built on: a backend implements a small
 * `StoreDriver` (raw get/set/delete/clear/entries, optional atomic batch and
 * external-change feed) and `storeFromDriver` adds the contract: input
 * validation, abort/dispose guards, error normalization, sorted/filtered seek,
 * non-atomic batch fallback and `watch` (local + external changes).
 *
 * Middleware authors use `createCursor`, `filterEntries`, `createWatchers` and
 * `guard` to implement the same semantics without duplicating them.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { StoreAbortedError, StoreDisposedError, StoreInvalidInputError, StoreUnsupportedError, toStoreError } from './errors.js';
import type {
  AsyncStore,
  BatchOp,
  Entry,
  KeyRange,
  OpOptions,
  SeekOptions,
  StoreCapabilities,
  StoreChange,
  StoreCursor,
  StoreListener,
  WatchOptions,
} from './types.js';

// ---------------------------------------------------------------- key ranges

export function inRange(key: string, range: KeyRange): boolean {
  if (range.prefix !== undefined && !key.startsWith(range.prefix)) return false;
  if (range.gte !== undefined && key < range.gte) return false;
  if (range.lt !== undefined && key >= range.lt) return false;
  return true;
}

/** Filter, sort (code-unit order), reverse and limit entries per `SeekOptions`. */
export function filterEntries<V>(entries: Iterable<Entry<V>>, options: SeekOptions = {}): Entry<V>[] {
  const out: Entry<V>[] = [];
  for (const entry of entries) if (inRange(entry[0], options)) out.push(entry);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (options.reverse === true) out.reverse();
  return options.limit === undefined ? out : out.slice(0, Math.max(0, options.limit));
}

/** Smallest string greater than every string starting with `prefix` (undefined = no upper bound). */
export function prefixUpperBound(prefix: string): string | undefined {
  for (let i = prefix.length - 1; i >= 0; i -= 1) {
    const code = prefix.charCodeAt(i);
    if (code < 0xffff) return prefix.slice(0, i) + String.fromCharCode(code + 1);
  }
  return undefined;
}

/** Collapse prefix/gte/lt into one [lower, upper) range. */
export function effectiveBounds(range: KeyRange): { readonly lower: string | undefined; readonly upper: string | undefined } {
  let lower = range.gte;
  let upper = range.lt;
  if (range.prefix !== undefined && range.prefix !== '') {
    if (lower === undefined || range.prefix > lower) lower = range.prefix;
    const prefixUpper = prefixUpperBound(range.prefix);
    if (prefixUpper !== undefined && (upper === undefined || prefixUpper < upper)) upper = prefixUpper;
  }
  return { lower, upper };
}

// ---------------------------------------------------------------- cursors

/** A cursor over a lazily loaded, already filtered entry list. Each iteration reloads. */
export function createCursor<V>(load: () => Promise<Result<readonly Entry<V>[]>>): StoreCursor<V> {
  let lastError: SfError | undefined;
  const run = async (): Promise<Result<readonly Entry<V>[]>> => {
    let loaded: Result<readonly Entry<V>[]>;
    try {
      loaded = await load();
    } catch (error) {
      loaded = err(toStoreError(error, 'cursor', 'seek'));
    }
    lastError = loaded.ok ? undefined : loaded.error;
    return loaded;
  };
  return {
    get error() {
      return lastError;
    },
    toArray: run,
    async keys() {
      const loaded = await run();
      return loaded.ok ? ok(loaded.value.map((entry) => entry[0])) : loaded;
    },
    async *[Symbol.asyncIterator]() {
      const loaded = await run();
      if (!loaded.ok) return;
      yield* loaded.value;
    },
  };
}

// ---------------------------------------------------------------- watchers

export interface Watchers<V> {
  add(listener: StoreListener<V>, options?: WatchOptions): () => void;
  emit(change: StoreChange<V>): void;
  readonly size: number;
  clear(): void;
}

/** Listener set with prefix filtering. A throwing listener never breaks the others. */
export function createWatchers<V>(onFirst?: () => void, onLast?: () => void): Watchers<V> {
  const listeners = new Map<StoreListener<V>, WatchOptions>();
  return {
    get size() {
      return listeners.size;
    },
    add(listener, options = {}) {
      const wrapped: StoreListener<V> = (change) => listener(change);
      listeners.set(wrapped, options);
      if (listeners.size === 1) onFirst?.();
      return () => {
        if (!listeners.delete(wrapped)) return;
        if (listeners.size === 0) onLast?.();
      };
    },
    emit(change) {
      for (const [listener, options] of [...listeners]) {
        if (change.type !== 'clear' && options.prefix !== undefined && !change.key.startsWith(options.prefix)) continue;
        try {
          listener(change);
        } catch {
          // listeners are notifications; a failing one must not affect storage or other listeners
        }
      }
    },
    clear() {
      const had = listeners.size > 0;
      listeners.clear();
      if (had) onLast?.();
    },
  };
}

// ---------------------------------------------------------------- guards

export function validateKey(key: unknown): Result<void> {
  if (typeof key !== 'string' || key.length === 0) {
    return err(StoreInvalidInputError({ message: 'Storage keys must be non-empty strings.', details: { key: String(key) } }));
  }
  return ok();
}

export function validateValue(key: string, value: unknown): Result<void> {
  if (value === undefined) {
    return err(StoreInvalidInputError({ message: `Cannot store undefined under "${key}"; use delete().`, details: { key } }));
  }
  return ok();
}

export function abortedResult(signal: AbortSignal | undefined): Result<never> | undefined {
  return signal?.aborted === true ? err(StoreAbortedError({ cause: signal.reason })) : undefined;
}

/** Shared guard: disposed → SF-STORE-007, aborted → SF-STORE-004. */
export function guard(disposed: boolean, id: string, signal: AbortSignal | undefined): Result<void> {
  if (disposed) return err(StoreDisposedError({ details: { store: id } }));
  return abortedResult(signal) ?? ok();
}

export function validateBatch<V>(ops: readonly BatchOp<V>[]): Result<void> {
  for (const op of ops) {
    const key = validateKey(op.key);
    if (!key.ok) return key;
    if (op.type === 'set') {
      const value = validateValue(op.key, op.value);
      if (!value.ok) return value;
    }
  }
  return ok();
}

// ---------------------------------------------------------------- driver → store

type Maybe<T> = Promise<Result<T>> | Result<T>;

export interface StoreDriver<V> {
  readonly id: string;
  readonly capabilities: StoreCapabilities;
  get(key: string, signal: AbortSignal | undefined): Maybe<V | undefined>;
  set(key: string, value: V, ttlMs: number | undefined, signal: AbortSignal | undefined): Maybe<void>;
  delete(key: string, signal: AbortSignal | undefined): Maybe<void>;
  clear(signal: AbortSignal | undefined): Maybe<void>;
  /** Entries matching the range hint; may be unsorted or a superset (the base filters and sorts). */
  entries(options: SeekOptions, signal: AbortSignal | undefined): Maybe<readonly Entry<V>[]>;
  has?(key: string, signal: AbortSignal | undefined): Maybe<boolean>;
  /** Atomic batch; when absent the base applies ops one by one. */
  batch?(ops: readonly BatchOp<V>[], signal: AbortSignal | undefined): Maybe<void>;
  /** Feed of changes made elsewhere (other tabs); called while at least one watcher exists. */
  listen?(emit: (change: StoreChange<V>) => void): () => void;
  /** Called after every successful local mutation (e.g. to broadcast to other tabs). */
  afterChange?(change: StoreChange<V>): void;
  dispose?(): void | Promise<void>;
}

async function call<T>(driverId: string, op: string, fn: () => Maybe<T>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (error) {
    return err(toStoreError(error, driverId, op));
  }
}

/** Build a contract-complete `AsyncStore` from a driver. */
export function storeFromDriver<V>(driver: StoreDriver<V>): AsyncStore<V> {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const watchers = createWatchers<V>(
    () => {
      if (driver.listen !== undefined) unlisten = driver.listen((change) => watchers.emit(change));
    },
    () => {
      unlisten?.();
      unlisten = undefined;
    },
  );
  const changed = (change: StoreChange<V>): void => {
    driver.afterChange?.(change);
    watchers.emit(change);
  };
  const id = driver.id;
  const ttlSupported = (ttlMs: number | undefined): Result<void> =>
    ttlMs !== undefined && !driver.capabilities.ttl
      ? err(StoreUnsupportedError({ message: `Backend "${id}" does not support ttlMs; wrap it with withTtl().`, details: { backend: id } }))
      : ok();

  const store: AsyncStore<V> = {
    id,
    capabilities: driver.capabilities,
    async get(key, options: OpOptions = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const valid = validateKey(key);
      if (!valid.ok) return valid;
      const result = await call(id, 'get', () => driver.get(key, options.signal));
      return abortedResult(options.signal) ?? result;
    },
    async set(key, value, options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const valid = validateKey(key);
      if (!valid.ok) return valid;
      const validValue = validateValue(key, value);
      if (!validValue.ok) return validValue;
      const ttl = ttlSupported(options.ttlMs);
      if (!ttl.ok) return ttl;
      const result = await call(id, 'set', () => driver.set(key, value, options.ttlMs, options.signal));
      if (result.ok) changed({ type: 'set', key, value, origin: 'local' });
      return result;
    },
    async delete(key, options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const valid = validateKey(key);
      if (!valid.ok) return valid;
      const result = await call(id, 'delete', () => driver.delete(key, options.signal));
      if (result.ok) changed({ type: 'delete', key, origin: 'local' });
      return result;
    },
    async has(key, options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const valid = validateKey(key);
      if (!valid.ok) return valid;
      if (driver.has !== undefined) {
        const has = driver.has.bind(driver);
        return call(id, 'has', () => has(key, options.signal));
      }
      const got = await call(id, 'has', () => driver.get(key, options.signal));
      return got.ok ? ok(got.value !== undefined) : got;
    },
    async clear(options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const result = await call(id, 'clear', () => driver.clear(options.signal));
      if (result.ok) changed({ type: 'clear', origin: 'local' });
      return result;
    },
    seek(options = {}) {
      return createCursor(async () => {
        const ready = guard(disposed, id, options.signal);
        if (!ready.ok) return ready;
        const loaded = await call(id, 'seek', () => driver.entries(options, options.signal));
        if (!loaded.ok) return loaded;
        return abortedResult(options.signal) ?? ok(filterEntries(loaded.value, options));
      });
    },
    async batch(ops, options = {}) {
      const ready = guard(disposed, id, options.signal);
      if (!ready.ok) return ready;
      const valid = validateBatch(ops);
      if (!valid.ok) return valid;
      for (const op of ops) {
        if (op.type === 'set') {
          const ttl = ttlSupported(op.ttlMs);
          if (!ttl.ok) return ttl;
        }
      }
      if (ops.length === 0) return ok();
      if (driver.batch !== undefined) {
        const batch = driver.batch.bind(driver);
        const result = await call(id, 'batch', () => batch(ops, options.signal));
        if (result.ok) for (const op of ops) changed(changeOf(op));
        return result;
      }
      for (const op of ops) {
        const aborted = abortedResult(options.signal);
        if (aborted !== undefined) return aborted;
        const result =
          op.type === 'set'
            ? await call(id, 'batch', () => driver.set(op.key, op.value, op.ttlMs, options.signal))
            : await call(id, 'batch', () => driver.delete(op.key, options.signal));
        if (!result.ok) return result;
        changed(changeOf(op));
      }
      return ok();
    },
    watch(listener, options) {
      if (disposed) return () => undefined;
      return watchers.add(listener, options);
    },
    async dispose() {
      if (disposed) return ok();
      disposed = true;
      watchers.clear();
      return call(id, 'dispose', async () => {
        await driver.dispose?.();
        return ok();
      });
    },
  };
  return store;
}

export function changeOf<V>(op: BatchOp<V>, origin: 'local' | 'external' = 'local'): StoreChange<V> {
  return op.type === 'set' ? { type: 'set', key: op.key, value: op.value, origin } : { type: 'delete', key: op.key, origin };
}

/** Structured clone with a JSON fallback (old engines). Throws DataCloneError for non-cloneable values. */
export function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** UTF-8 byte length of a string. */
export function utf8Bytes(text: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).byteLength : text.length * 3;
}
