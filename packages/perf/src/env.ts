/**
 * Browser seams of @staticflux/perf. Everything time- or observer-related is
 * injected so tests are deterministic (fake clock, fake raf, fake observers).
 * PerformanceObserver entry types are feature-detected via `supportedEntryTypes`
 * (LoAF/layout-shift/element/event are Chromium-only; Safari degrades).
 */

/** Minimal shape of a performance entry (subclasses add fields). */
export interface PerfEntryLike {
  readonly entryType: string;
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
}

export interface PerfObserverLike {
  observe(options: { readonly type: string; readonly buffered?: boolean; readonly durationThreshold?: number }): void;
  disconnect(): void;
}

export type PerfObserverFactory = (callback: (entries: readonly PerfEntryLike[]) => void) => PerfObserverLike;

export interface PerfEnv {
  now(): number;
  /** requestAnimationFrame; returns a cancel function. */
  raf(callback: (time: number) => void): () => void;
  /** setTimeout; returns a cancel function. */
  timer(callback: () => void, ms: number): () => void;
  readonly observer: PerfObserverFactory | undefined;
  readonly supportedEntryTypes: readonly string[];
}

export function supports(env: PerfEnv, entryType: string): boolean {
  return env.observer !== undefined && env.supportedEntryTypes.includes(entryType);
}

export function browserPerfEnv(): PerfEnv {
  const g = globalThis as {
    performance?: { now(): number };
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (h: number) => void;
    PerformanceObserver?: (new (cb: (list: { getEntries(): PerfEntryLike[] }) => void) => PerfObserverLike) & {
      readonly supportedEntryTypes?: readonly string[];
    };
  };
  const now = (): number => (g.performance === undefined ? Date.now() : g.performance.now());
  const PO = g.PerformanceObserver;
  return {
    now,
    raf:
      typeof g.requestAnimationFrame === 'function'
        ? (callback) => {
            const handle = (g.requestAnimationFrame as (cb: (t: number) => void) => number)(callback);
            return () => g.cancelAnimationFrame?.(handle);
          }
        : (callback) => {
            const handle = setTimeout(() => callback(now()), 16);
            return () => clearTimeout(handle);
          },
    timer: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
    observer: typeof PO === 'function' ? (callback) => new PO((list) => callback(list.getEntries())) : undefined,
    supportedEntryTypes: PO?.supportedEntryTypes ?? [],
  };
}
