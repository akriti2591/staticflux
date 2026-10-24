/**
 * Built-in experiment layer: deterministic bucketing of `targetingKey` into
 * weighted variants of enum/boolean flags. For vendor experimentation use an
 * OpenFeature provider adapted with `fromOpenFeatureProvider(…, { layer: 'experiment' })`.
 *
 * Assignment is a pure function of (salt, targetingKey) — stable across reloads
 * and identical in workers.
 */
import { ok } from '@staticflux/core';
import type { EvaluationContext } from './context.js';
import { type AnyFlag, type FlagDefinition, type VariantKey, variantValue } from './flag.js';
import type { FlagLayerProvider } from './layer.js';

export interface ExperimentDefinition<T = unknown> {
  readonly kind: 'experiment';
  readonly flag: FlagDefinition<T>;
  /** Hash salt; default the flag key. Change it to re-randomize. */
  readonly salt: string;
  /** Relative weights per variant. */
  readonly allocation: Readonly<Partial<Record<VariantKey<T>, number>>>;
  /** Restrict enrolment (e.g. by platform facts in the context). Not enrolled = fall through. */
  readonly include?: (context: EvaluationContext) => boolean;
}

/* @__NO_SIDE_EFFECTS__ */
export function defineExperiment<T>(definition: {
  readonly flag: FlagDefinition<T>;
  readonly allocation: Readonly<Partial<Record<VariantKey<T>, number>>>;
  readonly salt?: string;
  readonly include?: (context: EvaluationContext) => boolean;
}): ExperimentDefinition<T> {
  return {
    kind: 'experiment',
    flag: definition.flag,
    salt: definition.salt ?? definition.flag.key,
    allocation: definition.allocation,
    ...(definition.include === undefined ? {} : { include: definition.include }),
  };
}

/** 32-bit FNV-1a hash. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Variant key for `targetingKey`, or undefined when the allocation is empty. */
export function assignVariant(experiment: ExperimentDefinition, targetingKey: string): string | undefined {
  const entries = Object.entries(experiment.allocation as Record<string, number | undefined>).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0,
  );
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return undefined;
  // Map the hash to [0, total).
  const point = (fnv1a(`${experiment.salt}:${targetingKey}`) / 0x100000000) * total;
  let cumulative = 0;
  for (const [key, weight] of entries) {
    cumulative += weight;
    if (point < cumulative) return key;
  }
  return entries[entries.length - 1]?.[0];
}

export interface ExperimentLayerOptions {
  readonly id?: string;
  readonly experiments: readonly ExperimentDefinition[];
}

export function createExperimentLayer(options: ExperimentLayerOptions): FlagLayerProvider {
  const byKey = new Map<string, ExperimentDefinition>();
  for (const experiment of options.experiments) byKey.set(experiment.flag.key, experiment);
  return {
    id: options.id ?? 'config/experiments',
    layer: 'experiment',
    identityBound: true,
    lookup(flag: AnyFlag, context) {
      const experiment = byKey.get(flag.key);
      const targetingKey = context.targetingKey;
      if (experiment === undefined || targetingKey === undefined || targetingKey === '') return ok(undefined);
      if (experiment.include !== undefined && !experiment.include(context)) return ok(undefined);
      const key = assignVariant(experiment, targetingKey);
      if (key === undefined) return ok(undefined);
      return ok({
        value: variantValue(flag, key as never),
        variant: key,
        reason: 'SPLIT',
        flagMetadata: { experiment: experiment.salt },
      });
    },
  };
}
