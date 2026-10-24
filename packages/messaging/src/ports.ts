/**
 * Ports of @staticflux/messaging. Storage is async-only and a structural subset of
 * `@staticflux/storage`'s `AsyncStore` (R9.0a), so an AsyncStore can be passed directly.
 */
import { ok, type Result } from '@staticflux/core';

/** Minimal async key-value port (subset of AsyncStore). */
export interface KeyValuePort<V> {
  get(key: string, options?: { readonly signal?: AbortSignal }): Promise<Result<V | undefined>>;
  set(key: string, value: V, options?: { readonly signal?: AbortSignal }): Promise<Result<void>>;
  delete(key: string): Promise<Result<void>>;
}

/** In-memory key-value port (tests, guests; bind a per-user remote/local store in apps). */
export function createMemoryKeyValue<V>(initial: Iterable<readonly [string, V]> = []): KeyValuePort<V> & {
  readonly entries: ReadonlyMap<string, V>;
} {
  const map = new Map<string, V>(initial);
  return {
    entries: map,
    get: (key) => Promise.resolve(ok(map.get(key))),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve(ok());
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve(ok());
    },
  };
}

/** Timers for toast durations and exit transitions (injectable for tests). */
export interface MessagingClock {
  now(): number;
  /** Run `fn` after `ms`; returns cancel. */
  after(ms: number, fn: () => void): () => void;
}

export const systemClock: MessagingClock = {
  now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
  after(ms, fn) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/** Manual clock for tests: `advance(ms)` fires due timers in order. */
export function createManualClock(start = 0): MessagingClock & { advance(ms: number): void } {
  let time = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    after(ms, fn) {
      seq += 1;
      const id = seq;
      timers.set(id, { at: time + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
        if (next === undefined) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].fn();
      }
      time = target;
    },
  };
}
