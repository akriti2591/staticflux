/**
 * Ports the UI layer consumes. Each is a small interface with a default
 * implementation and a DI token, so apps (and tests) bind their own:
 *
 * - `RenderScheduler`    — one render pass per frame + measure/mutate phases (R12.13, R12.15).
 *                          Adapter for the runtime frame scheduler: `frameRenderScheduler`.
 * - `VisibilityObserver` — `on-visible` init timing (IntersectionObserver; degrades to "visible").
 * - `IsolationPolicy`    — `crossorigin` for cross-origin media/scripts (R11.16b, ui part).
 * - `RenderObserver`     — render counts / render commits (consumed by @staticflux/perf, R12.20).
 * - `DecidePort`         — gating decisions for surfaces, workspaces, slots (bound to @staticflux/gate by the app).
 */
import { ok, type Result, token } from '@staticflux/core';
import type { FrameScheduler } from '@staticflux/runtime';

// ---------------------------------------------------------------- render scheduler

export interface RenderScheduler {
  /** True while a frame flush runs (updates requested now render in the same frame, via microtask). */
  readonly flushing: boolean;
  /** Coalesced job for the next frame (same function scheduled twice runs once). */
  schedule(job: () => void, signal?: AbortSignal): void;
  /** DOM read in the measure phase. */
  measure<T>(read: () => T, signal?: AbortSignal): Promise<Result<T>>;
  /** DOM write in the mutate phase (after all reads of the frame). */
  mutate<T>(write: () => T, signal?: AbortSignal): Promise<Result<T>>;
}

/** Adapt the runtime frame scheduler (one coalesced flush per frame). */
export function frameRenderScheduler(scheduler: FrameScheduler): RenderScheduler {
  return {
    get flushing() {
      return scheduler.phase !== 'idle';
    },
    schedule: (job, signal) => scheduler.schedule(job, signal),
    measure: (read, signal) => scheduler.measure(read, signal),
    mutate: (write, signal) => scheduler.mutate(write, signal),
  };
}

/**
 * Microtask scheduler: no frame coalescing beyond Lit's own microtask batching.
 * For tests and non-browser hosts; apps bind `frameRenderScheduler`.
 */
export function microtaskRenderScheduler(): RenderScheduler {
  const jobs = new Set<() => void>();
  // Detaches the abort listeners of the jobs currently queued; replaced whenever the queue is drained.
  let jobsDetach = new AbortController();
  let queued = false;
  let flushing = false;
  const flush = (): void => {
    queued = false;
    flushing = true;
    try {
      const batch = [...jobs];
      jobs.clear();
      jobsDetach.abort();
      jobsDetach = new AbortController();
      for (const job of batch) job();
    } finally {
      flushing = false;
    }
  };
  return {
    get flushing() {
      return flushing;
    },
    schedule(job, signal) {
      if (signal?.aborted === true) return;
      jobs.add(job);
      signal?.addEventListener('abort', () => jobs.delete(job), { once: true, signal: jobsDetach.signal });
      if (!queued) {
        queued = true;
        queueMicrotask(flush);
      }
    },
    measure: (read) => Promise.resolve().then(() => ok(read())),
    mutate: (write) => Promise.resolve().then(() => ok(write())),
  };
}

// ---------------------------------------------------------------- visibility

export interface VisibilityObserver {
  /** Observe `element`; `callback(true)` when it intersects the viewport. Returns stop. */
  observe(element: Element, callback: (visible: boolean) => void): () => void;
}

/** IntersectionObserver-based visibility; without IO support every element counts as visible (degrade, never block). */
export function intersectionVisibility(options: { readonly rootMargin?: string } = {}): VisibilityObserver {
  const IO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  if (typeof IO !== 'function') return alwaysVisible();
  const callbacks = new Map<Element, Set<(visible: boolean) => void>>();
  let observer: IntersectionObserver | undefined;
  const ensure = (): IntersectionObserver => {
    observer ??= new IO(
      (entries) => {
        for (const entry of entries) {
          for (const cb of [...(callbacks.get(entry.target) ?? [])]) cb(entry.isIntersecting);
        }
      },
      { rootMargin: options.rootMargin ?? '200px' },
    );
    return observer;
  };
  return {
    observe(element, callback) {
      let set = callbacks.get(element);
      if (set === undefined) {
        set = new Set();
        callbacks.set(element, set);
        ensure().observe(element);
      }
      set.add(callback);
      return () => {
        const current = callbacks.get(element);
        current?.delete(callback);
        if (current !== undefined && current.size === 0) {
          callbacks.delete(element);
          observer?.unobserve(element);
        }
      };
    },
  };
}

/** Every observed element is reported visible on the next microtask. */
export function alwaysVisible(): VisibilityObserver {
  return {
    observe(_element, callback) {
      let active = true;
      queueMicrotask(() => {
        if (active) callback(true);
      });
      return () => {
        active = false;
      };
    },
  };
}

// ---------------------------------------------------------------- isolation policy (R11.16b, ui part)

export type CrossOriginValue = 'anonymous' | 'use-credentials';
export type CrossOriginElementKind = 'img' | 'video' | 'audio' | 'script' | 'link';

export interface IsolationPolicy {
  /** `crossorigin` value for a resource URL, or undefined when none is needed (same-origin, isolation off). */
  crossOriginFor(url: string, kind: CrossOriginElementKind): CrossOriginValue | undefined;
}

export type IsolationMode = 'required' | 'preferred' | 'off';
export type CoepFlavour = 'require-corp' | 'credentialless';

