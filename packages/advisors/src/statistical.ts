/**
 * Statistical tier (R19.6): per-user history, on-device only (R19.11).
 *
 * `createMarkovModel` is a bounded first-order Markov chain (e.g. route →
 * next route). History is persisted through `AdvisorStoragePort` — in the app,
 * a `device`- or `user`-scoped user-data slice (R9.8). Loss or corruption of
 * history is harmless: the model restarts empty and the default heuristic
 * answers until enough observations exist.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { type Advisor, advisorFor } from './advisor.js';
import type { DecisionPoint, DecisionPointId } from './decision.js';
import { normalize } from './decision.js';
import { AdvisorStorageError, CorruptHistoryError, InsufficientDataError } from './errors.js';

/** Per-call options for storage operations (structural subset of `@staticflux/storage` options). */
export interface AdvisorStorageCallOptions {
  readonly signal?: AbortSignal;
}

/**
 * Persistence port — a minimal structural subset of `@staticflux/storage`'s
 * `AsyncStore`, so an AsyncStore (or a user-data slice adapter) can be passed
 * directly. Async only; values are JSON-serializable.
 */
export interface AdvisorStoragePort {
  get(key: string, options?: AdvisorStorageCallOptions): Promise<Result<unknown>>;
  set(key: string, value: unknown, options?: AdvisorStorageCallOptions): Promise<Result<void>>;
  delete(key: string, options?: AdvisorStorageCallOptions): Promise<Result<void>>;
}

/** In-memory storage (tests, embedded hosts without storage). */
export function createMemoryAdvisorStorage(initial: Readonly<Record<string, unknown>> = {}): AdvisorStoragePort & {
  readonly data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: (key) => Promise.resolve(ok(data.get(key))),
    set: (key, value) => {
      data.set(key, structuredClone(value));
      return Promise.resolve(ok());
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve(ok());
    },
  };
}

export const MARKOV_SNAPSHOT_VERSION = 1;

export interface MarkovSnapshot {
  readonly version: typeof MARKOV_SNAPSHOT_VERSION;
  /** from → (to → weight) */
  readonly transitions: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly last: string | undefined;
}

export interface MarkovModelOptions {
  readonly storage: AdvisorStoragePort;
  /** Storage key (e.g. the user-data slice key). */
  readonly key: string;
  /** Maximum `from` states kept (least recently updated are dropped). Default 200. */
  readonly maxStates?: number;
  /** Maximum outgoing transitions kept per state (lowest weights dropped). Default 20. */
  readonly maxTransitions?: number;
  /** Multiply existing weights of a state by this on each new observation (recency). Default 1 (no decay). */
  readonly decay?: number;
  /** Schedule a coalesced write (default: microtask). Pass the boot scheduler's idle hook in apps. */
  readonly schedule?: (flush: () => void) => void;
  /** Reports storage/corruption problems (never thrown). */
  readonly onError?: (error: SfError) => void;
}

export interface MarkovModel {
  /** Restore history from storage (call once; failures reset to empty and are reported). */
  load(signal?: AbortSignal): Promise<Result<void>>;
  /** Observe the next state of a sequence (records `last → state`). */
  observe(state: string): void;
  /** Record one transition explicitly. */
  transition(from: string, to: string): void;
  /** Normalized next-state distribution from `from` (empty object when unknown). */
  predict(from: string): Readonly<Record<string, number>>;
  /** Total observations leaving `from`. */
  count(from: string): number;
  snapshot(): MarkovSnapshot;
  /** Write now (also happens automatically, coalesced). */
  flush(signal?: AbortSignal): Promise<Result<void>>;
  /** Forget everything (e.g. logout wipe of user-scoped slices). */
  reset(): void;
}

function isSnapshot(value: unknown): value is MarkovSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; transitions?: unknown; last?: unknown };
  if (candidate.version !== MARKOV_SNAPSHOT_VERSION) return false;
  if (candidate.last !== undefined && typeof candidate.last !== 'string') return false;
  if (typeof candidate.transitions !== 'object' || candidate.transitions === null) return false;
  for (const row of Object.values(candidate.transitions as Record<string, unknown>)) {
    if (typeof row !== 'object' || row === null) return false;
    for (const weight of Object.values(row as Record<string, unknown>)) {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) return false;
    }
  }
  return true;
}

