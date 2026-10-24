/**
 * The advisor service: the ONLY way framework decision points consult advisors
 * (R19.5–R19.14). Guardrails live here, not in advisors:
 *
 * - Time-boxed by latency class; timeout / error / low confidence → the point's
 *   deterministic default (R19.8). `decide()` never blocks; `ask()` never rejects.
 * - Answers are clamped by the point's (and the call's) constraint (R19.7).
 * - Background/idle answers are cached until the point's input facts (cache key)
 *   or the environment change (R19.13).
 * - Auto-downgrade: low-end device, save-data, battery saver, slow network →
 *   heuristic + statistical tiers only. Remote advisors only when explicitly
 *   allowed (private by default, R19.11).
 * - Every decision leaves a trace (advisor, confidence, the default it
 *   overrode, outcome) and feeds hit-rate / wasted-bytes metrics (R19.10).
 *
 * There is no authorization surface here, by design (R19.9): purposes are a
 * closed set of performance concerns and results are suggestions.
 */
import {
  anySignal,
  createMachine,
  createNoopTelemetry,
  createScope,
  defineMachine,
  metric,
  type Result,
  type Scope,
  type Telemetry,
} from '@staticflux/core';
import { type Advisor, type AdvisorAnswer, type AdvisorTier, TIER_RANK } from './advisor.js';
import {
  type AdvisoryPurpose,
  type AnyDecisionPoint,
  argmax,
  clamp,
  type DecisionPoint,
  type DecisionPointId,
  type FullDistribution,
  heuristicDistribution,
  normalize,
} from './decision.js';

export const ADVISORS_SUBSYSTEM = 'advisors/decide' as const;

/** Facts that drive auto-downgrade and privacy (from platform facts / settings). */
export interface AdvisorEnvironment {
  readonly lowEndDevice: boolean;
  readonly saveData: boolean;
  readonly batterySaver?: boolean;
  readonly slowNetwork?: boolean;
  /** Remote advisors are opt-in (R19.11). Default false. */
  readonly allowRemote?: boolean;
}

export type AdviceSource = 'advisor' | 'cache' | 'default';
export type AdviceFallback =
  | 'no-advisor'
  | 'downgraded'
  | 'timeout'
  | 'error'
  | 'invalid'
  | 'low-confidence'
  | 'clamped'
  | 'pending'
  | 'cancelled';

export interface Advice<O extends string> {
  readonly traceId: string;
  readonly point: DecisionPointId;
  /** The suggestion after clamping; undefined when the constraint excludes every option. */
  readonly choice: O | undefined;
  readonly distribution: FullDistribution<O>;
  readonly confidence: number;
  /** What the deterministic default would have chosen (after clamping). */
  readonly defaultChoice: O | undefined;
  readonly overridden: boolean;
  readonly advisor: string;
  readonly tier: AdvisorTier;
  readonly source: AdviceSource;
  /** Why the default was used, when it was. */
  readonly fallback: AdviceFallback | undefined;
  readonly explanation: string | undefined;
}

export interface AdviceOutcome {
  /** The suggestion turned out right (e.g. the warmed feature was opened). */
  readonly hit: boolean;
  /** Bytes fetched for nothing (e.g. a warmed chunk never used). */
  readonly wastedBytes?: number;
}

export interface DecisionTrace {
  readonly id: string;
  readonly point: DecisionPointId;
  readonly purpose: AdvisoryPurpose;
  readonly advisor: string;
  readonly tier: AdvisorTier;
  readonly source: AdviceSource;
  readonly choice: string | undefined;
  readonly defaultChoice: string | undefined;
  readonly overridden: boolean;
  readonly confidence: number;
  readonly fallback: AdviceFallback | undefined;
  readonly time: number;
  outcome: AdviceOutcome | undefined;
}

export interface AdvisorStats {
  readonly decisions: number;
  /** Decisions answered by an advisor (fresh or cached). */
  readonly advised: number;
  readonly overridden: number;
  readonly fallbacks: Readonly<Partial<Record<AdviceFallback, number>>>;
  readonly hits: number;
  readonly misses: number;
  /** hits / (hits + misses); undefined without outcomes. */
  readonly hitRate: number | undefined;
  readonly wastedBytes: number;
}

