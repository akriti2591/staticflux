/**
 * The one storage contract (R9.0a). Every adapter and every middleware returns
 * an `AsyncStore`, so any layer can be swapped without touching consumers.
 *
 * - All operations are async and return `Result` (never throw for expected failures).
 * - Keys are non-empty strings, compared by UTF-16 code units (the IndexedDB order).
 * - Values are structured-clone-safe; string-only backends serialize through a codec.
 * - `seek()` always yields entries sorted by key (ascending, or descending with `reverse`);
 *   `capabilities.ordered` says whether the backend does range scans natively (cheap) or
 *   the base sorts in memory.
 */
import type { Result, SfError } from '@staticflux/core';

export interface StoreCapabilities {
  /** `batch()` applies all ops or none. */
  readonly atomicBatch: boolean;
  /** Native ordered range scans (seek is cheap); otherwise seek scans and sorts. */
  readonly ordered: boolean;
  /** `watch()` also reports changes made by other tabs/windows. */
  readonly crossTabEvents: boolean;
  /** Survives a browser restart. */
  readonly persistent: boolean;
  /** `set(key, value, { ttlMs })` is honoured (natively or via `withTtl`). */
  readonly ttl: boolean;
  /** Largest single value the backend accepts (encoded bytes), when known. */
  readonly maxValueBytes?: number;
}

export interface OpOptions {
  readonly signal?: AbortSignal;
}

export interface SetOptions extends OpOptions {
  /** Expire the entry after this many ms. Requires `capabilities.ttl` (else `SF-STORE-005`). */
  readonly ttlMs?: number;
}

export interface KeyRange {
  /** Only keys starting with this prefix. */
  readonly prefix?: string;
  /** Keys >= gte. */
  readonly gte?: string;
  /** Keys < lt. */
  readonly lt?: string;
}

export interface SeekOptions extends KeyRange, OpOptions {
  readonly limit?: number;
  /** Descending key order. */
  readonly reverse?: boolean;
}

export type Entry<V> = readonly [key: string, value: V];

export type BatchOp<V> =
  | { readonly type: 'set'; readonly key: string; readonly value: V; readonly ttlMs?: number }
  | { readonly type: 'delete'; readonly key: string };

/** `local` = this store instance wrote it; `external` = another tab, device or a lower layer. */
export type ChangeOrigin = 'local' | 'external';

export type StoreChange<V> =
  | {
      readonly type: 'set';
      readonly key: string;
      /** Present when cheaply known (not for encrypted values or some cross-tab events). */
      readonly value?: V;
      readonly origin: ChangeOrigin;
    }
  | { readonly type: 'delete'; readonly key: string; readonly origin: ChangeOrigin }
  | { readonly type: 'clear'; readonly origin: ChangeOrigin };

export type StoreListener<V> = (change: StoreChange<V>) => void;

export interface WatchOptions {
  /** Only changes to keys with this prefix (`clear` is always delivered). */
  readonly prefix?: string;
}

/**
 * Result of `seek()`. Iterating never throws: when the backend fails, iteration
 * ends early and `error` is set. Use `toArray()` to get a `Result` instead.
 */
export interface StoreCursor<V> extends AsyncIterable<Entry<V>> {
  readonly error: SfError | undefined;
  toArray(): Promise<Result<readonly Entry<V>[]>>;
  keys(): Promise<Result<readonly string[]>>;
}

export interface AsyncStore<V = unknown> {
  /** Backend + middleware chain, e.g. `ttl(namespaced(indexeddb))`. For devtools and reports. */
  readonly id: string;
  readonly capabilities: StoreCapabilities;
  /** `ok(undefined)` when absent. */
  get(key: string, options?: OpOptions): Promise<Result<V | undefined>>;
  set(key: string, value: V, options?: SetOptions): Promise<Result<void>>;
  delete(key: string, options?: OpOptions): Promise<Result<void>>;
  has(key: string, options?: OpOptions): Promise<Result<boolean>>;
  /** Remove every entry this store can see (namespaced stores clear only their namespace). */
  clear(options?: OpOptions): Promise<Result<void>>;
  seek(options?: SeekOptions): StoreCursor<V>;
  /** All-or-nothing when `capabilities.atomicBatch`; otherwise applied in order, stopping at the first failure. */
  batch(ops: readonly BatchOp<V>[], options?: OpOptions): Promise<Result<void>>;
  /** Listen to changes; returns unsubscribe. Cross-tab when `capabilities.crossTabEvents`. */
  watch(listener: StoreListener<V>, options?: WatchOptions): () => void;
  /** Release connections/listeners. Later calls return `SF-STORE-007`. Idempotent. */
  dispose(): Promise<Result<void>>;
}

/** Middleware: wraps a store and returns the same interface (possibly with another value type). */
export type StoreMiddleware<In = unknown, Out = In> = (store: AsyncStore<In>) => AsyncStore<Out>;

/** Minimal BroadcastChannel shape (injectable; absent in some webviews). */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  close(): void;
}

export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike | undefined;

/** The global `BroadcastChannel` as a factory, or undefined when the engine lacks it. */
export function globalBroadcastFactory(): BroadcastChannelFactory | undefined {
  const ctor = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }).BroadcastChannel;
  if (typeof ctor !== 'function') return undefined;
  return (name) => {
    try {
      return new ctor(name);
    } catch {
      return undefined;
    }
  };
}
