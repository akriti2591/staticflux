/**
 * Logical chunk ids and chunk declarations (R12.2, R12.3, R12.12).
 *
 * Code refers to chunks by stable *logical* ids (`feature:studio-desktop`), never by
 * hashed file names. A declaration is data: tier, budget, dependencies, profiles and
 * load mode. `load: 'eager'` requires a `reason` (enforced by the type and at build time).
 *
 * Chunk ids are an open set via declaration merging, so typos are compile errors once
 * an app registers its chunks:
 *
 *   declare module '@staticflux/core' {
 *     interface Registry { chunks: { 'feature:studio-desktop': true; 'feature:agent-chat': true } }
 *   }
 */
import type { Registry } from '@staticflux/core';

/** `<kind>:<name>`, e.g. `feature:studio-desktop`, `lib:pdf`, `locale:de/studio`, `wasm:image`. */
export type ChunkIdShape = `${string}:${string}`;

/** Registered chunk ids (declaration merging), or any `<kind>:<name>` when none are registered. */
export type ChunkId = Registry extends { readonly chunks: infer C } ? Extract<keyof C, ChunkIdShape> : ChunkIdShape;

/** Warmup tiers (R12.3). */
export const WARMUP_TIERS = ['critical', 'likely', 'speculative', 'on-demand'] as const;
export type WarmupTier = (typeof WARMUP_TIERS)[number];

/** Budget categories (R12.7): initial feature chunk, lazy sub-chunk, heavy exemption, locale, wasm. */
export type BudgetCategory = 'feature' | 'sub-chunk' | 'heavy' | 'locale' | 'wasm' | 'lib';

/** Default gzip budgets per category in KB (REQUIREMENTS R12.7). */
export const DEFAULT_CHUNK_BUDGETS_KB: Readonly<Record<BudgetCategory, number>> = Object.freeze({
  feature: 50,
  'sub-chunk': 30,
  heavy: 200,
  locale: 10,
  wasm: 500,
  lib: 50,
});

export interface ChunkBudget {
  readonly category?: BudgetCategory;
  /** Overrides the category default (gzip KB). Raising it needs a reason (R12.8). */
  readonly maxKb?: number;
  readonly reason?: string;
}

interface ChunkDeclarationBase<Id extends ChunkIdShape> {
  readonly kind: 'chunk';
  readonly id: Id;
  /** Module path or bundler chunk name the build plugin maps to this id. */
  readonly entry?: string;
  readonly tier: WarmupTier;
  readonly budget?: ChunkBudget;
  /** Logical chunks that must load before this one (preloaded in parallel). */
  readonly deps?: readonly ChunkIdShape[];
  /** Profile keys (`web:expanded`) this chunk serves. Undefined = every profile. */
  readonly profiles?: readonly string[];
  readonly description?: string;
}

export interface LazyChunkDeclaration<Id extends ChunkIdShape = ChunkIdShape> extends ChunkDeclarationBase<Id> {
  readonly load: 'lazy';
}

export interface EagerChunkDeclaration<Id extends ChunkIdShape = ChunkIdShape> extends ChunkDeclarationBase<Id> {
  readonly load: 'eager';
  /** Mandatory: why this chunk is worth its boot cost (R12.12). Shown in the boot waterfall. */
  readonly reason: string;
  /** Profiles in which the chunk is eager (default: all of `profiles`). */
  readonly eagerProfiles?: readonly string[];
}

export type ChunkDeclaration<Id extends ChunkIdShape = ChunkIdShape> = LazyChunkDeclaration<Id> | EagerChunkDeclaration<Id>;

type CommonOptions = Omit<ChunkDeclarationBase<ChunkIdShape>, 'kind' | 'id' | 'tier'> & { readonly tier?: WarmupTier };

export type ChunkOptions =
  | (CommonOptions & { readonly load?: 'lazy' })
  | (CommonOptions & { readonly load: 'eager'; readonly reason: string; readonly eagerProfiles?: readonly string[] });

/**
 * Declare a logical chunk. Everything is lazy (`on-demand`) by default.
 *
 * @example
 * export const StudioChunk = chunk('feature:studio-desktop', { tier: 'on-demand', budget: { category: 'heavy' } });
 * export const ShellChunk = chunk('lib:shell', { load: 'eager', reason: 'Shell frame renders before core-ready' });
 */
/* @__NO_SIDE_EFFECTS__ */
export function chunk<const Id extends ChunkId>(id: Id, options: ChunkOptions = {}): ChunkDeclaration<Id> {
  const tier = options.tier ?? 'on-demand';
  if (options.load === 'eager') {
    return Object.freeze({ ...options, kind: 'chunk', id, tier, load: 'eager' }) as EagerChunkDeclaration<Id>;
  }
  return Object.freeze({ ...options, kind: 'chunk', id, tier, load: 'lazy' }) as LazyChunkDeclaration<Id>;
}

export function isChunkId(value: string): value is ChunkIdShape {
  return /^[a-z0-9-]+:[^\s:][^\s]*$/i.test(value);
}

/** Resolved budget in KB for a declaration (category default unless overridden). */
export function budgetKbOf(budget: ChunkBudget | undefined): number | undefined {
  if (budget === undefined) return undefined;
  if (budget.maxKb !== undefined) return budget.maxKb;
  return budget.category === undefined ? undefined : DEFAULT_CHUNK_BUDGETS_KB[budget.category];
}
