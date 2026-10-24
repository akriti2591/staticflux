/**
 * In-memory adapter: ordered, atomic batches, native TTL (injectable clock).
 * Values are structured-cloned on the way in and out, like a real backend, so
 * tests catch non-cloneable values and accidental shared mutation.
 */
import { err, ok } from '@staticflux/core';
import { cloneValue, storeFromDriver } from './base.js';
import { StoreQuotaError } from './errors.js';
import type { AsyncStore, Entry } from './types.js';

export interface MemoryStoreOptions {
  /** Store id (default `memory`). */
  readonly id?: string;
  /** Structured-clone values (default true). Disable only for trusted immutable data. */
  readonly clone?: boolean;
  /** Clock for `ttlMs` (default `Date.now`). */
  readonly now?: () => number;
  /** Simulated per-value limit (JSON length); larger writes → SF-STORE-001. */
  readonly maxValueBytes?: number;
  /** Initial entries. */
  readonly initial?: Readonly<Record<string, unknown>>;
}

interface Slot {
  readonly value: unknown;
  readonly expiresAt: number | undefined;
}

export interface MemoryStore<V> extends AsyncStore<V> {
  /** Live entry count (expired entries excluded). */
  readonly size: number;
}

export function createMemoryStore<V = unknown>(options: MemoryStoreOptions = {}): MemoryStore<V> {
  const id = options.id ?? 'memory';
  const now = options.now ?? Date.now;
  const copy = options.clone === false ? <T>(value: T): T => value : cloneValue;
  const entries = new Map<string, Slot>();
  for (const [key, value] of Object.entries(options.initial ?? {})) entries.set(key, { value: copy(value), expiresAt: undefined });

  const live = (key: string): Slot | undefined => {
    const slot = entries.get(key);
    if (slot === undefined) return undefined;
    if (slot.expiresAt !== undefined && slot.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return slot;
  };
  const tooLarge = (key: string, value: unknown): boolean => {
    if (options.maxValueBytes === undefined) return false;
    const size = JSON.stringify(value)?.length ?? 0;
    return size > options.maxValueBytes;
  };
  const slotFor = (value: unknown, ttlMs: number | undefined): Slot => ({
    value: copy(value),
    expiresAt: ttlMs === undefined ? undefined : now() + ttlMs,
  });
  const quota = (key: string) =>
    StoreQuotaError({ message: `Value for "${key}" exceeds ${String(options.maxValueBytes)} bytes.`, details: { backend: id, key } });

  const store = storeFromDriver<V>({
    id,
    capabilities: {
      atomicBatch: true,
      ordered: true,
      crossTabEvents: false,
      persistent: false,
      ttl: true,
      ...(options.maxValueBytes === undefined ? {} : { maxValueBytes: options.maxValueBytes }),
    },
    get(key) {
      const slot = live(key);
      return ok(slot === undefined ? undefined : copy(slot.value as V));
    },
    has(key) {
      return ok(live(key) !== undefined);
    },
    set(key, value, ttlMs) {
      if (tooLarge(key, value)) return err(quota(key));
      entries.set(key, slotFor(value, ttlMs));
      return ok();
    },
    delete(key) {
      entries.delete(key);
      return ok();
    },
    clear() {
      entries.clear();
      return ok();
    },
    entries() {
      const out: Entry<V>[] = [];
      for (const key of [...entries.keys()]) {
        const slot = live(key);
        if (slot !== undefined) out.push([key, copy(slot.value as V)]);
      }
      return ok(out);
    },
    batch(ops) {
      // validate + clone everything first so a failure leaves the map untouched (atomic)
      const staged: { key: string; slot: Slot | undefined }[] = [];
      for (const op of ops) {
        if (op.type === 'set') {
          if (tooLarge(op.key, op.value)) return err(quota(op.key));
          staged.push({ key: op.key, slot: slotFor(op.value, op.ttlMs) });
        } else {
          staged.push({ key: op.key, slot: undefined });
        }
      }
      for (const { key, slot } of staged) {
        if (slot === undefined) entries.delete(key);
        else entries.set(key, slot);
      }
      return ok();
    },
  });
  return Object.defineProperty(store, 'size', {
    get: () => [...entries.keys()].filter((key) => live(key) !== undefined).length,
    enumerable: true,
  }) as MemoryStore<V>;
}
