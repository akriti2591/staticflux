/**
 * Per-surface frame loop: rAF where available (main thread and workers that
 * have it), otherwise a timer. Measures frame interval and engine work and
 * feeds the surface metrics. Lifecycle: `idle → running ⇄ paused → stopped`.
 */
import { createMachine, defineMachine, type Machine, type Result } from '@staticflux/core';
import type { FrameScheduler } from './env.js';
import type { SurfaceMetricsRecorder } from './metrics.js';

export const FrameLoopLifecycle = defineMachine({
  id: 'surface/frame-loop',
  initial: 'idle',
  states: ['idle', 'running', 'paused', 'stopped'],
  transitions: {
    idle: { start: 'running', stop: 'stopped' },
    running: { pause: 'paused', stop: 'stopped' },
    paused: { resume: 'running', stop: 'stopped' },
  },
  terminal: ['stopped'],
});

export type FrameLoopState = (typeof FrameLoopLifecycle.states)[number];
export type FrameLoopEvent = 'start' | 'pause' | 'resume' | 'stop';

export interface FrameInfo {
  /** Frame number since start (0-based). */
  readonly frame: number;
  /** Scheduler time of this frame (ms). */
  readonly now: number;
  /** Interval since the previous frame (0 for the first frame after start/resume). */
  readonly dt: number;
}

export interface FrameLoop {
  readonly state: FrameLoopState;
  readonly machine: Machine<FrameLoopState, FrameLoopEvent>;
  readonly frames: number;
  start(): Result<FrameLoopState>;
  pause(): Result<FrameLoopState>;
  resume(): Result<FrameLoopState>;
  stop(): void;
}

export interface FrameLoopOptions {
  readonly scheduler: FrameScheduler;
  readonly now: () => number;
  readonly onFrame: (info: FrameInfo) => void;
  readonly metrics?: SurfaceMetricsRecorder;
  /** Called when `onFrame` throws (the loop keeps running). */
  readonly onError?: (error: unknown) => void;
}

export function createFrameLoop(options: FrameLoopOptions): FrameLoop {
  const machine = createMachine(FrameLoopLifecycle);
  let handle: unknown;
  let scheduled = false;
  let previous: number | undefined;
  let frame = 0;

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    handle = options.scheduler.request(tick);
  };
  const cancel = (): void => {
    if (!scheduled) return;
    scheduled = false;
    options.scheduler.cancel(handle);
  };
  const tick = (now: number): void => {
    scheduled = false;
    if (machine.state !== 'running') return;
    const dt = previous === undefined ? 0 : now - previous;
    previous = now;
    const started = options.now();
    try {
      options.onFrame({ frame, now, dt });
    } catch (error) {
      options.onError?.(error);
    }
    options.metrics?.frame(dt, options.now() - started);
    frame += 1;
    schedule();
  };

  return {
    machine,
    get state() {
      return machine.state;
    },
    get frames() {
      return frame;
    },
    start() {
      const result = machine.send('start');
      if (result.ok) {
        previous = undefined;
        schedule();
      }
      return result;
    },
    pause() {
      const result = machine.send('pause');
      if (result.ok) cancel();
      return result;
    },
    resume() {
      const result = machine.send('resume');
      if (result.ok) {
        previous = undefined; // a paused gap is not a dropped frame
        schedule();
      }
      return result;
    },
    stop() {
      if (machine.can('stop')) machine.send('stop');
      cancel();
    },
  };
}
