/**
 * Warmup tiers (R12.3):
 * - `critical`    — service-worker precache list from the manifest (`precacheList`, build/SW time).
 * - `likely`      — loaded in the background, one chunk per idle slot (`warmLikely`).
 * - `speculative` — on intent signals (`speculation.ts`).
 * - `on-demand`   — only when requested.
 *
 * Network/device aware (R18.2): offline, `saveData`, and 2g-class networks skip
 * background warmup; 3g and low-tier devices lower speculative eagerness.
 *
 * Warmup lifecycle (machine `loader/warmup`): idle ⇄ running; any → disposed.
 */
import { anySignal, createMachine, createNoopTelemetry, defineMachine, type Telemetry } from '@staticflux/core';
import { rankCandidates, type AdviceSource, type TimerFn, type WarmupAdvisor } from './advisor.js';
import type { ChunkIdShape, WarmupTier } from './chunk.js';
import { ProfileExcludedError } from './errors.js';
import type { ChunkLoader } from './loader.js';
import { LOADER_SUBSYSTEMS, loaderMetrics } from './telemetry.js';

export type EffectiveConnectionType = 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
export type DeviceTierName = 'low' | 'mid' | 'high';

/** Structural subset of platform facts (bind from `@staticflux/platform` network/device facts). */
export interface WarmupFacts {
  readonly online: boolean;
  readonly saveData: boolean;
  readonly effectiveType: EffectiveConnectionType;
  readonly deviceTier: DeviceTierName;
}

export const NOMINAL_WARMUP_FACTS: WarmupFacts = Object.freeze({
  online: true,
  saveData: false,
  effectiveType: 'unknown',
  deviceTier: 'mid',
});

export interface WarmupAllowance {
  readonly allowed: boolean;
  readonly reason: string | undefined;
  /** Eagerness steps to drop for speculative rules (0 = as declared). */
  readonly eagernessPenalty: number;
}

/** Decide whether background/speculative warmup may run under `facts`. */
export function warmupAllowance(facts: WarmupFacts, tier: WarmupTier): WarmupAllowance {
  if (tier === 'critical' || tier === 'on-demand') return { allowed: true, reason: undefined, eagernessPenalty: 0 };
  if (!facts.online) return { allowed: false, reason: 'offline', eagernessPenalty: 0 };
  if (facts.saveData) return { allowed: false, reason: 'save-data', eagernessPenalty: 0 };
  if (facts.effectiveType === 'slow-2g' || facts.effectiveType === '2g') {
    return { allowed: false, reason: `network-${facts.effectiveType}`, eagernessPenalty: 0 };
  }
  let penalty = 0;
  if (tier === 'speculative' && facts.effectiveType === '3g') penalty += 1;
  if (tier === 'speculative' && facts.deviceTier === 'low') penalty += 1;
  return { allowed: true, reason: undefined, eagernessPenalty: penalty };
}

/** Idle scheduler port (runtime frame scheduler `postTask('idle')`, or requestIdleCallback). */
export type IdleScheduler = (callback: () => void, signal: AbortSignal) => void;

export const defaultIdleScheduler: IdleScheduler = (callback, signal) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const cancelRic = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
  // The abort listener is itself removed once the callback ran (no leaked listener).
  const ran = new AbortController();
  const run = (): void => {
    ran.abort();
    callback();
  };
  if (typeof ric === 'function') {
    const handle = ric(run, { timeout: 2_000 });
    signal.addEventListener('abort', () => cancelRic?.(handle), { once: true, signal: ran.signal });
    return;
  }
  const handle = setTimeout(run, 50);
  signal.addEventListener('abort', () => clearTimeout(handle), { once: true, signal: ran.signal });
};

