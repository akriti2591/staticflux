/**
 * `withBudget({ maxBytes, maxEntries })`: rejects writes that would exceed the
 * budget with `SF-STORE-001` before they reach the backend (per-slice budgets,
 * R9.12; small Web Storage quotas). Usage is indexed lazily on the first write
 * (one seek) and kept up to date; external changes (other tabs) mark the index
 * stale so the next write re-scans. Sizes default to UTF-8 JSON bytes + key bytes.
 */
import { err, ok, type Result } from '@staticflux/core';
import { createCursor, guard, utf8Bytes, validateBatch, validateKey, validateValue } from './base.js';
import { StoreQuotaError } from './errors.js';
import type { AsyncStore, BatchOp, OpOptions } from './types.js';

export interface BudgetOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  /** Bytes of one value (default: JSON UTF-8 length; binary byteLength). */
  readonly sizeOf?: (value: unknown) => number;
}

export interface BudgetUsage {
  readonly bytes: number;
  readonly entries: number;
}

export interface BudgetStore<V> extends AsyncStore<V> {
  usage(options?: OpOptions): Promise<Result<BudgetUsage>>;
}

export function defaultSizeOf(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === 'string') return utf8Bytes(value);
  try {
    return utf8Bytes(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

export function withBudget<V>(options: BudgetOptions): (inner: AsyncStore<V>) => BudgetStore<V> {
  return (inner) => budgetStore(inner, options);
}

function budgetStore<V>(inner: AsyncStore<V>, options: BudgetOptions): BudgetStore<V> {
  const id = `budget(${inner.id})`;
  const sizeOf = options.sizeOf ?? defaultSizeOf;
  let disposed = false;
  let index: Map<string, number> | undefined;
  let total = 0;
  const unwatch = inner.watch((change) => {
    if (change.origin === 'external') index = undefined;
  });
  const entryBytes = (key: string, value: unknown): number => utf8Bytes(key) + sizeOf(value);
  const ensureIndex = async (opOptions: OpOptions): Promise<Result<Map<string, number>>> => {
    if (index !== undefined) return ok(index);
    const loaded = await inner.seek(opOptions).toArray();
    if (!loaded.ok) return loaded;
    const built = new Map<string, number>();
    total = 0;
    for (const [key, value] of loaded.value) {
      const bytes = entryBytes(key, value);
      built.set(key, bytes);
      total += bytes;
    }
    index = built;
    return ok(built);
  };
  /** Project applying ops; returns the new sizes or a quota error. */
  const project = (current: Map<string, number>, ops: readonly BatchOp<V>[]): Result<{ sizes: Map<string, number | undefined>; total: number }> => {
    const sizes = new Map<string, number | undefined>();
    let projected = total;
    let count = current.size;
    const sizeNow = (key: string): number | undefined => (sizes.has(key) ? sizes.get(key) : current.get(key));
    for (const op of ops) {
      const before = sizeNow(op.key);
      const after = op.type === 'set' ? entryBytes(op.key, op.value) : undefined;
      projected += (after ?? 0) - (before ?? 0);
      if (before === undefined && after !== undefined) count += 1;
      if (before !== undefined && after === undefined) count -= 1;
      sizes.set(op.key, after);
    }
    const growing = ops.some((op) => op.type === 'set');
    if (growing && options.maxBytes !== undefined && projected > options.maxBytes) {
      return err(StoreQuotaError({ message: `Write would use ${projected} bytes (budget ${options.maxBytes}).`, details: { store: id, bytes: projected, maxBytes: options.maxBytes } }));
    }
    if (growing && options.maxEntries !== undefined && count > options.maxEntries) {
      return err(StoreQuotaError({ message: `Write would hold ${count} entries (budget ${options.maxEntries}).`, details: { store: id, entries: count, maxEntries: options.maxEntries } }));
    }
    return ok({ sizes, total: projected });
  };
  const commit = (current: Map<string, number>, sizes: Map<string, number | undefined>, projected: number): void => {
    if (index !== current) return; // invalidated meanwhile; next write re-scans
    for (const [key, size] of sizes) {
      if (size === undefined) current.delete(key);
      else current.set(key, size);
    }
    total = projected;
  };
  const write = async (ops: readonly BatchOp<V>[], opOptions: OpOptions, apply: () => Promise<Result<void>>): Promise<Result<void>> => {
    const current = await ensureIndex(opOptions);
    if (!current.ok) return current;
    const planned = project(current.value, ops);
    if (!planned.ok) return planned;
    const applied = await apply();
    if (applied.ok) commit(current.value, planned.value.sizes, planned.value.total);
    else index = undefined;
    return applied;
  };
  return {
    id,
    capabilities: inner.capabilities,
    get: (key, o) => (disposed ? Promise.resolve(guard(true, id, undefined) as Result<never>) : inner.get(key, o)),
    has: (key, o) => (disposed ? Promise.resolve(guard(true, id, undefined) as Result<never>) : inner.has(key, o)),
    async set(key, value, opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const validKey = validateKey(key);
      if (!validKey.ok) return validKey;
      const validValue = validateValue(key, value);
      if (!validValue.ok) return validValue;
      return write([{ type: 'set', key, value }], opOptions, () => inner.set(key, value, opOptions));
    },
    async delete(key, opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const removed = await inner.delete(key, opOptions);
      if (removed.ok && index !== undefined) {
        total -= index.get(key) ?? 0;
        index.delete(key);
      }
      return removed;
    },
    async clear(opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const cleared = await inner.clear(opOptions);
      index = undefined;
      return cleared;
    },
    seek(seekOptions = {}) {
      return disposed ? createCursor(async () => guard(true, id, undefined) as Result<never>) : inner.seek(seekOptions);
    },
    async batch(ops, opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const valid = validateBatch(ops);
      if (!valid.ok) return valid;
      return write(ops, opOptions, () => inner.batch(ops, opOptions));
    },
    watch: (listener, watchOptions) => (disposed ? () => undefined : inner.watch(listener, watchOptions)),
    async usage(opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const current = await ensureIndex(opOptions);
      return current.ok ? ok({ bytes: total, entries: current.value.size }) : current;
    },
    async dispose() {
      if (disposed) return ok();
      disposed = true;
      unwatch();
      return inner.dispose();
    },
  };
}
