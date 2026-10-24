/**
 * Speculation engine (speculative tier, R12.3). Declarative rules bind logical chunks
 * to intent signals with an eagerness level (vocabulary of the Speculation Rules API,
 * but implemented with `modulepreload`/`import()` so it works in Safari/Firefox too):
 *
 * | eagerness    | triggers on                                              |
 * |--------------|----------------------------------------------------------|
 * | immediate    | as soon as the rule is activated/observed                |
 * | eager        | viewport, hover, focus, pointerdown, prediction          |
 * | moderate     | hover held for `dwellMs` (200), focus, pointerdown, prediction |
 * | conservative | pointerdown only                                         |
 *
 * Network/device backoff: saveData/offline/2g → nothing; 3g and low-tier devices drop
 * one eagerness step each (conservative − 1 = off). Gates apply in the loader (I-8).
 */
import { createNoopTelemetry, type Scope, type Telemetry } from '@staticflux/core';
import { defaultTimer, rankCandidates, type TimerFn, type WarmupAdvisor } from './advisor.js';
import type { ChunkIdShape } from './chunk.js';
import type { ChunkLoader } from './loader.js';
import { LOADER_SUBSYSTEMS, loaderMetrics } from './telemetry.js';
import { NOMINAL_WARMUP_FACTS, warmupAllowance, type WarmupFacts } from './warmup.js';

export const EAGERNESS_LEVELS = ['immediate', 'eager', 'moderate', 'conservative'] as const;
export type Eagerness = (typeof EAGERNESS_LEVELS)[number];

export type IntentSignal = 'viewport' | 'hover' | 'focus' | 'pointerdown' | 'prediction' | 'leave';

export interface SpeculationRule<Id extends string = string> {
  readonly kind: 'speculation-rule';
  readonly id: Id;
  readonly chunks: readonly ChunkIdShape[];
  readonly eagerness: Eagerness;
  /** `preload` = modulepreload links only (default); `load` = execute (warms functional deps). */
  readonly action: 'preload' | 'load';
  /** Hover dwell for `moderate` (default 200 ms). */
  readonly dwellMs: number;
  readonly description?: string;
}

export function defineSpeculationRule<const Id extends string>(rule: {
  readonly id: Id;
  readonly chunks: readonly ChunkIdShape[];
  readonly eagerness?: Eagerness;
  readonly action?: 'preload' | 'load';
  readonly dwellMs?: number;
  readonly description?: string;
}): SpeculationRule<Id> {
  return Object.freeze({
    kind: 'speculation-rule',
    eagerness: 'moderate',
    action: 'preload',
    dwellMs: 200,
    ...rule,
  }) as SpeculationRule<Id>;
}

/** Lower eagerness by `steps`; undefined = speculation off. */
export function lowerEagerness(eagerness: Eagerness, steps: number): Eagerness | undefined {
  const index = EAGERNESS_LEVELS.indexOf(eagerness) + steps;
  return EAGERNESS_LEVELS[index];
}

/** What a signal does for a rule at an effective eagerness. */
export function reaction(eagerness: Eagerness, signal: IntentSignal): 'trigger' | 'dwell' | 'cancel' | 'ignore' {
  if (signal === 'leave') return 'cancel';
  switch (eagerness) {
    case 'immediate':
    case 'eager':
      return 'trigger';
    case 'moderate':
      if (signal === 'hover') return 'dwell';
      return signal === 'viewport' ? 'ignore' : 'trigger';
    case 'conservative':
      return signal === 'pointerdown' ? 'trigger' : 'ignore';
  }
}

/** Injectable IntersectionObserver constructor (feature-detected; viewport signals off without it). */
export type IntersectionObserverFactory = (
  callback: (entries: readonly { readonly isIntersecting: boolean }[]) => void,
) => { observe(target: unknown): void; disconnect(): void };

export interface SpeculationEngineOptions {
  readonly loader: ChunkLoader;
  readonly rules: readonly SpeculationRule[];
  readonly facts?: () => WarmupFacts;
  readonly timer?: TimerFn;
  readonly advisor?: WarmupAdvisor;
  readonly advisorBudgetMs?: number;
  readonly telemetry?: Telemetry;
  readonly intersectionObserver?: IntersectionObserverFactory | undefined;
}

export type SpeculationOutcome = 'triggered' | 'dwelling' | 'cancelled' | 'ignored' | 'skipped' | 'done' | 'unknown-rule';

export interface SpeculationEngine {
  /** Feed an intent signal for a rule. */
  signal(ruleId: string, signal: IntentSignal): SpeculationOutcome;
  /** Activate a rule (fires `immediate` rules). */
  activate(ruleId: string): SpeculationOutcome;
  /** Bind DOM intent signals of `target` to a rule for the lifetime of `scope`. */
  observe(target: EventTarget, ruleId: string, scope: Scope): void;
  /** Rules that have fired. */
  readonly fired: ReadonlySet<string>;
  /** Wait for in-flight speculative work (tests/devtools). */
  settled(): Promise<void>;
  dispose(): void;
}

