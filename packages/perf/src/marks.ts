/**
 * Feature marks (R17.7, R17.10, R17.11, R17.20). Framework-measured, each labelled
 * with its method, never conflated with browser LCP:
 *
 * | mark              | default (framework) measurement                                  | method              |
 * |-------------------|------------------------------------------------------------------|---------------------|
 * | placeholder-shown | skeleton commit + next frame                                     | `commit+frame`      |
 * | first-render      | first content commit + next frame                                | `commit+frame`      |
 * | largest-render    | Element Timing `renderTime` where supported, else largest committed element area + frame | `element-timing` / `largest-heuristic` |
 * | interactive       | first-render done ∧ render deps resolved                         | `framework-default` |
 * | complete          | render deps ∧ initial resources settled ∧ no layout shift for `layoutStableMs` | `framework-default` |
 *
 * Features may declare their own readiness (`readiness: { interactive: 'feature' }`); the
 * framework then ignores its default for that mark and waits for `signal()` (method
 * `readiness-signal`). Marks are recorded once per mount (`start()` resets).
 */
import { createNoopTelemetry, type Telemetry } from '@staticflux/core';
import { type PerfEnv, type PerfEntryLike, supports } from './env.js';
import { type FeatureMark, featureMarkMetrics, PERF_SUBSYSTEMS } from './telemetry.js';

export type MarkMethod = 'commit+frame' | 'element-timing' | 'largest-heuristic' | 'framework-default' | 'readiness-signal';

export type ReadinessOwner = 'framework' | 'feature';

/** Readiness declaration of a feature (matches the runtime `FeatureManifest.readiness`). */
export interface ReadinessDeclaration {
  readonly firstRender?: ReadinessOwner;
  readonly interactive?: ReadinessOwner;
  readonly complete?: ReadinessOwner;
}

/** Element measurable by the largest-element heuristic. */
export interface MeasurableElement {
  getBoundingClientRect(): { readonly width: number; readonly height: number };
  setAttribute?(name: string, value: string): void;
}

/** Element Timing entry (`PerformanceElementTiming`). */
export interface ElementTimingEntry extends PerfEntryLike {
  readonly identifier: string;
  readonly renderTime: number;
  readonly loadTime: number;
  readonly intersectionRect?: { readonly width: number; readonly height: number };
}

export interface FeatureMarks {
  /** Readiness ownership per feature (R17.20). */
  declare(feature: string, readiness: ReadinessDeclaration): void;
  /** New mount session: clears marks and pending state for `feature`. */
  start(feature: string): void;
  /** Skeleton committed (feature loading layer, distinct from the app shell — R17.11). */
  placeholderCommitted(feature: string): void;
  /** A content render committed. `element` feeds the largest-element heuristic / Element Timing. */
  renderCommitted(feature: string, element?: MeasurableElement): void;
  /** All `render` deps are ready (UI layer). */
  renderDepsResolved(feature: string): void;
  /** Track an initial resource; `complete` waits for it to settle. */
  track(feature: string, pending: Promise<unknown>): void;
  /** A layout shift in the feature subtree (restarts the layout-stable window). */
  layoutShift(feature: string): void;
  /** Feature-declared readiness signal. */
  signal(feature: string, mark: 'first-render' | 'interactive' | 'complete'): void;
  /** Recorded marks of the current mount session (absolute times). */
  marks(feature: string): Readonly<Partial<Record<FeatureMark, { readonly at: number; readonly method: MarkMethod }>>>;
  dispose(): void;
}

export interface FeatureMarksOptions {
  readonly env: PerfEnv;
  readonly telemetry?: Telemetry;
  /** Origin for mark values (default 0 → absolute `env.now()` timestamps). */
  readonly origin?: () => number;
  /** Quiet window without layout shifts before `complete` (default 500 ms). */
  readonly layoutStableMs?: number;
}

interface Session {
  readonly marks: Partial<Record<FeatureMark, { at: number; method: MarkMethod }>>;
  renderDeps: boolean;
  pending: number;
  firstRenderDone: boolean;
  largest: { area: number; at: number; method: MarkMethod } | undefined;
  cancelStable: (() => void) | undefined;
  readonly cancels: Set<() => void>;
  generation: number;
}

const ownerKey = { 'first-render': 'firstRender', interactive: 'interactive', complete: 'complete' } as const;