export interface AskOptions<O extends string> {
  readonly signal?: AbortSignal;
  /** Extra clamp for this call (budgets, gates evaluated by the caller). */
  readonly constrain?: (option: O) => boolean;
}

export interface AdvisorService {
  /** Synchronous, never blocks. Sync points consult sync advisors; idle/background points return cache or default and refresh in the background. */
  decide<Q, O extends string, Id extends DecisionPointId>(
    point: DecisionPoint<Q, O, Id>,
    question: Q,
    options?: AskOptions<O>,
  ): Advice<O>;
  /** Time-boxed per latency class; resolves to the default on timeout/failure. Never rejects. */
  ask<Q, O extends string, Id extends DecisionPointId>(
    point: DecisionPoint<Q, O, Id>,
    question: Q,
    options?: AskOptions<O>,
  ): Promise<Advice<O>>;
  /** Report what happened, for hit-rate and wasted-bytes metrics. */
  recordOutcome(advice: Advice<string>, outcome: AdviceOutcome): void;
  stats(pointId: DecisionPointId): AdvisorStats;
  /** Recent decision traces (ring buffer, newest last). */
  traces(): readonly DecisionTrace[];
  /** Add an advisor plugin; removed when `scope` ends or the returned function is called. */
  addAdvisor(advisor: Advisor, scope?: Scope): () => void;
  /** Drop cached answers (all, or for one point). */
  invalidate(pointId?: DecisionPointId): void;
  dispose(): Promise<void>;
}

export interface AdvisorServiceOptions {
  readonly advisors?: readonly Advisor[];
  /** Read on every decision (reactive sources welcome). Default: not downgraded, no remote. */
  readonly environment?: () => AdvisorEnvironment;
  readonly telemetry?: Telemetry;
  /** Wait for one idle slot (default: requestIdleCallback, setTimeout fallback). */
  readonly idle?: (signal: AbortSignal) => Promise<void>;
  /** Clock for traces and negative-cache expiry (default: telemetry clock). */
  readonly now?: () => number;
  /** Max cached answers (LRU). Default 500. */
  readonly cacheSize?: number;
  /** How long a failed background consultation is remembered before retrying. Default 30 s. */
  readonly retryAfterMs?: number;
  /** Ring buffer size for traces. Default 200. */
  readonly traceLimit?: number;
}

/** One consultation (async path). Mirror into docs/LIFECYCLES.md §14. */
export const consultationMachine = defineMachine({
  id: 'advisors/consultation',
  initial: 'pending',
  states: ['pending', 'waiting-idle', 'consulting', 'answered', 'defaulted', 'cancelled'],
  transitions: {
    pending: { wait: 'waiting-idle', consult: 'consulting', cancel: 'cancelled' },
    'waiting-idle': { consult: 'consulting', cancel: 'cancelled' },
    consulting: { answer: 'answered', fallback: 'defaulted', cancel: 'cancelled' },
  },
  terminal: ['answered', 'defaulted', 'cancelled'],
});

export const AdvisorMetrics = {
  decisions: metric.counter('advisors/decisions', { description: 'Decisions by point, source and advisor.' }),
  overrides: metric.counter('advisors/overrides', { description: 'Decisions where the advisor overrode the default.' }),
  fallbacks: metric.counter('advisors/fallbacks', { description: 'Default used, by reason.' }),
  latency: metric.histogram('advisors/consult-latency', { unit: 'ms', description: 'Async consultation time.' }),
  outcomes: metric.counter('advisors/outcomes', { description: 'Reported outcomes (hit true/false) per point.' }),
  wasted: metric.histogram('advisors/wasted-bytes', { unit: 'By', description: 'Bytes fetched for suggestions that missed.' }),
} as const;

const DEFAULT_ENVIRONMENT: AdvisorEnvironment = { lowEndDevice: false, saveData: false };