/** IntersectionObserver factory when available (Baseline), else undefined. */
export function defaultIntersectionObserver(): IntersectionObserverFactory | undefined {
  const ctor = (globalThis as { IntersectionObserver?: new (cb: (e: readonly { isIntersecting: boolean }[]) => void) => { observe(t: unknown): void; disconnect(): void } }).IntersectionObserver;
  if (typeof ctor !== 'function') return undefined;
  return (callback) => new ctor(callback);
}

export function createSpeculationEngine(options: SpeculationEngineOptions): SpeculationEngine {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const timer = options.timer ?? defaultTimer;
  const facts = options.facts ?? (() => NOMINAL_WARMUP_FACTS);
  const rules = new Map(options.rules.map((r) => [r.id, r]));
  const io = 'intersectionObserver' in options ? options.intersectionObserver : defaultIntersectionObserver();
  const fired = new Set<string>();
  const dwells = new Map<string, () => void>();
  const inFlight = new Set<Promise<void>>();
  const lifetime = new AbortController();

  const run = (rule: SpeculationRule, signal: IntentSignal | 'activate', eagerness: Eagerness): void => {
    fired.add(rule.id);
    const work = (async (): Promise<void> => {
      const candidates = rule.chunks.filter((id) => options.loader.state(id) === 'idle');
      const ranked = await rankCandidates(options.advisor, candidates, {
        tier: 'speculative',
        ...(options.advisorBudgetMs === undefined ? {} : { budgetMs: options.advisorBudgetMs }),
        timer,
        telemetry,
        signal: lifetime.signal,
      });
      telemetry.event('speculation.trigger', {
        subsystem: LOADER_SUBSYSTEMS.speculation,
        attrs: { rule: rule.id, signal, eagerness, action: rule.action, chunks: [...ranked.order], advice: ranked.source },
      });
      for (const id of ranked.order) {
        if (lifetime.signal.aborted) return;
        if (rule.action === 'preload') options.loader.preload(id, { origin: 'speculative' });
        else await options.loader.load(id, { origin: 'speculative', signal: lifetime.signal });
      }
    })();
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const engine: SpeculationEngine = {
    fired,
    signal(ruleId, signal) {
      const rule = rules.get(ruleId);
      if (rule === undefined) return 'unknown-rule';
      if (signal === 'leave') {
        const cancel = dwells.get(ruleId);
        dwells.delete(ruleId);
        cancel?.();
        return cancel === undefined ? 'ignored' : 'cancelled';
      }
      if (fired.has(ruleId)) return 'done';
      const allowance = warmupAllowance(facts(), 'speculative');
      const eagerness = allowance.allowed ? lowerEagerness(rule.eagerness, allowance.eagernessPenalty) : undefined;
      if (eagerness === undefined) {
        telemetry.record(loaderMetrics.warmupSkipped, 1, { tier: 'speculative', reason: allowance.reason ?? 'eagerness-off', rule: ruleId });
        return 'skipped';
      }
      const what = reaction(eagerness, signal);
      if (what === 'ignore' || what === 'cancel') return 'ignored';
      if (what === 'dwell') {
        if (dwells.has(ruleId)) return 'dwelling';
        dwells.set(
          ruleId,
          timer(() => {
            dwells.delete(ruleId);
            if (!fired.has(ruleId) && !lifetime.signal.aborted) run(rule, 'hover', eagerness);
          }, rule.dwellMs),
        );
        return 'dwelling';
      }
      run(rule, signal, eagerness);
      return 'triggered';
    },
    activate(ruleId) {
      const rule = rules.get(ruleId);
      if (rule === undefined) return 'unknown-rule';
      if (fired.has(ruleId)) return 'done';
      const allowance = warmupAllowance(facts(), 'speculative');
      const eagerness = allowance.allowed ? lowerEagerness(rule.eagerness, allowance.eagernessPenalty) : undefined;
      if (eagerness === undefined) {
        telemetry.record(loaderMetrics.warmupSkipped, 1, { tier: 'speculative', reason: allowance.reason ?? 'eagerness-off', rule: ruleId });
        return 'skipped';
      }
      if (eagerness !== 'immediate') return 'ignored';
      run(rule, 'activate', eagerness);
      return 'triggered';
    },
    observe(target, ruleId, scope) {
      engine.activate(ruleId);
      scope.listen(target, 'pointerenter', () => engine.signal(ruleId, 'hover'));
      scope.listen(target, 'pointerleave', () => engine.signal(ruleId, 'leave'));
      scope.listen(target, 'focusin', () => engine.signal(ruleId, 'focus'));
      scope.listen(target, 'pointerdown', () => engine.signal(ruleId, 'pointerdown'));
      scope.listen(target, 'touchstart', () => engine.signal(ruleId, 'pointerdown'), { passive: true });
      if (io !== undefined) {
        const observer = io((entries) => {
          if (entries.some((e) => e.isIntersecting)) engine.signal(ruleId, 'viewport');
        });
        observer.observe(target);
        scope.defer(() => observer.disconnect());
      }
      scope.defer(() => {
        dwells.get(ruleId)?.();
        dwells.delete(ruleId);
      });
    },
    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    dispose() {
      lifetime.abort();
      for (const cancel of dwells.values()) cancel();
      dwells.clear();
    },
  };
  return engine;
}