export function createFeatureMarks(options: FeatureMarksOptions): FeatureMarks {
  const { env } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const origin = options.origin ?? (() => 0);
  const layoutStableMs = options.layoutStableMs ?? 500;
  const declarations = new Map<string, ReadinessDeclaration>();
  const sessions = new Map<string, Session>();
  const elementIds = new Map<string, string>();
  let disposed = false;

  const sessionOf = (feature: string): Session => {
    let session = sessions.get(feature);
    if (session === undefined) {
      session = { marks: {}, renderDeps: false, pending: 0, firstRenderDone: false, largest: undefined, cancelStable: undefined, cancels: new Set(), generation: 0 };
      sessions.set(feature, session);
    }
    return session;
  };

  const owner = (feature: string, mark: keyof typeof ownerKey): ReadinessOwner => declarations.get(feature)?.[ownerKey[mark]] ?? 'framework';

  const record = (feature: string, mark: FeatureMark, at: number, method: MarkMethod): void => {
    if (disposed) return;
    const session = sessionOf(feature);
    if (session.marks[mark] !== undefined) return;
    session.marks[mark] = { at, method };
    telemetry.record(featureMarkMetrics[mark], at - origin(), { feature, method, at });
    telemetry.event(`feature.${mark}`, { subsystem: PERF_SUBSYSTEMS.marks, level: 'standard', attrs: { feature, method, at } });
    if (mark === 'first-render') {
      session.firstRenderDone = true;
      maybeInteractive(feature);
    }
    if (mark === 'complete') finalizeLargest(feature);
  };

  const afterFrame = (feature: string, fn: (time: number) => void): void => {
    const session = sessionOf(feature);
    const generation = session.generation;
    const cancel = env.raf((time) => {
      session.cancels.delete(cancel);
      if (session.generation === generation && !disposed) fn(time);
    });
    session.cancels.add(cancel);
  };

  const finalizeLargest = (feature: string): void => {
    const session = sessionOf(feature);
    if (session.largest === undefined || session.marks['largest-render'] !== undefined) return;
    record(feature, 'largest-render', session.largest.at, session.largest.method);
  };

  const maybeInteractive = (feature: string): void => {
    const session = sessionOf(feature);
    if (owner(feature, 'interactive') === 'framework' && session.firstRenderDone && session.renderDeps) {
      record(feature, 'interactive', env.now(), 'framework-default');
    }
    maybeComplete(feature);
  };

  const maybeComplete = (feature: string): void => {
    const session = sessionOf(feature);
    if (owner(feature, 'complete') !== 'framework' || session.marks.complete !== undefined) return;
    if (!session.renderDeps || session.pending > 0 || !session.firstRenderDone) return;
    session.cancelStable?.();
    const generation = session.generation;
    session.cancelStable = env.timer(() => {
      session.cancelStable = undefined;
      if (session.generation === generation) record(feature, 'complete', env.now(), 'framework-default');
    }, layoutStableMs);
  };

  // Element Timing (Chromium): elements carry `elementtiming="sf:<feature>"`.
  let elementObserver: { disconnect(): void } | undefined;
  if (supports(env, 'element') && env.observer !== undefined) {
    const observer = env.observer((entries) => {
      for (const entry of entries as readonly ElementTimingEntry[]) {
        const feature = elementIds.get(entry.identifier);
        if (feature === undefined) continue;
        const session = sessionOf(feature);
        const rect = entry.intersectionRect;
        const area = rect === undefined ? 0 : rect.width * rect.height;
        const at = entry.renderTime > 0 ? entry.renderTime : entry.loadTime;
        if (session.largest === undefined || session.largest.method !== 'element-timing' || area >= session.largest.area) {
          session.largest = { area, at, method: 'element-timing' };
        }
      }
    });
    observer.observe({ type: 'element', buffered: true });
    elementObserver = observer;
  }

  return {
    declare(feature, readiness) {
      declarations.set(feature, readiness);
    },
    start(feature) {
      const session = sessionOf(feature);
      session.generation += 1;
      for (const cancel of session.cancels) cancel();
      session.cancels.clear();
      session.cancelStable?.();
      sessions.set(feature, {
        marks: {},
        renderDeps: false,
        pending: 0,
        firstRenderDone: false,
        largest: undefined,
        cancelStable: undefined,
        cancels: new Set(),
        generation: session.generation,
      });
    },
    placeholderCommitted(feature) {
      afterFrame(feature, (time) => record(feature, 'placeholder-shown', time, 'commit+frame'));
    },
    renderCommitted(feature, element) {
      const session = sessionOf(feature);
      if (element !== undefined) {
        if (elementObserver !== undefined && element.setAttribute !== undefined) {
          const id = `sf:${feature}`;
          elementIds.set(id, feature);
          element.setAttribute('elementtiming', id);
        }
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        afterFrame(feature, (time) => {
          const current = session.largest;
          if (current === undefined || (current.method !== 'element-timing' && area > current.area)) {
            session.largest = { area, at: time, method: 'largest-heuristic' };
          }
        });
      }
      if (owner(feature, 'first-render') === 'framework') {
        afterFrame(feature, (time) => record(feature, 'first-render', time, 'commit+frame'));
      }
    },
    renderDepsResolved(feature) {
      sessionOf(feature).renderDeps = true;
      maybeInteractive(feature);
    },
    track(feature, pending) {
      const session = sessionOf(feature);
      const generation = session.generation;
      session.pending += 1;
      session.cancelStable?.();
      session.cancelStable = undefined;
      const settle = (): void => {
        const current = sessions.get(feature);
        if (current === undefined || current.generation !== generation) return;
        current.pending -= 1;
        maybeComplete(feature);
      };
      pending.then(settle, settle);
    },
    layoutShift(feature) {
      const session = sessionOf(feature);
      if (session.cancelStable !== undefined) maybeComplete(feature);
    },
    signal(feature, mark) {
      // First record wins: a feature signal for a framework-owned mark only counts if it comes first.
      record(feature, mark, env.now(), 'readiness-signal');
      if (mark === 'interactive') maybeComplete(feature);
    },
    marks(feature) {
      return sessions.get(feature)?.marks ?? {};
    },
    dispose() {
      disposed = true;
      elementObserver?.disconnect();
      for (const session of sessions.values()) {
        for (const cancel of session.cancels) cancel();
        session.cancelStable?.();
      }
    },
  };
}
