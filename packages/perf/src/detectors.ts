/**
 * Detectors (R12.6, R12.15, R12.19, R12.20). All feature-detected and injectable:
 * - long frames: Long Animation Frames (Chromium) → Long Tasks → none; scripts mapped to chunks/features.
 * - forced synchronous layout (dev): measured-read API + read-after-write heuristic per frame,
 *   optional prototype instrumentation of layout-reading DOM APIs.
 * - layout shift per feature subtree (`layout-shift` entries → nearest `[data-sf-feature]`), plus
 *   a size-stable placeholder check that works in every browser.
 * - per-component render counts (API the ui layer calls) with render-storm detection.
 * - input → next paint latency (Event Timing where supported, raf fallback).
 * - memory sampling (where the browser exposes heap size).
 * Every detector checks `telemetry.enabled(subsystem, level)` and stays dormant when off.
 */
import { createNoopTelemetry, type Scope, type Telemetry } from '@staticflux/core';
import { type Conformance, violationOf } from './conformance.js';
import { type PerfEntryLike, type PerfEnv, supports } from './env.js';
import {
  ForcedLayoutViolation,
  LayoutShiftViolation,
  LongFrameViolation,
  RenderStormViolation,
  SlowInteractionViolation,
} from './errors.js';
import { PERF_SUBSYSTEMS, perfMetrics } from './telemetry.js';

// ---------------------------------------------------------------- long frames

export interface LoafScriptLike {
  readonly sourceURL?: string;
  readonly duration?: number;
  readonly forcedStyleAndLayoutDuration?: number;
  readonly invoker?: string;
}

export interface LongFrameEntryLike extends PerfEntryLike {
  readonly blockingDuration?: number;
  readonly scripts?: readonly LoafScriptLike[];
}

export interface LongFrameReport {
  readonly type: 'long-animation-frame' | 'longtask';
  readonly start: number;
  readonly duration: number;
  readonly blockingMs: number;
  readonly chunk: string | undefined;
  readonly feature: string | undefined;
  readonly forcedLayoutMs: number;
}

export interface LongFrameDetector {
  readonly mode: 'long-animation-frame' | 'longtask' | 'none';
  readonly reports: readonly LongFrameReport[];
  onReport(listener: (report: LongFrameReport) => void): () => void;
  dispose(): void;
}

export interface LongFrameDetectorOptions {
  readonly env: PerfEnv;
  readonly telemetry?: Telemetry;
  /** Script URL → logical chunk id (e.g. loader `chunkAttributor(manifest)`). */
  readonly attribute?: (url: string) => string | undefined;
  /** Chunk id → owning feature (default: `feature:<x>` → `<x>`). */
  readonly featureOf?: (chunk: string) => string | undefined;
  readonly conformance?: Conformance;
  /** Frames longer than this produce a violation (default: none). */
  readonly budgetMs?: number;
  /** Keep at most this many reports (default 100). */
  readonly limit?: number;
}

const defaultFeatureOf = (chunk: string): string | undefined => (chunk.startsWith('feature:') ? chunk.slice('feature:'.length) : undefined);

