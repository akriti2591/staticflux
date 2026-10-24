/**
 * Feature-detected environment defaults (timer, idle scheduler, IntersectionObserver, nominal
 * warmup facts). Kept apart from warmup/speculation so a boot-time loader env does not bundle
 * those engines (they load with the post-boot units). Re-exported from their original modules.
 */
import type { TimerFn } from './advisor.js';
import type { IntersectionObserverFactory } from './speculation.js';
import type { IdleScheduler, WarmupFacts } from './warmup.js';

export const defaultTimer: TimerFn = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

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

export const NOMINAL_WARMUP_FACTS: WarmupFacts = Object.freeze({
  online: true,
  saveData: false,
  effectiveType: 'unknown',
  deviceTier: 'mid',
});

export function defaultIntersectionObserver(): IntersectionObserverFactory | undefined {
  const ctor = (globalThis as { IntersectionObserver?: new (cb: (e: readonly { isIntersecting: boolean }[]) => void) => { observe(t: unknown): void; disconnect(): void } }).IntersectionObserver;
  if (typeof ctor !== 'function') return undefined;
  return (callback) => new ctor(callback);
}
