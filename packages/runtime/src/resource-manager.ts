/**
 * Resource manager (R5.3, R5.4, docs/LIFECYCLES.md §6 policy table).
 *
 * Demotion policy from weight + retention:
 *   cheap → unmount ⇒ deactivate ⇒ evict immediately
 *   warm  → unmount; keep activated until budget pressure (then deactivate)
 *   heavy → unmount; archive under pressure (snapshot persisted)
 *
 * Budgets: max live features, max warm (activated, unmounted), max hidden, max loaded
 * modules; tighter budgets per memory-pressure level. Memory pressure is a reactive
 * input fact (a core `box`/`derived`) — the platform package feeds it; no platform API here.
 * Candidates are ordered by retention priority, then LRU. An optional `rank` hook
 * (advisor, R19.7) may reorder candidates; it never changes how many are demoted.
 * Framework budgets always win over feature preferences. Features in use (mounted,
 * referenced by a live dependent, or explicitly activated headless) are never demoted.
 */
import { createNoopTelemetry, type Telemetry, watch } from '@staticflux/core';
import type { FeatureId } from './feature.js';
import type { FeatureHost, FeatureInfo } from './feature-host.js';
import { LOGIC_ALIVE_STATES } from './machines.js';
import { RUNTIME_SUBSYSTEMS, runtimeMetrics } from './telemetry.js';

const SUB = RUNTIME_SUBSYSTEMS.resources;

export type MemoryPressure = 'nominal' | 'moderate' | 'critical';

/** A reactive input fact (core `box`/`derived` satisfy it; reads must be tracked for changes to apply). */
export interface ReactiveInput<T> {
  get(): T;
}

export interface ResourceBudgets {
  /** Max features whose logic is alive (mounted + hidden + warm, in-use included). */
  readonly maxActive: number;
  /** Max activated-but-unmounted features kept warm. */
  readonly maxWarm: number;
  /** Max mounted-but-hidden features. */
  readonly maxHidden: number;
  /** Max loaded modules without live logic. */
  readonly maxLoaded: number;
}

export const DEFAULT_BUDGETS: ResourceBudgets = { maxActive: 8, maxWarm: 3, maxHidden: 2, maxLoaded: 6 };

export const DEFAULT_PRESSURE_BUDGETS: { readonly [K in Exclude<MemoryPressure, 'nominal'>]: Partial<ResourceBudgets> } = {
  moderate: { maxWarm: 1, maxHidden: 1, maxLoaded: 2 },
  critical: { maxActive: 2, maxWarm: 0, maxHidden: 0, maxLoaded: 0 },
};

export type DemotionAction = 'unmount' | 'deactivate' | 'archive' | 'evict';

