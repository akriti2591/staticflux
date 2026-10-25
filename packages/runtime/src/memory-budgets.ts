/**
 * Memory budgets for caches (SF-Δ29, R5.10–R5.12): GPU textures, decoded media and other
 * byte-heavy caches register with one ledger per thread, report the bytes they hold and give an
 * eviction callback. The ledger keeps every kind under its budget and tightens the budgets under
 * memory pressure. Caches are evicted **before** features are demoted: the ledger reacts to a
 * pressure change synchronously, the resource manager runs on a microtask afterwards (and calls
 * `relieve()` first when it is given the ledger).
 *
 * ```ts
 * const memory = createMemoryBudgets({ budgets: { gpu: 512 * MiB }, pressure });
 * const tiles = memory.register({ id: 'render/tiles', kind: 'gpu', evict: (bytes) => cache.evictLru(bytes) });
 * if (!tiles.ok) return tiles;
 * tiles.value.report(cache.bytes); // after every allocation or release; over budget → evict() is called
 * ```
 *
 * Eviction order: lower `priority` first, then the cache holding the most bytes. `evict` is
 * synchronous, frees what it can (LRU first) and returns the bytes it freed; it may call
 * `report()` itself. A cache that frees nothing is skipped for that round.
 */
import { createNoopTelemetry, defineError, err, metric, ok, type Result, type Telemetry, watch } from '@staticflux/core';
import type { MemoryPressure, ReactiveInput } from './resource-manager.js';
import { RUNTIME_SUBSYSTEMS } from './telemetry.js';

const SUB = RUNTIME_SUBSYSTEMS.resources;

export const MemoryCacheRegistrationError = defineError(
  'SF-MEM-001',
  'invariant',
  'A cache could not be registered with the memory budget ledger (duplicate id, unknown kind, or the ledger was disposed).',
  'Give every cache a unique id (e.g. `render/tiles`), use a kind from `MEMORY_KINDS`, and dispose the old handle before registering again.',
);

export const MiB = 1024 * 1024;