export function createLongFrameDetector(options: LongFrameDetectorOptions): LongFrameDetector {
  const { env } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const featureOf = options.featureOf ?? defaultFeatureOf;
  const limit = options.limit ?? 100;
  const reports: LongFrameReport[] = [];
  const listeners = new Set<(report: LongFrameReport) => void>();
  const enabled = telemetry.enabled(PERF_SUBSYSTEMS.frames, 'standard') || options.conformance !== undefined;
  const mode: LongFrameDetector['mode'] = !enabled
    ? 'none'
    : supports(env, 'long-animation-frame')
      ? 'long-animation-frame'
      : supports(env, 'longtask')
        ? 'longtask'
        : 'none';
  let observer: { disconnect(): void } | undefined;

  const handle = (entry: LongFrameEntryLike): void => {
    if (mode === 'none') return;
    // Attribute to the script that ran longest.
    const scripts = entry.scripts ?? [];
    const top = scripts.reduce<LoafScriptLike | undefined>((best, s) => (best === undefined || (s.duration ?? 0) > (best.duration ?? 0) ? s : best), undefined);
    const chunk = top?.sourceURL === undefined || top.sourceURL === '' ? undefined : options.attribute?.(top.sourceURL);
    const feature = chunk === undefined ? undefined : featureOf(chunk);
    const report: LongFrameReport = {
      type: mode,
      start: entry.startTime,
      duration: entry.duration,
      blockingMs: entry.blockingDuration ?? Math.max(0, entry.duration - 50),
      chunk,
      feature,
      forcedLayoutMs: scripts.reduce((sum, s) => sum + (s.forcedStyleAndLayoutDuration ?? 0), 0),
    };
    reports.push(report);
    if (reports.length > limit) reports.shift();
    telemetry.record(perfMetrics.longFrame, report.duration, { type: mode, chunk: chunk ?? '', feature: feature ?? '', blockingMs: report.blockingMs });
    if (options.budgetMs !== undefined && report.duration > options.budgetMs) {
      options.conformance?.report(
        violationOf(LongFrameViolation, {
          ...(feature === undefined ? {} : { feature }),
          ...(chunk === undefined ? {} : { unit: chunk }),
          severity: 'warning',
          details: { duration: report.duration, budgetMs: options.budgetMs, script: top?.sourceURL ?? null, invoker: top?.invoker ?? null },
        }),
      );
    }
    for (const listener of [...listeners]) listener(report);
  };

  if (mode !== 'none' && env.observer !== undefined) {
    const o = env.observer((entries) => {
      for (const entry of entries) handle(entry as LongFrameEntryLike);
    });
    o.observe({ type: mode, buffered: true });
    observer = o;
  }

  return {
    mode,
    reports,
    onReport(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      observer?.disconnect();
    },
  };
}

// ---------------------------------------------------------------- forced layout (dev)

export interface ForcedLayoutDetector {
  /** A DOM write by `component` (scheduler mutate phase, ui layer). Marks layout dirty until the next frame. */
  write(component: string): void;
  /** Measured read: reports a forced layout when layout is dirty (read-after-write in one frame). */
  read<T>(component: string, fn: () => T): T;
  /**
   * Dev-only: wrap layout-reading APIs on `proto` (e.g. `HTMLElement.prototype`) so unmeasured
   * reads are detected too. `componentOf(element)` attributes the read. Restored on scope dispose.
   */
  instrument(proto: object, scope: Scope, componentOf?: (element: unknown) => string): void;
  readonly count: number;
}

export interface ForcedLayoutDetectorOptions {
  readonly env: PerfEnv;
  readonly telemetry?: Telemetry;
  readonly conformance?: Conformance;
}

const LAYOUT_METHODS = ['getBoundingClientRect', 'getClientRects'] as const;
const LAYOUT_GETTERS = ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'scrollTop'] as const;

function findDescriptor(proto: object, key: string): { owner: object; descriptor: PropertyDescriptor } | undefined {
  for (let p: object | null = proto; p !== null; p = Object.getPrototypeOf(p) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(p, key);
    if (descriptor !== undefined) return { owner: p, descriptor };
  }
  return undefined;
}

