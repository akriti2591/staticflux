/**
 * Runtime budgets on feature marks (R17.12, R12.7, R12.8). Budgets are data: per
 * feature (or `*`), per mark, per device tier and journey start (cold/warm). The
 * evaluator checks journey summaries and emits `SF-PERF-002` violations on the
 * conformance stream (flagged in devtools, enforced in e2e lab runs).
 */
import { type Conformance, violationOf } from './conformance.js';
import { BudgetExceededViolation } from './errors.js';
import type { JourneyStart, JourneySummary, JourneyTracker } from './journey.js';
import type { FeatureMark } from './telemetry.js';

export type DeviceTier = 'low' | 'mid' | 'high';

export interface MarkBudget {
  readonly kind: 'mark-budget';
  /** Feature id, or `*` for every feature. */
  readonly feature: string;
  readonly mark: FeatureMark;
  readonly maxMs: number;
  /** Tiers this budget applies to (default all). */
  readonly tiers?: readonly DeviceTier[];
  /** Journey starts this budget applies to (default all). `soft` journeys count as warm. */
  readonly starts?: readonly JourneyStart[];
  readonly reason?: string;
}

export function defineMarkBudget(budget: Omit<MarkBudget, 'kind'>): MarkBudget {
  return Object.freeze({ ...budget, kind: 'mark-budget' });
}

/** Starting timing budgets (REQUIREMENTS R12.7; mid-tier mobile, 4G-class, lab). */
export const DEFAULT_MARK_BUDGETS: readonly MarkBudget[] = Object.freeze([
  defineMarkBudget({ feature: '*', mark: 'first-render', maxMs: 1_800, starts: ['cold'], reason: 'R12.7' }),
  defineMarkBudget({ feature: '*', mark: 'first-render', maxMs: 500, starts: ['warm', 'soft'], reason: 'R12.7' }),
  defineMarkBudget({ feature: '*', mark: 'interactive', maxMs: 2_500, starts: ['cold'], reason: 'R12.7' }),
  defineMarkBudget({ feature: '*', mark: 'interactive', maxMs: 700, starts: ['warm', 'soft'], reason: 'R12.7' }),
]);

export interface BudgetOverrun {
  readonly feature: string;
  readonly mark: FeatureMark;
  readonly valueMs: number;
  readonly budgetMs: number;
  readonly journey: string;
  readonly start: JourneyStart;
  readonly tier: DeviceTier;
}

export interface BudgetEvaluator {
  evaluate(summary: JourneySummary): readonly BudgetOverrun[];
  /** Evaluate every journey the tracker completes. Returns the unsubscribe function. */
  attach(tracker: JourneyTracker): () => void;
}

export interface BudgetEvaluatorOptions {
  readonly budgets: readonly MarkBudget[];
  readonly tier?: () => DeviceTier;
  readonly conformance?: Conformance;
}

/** The most specific applicable budget wins (feature-specific over `*`). */
export function applicableBudget(
  budgets: readonly MarkBudget[],
  feature: string,
  mark: FeatureMark,
  tier: DeviceTier,
  start: JourneyStart,
): MarkBudget | undefined {
  let best: MarkBudget | undefined;
  for (const b of budgets) {
    if (b.mark !== mark) continue;
    if (b.feature !== '*' && b.feature !== feature) continue;
    if (b.tiers !== undefined && !b.tiers.includes(tier)) continue;
    if (b.starts !== undefined && !b.starts.includes(start)) continue;
    if (best === undefined || (best.feature === '*' && b.feature !== '*')) best = b;
  }
  return best;
}

export function createBudgetEvaluator(options: BudgetEvaluatorOptions): BudgetEvaluator {
  const tierOf = options.tier ?? (() => 'mid' as const);
  const evaluator: BudgetEvaluator = {
    evaluate(summary) {
      const tier = tierOf();
      const start = summary.classification.start;
      const overruns: BudgetOverrun[] = [];
      for (const [feature, marks] of Object.entries(summary.marks)) {
        for (const [mark, recorded] of Object.entries(marks) as [FeatureMark, { value: number; method: string }][]) {
          const budget = applicableBudget(options.budgets, feature, mark, tier, start);
          if (budget === undefined || recorded.value <= budget.maxMs) continue;
          const overrun: BudgetOverrun = { feature, mark, valueMs: recorded.value, budgetMs: budget.maxMs, journey: summary.id, start, tier };
          overruns.push(overrun);
          options.conformance?.report(
            violationOf(BudgetExceededViolation, {
              feature,
              message: `feature.${mark} took ${Math.round(recorded.value)} ms (budget ${budget.maxMs} ms, ${start}, ${tier} tier).`,
              details: { ...overrun, method: recorded.method },
            }),
          );
        }
      }
      return overruns;
    },
    attach(tracker) {
      return tracker.onJourney((summary) => {
        evaluator.evaluate(summary);
      });
    },
  };
  return evaluator;
}