function defaultIdle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
      .requestIdleCallback;
    // Aborted to detach the abort listener once the idle callback fires.
    const detach = new AbortController();
    const done = (): void => {
      detach.abort();
      resolve();
    };
    if (typeof ric === 'function') ric(done, { timeout: 1000 });
    else setTimeout(done, 0);
    signal.addEventListener('abort', () => resolve(), { once: true, signal: detach.signal });
  });
}

interface RawAnswer {
  readonly kind: 'answer';
  readonly distribution: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly advisor: string;
  readonly tier: AdvisorTier;
  readonly explanation: string | undefined;
}
interface RawFallback {
  readonly kind: 'fallback';
  readonly reason: AdviceFallback;
  readonly at: number;
}
type Raw = RawAnswer | RawFallback;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

const EMPTY_STATS = (): {
  decisions: number;
  advised: number;
  overridden: number;
  fallbacks: Partial<Record<AdviceFallback, number>>;
  hits: number;
  misses: number;
  wastedBytes: number;
} => ({ decisions: 0, advised: 0, overridden: 0, fallbacks: {}, hits: 0, misses: 0, wastedBytes: 0 });

export function createAdvisorService(options: AdvisorServiceOptions = {}): AdvisorService {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? ((): number => telemetry.now());
  const environment = options.environment ?? ((): AdvisorEnvironment => DEFAULT_ENVIRONMENT);
  const idle = options.idle ?? defaultIdle;
  const cacheSize = options.cacheSize ?? 500;
  const retryAfterMs = options.retryAfterMs ?? 30_000;
  const traceLimit = options.traceLimit ?? 200;
  const scope = createScope('advisors/service');
  const advisors: Advisor[] = [...(options.advisors ?? [])];
  const cache = new Map<string, Raw>();
  const flights = new Map<string, Promise<Raw>>();
  const traceBuffer: DecisionTrace[] = [];
  const traceById = new Map<string, DecisionTrace>();
  const statsByPoint = new Map<string, ReturnType<typeof EMPTY_STATS>>();
  let traceCounter = 0;

  const statsOf = (pointId: string): ReturnType<typeof EMPTY_STATS> => {
    let stats = statsByPoint.get(pointId);
    if (stats === undefined) {
      stats = EMPTY_STATS();
      statsByPoint.set(pointId, stats);
    }
    return stats;
  };

  const tiersFor = (env: AdvisorEnvironment): { readonly allowed: ReadonlySet<AdvisorTier>; readonly downgraded: boolean; readonly key: string } => {
    const downgraded = env.lowEndDevice || env.saveData || env.batterySaver === true || env.slowNetwork === true;
    const allowed = new Set<AdvisorTier>(['heuristic', 'statistical']);
    if (!downgraded) allowed.add('model');
    if (!downgraded && env.allowRemote === true) allowed.add('remote');
    return { allowed, downgraded, key: `${downgraded ? 'd' : 'f'}${env.allowRemote === true ? 'r' : 'l'}` };
  };

  const candidatesFor = (
    point: AnyDecisionPoint,
    allowed: ReadonlySet<AdvisorTier>,
  ): { readonly list: readonly Advisor[]; readonly excluded: boolean } => {
    const supporting = advisors.filter((advisor) => advisor.supports(point));
    const list = supporting
      .filter((advisor) => allowed.has(advisor.tier))
      .map((advisor, index) => ({ advisor, index }))
      .sort((a, b) => TIER_RANK[b.advisor.tier] - TIER_RANK[a.advisor.tier] || a.index - b.index)
      .map((entry) => entry.advisor);
    return { list, excluded: list.length < supporting.length };
  };

  const remember = (key: string, raw: Raw): void => {
    cache.delete(key);
    cache.set(key, raw);
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const lookup = (key: string): Raw | undefined => {
    const raw = cache.get(key);
    if (raw === undefined) return undefined;
    if (raw.kind === 'fallback' && now() - raw.at >= retryAfterMs) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, raw);
    return raw;
  };

  /** Validate an advisor answer against the point. */
  const accept = (point: AnyDecisionPoint, advisor: Advisor, answer: AdvisorAnswer): RawAnswer | AdviceFallback => {
    const full = normalize(point.options, answer.distribution);
    const top = Math.max(...point.options.map((option) => full[option] ?? 0));
    if (top <= 0) return 'invalid';
    const confidence =
      typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
        ? Math.min(1, Math.max(0, answer.confidence))
        : top;
    if (confidence < point.minConfidence) return 'low-confidence';
    return { kind: 'answer', distribution: full, confidence, advisor: advisor.id, tier: advisor.tier, explanation: answer.explanation };
  };

  /** Sync consultation: only `sync` advisors; a returned promise is ignored (not sync-capable). */
  const consultSync = (point: AnyDecisionPoint, question: unknown, list: readonly Advisor[]): Raw => {
    let reason: AdviceFallback = 'no-advisor';
    const controller = new AbortController();
    for (const advisor of list) {
      if (advisor.latency !== 'sync') continue;
      let response: ReturnType<Advisor['advise']>;
      try {
        response = advisor.advise(point, question, { signal: controller.signal });
      } catch {
        reason = 'error';
        continue;
      }
      if (isThenable(response)) {
        controller.abort();
        void Promise.resolve(response).catch(() => undefined);
        reason = 'error';
        continue;
      }
      const result = response as Result<AdvisorAnswer>;
      if (!result.ok) {
        reason = 'error';
        continue;
      }
      const accepted = accept(point, advisor, result.value);
      if (typeof accepted === 'string') {
        reason = accepted;
        continue;
      }
      return accepted;
    }
    return { kind: 'fallback', reason, at: now() };
  };

  /** Async, time-boxed consultation of all candidates in tier order. */
  const consultAsync = async (point: AnyDecisionPoint, question: unknown, list: readonly Advisor[]): Promise<Raw> => {
    const machine = createMachine(consultationMachine);
    const span = telemetry.span('advisor.consult', {
      subsystem: ADVISORS_SUBSYSTEM,
      level: 'verbose',
      attrs: { point: point.id, latency: point.latency, budgetMs: point.budgetMs },
    });
    machine.onTransition((record) => span.event(record.to));
    const started = now();
    const end = (raw: Raw): Raw => {
      if (raw.kind === 'answer') machine.send('answer');
      else machine.send(raw.reason === 'cancelled' ? 'cancel' : 'fallback');
      span.set('outcome', raw.kind === 'answer' ? raw.advisor : raw.reason);
      span.end(raw.kind === 'fallback' && raw.reason === 'cancelled' ? 'cancelled' : 'ok');
      telemetry.record(AdvisorMetrics.latency, now() - started, { point: point.id });
      return raw;
    };
    if (point.latency === 'idle') {
      machine.send('wait');
      await idle(scope.signal);
    }
    if (scope.signal.aborted) return end({ kind: 'fallback', reason: 'cancelled', at: now() });
    machine.send('consult');
    const deadline = new AbortController();
    const signal = anySignal(scope.signal, deadline.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
        deadline.abort(new DOMException('advisor time box', 'TimeoutError'));
      }, point.budgetMs);
    });
    let reason: AdviceFallback = 'no-advisor';
    try {
      for (const advisor of list) {
        let response: Result<AdvisorAnswer> | 'timeout';
        try {
          const pending = Promise.resolve(advisor.advise(point, question, { signal }));
          pending.catch(() => undefined);
          response = await Promise.race([pending, expired]);
        } catch {
          reason = 'error';
          continue;
        }
        // An answer produced after the deadline (e.g. in an abort handler) is discarded.
        if (response === 'timeout' || deadline.signal.aborted) return end({ kind: 'fallback', reason: 'timeout', at: now() });
        if (scope.signal.aborted) return end({ kind: 'fallback', reason: 'cancelled', at: now() });
        if (!response.ok) {
          reason = response.error.kind === 'timeout' ? 'timeout' : 'error';
          continue;
        }
        const accepted = accept(point, advisor, response.value);
        if (typeof accepted === 'string') {
          reason = accepted;
          continue;
        }
        return end(accepted);
      }
      return end({ kind: 'fallback', reason, at: now() });
    } finally {
      clearTimeout(timer);
    }
  };

  const build = <Q, O extends string>(
    point: DecisionPoint<Q, O>,
    question: Q,
    raw: Raw,
    source: AdviceSource,
    callConstraint: ((option: O) => boolean) | undefined,
  ): Advice<O> => {
    const allowed =
      point.constrain === undefined && callConstraint === undefined
        ? undefined
        : (option: O): boolean => (point.constrain?.(option, question) ?? true) && (callConstraint?.(option) ?? true);
    const defaultDistribution = clamp(point.options, heuristicDistribution(point, question), allowed);
    const defaultChoice = argmax(point.options, defaultDistribution);
    let fallback: AdviceFallback | undefined = raw.kind === 'fallback' ? raw.reason : undefined;
    let distribution = defaultDistribution;
    let choice = defaultChoice;
    let confidence = defaultChoice === undefined ? 0 : defaultDistribution[defaultChoice];
    let advisor = 'default';
    let tier: AdvisorTier = 'heuristic';
    let explanation: string | undefined;
    if (raw.kind === 'answer') {
      const clamped = clamp(point.options, normalize(point.options, raw.distribution), allowed);
      const clampedChoice = argmax(point.options, clamped);
      if (clampedChoice === undefined) {
        fallback = 'clamped';
      } else {
        distribution = clamped;
        choice = clampedChoice;
        confidence = raw.confidence;
        advisor = raw.advisor;
        tier = raw.tier;
        explanation = raw.explanation;
      }
    }
    const usedAdvisor = fallback === undefined && raw.kind === 'answer';
    const finalSource: AdviceSource = usedAdvisor ? source : 'default';
    const overridden = usedAdvisor && choice !== defaultChoice;
    traceCounter += 1;
    const traceId = `adv-${traceCounter}`;
    const trace: DecisionTrace = {
      id: traceId,
      point: point.id,
      purpose: point.purpose,
      advisor,
      tier,
      source: finalSource,
      choice,
      defaultChoice,
      overridden,
      confidence,
      fallback,
      time: now(),
      outcome: undefined,
    };
    traceBuffer.push(trace);
    traceById.set(traceId, trace);
    while (traceBuffer.length > traceLimit) {
      const dropped = traceBuffer.shift();
      if (dropped !== undefined) traceById.delete(dropped.id);
    }
    const stats = statsOf(point.id);
    stats.decisions += 1;
    if (usedAdvisor) stats.advised += 1;
    if (overridden) stats.overridden += 1;
    if (fallback !== undefined) stats.fallbacks[fallback] = (stats.fallbacks[fallback] ?? 0) + 1;
    telemetry.record(AdvisorMetrics.decisions, 1, { point: point.id, source: finalSource, advisor });
    if (overridden) telemetry.record(AdvisorMetrics.overrides, 1, { point: point.id, advisor });
    if (fallback !== undefined) telemetry.record(AdvisorMetrics.fallbacks, 1, { point: point.id, reason: fallback });
    return {
      traceId,
      point: point.id,
      choice,
      distribution,
      confidence,
      defaultChoice,
      overridden,
      advisor,
      tier,
      source: finalSource,
      fallback,
      explanation,
    };
  };

  const keyOf = (point: AnyDecisionPoint, question: unknown, envKey: string): string =>
    `${point.id}|${envKey}|${point.cacheKey(question)}`;

  const startFlight = (key: string, point: AnyDecisionPoint, question: unknown, list: readonly Advisor[]): Promise<Raw> => {
    const existing = flights.get(key);
    if (existing !== undefined) return existing;
    const flight = consultAsync(point, question, list).then((raw) => {
      flights.delete(key);
      if (!(raw.kind === 'fallback' && raw.reason === 'cancelled')) remember(key, raw);
      return raw;
    });
    flights.set(key, flight);
    return flight;
  };

  const prepare = (
    point: AnyDecisionPoint,
    question: unknown,
  ): { readonly key: string; readonly list: readonly Advisor[]; readonly empty: AdviceFallback } => {
    const tiers = tiersFor(environment());
    const { list, excluded } = candidatesFor(point, tiers.allowed);
    return {
      key: keyOf(point, question, tiers.key),
      list,
      empty: list.length === 0 && excluded && tiers.downgraded ? 'downgraded' : 'no-advisor',
    };
  };

  const service: AdvisorService = {
    decide(point, question, askOptions = {}) {
      const { key, list, empty } = prepare(point, question);
      if (list.length === 0) return build(point, question, { kind: 'fallback', reason: empty, at: now() }, 'default', askOptions.constrain);
      if (point.latency === 'sync') {
        return build(point, question, consultSync(point, question, list), 'advisor', askOptions.constrain);
      }
      const cached = lookup(key);
      if (cached !== undefined) return build(point, question, cached, 'cache', askOptions.constrain);
      if (!scope.disposed) void startFlight(key, point, question, list);
      return build(point, question, { kind: 'fallback', reason: 'pending', at: now() }, 'default', askOptions.constrain);
    },

    async ask(point, question, askOptions = {}) {
      const { key, list, empty } = prepare(point, question);
      if (list.length === 0) return build(point, question, { kind: 'fallback', reason: empty, at: now() }, 'default', askOptions.constrain);
      if (point.latency === 'sync') return service.decide(point, question, askOptions);
      const cached = lookup(key);
      if (cached !== undefined) return build(point, question, cached, 'cache', askOptions.constrain);
      if (scope.disposed) {
        return build(point, question, { kind: 'fallback', reason: 'cancelled', at: now() }, 'default', askOptions.constrain);
      }
      const flight = startFlight(key, point, question, list);
      const callerSignal = askOptions.signal;
      const raw = await (callerSignal === undefined
        ? flight
        : new Promise<Raw>((resolve) => {
            if (callerSignal.aborted) {
              resolve({ kind: 'fallback', reason: 'cancelled', at: now() });
              return;
            }
            const onAbort = (): void => resolve({ kind: 'fallback', reason: 'cancelled', at: now() });
            const detach = new AbortController();
            callerSignal.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
            void flight.then((value) => {
              detach.abort();
              resolve(value);
            });
          }));
      return build(point, question, raw, 'advisor', askOptions.constrain);
    },

    recordOutcome(advice, outcome) {
      const trace = traceById.get(advice.traceId);
      if (trace !== undefined) trace.outcome = outcome;
      const stats = statsOf(advice.point);
      if (outcome.hit) stats.hits += 1;
      else stats.misses += 1;
      const wasted = outcome.wastedBytes ?? 0;
      stats.wastedBytes += wasted;
      telemetry.record(AdvisorMetrics.outcomes, 1, { point: advice.point, advisor: advice.advisor, hit: outcome.hit });
      if (wasted > 0) telemetry.record(AdvisorMetrics.wasted, wasted, { point: advice.point, advisor: advice.advisor });
    },

    stats(pointId) {
      const stats = statsOf(pointId);
      const judged = stats.hits + stats.misses;
      return { ...stats, fallbacks: { ...stats.fallbacks }, hitRate: judged === 0 ? undefined : stats.hits / judged };
    },

    traces: () => [...traceBuffer],

    addAdvisor(advisor, advisorScope) {
      advisors.push(advisor);
      cache.clear();
      let removed = false;
      const remove = (): void => {
        if (removed) return;
        removed = true;
        const index = advisors.indexOf(advisor);
        if (index >= 0) advisors.splice(index, 1);
        cache.clear();
      };
      advisorScope?.defer(remove);
      return remove;
    },

    invalidate(pointId) {
      if (pointId === undefined) {
        cache.clear();
        return;
      }
      for (const key of [...cache.keys()]) if (key.startsWith(`${pointId}|`)) cache.delete(key);
    },

    async dispose() {
      await scope.dispose();
      cache.clear();
      advisors.length = 0;
    },
  };
  return service;
}
