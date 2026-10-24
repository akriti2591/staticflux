/**
 * The browser surface of @staticflux/surface, injectable so every behaviour
 * runs under happy-dom with fakes: clock, cross-thread time origin, device
 * pixel ratio, frame scheduler (rAF where available — also in workers —
 * otherwise a timer), document, ResizeObserver.
 */

export interface FrameScheduler {
  readonly kind: 'raf' | 'timer';
  /** Schedule `callback(now)` for the next frame. */
  request(callback: (now: number) => void): unknown;
  cancel(handle: unknown): void;
}

export interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

export type ResizeObserverFactory = (callback: (entries: readonly { readonly contentRect: { width: number; height: number } }[]) => void) => ResizeObserverLike;

export interface SurfaceEnvironment {
  /** High-resolution clock (ms, relative to `timeOrigin`). */
  now(): number;
  /** `performance.timeOrigin`: input timestamps are `timeOrigin + timeStamp` so they compare across threads. */
  readonly timeOrigin: number;
  devicePixelRatio(): number;
  readonly scheduler: FrameScheduler;
  /** Absent in workers. */
  readonly document: Document | undefined;
  readonly resizeObserver: ResizeObserverFactory | undefined;
}

interface SchedulerGlobals {
  readonly requestAnimationFrame?: (callback: (now: number) => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** `requestAnimationFrame` scheduler (main thread, and dedicated workers that have it). */
export function rafScheduler(globals: SchedulerGlobals = globalThis as SchedulerGlobals): FrameScheduler | undefined {
  const raf = globals.requestAnimationFrame;
  const caf = globals.cancelAnimationFrame;
  if (typeof raf !== 'function') return undefined;
  return {
    kind: 'raf',
    request: (callback) => raf.call(globalThis, callback),
    cancel: (handle) => {
      if (typeof caf === 'function') caf.call(globalThis, handle as number);
    },
  };
}

/** Timer scheduler (fallback where rAF is missing — e.g. some worker scopes). */
export function timerScheduler(
  frameMs = 1000 / 60,
  now: () => number = defaultNow,
  globals: SchedulerGlobals = globalThis as SchedulerGlobals,
): FrameScheduler {
  const setTimer = globals.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = globals.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  return {
    kind: 'timer',
    request: (callback) => setTimer.call(globalThis, () => callback(now()), frameMs),
    cancel: (handle) => clearTimer.call(globalThis, handle),
  };
}

function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

export interface SurfaceGlobals extends SchedulerGlobals {
  readonly document?: Document;
  readonly devicePixelRatio?: number;
  readonly ResizeObserver?: new (callback: (entries: readonly ResizeObserverEntry[]) => void) => ResizeObserverLike;
  readonly performance?: { now(): number; readonly timeOrigin?: number };
}

export function defaultSurfaceEnvironment(
  overrides: Partial<SurfaceEnvironment> = {},
  globals: SurfaceGlobals = globalThis as SurfaceGlobals,
): SurfaceEnvironment {
  const perf = globals.performance;
  const now = overrides.now ?? (perf === undefined ? () => Date.now() : () => perf.now());
  const RO = globals.ResizeObserver;
  return {
    now,
    timeOrigin: overrides.timeOrigin ?? perf?.timeOrigin ?? 0,
    devicePixelRatio: overrides.devicePixelRatio ?? (() => globals.devicePixelRatio ?? 1),
    scheduler: overrides.scheduler ?? rafScheduler(globals) ?? timerScheduler(1000 / 60, now, globals),
    document: 'document' in overrides ? overrides.document : globals.document,
    resizeObserver:
      'resizeObserver' in overrides
        ? overrides.resizeObserver
        : typeof RO === 'function'
          ? (callback) => new RO((entries) => callback(entries))
          : undefined,
  };
}

/** Absolute (cross-thread comparable) time: `timeOrigin + now()`. */
export function absoluteNow(env: Pick<SurfaceEnvironment, 'now' | 'timeOrigin'>): number {
  return env.timeOrigin + env.now();
}
