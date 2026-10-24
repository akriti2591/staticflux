/**
 * Injectable clock so heartbeats, timeouts and backoff are deterministic in
 * tests (works with fake timers or a hand-rolled clock).
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Schedules a flush of batched work (patches, telemetry). */
export type FlushScheduler = (flush: () => void) => void;

/** Flush at the end of the current task (default). */
export const microtaskScheduler: FlushScheduler = (flush) => {
  queueMicrotask(flush);
};

/**
 * Flush once per frame: `requestAnimationFrame` when available, raced with a
 * timeout so hidden/throttled tabs (no rAF) still make progress (R11.4).
 */
export function frameScheduler(fallbackMs = 50, clock: Clock = systemClock): FlushScheduler {
  return (flush) => {
    let done = false;
    const run = (): void => {
      if (done) return;
      done = true;
      flush();
    };
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (typeof raf === 'function') raf(run);
    clock.setTimeout(run, fallbackMs);
  };
}
