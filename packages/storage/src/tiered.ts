/**
 * `tiered({ local, remote, mode })`: a local cache in front of a remote store.
 *
 * - Reads: local first; a miss reads remote and populates local.
 * - `write-through`: remote first, then local; a remote failure fails the write
 *   (local is untouched, so it never shows data the server rejected).
 * - `write-back`: local immediately, remote later. Dirty keys are flushed in one
 *   remote `batch` every `flushIntervalMs` (default 5 s; 0 = manual), on
 *   `flush()` and on `dispose()`. Failed flushes keep the keys dirty (offline-first).
 *   `seek` overlays pending writes on the remote listing; when remote is
 *   unreachable it returns the local view.
 * - Remote change pushes refresh the local cache and are re-emitted as `external`.
 *
 * Flush lifecycle: `TieredFlushMachine` (idle → flushing → idle | failed).
 */
import { createMachine, defineMachine, ok, type Result, type SfError } from '@staticflux/core';
import { createCursor, createWatchers, filterEntries, guard, inRange, validateBatch, validateKey, validateValue } from './base.js';
import type { AsyncStore, BatchOp, Entry, OpOptions, StoreChange } from './types.js';

export type TieredMode = 'write-through' | 'write-back';

export const TieredFlushMachine = defineMachine({
  id: 'storage/tiered-flush',
  initial: 'idle',
  states: ['idle', 'flushing', 'failed', 'disposed'],
  transitions: {
    idle: { flush: 'flushing', dispose: 'disposed' },
    flushing: { flushed: 'idle', fail: 'failed', dispose: 'disposed' },
    failed: { flush: 'flushing', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});
export type TieredFlushState = (typeof TieredFlushMachine.states)[number];

export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface TieredOptions<V> {
  readonly local: AsyncStore<V>;
  readonly remote: AsyncStore<V>;
  readonly mode: TieredMode;
  /** write-back flush period (default 5000; 0 disables the timer). */
  readonly flushIntervalMs?: number;
  readonly timers?: IntervalTimers;
  /** Called when a background flush fails (keys stay dirty). */
  readonly onFlushError?: (error: SfError) => void;
}

export interface TieredStore<V> extends AsyncStore<V> {
  readonly mode: TieredMode;
  /** Dirty keys waiting for a write-back flush. */
  readonly pending: number;
  readonly flushState: TieredFlushState;
  /** Push dirty keys to remote now; returns how many were flushed. */
  flush(options?: OpOptions): Promise<Result<number>>;
}

const defaultTimers: IntervalTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

export function tiered<V>(options: TieredOptions<V>): TieredStore<V> {
  const { local, remote, mode } = options;
  const id = `tiered[${mode}](${local.id} -> ${remote.id})`;
  const machine = createMachine(TieredFlushMachine);
  const dirty = new Map<string, BatchOp<V>>();
  let disposed = false;
  let flushing: Promise<Result<number>> | undefined;
  const watchers = createWatchers<V>();
  const emit = (change: StoreChange<V>): void => watchers.emit(change);

  const subscriptions = [
    remote.watch((change) => {
      if (change.origin !== 'external') return;
      // refresh the cache, unless a local write is pending for that key (local wins until flushed)
      if (change.type === 'clear') void local.clear();
      else if (!dirty.has(change.key)) {
        if (change.type === 'set' && change.value !== undefined) void local.set(change.key, change.value);
        else void local.delete(change.key);
      }
      emit(change);
    }),
    local.watch((change) => {
      if (change.origin === 'external') emit(change);
    }),
  ];

  const flush = (opOptions: OpOptions = {}): Promise<Result<number>> => {
    if (flushing !== undefined) return flushing;
    if (dirty.size === 0) return Promise.resolve(ok(0));
    const snapshot = [...dirty.values()];
    machine.send('flush');
    flushing = remote.batch(snapshot, opOptions).then((pushed) => {
      flushing = undefined;
      if (!pushed.ok) {
        if (machine.is('flushing')) machine.send('fail');
        return pushed;
      }
      for (const op of snapshot) if (dirty.get(op.key) === op) dirty.delete(op.key);
      if (machine.is('flushing')) machine.send('flushed');
      return ok(snapshot.length);
    });
    return flushing;
  };

  const interval = options.flushIntervalMs ?? 5000;
  const timers = options.timers ?? defaultTimers;
  const timer =
    mode === 'write-back' && interval > 0
      ? timers.setInterval(() => {
          if (dirty.size === 0) return;
          void flush().then((result) => {
            if (!result.ok) options.onFlushError?.(result.error);
          });
        }, interval)
      : undefined;

  const check = (key: string, opOptions: OpOptions): Result<void> => {
    const ready = guard(disposed, id, opOptions.signal);
    return ready.ok ? validateKey(key) : ready;
  };

  const read = async (key: string, opOptions: OpOptions): Promise<Result<V | undefined>> => {
    const cached = await local.get(key, opOptions);
    if (cached.ok && cached.value !== undefined) return cached;
    if (dirty.get(key)?.type === 'delete') return ok(undefined);
    const fetched = await remote.get(key, opOptions);
    if (fetched.ok && fetched.value !== undefined) await local.set(key, fetched.value);
    return fetched;
  };

  const store: TieredStore<V> = {
    id,
    mode,
    capabilities: {
      atomicBatch: false,
      ordered: remote.capabilities.ordered,
      crossTabEvents: local.capabilities.crossTabEvents || remote.capabilities.crossTabEvents,
      persistent: local.capabilities.persistent || remote.capabilities.persistent,
      ttl: local.capabilities.ttl && remote.capabilities.ttl,
    },
    get pending() {
      return dirty.size;
    },
    get flushState() {
      return machine.state;
    },
    flush,
    async get(key, opOptions = {}) {
      const valid = check(key, opOptions);
      return valid.ok ? read(key, opOptions) : valid;
    },
    async has(key, opOptions = {}) {
      const valid = check(key, opOptions);
      if (!valid.ok) return valid;
      const value = await read(key, opOptions);
      return value.ok ? ok(value.value !== undefined) : value;
    },
    async set(key, value, opOptions = {}) {
      const valid = check(key, opOptions);
      if (!valid.ok) return valid;
      const validValue = validateValue(key, value);
      if (!validValue.ok) return validValue;
      if (mode === 'write-through') {
        const pushed = await remote.set(key, value, opOptions);
        if (!pushed.ok) return pushed;
        const cached = await local.set(key, value, opOptions);
        if (!cached.ok) await local.delete(key);
      } else {
        const cached = await local.set(key, value, opOptions);
        if (!cached.ok) return cached;
        dirty.set(key, opOptions.ttlMs === undefined ? { type: 'set', key, value } : { type: 'set', key, value, ttlMs: opOptions.ttlMs });
      }
      emit({ type: 'set', key, value, origin: 'local' });
      return ok();
    },
    async delete(key, opOptions = {}) {
      const valid = check(key, opOptions);
      if (!valid.ok) return valid;
      if (mode === 'write-through') {
        const pushed = await remote.delete(key, opOptions);
        if (!pushed.ok) return pushed;
        await local.delete(key);
      } else {
        const removed = await local.delete(key, opOptions);
        if (!removed.ok) return removed;
        dirty.set(key, { type: 'delete', key });
      }
      emit({ type: 'delete', key, origin: 'local' });
      return ok();
    },
    async clear(opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const cleared = await remote.clear(opOptions);
      if (!cleared.ok) return cleared;
      dirty.clear();
      await local.clear();
      emit({ type: 'clear', origin: 'local' });
      return ok();
    },
    seek(seekOptions = {}) {
      return createCursor(async () => {
        const ready = guard(disposed, id, seekOptions.signal);
        if (!ready.ok) return ready;
        const { limit: _limit, ...unlimited } = seekOptions;
        const listed = await remote.seek(mode === 'write-back' ? unlimited : seekOptions).toArray();
        if (!listed.ok) {
          if (listed.error.kind === 'aborted') return listed;
          return local.seek(seekOptions).toArray(); // offline: local view
        }
        if (mode === 'write-through') return listed;
        const merged = new Map<string, V>(listed.value);
        for (const op of dirty.values()) {
          if (!inRange(op.key, seekOptions)) continue;
          if (op.type === 'set') merged.set(op.key, op.value);
          else merged.delete(op.key);
        }
        return ok(filterEntries<V>([...merged].map(([k, v]): Entry<V> => [k, v]), seekOptions));
      });
    },
    async batch(ops, opOptions = {}) {
      const ready = guard(disposed, id, opOptions.signal);
      if (!ready.ok) return ready;
      const valid = validateBatch(ops);
      if (!valid.ok) return valid;
      if (mode === 'write-through') {
        const pushed = await remote.batch(ops, opOptions);
        if (!pushed.ok) return pushed;
        const cached = await local.batch(ops);
        if (!cached.ok) await local.batch(ops.map((op) => ({ type: 'delete', key: op.key })));
      } else {
        const cached = await local.batch(ops, opOptions);
        if (!cached.ok) return cached;
        for (const op of ops) dirty.set(op.key, op);
      }
      for (const op of ops) emit(op.type === 'set' ? { type: 'set', key: op.key, value: op.value, origin: 'local' } : { type: 'delete', key: op.key, origin: 'local' });
      return ok();
    },
    watch(listener, watchOptions) {
      return disposed ? () => undefined : watchers.add(listener, watchOptions);
    },
    async dispose() {
      if (disposed) return ok();
      if (timer !== undefined) timers.clearInterval(timer);
      const flushed = mode === 'write-back' ? await flush() : ok(0);
      disposed = true;
      machine.send('dispose');
      watchers.clear();
      for (const unsubscribe of subscriptions) unsubscribe();
      await local.dispose();
      await remote.dispose();
      return flushed.ok ? ok() : flushed;
    },
  };
  return store;
}