export function createForcedLayoutDetector(options: ForcedLayoutDetectorOptions): ForcedLayoutDetector {
  const { env } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  let dirtyBy: string | undefined;
  let cancelFrame: (() => void) | undefined;
  let count = 0;
  let inRead = false;
  const reported = new Set<string>();

  const onRead = (component: string, api: string): void => {
    if (dirtyBy === undefined) return;
    count += 1;
    telemetry.record(perfMetrics.forcedLayout, 1, { component, writer: dirtyBy, api });
    const key = `${component}|${dirtyBy}`;
    if (reported.has(key)) return;
    reported.add(key);
    options.conformance?.report(
      violationOf(ForcedLayoutViolation, { unit: component, details: { reader: component, writer: dirtyBy, api } }),
    );
  };

  return {
    get count() {
      return count;
    },
    write(component) {
      dirtyBy = component;
      cancelFrame ??= env.raf(() => {
        dirtyBy = undefined;
        cancelFrame = undefined;
      });
    },
    read(component, fn) {
      onRead(component, 'measured-read');
      inRead = true;
      try {
        return fn();
      } finally {
        inRead = false;
      }
    },
    instrument(proto, scope, componentOf = () => 'unknown') {
      for (const method of LAYOUT_METHODS) {
        const found = findDescriptor(proto, method);
        const original = found?.descriptor.value as ((...args: unknown[]) => unknown) | undefined;
        if (typeof original !== 'function') continue;
        Object.defineProperty(proto, method, {
          configurable: true,
          writable: true,
          value: function (this: unknown, ...args: unknown[]) {
            if (!inRead) onRead(componentOf(this), method);
            return original.apply(this, args);
          },
        });
        scope.defer(() => {
          delete (proto as Record<string, unknown>)[method];
          if (found?.owner === proto) Object.defineProperty(proto, method, found.descriptor);
        });
      }
      for (const getter of LAYOUT_GETTERS) {
        const found = findDescriptor(proto, getter);
        const get = found?.descriptor.get;
        if (get === undefined) continue;
        Object.defineProperty(proto, getter, {
          configurable: true,
          get(this: unknown) {
            if (!inRead) onRead(componentOf(this), getter);
            return get.call(this);
          },
          ...(found?.descriptor.set === undefined ? {} : { set: found.descriptor.set }),
        });
        scope.defer(() => {
          delete (proto as Record<string, unknown>)[getter];
          if (found?.owner === proto) Object.defineProperty(proto, getter, found.descriptor);
        });
      }
    },
  };
}

// ---------------------------------------------------------------- layout shift

export interface LayoutShiftEntryLike extends PerfEntryLike {
  readonly value: number;
  readonly hadRecentInput: boolean;
  readonly sources?: readonly { readonly node?: unknown }[];
}

export interface LayoutShiftTracker {
  readonly supported: boolean;
  /** Manual report (fallback browsers, or ResizeObserver-based placeholders). */
  report(feature: string, value: number): void;
  /** Size-stable placeholder check (R12.19): violation when placeholder and content sizes differ. */
  checkPlaceholder(feature: string, placeholder: { readonly width: number; readonly height: number }, content: { readonly width: number; readonly height: number }): boolean;
  scoreOf(feature: string): number;
  reset(feature: string): void;
  onShift(listener: (feature: string, value: number) => void): () => void;
  dispose(): void;
}

export interface LayoutShiftTrackerOptions {
  readonly env: PerfEnv;
  readonly telemetry?: Telemetry;
  readonly conformance?: Conformance;
  /** Node → feature id (default: nearest `[data-sf-feature]`). */
  readonly featureOf?: (node: unknown) => string | undefined;
  /** Per-feature score above which a violation is reported once (default 0.1). */
  readonly threshold?: number;
  /** Placeholder size tolerance in px (default 1). */
  readonly tolerancePx?: number;
}

export const FEATURE_ATTRIBUTE = 'data-sf-feature' as const;

export function featureOfNode(node: unknown): string | undefined {
  const el = node as { closest?: (s: string) => { getAttribute(n: string): string | null } | null; parentElement?: unknown } | null;
  if (el === null || el === undefined) return undefined;
  const target = typeof el.closest === 'function' ? el : (el.parentElement as typeof el | undefined);
  const host = target?.closest?.(`[${FEATURE_ATTRIBUTE}]`);
  return host?.getAttribute(FEATURE_ATTRIBUTE) ?? undefined;
}