export function createMarkovModel(options: MarkovModelOptions): MarkovModel {
  const maxStates = options.maxStates ?? 200;
  const maxTransitions = options.maxTransitions ?? 20;
  const decay = options.decay ?? 1;
  const schedule = options.schedule ?? ((fn: () => void) => queueMicrotask(fn));
  // Map insertion order = recency of update (re-inserted on update).
  let rows = new Map<string, Map<string, number>>();
  let last: string | undefined;
  let dirty = false;
  let scheduled = false;

  const snapshot = (): MarkovSnapshot => {
    const transitions: Record<string, Record<string, number>> = {};
    for (const [from, row] of rows) transitions[from] = Object.fromEntries(row);
    return { version: MARKOV_SNAPSHOT_VERSION, transitions, last };
  };

  const flush = async (signal: AbortSignal = new AbortController().signal): Promise<Result<void>> => {
    dirty = false;
    try {
      const written = await options.storage.set(options.key, snapshot(), { signal });
      if (!written.ok) {
        const error = AdvisorStorageError({ cause: written.error, details: { key: options.key } });
        options.onError?.(error);
        return err(error);
      }
      return ok();
    } catch (error) {
      const wrapped = AdvisorStorageError({ cause: error, details: { key: options.key } });
      options.onError?.(wrapped);
      return err(wrapped);
    }
  };

  const markDirty = (): void => {
    dirty = true;
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      if (dirty) void flush();
    });
  };

  const transition = (from: string, to: string): void => {
    const row = rows.get(from) ?? new Map<string, number>();
    rows.delete(from);
    if (decay !== 1) for (const [key, weight] of row) row.set(key, weight * decay);
    row.set(to, (row.get(to) ?? 0) + 1);
    if (row.size > maxTransitions) {
      const weakest = [...row.entries()].sort((a, b) => a[1] - b[1])[0];
      if (weakest !== undefined) row.delete(weakest[0]);
    }
    rows.set(from, row);
    while (rows.size > maxStates) {
      const oldest = rows.keys().next().value;
      if (oldest === undefined) break;
      rows.delete(oldest);
    }
    markDirty();
  };

  return {
    async load(signal = new AbortController().signal) {
      let read: Result<unknown>;
      try {
        read = await options.storage.get(options.key, { signal });
      } catch (error) {
        read = err(AdvisorStorageError({ cause: error }));
      }
      if (!read.ok) {
        const error = AdvisorStorageError({ cause: read.error, details: { key: options.key } });
        options.onError?.(error);
        return err(error);
      }
      if (read.value === undefined) return ok();
      if (!isSnapshot(read.value)) {
        rows = new Map();
        last = undefined;
        const error = CorruptHistoryError({ details: { key: options.key } });
        options.onError?.(error);
        return err(error);
      }
      rows = new Map(Object.entries(read.value.transitions).map(([from, row]) => [from, new Map(Object.entries(row))]));
      last = read.value.last;
      return ok();
    },
    observe(state) {
      if (last !== undefined && last !== state) transition(last, state);
      if (last !== state) {
        last = state;
        markDirty();
      }
    },
    transition,
    predict(from) {
      const row = rows.get(from);
      if (row === undefined) return {};
      const keys = [...row.keys()];
      return normalize(keys, Object.fromEntries(row));
    },
    count(from) {
      let total = 0;
      for (const weight of rows.get(from)?.values() ?? []) total += weight;
      return total;
    },
    snapshot,
    flush,
    reset() {
      rows = new Map();
      last = undefined;
      markDirty();
    },
  };
}

export interface MarkovAdvisorOptions<Q> {
  readonly id: string;
  readonly model: MarkovModel;
  /** The current state for a question (e.g. the current route id). */
  readonly from: (question: Q) => string;
  /** Observations needed before answering. Default 3. */
  readonly minObservations?: number;
}

/** A sync, statistical advisor over a Markov model (e.g. next-feature warmup). */
export function createMarkovAdvisor<Q, O extends string, Id extends DecisionPointId>(
  point: DecisionPoint<Q, O, Id>,
  options: MarkovAdvisorOptions<Q>,
): Advisor {
  const minObservations = options.minObservations ?? 3;
  return advisorFor(point, {
    id: options.id,
    tier: 'statistical',
    latency: 'sync',
    advise: (question) => {
      const from = options.from(question);
      const observations = options.model.count(from);
      if (observations < minObservations) {
        return err(InsufficientDataError({ details: { from, observations, minObservations } }));
      }
      const predicted = options.model.predict(from) as Readonly<Partial<Record<O, number>>>;
      // Confidence grows with evidence: n / (n + k), k = minObservations.
      const confidence = observations / (observations + minObservations);
      return ok({ distribution: predicted, confidence, explanation: `${observations} observations from "${from}"` });
    },
  });
}
