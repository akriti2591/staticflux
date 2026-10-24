/**
 * DataLoader-style coalescing (R9.2 batched kind; research §5 DataLoader).
 *
 * Every `load(key)` inside one window (a microtask by default, or N ms) is
 * collected into one `loadMany(keys)` call, split into chunks of
 * `maxBatchSize`. Results are per key (`Result[]`), so one failure never fails
 * the whole batch. Duplicate keys inside a window share one slot. There is no
 * long-lived cache here — caching belongs to the SWR resource layer.
 *
 * A chunk's request is aborted only when every caller waiting on it aborted.
 */
import { AbortedError, err, type Result } from '@staticflux/core';
import { stableStringify } from './clone.js';
import { BatchResultMissingError } from './errors.js';

export type BatchWindow = 'microtask' | { readonly ms: number };

export interface BatcherOptions<K, V> {
  /** Load all keys; return one Result per key in the same order (or a whole-batch error). */
  readonly loadMany: (keys: readonly K[], signal: AbortSignal) => Promise<Result<readonly Result<V>[]>>;
  readonly maxBatchSize?: number;
  readonly window?: BatchWindow;
  readonly keyId?: (key: K) => string;
  /** Observes the size of each dispatched chunk (metrics). */
  readonly onBatch?: (size: number) => void;
}

export interface Batcher<K, V> {
  load(key: K, signal?: AbortSignal): Promise<Result<V>>;
  /** Keys waiting for the current window. */
  readonly pending: number;
}

interface Slot<K, V> {
  readonly key: K;
  readonly waiters: Set<(result: Result<V>) => void>;
  readonly controller: AbortController;
  active: number;
}

export function createBatcher<K, V>(options: BatcherOptions<K, V>): Batcher<K, V> {
  const maxBatchSize = Math.max(1, options.maxBatchSize ?? 100);
  const window = options.window ?? 'microtask';
  const keyId = options.keyId ?? stableStringify;
  let queue = new Map<string, Slot<K, V>>();
  let scheduled = false;

  const dispatch = (slots: readonly Slot<K, V>[]): void => {
    const controller = new AbortController();
    let live = slots.length;
    for (const slot of slots) {
      slot.controller.signal.addEventListener(
        'abort',
        () => {
          live -= 1;
          if (live === 0) controller.abort(new DOMException('All batch callers aborted', 'AbortError'));
        },
        { once: true },
      );
    }
    options.onBatch?.(slots.length);
    void options.loadMany(
      slots.map((s) => s.key),
      controller.signal,
    ).then((batch) => {
      slots.forEach((slot, index) => {
        const result: Result<V> = !batch.ok
          ? batch
          : (batch.value[index] ?? err(BatchResultMissingError({ details: { key: keyId(slot.key), index } })));
        for (const resolve of slot.waiters) resolve(result);
      });
    });
  };

  const flush = (): void => {
    scheduled = false;
    const slots = [...queue.values()].filter((s) => s.active > 0);
    queue = new Map();
    for (let i = 0; i < slots.length; i += maxBatchSize) dispatch(slots.slice(i, i + maxBatchSize));
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    if (window === 'microtask') queueMicrotask(flush);
    else setTimeout(flush, window.ms);
  };

  return {
    get pending() {
      return queue.size;
    },
    load(key, signal) {
      if (signal?.aborted === true) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      const id = keyId(key);
      let slot = queue.get(id);
      if (slot === undefined) {
        slot = { key, waiters: new Set(), controller: new AbortController(), active: 0 };
        queue.set(id, slot);
      }
      const current = slot;
      current.active += 1;
      schedule();
      return new Promise<Result<V>>((resolve) => {
        const waiter = (result: Result<V>): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = (): void => {
          current.waiters.delete(waiter);
          current.active -= 1;
          if (current.active === 0) current.controller.abort(signal?.reason);
          resolve(err(AbortedError({ cause: signal?.reason })));
        };
        current.waiters.add(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
