/**
 * `fallback([primary, secondary, …])`: use the first available store; report
 * every skipped candidate. Candidates may be stores, `Result`s from adapter
 * factories (`createIndexedDbStore(...)`) or thunks (created only when needed).
 * At runtime, an operation failing with `SF-STORE-002` (unavailable) switches
 * to the next candidate and retries there — data is NOT migrated between
 * candidates (the secondary starts empty). Listen with `onFallback` to report
 * degradation (R9.0b "fallback reported").
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { createCursor, createWatchers } from './base.js';
import { StoreUnavailableError } from './errors.js';
import type { AsyncStore, StoreCapabilities } from './types.js';

export type StoreCandidate<V> = AsyncStore<V> | Result<AsyncStore<V>> | (() => AsyncStore<V> | Result<AsyncStore<V>>);

export interface FallbackReport {
  /** Index of the skipped candidate. */
  readonly index: number;
  /** Store id when the candidate was created. */
  readonly id: string | undefined;
  readonly error: SfError;
  readonly phase: 'create' | 'runtime';
}

export interface FallbackStore<V> extends AsyncStore<V> {
  readonly active: AsyncStore<V>;
  /** True when the active store is not the first candidate. */
  readonly degraded: boolean;
  readonly reports: readonly FallbackReport[];
  onFallback(listener: (report: FallbackReport, active: AsyncStore<V>) => void): () => void;
}

function isResult<V>(value: AsyncStore<V> | Result<AsyncStore<V>>): value is Result<AsyncStore<V>> {
  return 'ok' in value && typeof (value as { ok: unknown }).ok === 'boolean' && !('get' in value);
}

function materialize<V>(candidate: StoreCandidate<V>): Result<AsyncStore<V>> {
  const value = typeof candidate === 'function' ? candidate() : candidate;
  return isResult(value) ? value : ok(value);
}

export function fallback<V>(candidates: readonly StoreCandidate<V>[]): Result<FallbackStore<V>> {
  const reports: FallbackReport[] = [];
  const listeners = new Set<(report: FallbackReport, active: AsyncStore<V>) => void>();
  const created: AsyncStore<V>[] = [];
  let index = -1;
  let active: AsyncStore<V> | undefined;
  let disposed = false;

  let pendingReport: FallbackReport | undefined;
  const advance = (phase: FallbackReport['phase'], cause?: SfError): boolean => {
    if (cause !== undefined && active !== undefined) {
      const report: FallbackReport = { index, id: active.id, error: cause, phase };
      reports.push(report);
      pendingReport = report;
    }
    for (index += 1; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      const made = materialize(candidate);
      if (made.ok) {
        active = made.value;
        created.push(made.value);
        return true;
      }
      const report: FallbackReport = { index, id: undefined, error: made.error, phase: 'create' };
      reports.push(report);
      pendingReport ??= report;
    }
    return false;
  };
  const announce = (): void => {
    if (pendingReport === undefined || active === undefined) return;
    const report = pendingReport;
    pendingReport = undefined;
    for (const listener of [...listeners]) listener(report, active);
  };

  if (!advance('create') || active === undefined) {
    return err(StoreUnavailableError({ message: 'No storage candidate is available.', details: { tried: reports.map((r) => r.error.code) } }));
  }
  const firstIndex = 0;
  pendingReport = undefined; // initial skips are visible in `reports`/`degraded`

  let unwatch: (() => void) | undefined;
  const watchers = createWatchers<V>(
    () => {
      unwatch = active?.watch((change) => watchers.emit(change));
    },
    () => {
      unwatch?.();
      unwatch = undefined;
    },
  );
  const rewatch = (): void => {
    if (unwatch === undefined) return;
    unwatch();
    unwatch = active?.watch((change) => watchers.emit(change));
  };

  const current = (): AsyncStore<V> => active as AsyncStore<V>;
  const attemptOn = async <T>(fn: (store: AsyncStore<V>) => Promise<Result<T>>): Promise<Result<T>> => {
    for (;;) {
      const result = await fn(current());
      if (result.ok || result.error.code !== StoreUnavailableError.code || disposed) return result;
      if (!advance('runtime', result.error)) return result;
      rewatch();
      announce();
    }
  };

  const store: FallbackStore<V> = {
    get id() {
      return `fallback(${current().id})`;
    },
    get capabilities(): StoreCapabilities {
      return current().capabilities;
    },
    get active() {
      return current();
    },
    get degraded() {
      return index !== firstIndex;
    },
    reports,
    onFallback(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: (key, options) => attemptOn((s) => s.get(key, options)),
    set: (key, value, options) => attemptOn((s) => s.set(key, value, options)),
    delete: (key, options) => attemptOn((s) => s.delete(key, options)),
    has: (key, options) => attemptOn((s) => s.has(key, options)),
    clear: (options) => attemptOn((s) => s.clear(options)),
    batch: (ops, options) => attemptOn((s) => s.batch(ops, options)),
    seek: (options) => createCursor(() => attemptOn((s) => s.seek(options).toArray())),
    watch: (listener, options) => watchers.add(listener, options),
    async dispose() {
      if (disposed) return ok();
      disposed = true;
      watchers.clear();
      let failure: Result<void> = ok();
      for (const made of created) {
        const result = await made.dispose();
        if (!result.ok && failure.ok) failure = result;
      }
      return failure;
    },
  };
  return ok(store);
}