export function createLayoutShiftTracker(options: LayoutShiftTrackerOptions): LayoutShiftTracker {
  const { env } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const featureOf = options.featureOf ?? featureOfNode;
  const threshold = options.threshold ?? 0.1;
  const tolerance = options.tolerancePx ?? 1;
  const scores = new Map<string, number>();
  const flagged = new Set<string>();
  const listeners = new Set<(feature: string, value: number) => void>();
  const supported = supports(env, 'layout-shift') && telemetry.enabled(PERF_SUBSYSTEMS.layout, 'standard');

  const add = (feature: string, value: number): void => {
    const score = (scores.get(feature) ?? 0) + value;
    scores.set(feature, score);
    telemetry.record(perfMetrics.layoutShift, value, { feature });
    for (const listener of [...listeners]) listener(feature, value);
    if (score > threshold && !flagged.has(feature)) {
      flagged.add(feature);
      options.conformance?.report(violationOf(LayoutShiftViolation, { feature, details: { score, threshold } }));
    }
  };

  let observer: { disconnect(): void } | undefined;
  if (supported && env.observer !== undefined) {
    const o = env.observer((entries) => {
      for (const entry of entries as readonly LayoutShiftEntryLike[]) {
        if (entry.hadRecentInput) continue;
        const features = new Set<string>();
        for (const source of entry.sources ?? []) {
          const feature = featureOf(source.node);
          if (feature !== undefined) features.add(feature);
        }
        for (const feature of features) add(feature, entry.value);
      }
    });
    o.observe({ type: 'layout-shift', buffered: true });
    observer = o;
  }

  return {
    supported,
    report: add,
    checkPlaceholder(feature, placeholder, content) {
      const stable = Math.abs(placeholder.width - content.width) <= tolerance && Math.abs(placeholder.height - content.height) <= tolerance;
      if (!stable) {
        options.conformance?.report(
          violationOf(LayoutShiftViolation, {
            feature,
            message: 'Placeholder size differs from the rendered content (layout shift on load).',
            details: { placeholder: { ...placeholder }, content: { ...content } },
          }),
        );
        for (const listener of [...listeners]) listener(feature, 0);
      }
      return stable;
    },
    scoreOf: (feature) => scores.get(feature) ?? 0,
    reset(feature) {
      scores.delete(feature);
      flagged.delete(feature);
    },
    onShift(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      observer?.disconnect();
    },
  };
}

// ---------------------------------------------------------------- render counts

export interface RenderCounter {
  /** Called by the ui layer once per component render commit. */
  count(component: string, feature?: string): void;
  counts(): ReadonlyMap<string, number>;
  reset(): void;
}

export interface RenderCounterOptions {
  readonly now: () => number;
  readonly telemetry?: Telemetry;
  readonly conformance?: Conformance;
  /** Renders within `windowMs` that count as a storm (default 30 in 1000 ms). */
  readonly stormThreshold?: number;
  readonly windowMs?: number;
}

export function createRenderCounter(options: RenderCounterOptions): RenderCounter {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const stormThreshold = options.stormThreshold ?? 30;
  const windowMs = options.windowMs ?? 1_000;
  const totals = new Map<string, number>();
  const recent = new Map<string, number[]>();
  const stormed = new Map<string, number>();
  return {
    count(component, feature) {
      totals.set(component, (totals.get(component) ?? 0) + 1);
      if (telemetry.enabled(PERF_SUBSYSTEMS.render, 'verbose')) {
        telemetry.record(perfMetrics.renders, 1, { component, feature: feature ?? '' });
      }
      const now = options.now();
      const times = (recent.get(component) ?? []).filter((t) => now - t < windowMs);
      times.push(now);
      recent.set(component, times);
      const lastStorm = stormed.get(component);
      if (times.length >= stormThreshold && (lastStorm === undefined || now - lastStorm >= windowMs)) {
        stormed.set(component, now);
        options.conformance?.report(
          violationOf(RenderStormViolation, {
            unit: component,
            ...(feature === undefined ? {} : { feature }),
            details: { renders: times.length, windowMs },
          }),
        );
      }
    },
    counts: () => totals,
    reset() {
      totals.clear();
      recent.clear();
      stormed.clear();
    },
  };
}

// ---------------------------------------------------------------- input latency

export interface EventTimingEntryLike extends PerfEntryLike {
  readonly interactionId?: number;
  readonly processingStart?: number;
}

export interface InputLatencyTracker {
  readonly mode: 'event-timing' | 'raf';
  /** Fallback measurement: call from the input handler with `event.timeStamp`. No-op under Event Timing. */
  track(eventName: string, eventTime: number): void;
  stats(): { readonly count: number; readonly max: number; readonly p75: number; readonly p98: number };
  dispose(): void;
}