/** Kinds of memory with their own budget. */
export const MEMORY_KINDS = ['gpu', 'media'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Bytes per kind. */
export type MemoryBudgets = { readonly [K in MemoryKind]: number };

/** Defaults sized for a desktop editor (Instaflow IF-15.7: GPU caches ≤ 512 MiB, media ≤ 1 GiB). */
export const DEFAULT_MEMORY_BUDGETS: MemoryBudgets = { gpu: 512 * MiB, media: 1024 * MiB };

/** Fraction of each budget left under pressure (pressure only tightens). */
export const DEFAULT_PRESSURE_FACTORS: { readonly [K in Exclude<MemoryPressure, 'nominal'>]: number } = {
  moderate: 0.5,
  critical: 0.25,
};

export type EvictionReason = 'budget' | 'pressure' | 'manual';
export type CachePriority = 'low' | 'normal' | 'high';

export interface MemoryCacheRegistration {
  /** Stable id, unique per ledger (e.g. `render/tiles`). */
  readonly id: string;
  readonly kind: MemoryKind;
  /** Lower priorities are evicted first. Default `normal`. */
  readonly priority?: CachePriority;
  /** Free at least `bytes` if possible (least recently used first); return the bytes freed. */
  evict(bytes: number, reason: EvictionReason): number;
}

export interface MemoryCacheHandle {
  readonly id: string;
  readonly kind: MemoryKind;
  /** Bytes last reported. */
  readonly bytes: number;
  /** Report the bytes this cache holds now. Over budget, caches are evicted before this returns. */
  report(bytes: number): void;
  /** Bytes this kind can still grow by before eviction starts (≥ 0). */
  headroom(): number;
  /** Unregister (bytes count as freed). Idempotent. */
  dispose(): void;
}

export interface MemoryUsage {
  readonly kind: MemoryKind;
  readonly bytes: number;
  readonly budget: number;
  readonly caches: readonly { readonly id: string; readonly bytes: number; readonly priority: CachePriority }[];
}

export interface MemoryEviction {
  readonly cache: string;
  readonly kind: MemoryKind;
  readonly requested: number;
  readonly freed: number;
  readonly reason: EvictionReason;
  readonly pressure: MemoryPressure;
}

export interface MemoryBudgetManager {
  readonly pressure: MemoryPressure;
  register(registration: MemoryCacheRegistration): Result<MemoryCacheHandle>;
  /** Effective budget of a kind for the current pressure. */
  budget(kind: MemoryKind): number;
  usage(kind: MemoryKind): MemoryUsage;
  setBudgets(budgets: Partial<MemoryBudgets>): void;
  /**
   * Evict until every kind is under its effective budget (call before demoting features).
   * `targetFraction` evicts further, down to that fraction of the budget (e.g. 0 empties caches).
   * Returns the bytes freed.
   */
  relieve(options?: { readonly reason?: EvictionReason; readonly targetFraction?: number }): number;
  /** Recent evictions, newest last. */
  history(): readonly MemoryEviction[];
  dispose(): void;
}

export interface MemoryBudgetOptions {
  readonly budgets?: Partial<MemoryBudgets>;
  readonly pressureFactors?: Partial<typeof DEFAULT_PRESSURE_FACTORS>;
  readonly pressure?: ReactiveInput<MemoryPressure>;
  readonly telemetry?: Telemetry;
  /** Eviction log length (default 50). */
  readonly historyLimit?: number;
}

export const memoryMetrics = {
  /** Bytes held per kind (attrs: kind). */
  bytes: /* @__PURE__ */ metric.gauge('runtime/memory-bytes', { unit: 'bytes', description: 'Bytes held by registered caches, per memory kind.' }),
  /** Bytes freed by cache evictions (attrs: kind, cache, reason). */
  evicted: /* @__PURE__ */ metric.counter('runtime/memory-evicted-bytes', { unit: 'bytes', description: 'Bytes freed by budget or pressure evictions.' }),
} as const;

const PRIORITY_RANK: Readonly<Record<CachePriority, number>> = { low: 0, normal: 1, high: 2 };

interface Entry {
  readonly registration: MemoryCacheRegistration;
  readonly priority: CachePriority;
  bytes: number;
  disposed: boolean;
}

export function createMemoryBudgets(options: MemoryBudgetOptions = {}): MemoryBudgetManager {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const historyLimit = options.historyLimit ?? 50;
  const pressureInput: ReactiveInput<MemoryPressure> = options.pressure ?? { get: () => 'nominal' };
  const factors = { ...DEFAULT_PRESSURE_FACTORS, ...options.pressureFactors };
  let base: MemoryBudgets = { ...DEFAULT_MEMORY_BUDGETS, ...options.budgets };
  const entries = new Map<string, Entry>();
  const log: MemoryEviction[] = [];
  let enforcing = false;
  let disposed = false;

  const budgetOf = (kind: MemoryKind): number => {
    const pressure = pressureInput.get();
    const factor = pressure === 'nominal' ? 1 : Math.min(1, Math.max(0, factors[pressure]));
    return Math.floor(base[kind] * factor);
  };

  const totalOf = (kind: MemoryKind): number => {
    let total = 0;
    for (const entry of entries.values()) if (entry.registration.kind === kind && !entry.disposed) total += entry.bytes;
    return total;
  };

  const publish = (kind: MemoryKind): void => {
    telemetry.record(memoryMetrics.bytes, totalOf(kind), { kind });
  };

  /** Evict caches of `kind` until its total is ≤ `target`. Returns bytes freed. */
  const evictKind = (kind: MemoryKind, target: number, reason: EvictionReason): number => {
    let freedTotal = 0;
    const skipped = new Set<string>();
    for (let round = 0; round < entries.size * 2 + 2; round += 1) {
      const over = totalOf(kind) - target;
      if (over <= 0) break;
      const candidates = [...entries.values()]
        .filter((e) => e.registration.kind === kind && !e.disposed && e.bytes > 0 && !skipped.has(e.registration.id))
        .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.bytes - a.bytes);
      const victim = candidates[0];
      if (victim === undefined) break;
      const before = victim.bytes;
      let freed = 0;
      try {
        freed = Math.max(0, victim.registration.evict(over, reason));
      } catch (cause) {
        telemetry.event('resources.cache-evict-failed', { subsystem: SUB, level: 'critical', attrs: { cache: victim.registration.id, kind, error: String(cause) } });
      }
      // The cache may have reported its new size itself; otherwise apply what it says it freed.
      if (victim.bytes === before) victim.bytes = Math.max(0, before - freed);
      const actual = before - victim.bytes;
      if (actual <= 0) skipped.add(victim.registration.id);
      freedTotal += Math.max(0, actual);
      const eviction: MemoryEviction = { cache: victim.registration.id, kind, requested: over, freed: Math.max(0, actual), reason, pressure: pressureInput.get() };
      log.push(eviction);
      if (log.length > historyLimit) log.splice(0, log.length - historyLimit);
      telemetry.event('resources.cache-evict', { subsystem: SUB, level: 'standard', attrs: { ...eviction } });
      telemetry.record(memoryMetrics.evicted, Math.max(0, actual), { kind, cache: victim.registration.id, reason });
    }
    if (totalOf(kind) > target) {
      telemetry.event('resources.memory-over-budget', { subsystem: SUB, level: 'critical', attrs: { kind, bytes: totalOf(kind), budget: target } });
    }
    return freedTotal;
  };

  const enforce = (kinds: readonly MemoryKind[], reason: EvictionReason, fraction = 1): number => {
    if (enforcing || disposed) return 0;
    enforcing = true;
    let freed = 0;
    try {
      for (const kind of kinds) {
        freed += evictKind(kind, Math.floor(budgetOf(kind) * Math.min(1, Math.max(0, fraction))), reason);
        publish(kind);
      }
    } finally {
      enforcing = false;
    }
    return freed;
  };

  const stopWatching = watch(
    () => pressureInput.get(),
    () => {
      enforce(MEMORY_KINDS, 'pressure');
    },
  );

  return {
    get pressure() {
      return pressureInput.get();
    },
    register(registration) {
      if (disposed) return err(MemoryCacheRegistrationError({ message: 'The memory budget ledger was disposed.', details: { cache: registration.id } }));
      if (entries.has(registration.id)) {
        return err(MemoryCacheRegistrationError({ message: `A cache with id "${registration.id}" is already registered.`, details: { cache: registration.id } }));
      }
      if (!(MEMORY_KINDS as readonly string[]).includes(registration.kind)) {
        return err(MemoryCacheRegistrationError({ message: `Unknown memory kind "${String(registration.kind)}".`, details: { cache: registration.id, kinds: [...MEMORY_KINDS] } }));
      }
      const entry: Entry = { registration, priority: registration.priority ?? 'normal', bytes: 0, disposed: false };
      entries.set(registration.id, entry);
      const handle: MemoryCacheHandle = {
        id: registration.id,
        kind: registration.kind,
        get bytes() {
          return entry.bytes;
        },
        report(bytes) {
          if (entry.disposed) return;
          entry.bytes = Math.max(0, Math.floor(bytes));
          if (enforcing) return; // an eviction callback reporting its new size
          if (totalOf(registration.kind) > budgetOf(registration.kind)) enforce([registration.kind], 'budget');
          else publish(registration.kind);
        },
        headroom() {
          return Math.max(0, budgetOf(registration.kind) - totalOf(registration.kind));
        },
        dispose() {
          if (entry.disposed) return;
          entry.disposed = true;
          entries.delete(registration.id);
          publish(registration.kind);
        },
      };
      return ok(handle);
    },
    budget: budgetOf,
    usage(kind) {
      const caches = [...entries.values()]
        .filter((e) => e.registration.kind === kind && !e.disposed)
        .map((e) => ({ id: e.registration.id, bytes: e.bytes, priority: e.priority }));
      return { kind, bytes: totalOf(kind), budget: budgetOf(kind), caches };
    },
    setBudgets(budgets) {
      base = { ...base, ...budgets };
      enforce(MEMORY_KINDS, 'budget');
    },
    relieve(relieveOptions = {}) {
      return enforce(MEMORY_KINDS, relieveOptions.reason ?? 'pressure', relieveOptions.targetFraction ?? 1);
    },
    history: () => [...log],
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching();
      entries.clear();
    },
  };
}
