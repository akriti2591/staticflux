/**
 * Per-surface frame metrics (R11.24) as declared metrics with budgets:
 * frame time (engine work per frame), dropped frames (from frame intervals vs
 * the target frame time), input-to-frame latency (input timestamp → frame that
 * consumed it). Samples aggregate in a window and are reported once per window
 * (not per frame), so a 120 Hz surface does not flood telemetry.
 */
import { createNoopTelemetry, metric, type Telemetry } from '@staticflux/core';
import { FrameBudgetExceededError } from './errors.js';

export const SurfaceMetrics = {
  frameTime: metric.histogram('surface/frame-time', { unit: 'ms', description: 'Engine work per frame (window average)' }),
  frameTimeMax: metric.gauge('surface/frame-time-max', { unit: 'ms', description: 'Worst frame in the window' }),
  droppedFrames: metric.counter('surface/dropped-frames', { description: 'Frames missed against the target frame time' }),
  inputLatency: metric.histogram('surface/input-latency', { unit: 'ms', description: 'Input timestamp → frame that consumed it' }),
} as const;

export interface SurfaceBudget {
  /** Max average engine work per frame. Default: the target frame time. */
  readonly frameMs?: number;
  /** Max average input-to-frame latency. Default 100 ms. */
  readonly inputLatencyMs?: number;
}

export interface SurfaceMetricsSnapshot {
  readonly frames: number;
  readonly droppedFrames: number;
  readonly lastFrameMs: number;
  readonly avgFrameMs: number;
  readonly maxFrameMs: number;
  readonly lastInputLatencyMs: number | undefined;
  readonly avgInputLatencyMs: number | undefined;
  readonly maxInputLatencyMs: number | undefined;
  readonly budgetExceeded: number;
}

export interface SurfaceMetricsRecorder {
  /** One frame: interval since the previous frame and engine work time. */
  frame(intervalMs: number, workMs: number): void;
  input(latencyMs: number): void;
  snapshot(): SurfaceMetricsSnapshot;
  /** Report the current window now (e.g. before detach). */
  flush(): void;
}

export interface SurfaceMetricsOptions {
  readonly surfaceId: string;
  readonly kind: string;
  readonly telemetry?: Telemetry;
  readonly budget?: SurfaceBudget;
  /** Target frame time. Default 1000/60. */
  readonly targetFrameMs?: number;
  /** Frames per reporting window. Default 120. */
  readonly window?: number;
}

const SUBSYSTEM = 'surface/metrics';

export const EMPTY_SURFACE_METRICS: SurfaceMetricsSnapshot = Object.freeze({
  frames: 0,
  droppedFrames: 0,
  lastFrameMs: 0,
  avgFrameMs: 0,
  maxFrameMs: 0,
  lastInputLatencyMs: undefined,
  avgInputLatencyMs: undefined,
  maxInputLatencyMs: undefined,
  budgetExceeded: 0,
});

export function createSurfaceMetrics(options: SurfaceMetricsOptions): SurfaceMetricsRecorder {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const target = options.targetFrameMs ?? 1000 / 60;
  const frameBudget = options.budget?.frameMs ?? target;
  const latencyBudget = options.budget?.inputLatencyMs ?? 100;
  const windowSize = options.window ?? 120;
  const attrs = { surface: options.surfaceId, kind: options.kind };
  const total = { frames: 0, dropped: 0, last: 0, sum: 0, max: 0, inputs: 0, inputSum: 0, inputMax: 0, inputLast: undefined as number | undefined, exceeded: 0 };
  let win = { frames: 0, sum: 0, max: 0, dropped: 0, inputs: 0, inputSum: 0 };

  const report = (): void => {
    if (win.frames === 0 && win.inputs === 0) return;
    if (win.frames > 0) {
      const avg = win.sum / win.frames;
      telemetry.record(SurfaceMetrics.frameTime, avg, attrs);
      telemetry.record(SurfaceMetrics.frameTimeMax, win.max, attrs);
      if (win.dropped > 0) telemetry.record(SurfaceMetrics.droppedFrames, win.dropped, attrs);
      if (avg > frameBudget) exceeded('frame', avg, frameBudget);
    }
    if (win.inputs > 0) {
      const avg = win.inputSum / win.inputs;
      telemetry.record(SurfaceMetrics.inputLatency, avg, attrs);
      if (avg > latencyBudget) exceeded('input-latency', avg, latencyBudget);
    }
    win = { frames: 0, sum: 0, max: 0, dropped: 0, inputs: 0, inputSum: 0 };
  };

  const exceeded = (budget: string, value: number, limit: number): void => {
    total.exceeded += 1;
    telemetry.event('surface.budget-exceeded', {
      subsystem: SUBSYSTEM,
      level: 'critical',
      attrs: { ...attrs, budget, value, limit, code: FrameBudgetExceededError.code },
    });
  };

  return {
    frame(intervalMs, workMs) {
      const dropped = total.frames === 0 ? 0 : Math.max(0, Math.round(intervalMs / target) - 1);
      total.frames += 1;
      total.dropped += dropped;
      total.last = workMs;
      total.sum += workMs;
      total.max = Math.max(total.max, workMs);
      win.frames += 1;
      win.sum += workMs;
      win.max = Math.max(win.max, workMs);
      win.dropped += dropped;
      if (win.frames >= windowSize) report();
    },
    input(latencyMs) {
      const value = Math.max(0, latencyMs);
      total.inputs += 1;
      total.inputSum += value;
      total.inputMax = Math.max(total.inputMax, value);
      total.inputLast = value;
      win.inputs += 1;
      win.inputSum += value;
    },
    snapshot: () => ({
      frames: total.frames,
      droppedFrames: total.dropped,
      lastFrameMs: total.last,
      avgFrameMs: total.frames === 0 ? 0 : total.sum / total.frames,
      maxFrameMs: total.max,
      lastInputLatencyMs: total.inputLast,
      avgInputLatencyMs: total.inputs === 0 ? undefined : total.inputSum / total.inputs,
      maxInputLatencyMs: total.inputs === 0 ? undefined : total.inputMax,
      budgetExceeded: total.exceeded,
    }),
    flush: report,
  };
}