export interface InputLatencyOptions {
  readonly env: PerfEnv;
  readonly telemetry?: Telemetry;
  readonly conformance?: Conformance;
  /** Latency above this is a violation (default 200 ms, the INP "good" threshold). */
  readonly budgetMs?: number;
  readonly feature?: () => string | undefined;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export function createInputLatencyTracker(options: InputLatencyOptions): InputLatencyTracker {
  const { env } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const budgetMs = options.budgetMs ?? 200;
  const samples: number[] = [];
  const mode: InputLatencyTracker['mode'] = supports(env, 'event') ? 'event-timing' : 'raf';
  const byInteraction = new Map<number, number>();

  const sample = (eventName: string, latency: number, method: InputLatencyTracker['mode']): void => {
    samples.push(latency);
    if (samples.length > 500) samples.shift();
    telemetry.record(perfMetrics.inputLatency, latency, { event: eventName, method });
    if (latency > budgetMs) {
      const feature = options.feature?.();
      options.conformance?.report(
        violationOf(SlowInteractionViolation, {
          severity: 'warning',
          ...(feature === undefined ? {} : { feature }),
          details: { event: eventName, latency, budgetMs, method },
        }),
      );
    }
  };

  let observer: { disconnect(): void } | undefined;
  if (mode === 'event-timing' && env.observer !== undefined) {
    const o = env.observer((entries) => {
      for (const entry of entries as readonly EventTimingEntryLike[]) {
        const id = entry.interactionId ?? 0;
        if (id === 0) continue;
        const previous = byInteraction.get(id);
        if (previous !== undefined && previous >= entry.duration) continue;
        byInteraction.set(id, entry.duration);
        if (byInteraction.size > 200) byInteraction.delete(byInteraction.keys().next().value as number);
        if (previous === undefined) sample(entry.name, entry.duration, 'event-timing');
        else samples[samples.lastIndexOf(previous)] = entry.duration;
      }
    });
    o.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    observer = o;
  }

  return {
    mode,
    track(eventName, eventTime) {
      if (mode === 'event-timing') return;
      // Next paint ≈ the frame after the next rAF callback.
      env.raf(() => {
        env.timer(() => sample(eventName, env.now() - eventTime, 'raf'), 0);
      });
    },
    stats() {
      const sorted = [...samples].sort((a, b) => a - b);
      return { count: sorted.length, max: sorted[sorted.length - 1] ?? 0, p75: percentile(sorted, 0.75), p98: percentile(sorted, 0.98) };
    },
    dispose() {
      observer?.disconnect();
    },
  };
}

// ---------------------------------------------------------------- memory

export interface MemorySampler {
  sample(): number | undefined;
  dispose(): void;
}

export interface MemorySamplerOptions {
  readonly env: PerfEnv;
  readonly telemetry?: Telemetry;
  /** Heap size in bytes, or undefined when unavailable (Safari/Firefox). Default: `performance.memory`. */
  readonly read?: () => number | undefined;
  /** Sample periodically (default 30 s); 0 disables the timer. */
  readonly intervalMs?: number;
}

export function defaultHeapRead(): number | undefined {
  const memory = (globalThis as { performance?: { memory?: { usedJSHeapSize?: number } } }).performance?.memory;
  return memory?.usedJSHeapSize;
}

export function createMemorySampler(options: MemorySamplerOptions): MemorySampler {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const read = options.read ?? defaultHeapRead;
  const intervalMs = options.intervalMs ?? 30_000;
  let cancel: (() => void) | undefined;
  let disposed = false;
  const sample = (): number | undefined => {
    const bytes = read();
    if (bytes === undefined) return undefined;
    const mb = Math.round((bytes / 1_048_576) * 10) / 10;
    telemetry.record(perfMetrics.memory, mb);
    return mb;
  };
  const schedule = (): void => {
    if (disposed || intervalMs <= 0 || !telemetry.enabled(PERF_SUBSYSTEMS.memory, 'standard')) return;
    cancel = options.env.timer(() => {
      sample();
      schedule();
    }, intervalMs);
  };
  schedule();
  return {
    sample,
    dispose() {
      disposed = true;
      cancel?.();
    },
  };
}