export interface IsolationPolicyOptions {
  readonly mode: IsolationMode;
  /** Platform fact: `globalThis.crossOriginIsolated`. */
  readonly isolated: boolean;
  readonly coep?: CoepFlavour;
  /** The page origin (default `location.origin`). */
  readonly origin?: string;
  /** Origins whose resources are fetched with credentials (`use-credentials`). */
  readonly credentialedOrigins?: readonly string[];
}

/** No-op policy (isolation off): never adds `crossorigin`. */
export const noIsolationPolicy: IsolationPolicy = Object.freeze({ crossOriginFor: () => undefined });

/**
 * Policy derived from the app's isolation mode and platform facts. Under COEP
 * `require-corp`, cross-origin subresources need CORS (`crossorigin`) or CORP;
 * we add `crossorigin` so they load CORS-clean (also: no tainted canvas).
 */
export function createIsolationPolicy(options: IsolationPolicyOptions): IsolationPolicy {
  if (options.mode === 'off' || !options.isolated) return noIsolationPolicy;
  const origin = options.origin ?? (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
  const credentialed = new Set(options.credentialedOrigins ?? []);
  return {
    crossOriginFor(url) {
      let target: URL;
      try {
        target = new URL(url, origin === '' ? undefined : origin);
      } catch {
        return undefined;
      }
      if (target.origin === origin || target.protocol === 'data:' || target.protocol === 'blob:') return undefined;
      return credentialed.has(target.origin) ? 'use-credentials' : 'anonymous';
    },
  };
}

// ---------------------------------------------------------------- render observers (perf port)

export type RenderOutcome = 'content' | 'placeholder' | 'failed';

export interface RenderRecord {
  /** Custom element tag. */
  readonly tag: string;
  readonly element: Element;
  readonly outcome: RenderOutcome;
  /** Render count of this element instance (1 = first render). */
  readonly count: number;
  /** Synchronous update duration (ms). */
  readonly duration: number;
  /** Why the update ran: first render, property change, or reactive (MobX) invalidation. */
  readonly reason: 'initial' | 'property' | 'reactive';
  readonly time: number;
}

export interface RenderObserver {
  /** After each update pass (render + commit to DOM). */
  rendered?(record: RenderRecord): void;
  /** First time an element commits its real content (not the placeholder). */
  firstContent?(record: RenderRecord): void;
}

export interface RenderCounter extends RenderObserver {
  /** Renders per tag. */
  counts(): ReadonlyMap<string, number>;
  countOf(tag: string): number;
  reset(): void;
}

/** In-memory render counter (devtools, tests, perf package). */
export function createRenderCounter(): RenderCounter {
  const counts = new Map<string, number>();
  return {
    rendered(record) {
      counts.set(record.tag, (counts.get(record.tag) ?? 0) + 1);
    },
    counts: () => counts,
    countOf: (tag) => counts.get(tag) ?? 0,
    reset: () => counts.clear(),
  };
}

// ---------------------------------------------------------------- gating port

/** Something a gate decides on (a surface, workspace, slot, command). Typed value, not a string. */
export interface GateResource<Kind extends string = string> {
  readonly kind: 'gate-resource';
  readonly level: Kind;
  readonly id: `${string}/${string}` | `${string}:${string}`;
}

export function gateResource<const Kind extends string, const Id extends `${string}/${string}` | `${string}:${string}`>(
  level: Kind,
  id: Id,
): GateResource<Kind> & { readonly id: Id } {
  return Object.freeze({ kind: 'gate-resource', level, id });
}

export type GateVerdict =
  | { readonly effect: 'allow' }
  | { readonly effect: 'deny'; readonly reason: string; readonly code?: string };

export interface DecidePort {
  decide(resource: GateResource, signal?: AbortSignal): GateVerdict | Promise<GateVerdict>;
}

/** Default: everything allowed (client gating is UX, never security). */
export const allowAllDecide: DecidePort = Object.freeze({ decide: () => ({ effect: 'allow' }) as const });

// ---------------------------------------------------------------- environment

/** Everything a component needs from its surroundings besides DI units. Carried by `<sf-scope>`. */
export interface UiEnvironment {
  readonly scheduler: RenderScheduler;
  readonly visibility: VisibilityObserver;
  readonly isolation: IsolationPolicy;
  readonly renderObservers: readonly RenderObserver[];
  readonly now: () => number;
}

export interface UiEnvironmentOptions {
  readonly scheduler?: RenderScheduler;
  readonly visibility?: VisibilityObserver;
  readonly isolation?: IsolationPolicy;
  readonly renderObservers?: readonly RenderObserver[];
  readonly now?: () => number;
}

const defaultNow = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

export function createUiEnvironment(options: UiEnvironmentOptions = {}): UiEnvironment {
  return {
    scheduler: options.scheduler ?? microtaskRenderScheduler(),
    visibility: options.visibility ?? intersectionVisibility(),
    isolation: options.isolation ?? noIsolationPolicy,
    renderObservers: options.renderObservers ?? [],
    now: options.now ?? defaultNow,
  };
}

// ---------------------------------------------------------------- tokens

export const UiEnvironmentToken = /* @__PURE__ */ token('ui/environment').type<UiEnvironment>();
export const RenderSchedulerToken = /* @__PURE__ */ token('ui/render-scheduler').type<RenderScheduler>();
export const VisibilityObserverToken = /* @__PURE__ */ token('ui/visibility-observer').type<VisibilityObserver>();
export const IsolationPolicyToken = /* @__PURE__ */ token('ui/isolation-policy').type<IsolationPolicy>();
/** Multi: render observers (perf, devtools). */
export const RenderObserversToken = /* @__PURE__ */ token('ui/render-observers').multi<RenderObserver>();
export const DecideToken = /* @__PURE__ */ token('ui/decide').type<DecidePort>();
