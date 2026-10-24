/**
 * Telemetry of @staticflux/loader: subsystems and declared metrics. Levels come
 * from core telemetry (`telemetry.setLevel('loader/chunk', 'verbose')`).
 */
import { metric, type Subsystem } from '@staticflux/core';

export const LOADER_SUBSYSTEMS = {
  chunk: 'loader/chunk',
  warmup: 'loader/warmup',
  speculation: 'loader/speculation',
  boot: 'loader/boot',
} as const satisfies Record<string, Subsystem>;

export const loaderMetrics = {
  /** Chunk load duration (attrs: chunk, tier, strategy, codeSource, origin). */
  chunkLoad: metric.histogram('loader/chunk-load', { unit: 'ms', description: 'Logical chunk load duration.' }),
  /** Chunk loads denied by the gate (attrs: chunk, reason). Nothing was fetched (I-8). */
  chunkDenied: metric.counter('loader/chunk-denied', { description: 'Chunk fetches prevented by the gate.' }),
  /** Chunk load failures after retries (attrs: chunk, code). */
  chunkFailed: metric.counter('loader/chunk-failed', { description: 'Chunk loads that failed after retries.' }),
  /** Demand load of a chunk that warmup had already preloaded/loaded (attrs: chunk, warmedBy). */
  warmupHit: metric.counter('loader/warmup-hit', { description: 'Warmed chunks that were later demanded.' }),
  /** Warmup skipped because of network/device facts (attrs: tier, reason). */
  warmupSkipped: metric.counter('loader/warmup-skipped', { description: 'Warmup work skipped by network/device backoff.' }),
  /** Eager boot cost per eager chunk in KB (attrs: chunk, reason, profile). */
  eagerBootCost: metric.gauge('loader/eager-boot-cost', { unit: 'KB', description: "Size of chunks declared load: 'eager' (R12.12)." }),
} as const;
