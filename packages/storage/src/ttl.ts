/**
 * `withTtl()`: per-entry expiry for any backend. Values are wrapped as
 * `{ v: value, e: expiresAt | null }`; expired entries read as absent and are
 * deleted lazily on read, plus in bulk by `purgeExpired()` (call it on idle or
 * at boot). The clock is injectable.
 */
import { err, ok, type Result } from '@staticflux/core';
import { createCursor, createWatchers, guard, validateBatch, validateKey, validateValue } from './base.js';
import { StoreCorruptError } from './errors.js';
import type { AsyncStore, BatchOp, Entry, OpOptions, StoreChange } from './types.js';

export interface TtlRecord<V> {
  readonly v: V;
  /** Expiry (epoch ms) or null for no expiry. */
  readonly e: number | null;
}

export interface TtlOptions {
  readonly now?: () => number;
  /** Applied when `set` has no `ttlMs`. */
  readonly defaultTtlMs?: number;
}

export interface TtlStore<V> extends AsyncStore<V> {
  /** Delete every expired entry; returns how many were removed. */
  purgeExpired(options?: OpOptions): Promise<Result<number>>;
}

export function isTtlRecord(value: unknown): value is TtlRecord<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return 'v' in record && (record['e'] === null || typeof record['e'] === 'number');
}

export function withTtl<V>(options: TtlOptions = {}): (inner: AsyncStore<TtlRecord<V>>) => TtlStore<V> {
  return (inner) => ttlStore(inner, options);
}

function ttlStore<V>(inner: AsyncStore<TtlRecord<V>>, options: TtlOptions): TtlStore<V> {
  const now = options.now ?? Date.now;
  const id = `ttl(${inner.id})`;
  let disposed = false;
  const wrap = (value: V, ttlMs: number | undefined): TtlRecord<V> => {
    const ttl = ttlMs ?? options.defaultTtlMs;
    return { v: value, e: ttl === undefined ? null : now() + ttl };
  };
  const expired = (record: TtlRecord<V>): boolean => record.e !== null && record.e <= now();
  const unwrap = (key: string, raw: unknown): Result<TtlRecord<V>> =>
    isTtlRecord(raw) ? ok(raw as TtlRecord<V>) : err(StoreCorruptError({ message: `Entry "${key}" is not a TTL record.`, details: { key } }));

  let unsubscribe: (() => void) | undefined;
  const watchers = createWatchers<V>(
    () => {
      unsubscribe = inner.watch((change) => {
        if (change.type !== 'set') {
          watchers.emit(change);
          return;
        }
        const mapped: StoreChange<V> =
          change.value !== undefined && isTtlRecord(change.value)
            ? { type: 'set', key: change.key, value: change.value.v, origin: change.origin }
            : { type: 'set', key: change.key, origin: change.origin };
        watchers.emit(mapped);
      });
    },
    () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  );

  const read = async (key: string, opOptions: OpOptions): Promise<Result<V | undefined>> => {
    const raw = await inner.get(key, opOptions);
    if (!raw.ok || raw.value === undefined) return raw as Result<undefined>;
    const record = unwrap(key, raw.value);
    if (!record.ok) return record;
    if (expired(record.value)) {
      await inner.delete(key);
      return ok(undefined);
    }
    return ok(record.value.v);
  };

  return {
    id,
    capabilities: { ...inner.capabilities, ttl: true },
    async get(key, opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      return ready.ok ? read(key, opOptions) : ready;
    },
    async has(key, opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const value = await read(key, opOptions);
      return value.ok ? ok(value.value !== undefined) : value;
    },
    async set(key, value, opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const validKey = validateKey(key);
      if (!validKey.ok) return validKey;
      const validValue = validateValue(key, value);
      if (!validValue.ok) return validValue;
      return inner.set(key, wrap(value, opOptions.ttlMs), opOptions.signal === undefined ? {} : { signal: opOptions.signal });
    },
    delete: (key, opOptions = {}) => (disposed ? Promise.resolve(guard(true, id, undefined)) : inner.delete(key, opOptions)),
    clear: (opOptions = {}) => (disposed ? Promise.resolve(guard(true, id, undefined)) : inner.clear(opOptions)),
    seek(seekOptions = {}) {
      return createCursor(async () => {
        const ready = guard(disposed, id, seekOptions.signal);
        if (!ready.ok) return ready;
        // limit applies after dropping expired entries, so ask the inner store without it
        const { limit, ...rest } = seekOptions;
        const loaded = await inner.seek(rest).toArray();
        if (!loaded.ok) return loaded;
        const out: Entry<V>[] = [];
        for (const [key, raw] of loaded.value) {
          const record = unwrap(key, raw);
          if (!record.ok) return record;
          if (expired(record.value)) continue;
          out.push([key, record.value.v]);
          if (limit !== undefined && out.length >= limit) break;
        }
        return ok(out);
      });
    },
    async batch(ops, opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const valid = validateBatch(ops);
      if (!valid.ok) return valid;
      return inner.batch(
        ops.map((op): BatchOp<TtlRecord<V>> => (op.type === 'set' ? { type: 'set', key: op.key, value: wrap(op.value, op.ttlMs) } : op)),
        opOptions,
      );
    },
    watch(listener, watchOptions) {
      return disposed ? () => undefined : watchers.add(listener, watchOptions);
    },
    async purgeExpired(opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const loaded = await inner.seek(opOptions).toArray();
      if (!loaded.ok) return loaded;
      const stale = loaded.value.filter(([, raw]) => isTtlRecord(raw) && expired(raw as TtlRecord<V>)).map(([key]) => key);
      if (stale.length === 0) return ok(0);
      const removed = await inner.batch(stale.map((key) => ({ type: 'delete', key })), opOptions);
      return removed.ok ? ok(stale.length) : removed;
    },
    async dispose() {
      if (disposed) return ok();
      disposed = true;
      watchers.clear();
      return inner.dispose();
    },
  };
}