export const warmupMachine = defineMachine({
  id: 'loader/warmup',
  initial: 'idle',
  states: ['idle', 'running', 'disposed'],
  transitions: {
    idle: { start: 'running', dispose: 'disposed' },
    running: { finish: 'idle', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type WarmOutcome = 'loaded' | 'skipped' | 'denied' | 'failed' | 'already-loaded' | 'aborted';

export interface WarmReport {
  readonly results: readonly { readonly id: ChunkIdShape; readonly outcome: WarmOutcome }[];
  readonly advice: AdviceSource;
  readonly skippedReason: string | undefined;
}

export interface Warmup {
  /** Warm `ids` (default: every `likely` chunk), one per idle slot, in advisor-ranked order. */
  warmLikely(ids?: readonly ChunkIdShape[], signal?: AbortSignal): Promise<WarmReport>;
  readonly state: 'idle' | 'running' | 'disposed';
  dispose(): void;
}

export interface WarmupOptions {
  readonly loader: ChunkLoader;
  readonly idle?: IdleScheduler;
  readonly facts?: () => WarmupFacts;
  readonly advisor?: WarmupAdvisor;
  readonly advisorBudgetMs?: number;
  readonly timer?: TimerFn;
  readonly telemetry?: Telemetry;
  /** `load` executes the chunk (default); `preload` only injects modulepreload links. */
  readonly action?: 'load' | 'preload';
}

export function createWarmup(options: WarmupOptions): Warmup {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const idle = options.idle ?? defaultIdleScheduler;
  const facts = options.facts ?? (() => NOMINAL_WARMUP_FACTS);
  const action = options.action ?? 'load';
  const machine = createMachine(warmupMachine);
  const lifetime = new AbortController();

  const waitIdle = (signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const settled = new AbortController();
      signal.addEventListener('abort', () => resolve(false), { once: true, signal: settled.signal });
      idle(() => {
        settled.abort();
        resolve(!signal.aborted);
      }, signal);
    });

  return {
    get state() {
      return machine.state;
    },
    async warmLikely(ids, callerSignal) {
      const signal = anySignal(callerSignal, lifetime.signal);
      const allowance = warmupAllowance(facts(), 'likely');
      if (!allowance.allowed) {
        telemetry.record(loaderMetrics.warmupSkipped, 1, { tier: 'likely', reason: allowance.reason ?? '' });
        return { results: [], advice: 'default', skippedReason: allowance.reason };
      }
      const manifest = options.loader.manifest;
      const requested = ids ?? Object.values(manifest.chunks).filter((c) => c.tier === 'likely').map((c) => c.id);
      const candidates = requested.filter((id) => options.loader.state(id) !== 'loaded');
      if (!machine.can('start')) return { results: [], advice: 'default', skippedReason: machine.state };
      machine.send('start');
      const span = telemetry.span('warmup.likely', { subsystem: LOADER_SUBSYSTEMS.warmup, attrs: { candidates: [...candidates] } });
      const ranked = await rankCandidates(options.advisor, candidates, {
        tier: 'likely',
        ...(options.advisorBudgetMs === undefined ? {} : { budgetMs: options.advisorBudgetMs }),
        ...(options.timer === undefined ? {} : { timer: options.timer }),
        telemetry,
        signal,
      });
      const results: { id: ChunkIdShape; outcome: WarmOutcome }[] = [];
      for (const id of requested.filter((r) => !candidates.includes(r))) results.push({ id, outcome: 'already-loaded' });
      for (const id of ranked.order) {
        if (!(await waitIdle(signal))) {
          results.push({ id, outcome: 'aborted' });
          continue;
        }
        const now = warmupAllowance(facts(), 'likely');
        if (!now.allowed) {
          telemetry.record(loaderMetrics.warmupSkipped, 1, { tier: 'likely', reason: now.reason ?? '' });
          results.push({ id, outcome: 'skipped' });
          continue;
        }
        if (action === 'preload') {
          const pre = options.loader.preload(id, { origin: 'likely' });
          results.push({ id, outcome: pre.ok ? 'loaded' : pre.error.kind === 'forbidden' || pre.error.kind === 'unavailable' ? 'denied' : 'failed' });
          continue;
        }
        const loaded = await options.loader.load(id, { signal, origin: 'likely', parent: span });
        results.push({
          id,
          outcome: loaded.ok
            ? 'loaded'
            : loaded.error.kind === 'aborted'
              ? 'aborted'
              : loaded.error.kind === 'forbidden' || loaded.error.code === ProfileExcludedError.code
                ? 'denied'
                : 'failed',
        });
      }
      span.set('advice', ranked.source);
      span.end(signal.aborted ? 'cancelled' : 'ok');
      if (machine.can('finish')) machine.send('finish');
      return { results, advice: ranked.source, skippedReason: undefined };
    },
    dispose() {
      lifetime.abort();
      if (machine.can('dispose')) machine.send('dispose');
    },
  };
}
