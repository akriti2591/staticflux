/**
 * Adapter: @staticflux/advisors → @staticflux/loader warmup ranking (R19.5–R19.8).
 *
 * A statistical (first-order Markov) advisor learns "which feature chunk follows
 * which" from committed navigations and reorders warmup candidates. Advisors only
 * reorder (the loader clamps to its candidates, time-boxed) and are never used for
 * authorization (R19.9). History persists in the storage registry (device scope).
 */
import { token, unit } from '@staticflux/core';
import {
  AdvisorServiceToken,
  AdvisorStorageToken,
  defineDecisionPoint,
  type MarkovModel,
  markovAdvisorUnits,
} from '@staticflux/advisors';
import { type ChunkIdShape, type WarmupAdvisor, WarmupAdvisorsToken } from '@staticflux/loader';
import { StoreRegistryToken } from '@staticflux/storage';
import { contribution } from '@staticflux/core';
import { Chunks } from '../app/contracts.js';

export const NO_FEATURE = 'none:none';
const OPTIONS = [...Object.values(Chunks), NO_FEATURE] as const;
type ChunkOption = (typeof OPTIONS)[number];

export interface NextChunkQuestion {
  readonly from: string;
}

export const NextChunkPoint = defineDecisionPoint({
  id: 'studio/next-chunk',
  purpose: 'warmup',
  options: OPTIONS,
  latency: 'sync',
  heuristic: (_q: NextChunkQuestion) => ({ [Chunks.agentChat]: 0.5, [Chunks.onboarding]: 0.2, [Chunks.billing]: 0.1, [Chunks.settings]: 0.1, [NO_FEATURE]: 0.1 }),
  cacheKey: (q) => q.from,
  description: 'Which feature chunk the user opens next (warmup order only).',
});

export const NextChunkModelToken = token('studio/next-chunk-model').type<MarkovModel>();

export const advisorStorageUnit = unit({
  id: 'studio/advisor-storage-unit',
  provides: AdvisorStorageToken,
  scope: 'app',
  deps: { required: { registry: StoreRegistryToken } },
  create: ({ registry }) => registry.open('device', 'studio/advisors'),
  description: 'Advisor history in the device store (IndexedDB in browsers).',
});

export const nextChunkAdvisorUnits = markovAdvisorUnits({
  id: 'studio/next-chunk-markov',
  point: NextChunkPoint,
  modelToken: NextChunkModelToken,
  storageKey: 'studio/next-chunk',
  from: (q: NextChunkQuestion) => q.from,
  minObservations: 2,
});

/** The current "from" state (last committed feature chunk), set by the router adapter. */
export interface ChunkCursor {
  current: string;
}
export const ChunkCursorToken = token('studio/chunk-cursor').type<ChunkCursor>();
export const chunkCursorUnit = unit({ id: 'studio/chunk-cursor-unit', provides: ChunkCursorToken, scope: 'app', create: (): ChunkCursor => ({ current: NO_FEATURE }) });

export const advisorWarmupRankerUnit = contribution({
  id: 'studio/advisor-warmup-ranker-unit',
  provides: WarmupAdvisorsToken,
  scope: 'app',
  deps: { required: { advisors: AdvisorServiceToken, cursor: ChunkCursorToken } },
  create: ({ advisors, cursor }): WarmupAdvisor => ({
    id: 'studio/next-chunk-ranker',
    rank(candidates) {
      const advice = advisors.decide(NextChunkPoint, { from: cursor.current });
      const weight = (id: ChunkIdShape): number => (advice.distribution as Readonly<Record<string, number>>)[id] ?? 0;
      return [...candidates].sort((a, b) => weight(b) - weight(a));
    },
  }),
  description: 'Warmup order from the next-chunk decision point.',
});

export type { ChunkOption };