export interface Demotion {
  readonly id: FeatureId;
  readonly action: DemotionAction;
  readonly reason: 'weight' | 'keep-alive' | 'maxActive' | 'maxWarm' | 'maxHidden' | 'maxLoaded';
  readonly pressure: MemoryPressure;
  readonly ok: boolean;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ResourceManagerOptions {
  readonly host: FeatureHost;
  readonly budgets?: Partial<ResourceBudgets>;
  readonly pressureBudgets?: { readonly moderate?: Partial<ResourceBudgets>; readonly critical?: Partial<ResourceBudgets> };
  readonly pressure?: ReactiveInput<MemoryPressure>;
  /** Advisor hook: reorder demotion candidates (suggestion only). */
  readonly rank?: (candidates: readonly FeatureInfo[]) => readonly FeatureId[];
  readonly telemetry?: Telemetry;
  readonly timers?: Timers;
  /** Demotion log length kept for devtools (default 50). */
  readonly historyLimit?: number;
}

export interface ResourceManager {
  readonly pressure: MemoryPressure;
  /** Effective budgets for the current pressure. */
  readonly budgets: ResourceBudgets;
  setBudgets(budgets: Partial<ResourceBudgets>): void;
  /** Run the policy now (it also runs automatically, coalesced, after transitions and pressure changes). */
  enforce(): Promise<readonly Demotion[]>;
  /** Recent demotions (newest last). */
  history(): readonly Demotion[];
  dispose(): void;
}

const PRIORITY_RANK = { low: 0, normal: 1, high: 2 } as const;

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createResourceManager(options: ResourceManagerOptions): ResourceManager {
  const { host } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const timers = options.timers ?? defaultTimers;
  const historyLimit = options.historyLimit ?? 50;
  const pressureInput: ReactiveInput<MemoryPressure> = options.pressure ?? { get: () => 'nominal' };
  let base: ResourceBudgets = { ...DEFAULT_BUDGETS, ...options.budgets };
  const pressureBudgets = {
    moderate: { ...DEFAULT_PRESSURE_BUDGETS.moderate, ...options.pressureBudgets?.moderate },
    critical: { ...DEFAULT_PRESSURE_BUDGETS.critical, ...options.pressureBudgets?.critical },
  };
  const log: Demotion[] = [];
  const keepAlive = new Map<FeatureId, unknown>();
  /** Features that must demote by weight as soon as they are free (just unmounted, or lost their last dependent). */
  const released = new Set<FeatureId>();
  let disposed = false;
  let scheduled = false;
  let running: Promise<readonly Demotion[]> | undefined;
  let rerun = false;

  const effective = (): ResourceBudgets => {
    const pressure = pressureInput.get();
    if (pressure === 'nominal') return base;
    const tighter = pressureBudgets[pressure];
    // Pressure can only tighten budgets.
    return {
      maxActive: Math.min(base.maxActive, tighter.maxActive ?? base.maxActive),
      maxWarm: Math.min(base.maxWarm, tighter.maxWarm ?? base.maxWarm),
      maxHidden: Math.min(base.maxHidden, tighter.maxHidden ?? base.maxHidden),
      maxLoaded: Math.min(base.maxLoaded, tighter.maxLoaded ?? base.maxLoaded),
    };
  };

  const inUse = (info: FeatureInfo): boolean =>
    info.state === 'mounting' ||
    info.state === 'mounted' ||
    info.state === 'hidden' ||
    info.state === 'unmounting' ||
    info.refCount > 0 ||
    info.busy ||
    (info.headless && info.explicit);

  const isWarm = (info: FeatureInfo): boolean => info.state === 'activated' && !inUse(info);

  /** The demotion a warm feature gets, by weight + retention. */
  const demoteActionOf = (info: FeatureInfo): DemotionAction => {
    if (info.weight === 'heavy' && info.retention.archive !== false) return 'archive';
    if (info.weight === 'cheap') return 'evict';
    return 'deactivate';
  };

  /** Retention keep-alive after release: cheap defaults to 0 (immediate), warm/heavy to "until pressure" (undefined). */
  const keepAliveOf = (info: FeatureInfo): number | undefined =>
    info.retention.keepAliveMs ?? (info.weight === 'cheap' ? 0 : undefined);

  const order = (candidates: FeatureInfo[]): FeatureInfo[] => {
    const sorted = [...candidates].sort(
      (a, b) =>
        PRIORITY_RANK[a.retention.priority ?? 'normal'] - PRIORITY_RANK[b.retention.priority ?? 'normal'] || a.lastUsed - b.lastUsed,
    );
    if (options.rank === undefined || sorted.length < 2) return sorted;
    try {
      const suggested = options.rank(sorted);
      const byId = new Map(sorted.map((c) => [c.id, c]));
      const out: FeatureInfo[] = [];
      for (const id of suggested) {
        const candidate = byId.get(id);
        if (candidate !== undefined) {
          out.push(candidate);
          byId.delete(id);
        }
      }
      return [...out, ...byId.values()];
    } catch {
      return sorted;
    }
  };

  const run = async (id: FeatureId, action: DemotionAction, reason: Demotion['reason']): Promise<Demotion> => {
    const result =
      action === 'unmount'
        ? await host.unmount(id)
        : action === 'deactivate'
          ? await host.deactivate(id)
          : action === 'archive'
            ? await host.archive(id)
            : await host.evict(id);
    const demotion: Demotion = { id, action, reason, pressure: pressureInput.get(), ok: result.ok };
    log.push(demotion);
    if (log.length > historyLimit) log.splice(0, log.length - historyLimit);
    telemetry.event('resources.demote', {
      subsystem: SUB,
      level: 'standard',
      attrs: { feature: id, action, reason, pressure: demotion.pressure, ok: result.ok },
    });
    telemetry.record(runtimeMetrics.demotions, 1, { feature: id, action, reason });
    return demotion;
  };

  /** Pick the next demotion, or undefined when every budget holds. */
  const next = (attempted: Set<string>): { id: FeatureId; action: DemotionAction; reason: Demotion['reason'] } | undefined => {
    const budgets = effective();
    const all = host.list();
    const fresh = (id: FeatureId, action: DemotionAction): boolean => !attempted.has(`${id}:${action}`);

    // 1. Weight policy for just-released features (cheap: immediately).
    for (const info of all) {
      if (!released.has(info.id)) continue;
      if (!isWarm(info)) {
        if (!inUse(info)) released.delete(info.id);
        continue;
      }
      const action = demoteActionOf(info);
      if (fresh(info.id, action)) return { id: info.id, action, reason: 'weight' };
      released.delete(info.id);
    }
    // 2. Hidden budget: unmount the least recently used hidden features.
    const hidden = order(all.filter((i) => i.state === 'hidden' && i.mountedDependents.length === 0));
    const hiddenCount = all.filter((i) => i.state === 'hidden').length;
    if (hiddenCount > budgets.maxHidden) {
      const victim = hidden.find((i) => fresh(i.id, 'unmount'));
      if (victim !== undefined) return { id: victim.id, action: 'unmount', reason: 'maxHidden' };
    }
    // 3. Warm and active budgets: demote LRU warm features by weight.
    const warm = order(all.filter(isWarm));
    const aliveCount = all.filter((i) => LOGIC_ALIVE_STATES.includes(i.state)).length;
    const overWarm = warm.length > budgets.maxWarm;
    const overActive = aliveCount > budgets.maxActive;
    if (overWarm || overActive) {
      const victim = warm.find((i) => fresh(i.id, demoteActionOf(i)));
      if (victim !== undefined) return { id: victim.id, action: demoteActionOf(victim), reason: overWarm ? 'maxWarm' : 'maxActive' };
      if (overActive) {
        const hiddenVictim = hidden.find((i) => fresh(i.id, 'unmount'));
        if (hiddenVictim !== undefined) return { id: hiddenVictim.id, action: 'unmount', reason: 'maxActive' };
      }
    }
    // 4. Loaded modules without logic.
    const loaded = order(all.filter((i) => i.state === 'loaded'));
    if (loaded.length > budgets.maxLoaded) {
      const victim = loaded.find((i) => fresh(i.id, i.weight === 'heavy' ? 'archive' : 'evict'));
      if (victim !== undefined) {
        return { id: victim.id, action: victim.weight === 'heavy' ? 'archive' : 'evict', reason: 'maxLoaded' };
      }
    }
    return undefined;
  };

  const enforceOnce = async (): Promise<readonly Demotion[]> => {
    const done: Demotion[] = [];
    const attempted = new Set<string>();
    const limit = host.list().length * 4 + 4;
    for (let i = 0; i < limit && !disposed; i += 1) {
      const step = next(attempted);
      if (step === undefined) break;
      attempted.add(`${step.id}:${step.action}`);
      released.delete(step.id);
      done.push(await run(step.id, step.action, step.reason));
    }
    return done;
  };

  const enforce = (): Promise<readonly Demotion[]> => {
    if (running !== undefined) {
      rerun = true;
      return running;
    }
    running = (async () => {
      const all: Demotion[] = [];
      do {
        rerun = false;
        all.push(...(await enforceOnce()));
      } while (rerun && !disposed);
      running = undefined;
      return all;
    })();
    return running;
  };

  const schedule = (): void => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void enforce();
    });
  };

  const clearKeepAlive = (id: FeatureId): void => {
    const handle = keepAlive.get(id);
    if (handle !== undefined) timers.clear(handle);
    keepAlive.delete(id);
  };

  const unsubscribe = host.onTransition(({ id, from, to }) => {
    if (disposed) return;
    if (to === 'mounting' || to === 'deactivating' || to === 'evicted' || to === 'archived') clearKeepAlive(id);
    if (from === 'unmounting' && to === 'activated') {
      const info = host.info(id);
      const keep = info === undefined ? undefined : keepAliveOf(info);
      if (keep === 0) released.add(id);
      else if (keep !== undefined) {
        clearKeepAlive(id);
        keepAlive.set(
          id,
          timers.set(() => {
            keepAlive.delete(id);
            const current = host.info(id);
            if (current !== undefined && isWarm(current)) void run(id, demoteActionOf(current), 'keep-alive');
          }, keep),
        );
      }
    }
    // A dependency whose last dependent went away is released, too.
    if (from === 'deactivating') {
      for (const info of host.list()) {
        if (info.state === 'activated' && !info.explicit && info.refCount === 0 && keepAliveOf(info) === 0) released.add(info.id);
      }
    }
    schedule();
  });

  const unsubscribeSettled = host.onSettled(() => schedule());

  const stopWatching = watch(
    () => pressureInput.get(),
    (pressure) => {
      telemetry.event('resources.pressure', { subsystem: SUB, level: 'standard', attrs: { pressure } });
      schedule();
    },
  );

  return {
    get pressure() {
      return pressureInput.get();
    },
    get budgets() {
      return effective();
    },
    setBudgets(budgets) {
      base = { ...base, ...budgets };
      schedule();
    },
    enforce,
    history: () => [...log],
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      unsubscribeSettled();
      stopWatching();
      for (const id of [...keepAlive.keys()]) clearKeepAlive(id);
    },
  };
}
