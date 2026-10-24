/**
 * The advisor contract (R19.6, R19.12): a typed question + the closed option
 * set in, a probability distribution out (plus optional confidence and
 * explanation). Decision models such as Jev, statistical predictors and
 * remote services all implement this one shape.
 *
 * Advisors never decide: the advisor service clamps, time-boxes and falls back.
 */
import type { Result } from '@staticflux/core';
import type { AnyDecisionPoint, DecisionPoint, DecisionPointId, Distribution, LatencyClass } from './decision.js';

export type AdvisorTier = 'heuristic' | 'statistical' | 'model' | 'remote';

/** Preference order when several advisors support a point (highest first). */
export const TIER_RANK: { readonly [K in AdvisorTier]: number } = { heuristic: 0, statistical: 1, model: 2, remote: 3 };

export interface AdvisorAnswer {
  readonly distribution: Readonly<Partial<Record<string, number>>>;
  /** [0,1]. Defaults to the top probability. */
  readonly confidence?: number;
  readonly explanation?: string;
}

export interface AdviseContext {
  /** Aborted when the time box expires or the caller gives up. */
  readonly signal: AbortSignal;
}

export type AdvisorResponse = Result<AdvisorAnswer> | Promise<Result<AdvisorAnswer>>;

export interface Advisor {
  readonly id: string;
  readonly tier: AdvisorTier;
  /** `sync` advisors answer synchronously (< 1 ms) and may serve sync points. */
  readonly latency: LatencyClass;
  supports(point: AnyDecisionPoint): boolean;
  advise(point: AnyDecisionPoint, question: unknown, context: AdviseContext): AdvisorResponse;
}

export interface TypedAdvise<Q, O extends string> {
  (question: Q, context: AdviseContext):
    | Result<{ readonly distribution: Distribution<O>; readonly confidence?: number; readonly explanation?: string }>
    | Promise<Result<{ readonly distribution: Distribution<O>; readonly confidence?: number; readonly explanation?: string }>>;
}

/** Author a single-point advisor with full typing (any tier). */
export function advisorFor<Q, O extends string, Id extends DecisionPointId>(
  point: DecisionPoint<Q, O, Id>,
  options: { readonly id: string; readonly tier: AdvisorTier; readonly latency: LatencyClass; readonly advise: TypedAdvise<Q, O> },
): Advisor {
  return {
    id: options.id,
    tier: options.tier,
    latency: options.latency,
    supports: (candidate) => candidate.id === point.id,
    advise: (_point, question, context) => options.advise(question as Q, context) as AdvisorResponse,
  };
}
