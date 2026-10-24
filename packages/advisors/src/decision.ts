/**
 * Decision points (R19.5, R19.12, R19.13).
 *
 * A decision point is a typed question with a CLOSED set of options. The
 * framework owns the point and its deterministic default heuristic; advisors
 * only return a probability distribution over the options. Advisors suggest,
 * the framework decides (R19.7).
 *
 * Purposes are a closed set of performance concerns. There is deliberately no
 * `authorization` / `entitlement` / `security` purpose (R19.9): advisors can
 * change performance, never correctness.
 *
 * @example
 * export const NextFeaturePoint = defineDecisionPoint({
 *   id: 'loader/next-feature',
 *   purpose: 'warmup',
 *   options: ['studio', 'agent-chat', 'billing', 'none'] as const,
 *   latency: 'sync',
 *   heuristic: (q: { from: string }) => (q.from === 'studio' ? 'agent-chat' : 'none'),
 * });
 */

/** What advisors may influence. Closed on purpose: never authorization (R19.9). */
export type AdvisoryPurpose = 'warmup' | 'retention' | 'scheduling' | 'prefetch' | 'messaging-timing' | 'sampling';

/** sync < 1 ms (heuristic/statistical) · idle = one idle slot · background ≤ ~500 ms, cached (R19.13). */
export type LatencyClass = 'sync' | 'idle' | 'background';

export type DecisionPointId = `${string}/${string}`;

/** A (possibly partial, unnormalized) distribution over options. */
export type Distribution<O extends string> = { readonly [K in O]?: number };

/** A normalized distribution over every option. */
export type FullDistribution<O extends string> = { readonly [K in O]: number };

export interface DecisionPointOptions<Q, O extends string, Id extends DecisionPointId> {
  readonly id: Id;
  readonly purpose: AdvisoryPurpose;
  readonly description?: string;
  /** The closed option set. */
  readonly options: readonly O[];
  readonly latency: LatencyClass;
  /** Deterministic default (the heuristic tier). Must be cheap and pure. */
  readonly heuristic: (question: Q) => O | Distribution<O>;
  /** Clamp: options failing this (budgets, gates, invariants) get probability 0. */
  readonly constrain?: (option: O, question: Q) => boolean;
  /** Identity of the input facts; answers are cached until it changes. Default: stable JSON of the question. */
  readonly cacheKey?: (question: Q) => string;
  /** Time box in ms (defaults: sync 1, idle 50, background 500). */
  readonly budgetMs?: number;
  /** Advisor answers below this confidence fall back to the default. Default 0. */
  readonly minConfidence?: number;
}

export interface DecisionPoint<Q = unknown, O extends string = string, Id extends DecisionPointId = DecisionPointId> {
  readonly kind: 'decision-point';
  readonly id: Id;
  readonly purpose: AdvisoryPurpose;
  readonly description: string | undefined;
  readonly options: readonly O[];
  readonly latency: LatencyClass;
  readonly heuristic: (question: Q) => O | Distribution<O>;
  readonly constrain: ((option: O, question: Q) => boolean) | undefined;
  readonly cacheKey: (question: Q) => string;
  readonly budgetMs: number;
  readonly minConfidence: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDecisionPoint = DecisionPoint<any, any, DecisionPointId>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type QuestionOf<P> = P extends DecisionPoint<infer Q, infer _O, infer _Id> ? Q : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type OptionOf<P> = P extends DecisionPoint<infer _Q, infer O, infer _Id> ? O : never;

export const DEFAULT_BUDGET_MS: { readonly [K in LatencyClass]: number } = { sync: 1, idle: 50, background: 500 };

/** Stable JSON (sorted keys) — the default cache key. */
export function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
    .join(',')}}`;
}

export function defineDecisionPoint<Q, const O extends string, const Id extends DecisionPointId>(
  options: DecisionPointOptions<Q, O, Id>,
): DecisionPoint<Q, O, Id> {
  if (options.options.length === 0) throw new Error(`defineDecisionPoint("${options.id}"): options must not be empty`);
  if (new Set(options.options).size !== options.options.length) {
    throw new Error(`defineDecisionPoint("${options.id}"): options must be unique`);
  }
  return Object.freeze({
    kind: 'decision-point',
    id: options.id,
    purpose: options.purpose,
    description: options.description,
    options: Object.freeze([...options.options]),
    latency: options.latency,
    heuristic: options.heuristic,
    constrain: options.constrain,
    cacheKey: options.cacheKey ?? ((question: Q) => stableKey(question)),
    budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS[options.latency],
    minConfidence: options.minConfidence ?? 0,
  });
}

/**
 * Normalize to a full distribution over `options`. Unknown keys, negative and
 * non-finite values are dropped. Returns all zeros when there is no mass.
 */
export function normalize<O extends string>(
  options: readonly O[],
  distribution: Readonly<Partial<Record<string, number>>>,
): FullDistribution<O> {
  let total = 0;
  for (const option of options) {
    const value = distribution[option];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value;
  }
  const out = {} as Record<O, number>;
  for (const option of options) {
    const value = distribution[option];
    out[option] = total > 0 && typeof value === 'number' && Number.isFinite(value) && value > 0 ? value / total : 0;
  }
  return out;
}

/** Highest-probability option (first wins ties, in option order); undefined when there is no mass. */
export function argmax<O extends string>(options: readonly O[], distribution: FullDistribution<O>): O | undefined {
  let best: O | undefined;
  let bestValue = 0;
  for (const option of options) {
    const value = distribution[option];
    if (value > bestValue) {
      best = option;
      bestValue = value;
    }
  }
  return best;
}

/** Zero out options that fail `allowed`, then renormalize. */
export function clamp<O extends string>(
  options: readonly O[],
  distribution: FullDistribution<O>,
  allowed: ((option: O) => boolean) | undefined,
): FullDistribution<O> {
  if (allowed === undefined) return distribution;
  const kept: Partial<Record<O, number>> = {};
  for (const option of options) kept[option] = allowed(option) ? distribution[option] : 0;
  return normalize(options, kept);
}

/** The heuristic's answer as a full distribution (a bare option = probability 1). */
export function heuristicDistribution<Q, O extends string>(point: DecisionPoint<Q, O>, question: Q): FullDistribution<O> {
  const answer = point.heuristic(question);
  if (typeof answer === 'string') return normalize(point.options, { [answer]: 1 });
  return normalize(point.options, answer);
}
