/**
 * Warmup advisor hook (R19.5, R19.7, R19.8, R19.10). An advisor may *reorder* warmup
 * candidates; the loader decides. Suggestions are clamped (only known candidates,
 * nothing added, omitted ones appended in default order, gates still apply in the
 * loader) and time-boxed (timeout → deterministic default order). Never awaited on a
 * navigation critical path: only warmup (likely/speculative) consults it.
 */
import type { Telemetry } from '@staticflux/core';
import type { ChunkIdShape, WarmupTier } from './chunk.js';
import { LOADER_SUBSYSTEMS } from './telemetry.js';

export interface AdviceContext {
  readonly tier: WarmupTier;
  readonly signal: AbortSignal;
}

export interface WarmupAdvisor {
  readonly id: string;
  rank(candidates: readonly ChunkIdShape[], context: AdviceContext): readonly ChunkIdShape[] | Promise<readonly ChunkIdShape[]>;
}

export type AdviceSource = 'default' | 'advisor' | 'timeout' | 'error';

export interface AdviceResult {
  readonly order: readonly ChunkIdShape[];
  readonly source: AdviceSource;
}

export type TimerFn = (callback: () => void, ms: number) => () => void;

export const defaultTimer: TimerFn = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

/** Clamp an advisor's suggestion to the candidate set (R19.7). */
export function clampOrder(candidates: readonly ChunkIdShape[], suggested: readonly ChunkIdShape[]): readonly ChunkIdShape[] {
  const allowed = new Set(candidates);
  const out: ChunkIdShape[] = [];
  const seen = new Set<string>();
  for (const id of suggested) {
    if (allowed.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of candidates) if (!seen.has(id)) out.push(id);
  return out;
}

export interface RankOptions {
  readonly tier: WarmupTier;
  readonly budgetMs?: number;
  readonly timer?: TimerFn;
  readonly telemetry?: Telemetry;
  readonly signal?: AbortSignal;
}

/** Consult the advisor within `budgetMs` (default 5 ms); fall back to the default order. */
export async function rankCandidates(
  advisor: WarmupAdvisor | undefined,
  candidates: readonly ChunkIdShape[],
  options: RankOptions,
): Promise<AdviceResult> {
  if (advisor === undefined || candidates.length < 2) return { order: candidates, source: 'default' };
  const timer = options.timer ?? defaultTimer;
  const budgetMs = options.budgetMs ?? 5;
  const controller = new AbortController();
  const finish = (result: AdviceResult): AdviceResult => {
    controller.abort();
    options.telemetry?.event('advisor.decision', {
      subsystem: LOADER_SUBSYSTEMS.warmup,
      level: 'verbose',
      attrs: {
        advisor: advisor.id,
        tier: options.tier,
        source: result.source,
        overrodeDefault: result.order.some((id, i) => id !== candidates[i]),
        candidates: [...candidates],
        order: [...result.order],
      },
    });
    return result;
  };
  let suggestion: readonly ChunkIdShape[] | Promise<readonly ChunkIdShape[]>;
  try {
    suggestion = advisor.rank(candidates, { tier: options.tier, signal: controller.signal });
  } catch {
    return finish({ order: candidates, source: 'error' });
  }
  if (!(suggestion instanceof Promise)) return finish({ order: clampOrder(candidates, suggestion), source: 'advisor' });
  const result = await new Promise<AdviceResult>((resolve) => {
    const cancel = timer(() => resolve({ order: candidates, source: 'timeout' }), budgetMs);
    suggestion.then(
      (order) => {
        cancel();
        resolve({ order: clampOrder(candidates, order), source: 'advisor' });
      },
      () => {
        cancel();
        resolve({ order: candidates, source: 'error' });
      },
    );
  });
  return finish(result);
}
