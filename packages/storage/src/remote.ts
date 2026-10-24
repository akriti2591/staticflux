/**
 * Remote/cloud adapter over a `RemoteStoreTransport` port (the app supplies the
 * HTTP/WS client; this package ships a mock). The transport owns retries — the
 * adapter never retries (one retry layer, like `@staticflux/data`'s client).
 */
import { AbortedError, err, ok, type Result, sleep } from '@staticflux/core';
import { cloneValue, filterEntries, storeFromDriver } from './base.js';
import { StoreIoError } from './errors.js';
import type { AsyncStore, BatchOp, Entry, SeekOptions, StoreChange } from './types.js';

export interface RemoteListOptions {
  readonly prefix?: string;
  readonly gte?: string;
  readonly lt?: string;
  readonly limit?: number;
  readonly reverse?: boolean;
}

export interface RemoteStoreTransport<V = unknown> {
  get(key: string, signal: AbortSignal): Promise<Result<V | undefined>>;
  set(key: string, value: V, options: { readonly ttlMs?: number }, signal: AbortSignal): Promise<Result<void>>;
  delete(key: string, signal: AbortSignal): Promise<Result<void>>;
  list(options: RemoteListOptions, signal: AbortSignal): Promise<Result<readonly Entry<V>[]>>;
  /** Atomic multi-op (server transaction). When absent, batches are applied one by one. */
  batch?(ops: readonly BatchOp<V>[], signal: AbortSignal): Promise<Result<void>>;
  /** Server push of changes made by other clients/devices. */
  subscribe?(listener: (change: StoreChange<V>) => void): () => void;
  /** Server honours `ttlMs`. */
  readonly ttl?: boolean;
}

export interface RemoteStoreOptions {
  readonly id?: string;
}

const NEVER = new AbortController().signal;

export function createRemoteStore<V = unknown>(transport: RemoteStoreTransport<V>, options: RemoteStoreOptions = {}): AsyncStore<V> {
  const id = options.id ?? 'remote';
  const listOf = (seek: SeekOptions): RemoteListOptions => ({
    ...(seek.prefix === undefined ? {} : { prefix: seek.prefix }),
    ...(seek.gte === undefined ? {} : { gte: seek.gte }),
    ...(seek.lt === undefined ? {} : { lt: seek.lt }),
    ...(seek.limit === undefined ? {} : { limit: seek.limit }),
    ...(seek.reverse === undefined ? {} : { reverse: seek.reverse }),
  });
  const batch = transport.batch?.bind(transport);
  return storeFromDriver<V>({
    id,
    capabilities: { atomicBatch: batch !== undefined, ordered: true, crossTabEvents: transport.subscribe !== undefined, persistent: true, ttl: transport.ttl === true },
    get: (key, signal) => transport.get(key, signal ?? NEVER),
    set: (key, value, ttlMs, signal) => transport.set(key, value, ttlMs === undefined ? {} : { ttlMs }, signal ?? NEVER),
    delete: (key, signal) => transport.delete(key, signal ?? NEVER),
    async clear(signal) {
      const listed = await transport.list({}, signal ?? NEVER);
      if (!listed.ok) return listed;
      if (batch !== undefined) return batch(listed.value.map(([key]) => ({ type: 'delete', key })), signal ?? NEVER);
      for (const [key] of listed.value) {
        const removed = await transport.delete(key, signal ?? NEVER);
        if (!removed.ok) return removed;
      }
      return ok();
    },
    entries: (seek, signal) => transport.list(listOf(seek), signal ?? NEVER),
    ...(batch === undefined ? {} : { batch: (ops: readonly BatchOp<V>[], signal: AbortSignal | undefined) => batch(ops, signal ?? NEVER) }),
    ...(transport.subscribe === undefined
      ? {}
      : { listen: (emit: (change: StoreChange<V>) => void) => transport.subscribe?.((change) => emit({ ...change, origin: 'external' })) ?? (() => undefined) }),
  });
}

// ---------------------------------------------------------------- mock

export interface MockRemoteCall {
  readonly op: 'get' | 'set' | 'delete' | 'list' | 'batch';
  readonly key?: string;
}

export interface MockRemoteTransport<V = unknown> extends RemoteStoreTransport<V> {
  readonly records: ReadonlyMap<string, V>;
  readonly calls: readonly MockRemoteCall[];
  /** Simulate a write from another device (pushed to subscribers). */
  serverSet(key: string, value: V): void;
  serverDelete(key: string): void;
  failNext(times?: number): void;
  setOffline(offline: boolean): void;
}

export interface MockRemoteOptions {
  readonly latencyMs?: number;
  /** Implement `batch` atomically (default true). */
  readonly atomicBatch?: boolean;
}

export function createMockRemoteTransport<V = unknown>(options: MockRemoteOptions = {}): MockRemoteTransport<V> {
  const records = new Map<string, V>();
  const calls: MockRemoteCall[] = [];
  const listeners = new Set<(change: StoreChange<V>) => void>();
  let failures = 0;
  let offline = false;
  const gate = async (signal: AbortSignal): Promise<Result<void>> => {
    if ((options.latencyMs ?? 0) > 0) {
      const slept = await sleep(options.latencyMs ?? 0, signal);
      if (!slept.ok) return slept;
    }
    if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
    if (offline) return err(StoreIoError({ message: 'Remote store is offline.', details: { backend: 'remote', offline: true } }));
    if (failures > 0) {
      failures -= 1;
      return err(StoreIoError({ message: 'Injected remote failure.', details: { backend: 'remote', injected: true } }));
    }
    return ok();
  };
  const push = (change: StoreChange<V>): void => {
    for (const listener of [...listeners]) listener(change);
  };
  const transport: MockRemoteTransport<V> = {
    records,
    calls,
    serverSet(key, value) {
      records.set(key, cloneValue(value));
      push({ type: 'set', key, value: cloneValue(value), origin: 'external' });
    },
    serverDelete(key) {
      records.delete(key);
      push({ type: 'delete', key, origin: 'external' });
    },
    failNext(times = 1) {
      failures = times;
    },
    setOffline(value) {
      offline = value;
    },
    async get(key, signal) {
      calls.push({ op: 'get', key });
      const open = await gate(signal);
      if (!open.ok) return open;
      const value = records.get(key);
      return ok(value === undefined ? undefined : cloneValue(value));
    },
    async set(key, value, _options, signal) {
      calls.push({ op: 'set', key });
      const open = await gate(signal);
      if (!open.ok) return open;
      records.set(key, cloneValue(value));
      return ok();
    },
    async delete(key, signal) {
      calls.push({ op: 'delete', key });
      const open = await gate(signal);
      if (!open.ok) return open;
      records.delete(key);
      return ok();
    },
    async list(listOptions, signal) {
      calls.push({ op: 'list' });
      const open = await gate(signal);
      if (!open.ok) return open;
      return ok(filterEntries([...records].map(([k, v]) => [k, cloneValue(v)] as const), listOptions));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  if (options.atomicBatch !== false) {
    transport.batch = async (ops, signal) => {
      calls.push({ op: 'batch' });
      const open = await gate(signal);
      if (!open.ok) return open;
      for (const op of ops) {
        if (op.type === 'set') records.set(op.key, cloneValue(op.value));
        else records.delete(op.key);
      }
      return ok();
    };
  }
  return transport;
}
