/**
 * Worker-side scheduler and long-task detector (SF-Δ28).
 *
 * Workers have no frames to coalesce into and no `requestIdleCallback`; what they
 * need is a priority queue that keeps urgent work (input, the next view frame)
 * ahead of bulk work (CRDT merges, index rebuilds, tile prep) and cooperative
 * yielding inside long jobs:
 *
 * - **Priorities** `interaction → critical → visible → idle` (the frame scheduler's),
 *   run in slices of `sliceMs` on the best macrotask primitive:
 *   `scheduler.postTask(priority)` → `MessageChannel` → `setTimeout`.
 * - **`yield()`** inside a long task: `scheduler.yield()` (continuation keeps its
 *   priority) with a `MessageChannel` fallback (Safari, older engines), then waits
 *   while the scheduler is paused (I-1). `shouldYield()` says when: the slice is used
 *   up or interaction work is waiting.
 * - **Long-task detector.** PerformanceObserver `longtask` does not exist in workers:
 *   every scheduled task is timed, `measure()` / `record()` time other work, and an
 *   optional event-loop lag probe catches long work that bypasses the scheduler.
 *   Long tasks (≥ `thresholdMs`, default 50) are a metric, an event and a callback.
 *
 * Every timing source is injectable, so tests are deterministic.
 *
 * @example (inside the editor worker)
 * const scheduler = createWorkerScheduler({ telemetry: runtime.telemetry });
 * scheduler.longTasks.start();
 * void scheduler.postTask(async (signal) => {
 *   for (const chunk of chunks) { merge(chunk); if (scheduler.shouldYield()) await scheduler.yield(signal); }
 * }, { priority: 'idle', name: 'crdt-merge' });
 */
import {
  AbortedError,
  createNoopTelemetry,
  err,
  metric,
  ok,
  type Result,
  type Telemetry,
  token,
  toSfError,
  unit,
  type UnitDefinition,
} from '@staticflux/core';
import { WorkerSchedulerDisposedError } from './errors.js';
import { defaultNow } from './hooks.js';
import { defaultMacrotask, PRIORITIES, type Priority, yieldToMain } from './scheduler.js';
import { RUNTIME_SUBSYSTEMS } from './telemetry.js';

const SUB = RUNTIME_SUBSYSTEMS.scheduler;

export const WorkerSchedulerMetrics = {
  /** Long tasks in workers (attrs: name, source task|lag). */
  longTask: /* @__PURE__ */ metric.histogram('runtime/worker-long-task', { unit: 'ms', description: 'Worker tasks or event-loop stalls ≥ the long-task threshold.' }),
} as const;

// ---------------------------------------------------------------- long-task detector

export interface LongTask {
  readonly name: string;
  readonly start: number;
  readonly duration: number;
  /** `task`: timed work; `lag`: the event-loop probe fired late (work outside the scheduler). */
  readonly source: 'task' | 'lag';
}

export interface LongTaskStats {
  readonly count: number;
  readonly longestMs: number;
  readonly totalMs: number;
}

export interface LongTaskDetectorOptions {
  /** Default 50 ms (the web's long-task definition). */
  readonly thresholdMs?: number;
  readonly now?: () => number;
  readonly telemetry?: Telemetry;
  /** Lag probe interval. Default 100 ms. */
  readonly probeIntervalMs?: number;
  /** Timer for the lag probe; returns a cancel function. Default setTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
  /** Long tasks kept in `recent`. Default 16. */
  readonly keep?: number;
}

export interface LongTaskDetector {
  readonly thresholdMs: number;
  /** Time synchronous work; reports it when long. */
  measure<T>(name: string, fn: () => T): T;
  /** Report work measured elsewhere (e.g. a Wasm call). Returns the long task, if it was one. */
  record(name: string, start: number, end: number): LongTask | undefined;
  /** Start the event-loop lag probe. */
  start(): void;
  stop(): void;
  readonly probing: boolean;
  onLongTask(listener: (task: LongTask) => void): () => void;
  readonly stats: LongTaskStats;
  /** The most recent long tasks, oldest first. */
  readonly recent: readonly LongTask[];
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.(); // never keep a Node process alive for the probe
  return () => clearTimeout(handle);
};

export function createLongTaskDetector(options: LongTaskDetectorOptions = {}): LongTaskDetector {
  const thresholdMs = options.thresholdMs ?? 50;
  const now = options.now ?? defaultNow;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const intervalMs = options.probeIntervalMs ?? 100;
  const setTimer = options.setTimer ?? defaultTimer;
  const keep = options.keep ?? 16;
  const listeners = new Set<(task: LongTask) => void>();
  const recent: LongTask[] = [];
  const stats = { count: 0, longestMs: 0, totalMs: 0 };
  let cancelProbe: (() => void) | undefined;

  const report = (task: LongTask): void => {
    stats.count += 1;
    stats.totalMs += task.duration;
    stats.longestMs = Math.max(stats.longestMs, task.duration);
    recent.push(task);
    if (recent.length > keep) recent.shift();
    telemetry.record(WorkerSchedulerMetrics.longTask, task.duration, { name: task.name, source: task.source });
    telemetry.event('worker.long-task', { subsystem: SUB, level: 'standard', attrs: { name: task.name, source: task.source, duration: task.duration } });
    for (const listener of [...listeners]) listener(task);
  };
  const record = (name: string, start: number, end: number, source: LongTask['source'] = 'task'): LongTask | undefined => {
    const duration = end - start;
    if (duration < thresholdMs) return undefined;
    const task: LongTask = { name, start, duration, source };
    report(task);
    return task;
  };
  const probe = (): void => {
    const expected = now() + intervalMs;
    cancelProbe = setTimer(() => {
      const late = now() - expected;
      // The probe fired `late` ms after it was due: the event loop was blocked that long.
      if (late >= thresholdMs) record('event-loop', expected, expected + late, 'lag');
      if (cancelProbe !== undefined) probe();
    }, intervalMs);
  };

  return {
    thresholdMs,
    measure(name, fn) {
      const start = now();
      try {
        return fn();
      } finally {
        record(name, start, now());
      }
    },
    record: (name, start, end) => record(name, start, end),
    start() {
      if (cancelProbe === undefined) probe();
    },
    stop() {
      const cancel = cancelProbe;
      cancelProbe = undefined;
      cancel?.();
    },
    get probing() {
      return cancelProbe !== undefined;
    },
    onLongTask(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get stats() {
      return { ...stats };
    },
    get recent() {
      return [...recent];
    },
  };
}

// ---------------------------------------------------------------- scheduler

export interface WorkerTaskOptions {
  readonly priority?: Priority;
  readonly signal?: AbortSignal;
  /** Name in long-task reports. Default `task:<priority>`. */
  readonly name?: string;
}

export interface WorkerSchedulerEnvironment {
  readonly now?: () => number;
  /** Queue a macrotask at a priority. Default: scheduler.postTask → MessageChannel → setTimeout. */
  readonly macrotask?: (callback: () => void, priority: Priority) => void;
  /** Yield primitive. Default: scheduler.yield → scheduler.postTask → MessageChannel → setTimeout. */
  readonly yield?: () => Promise<void>;
}

export interface WorkerSchedulerOptions extends WorkerSchedulerEnvironment {
  readonly telemetry?: Telemetry;
  /** Time running queued tasks before giving the event loop a turn. Default 8 ms (no frames to protect in workers). */
  readonly sliceMs?: number;
  /** A detector to share, or options for a new one. */
  readonly longTasks?: LongTaskDetector | LongTaskDetectorOptions;
}

export interface WorkerScheduler {
  readonly paused: boolean;
  readonly disposed: boolean;
  /** Queued tasks. */
  readonly pending: number;
  /** Priority of the task whose synchronous part is running, if any. */
  readonly running: Priority | undefined;
  postTask<T>(fn: (signal: AbortSignal) => T | Promise<T>, options?: WorkerTaskOptions): Promise<Result<T>>;
  /** Give the event loop (and more urgent tasks) a turn; waits while paused. */
  yield(signal?: AbortSignal): Promise<Result<void>>;
  /** True when the current slice is used up or interaction work is waiting. */
  shouldYield(): boolean;
  pause(): void;
  resume(): void;
  dispose(): void;
  readonly longTasks: LongTaskDetector;
}

interface QueuedTask {
  readonly run: () => void;
  readonly cancel: () => void;
}

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const isDetector = (value: LongTaskDetector | LongTaskDetectorOptions | undefined): value is LongTaskDetector =>
  typeof (value as LongTaskDetector | undefined)?.record === 'function';

export function createWorkerScheduler(options: WorkerSchedulerOptions = {}): WorkerScheduler {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? defaultNow;
  const macrotask = options.macrotask ?? defaultMacrotask;
  const yieldFn = options.yield ?? yieldToMain;
  const sliceMs = options.sliceMs ?? 8;
  const longTasks = isDetector(options.longTasks) ? options.longTasks : createLongTaskDetector({ now, telemetry, ...options.longTasks });
  const queues: Record<Priority, QueuedTask[]> = { interaction: [], critical: [], visible: [], idle: [] };
  const resumeWaiters = new Set<() => void>();
  let paused = false;
  let disposed = false;
  let loopScheduled = false;
  let running: Priority | undefined;
  let sliceStart = now();

  const top =(): Priority | undefined => PRIORITIES.find((p) => queues[p].length > 0);

  const scheduleLoop = (): void => {
    if (paused || disposed || loopScheduled) return;
    const priority = top();
    if (priority === undefined) return;
    loopScheduled = true;
    macrotask(runSlice, priority);
  };
  const runSlice = (): void => {
    loopScheduled = false;
    if (paused || disposed) return;
    sliceStart = now();
    for (;;) {
      const priority = top();
      if (priority === undefined || paused) break;
      (queues[priority].shift() as QueuedTask).run();
      if (now() - sliceStart >= sliceMs) break;
    }
    scheduleLoop();
  };

  const waitForResume = (signal: AbortSignal | undefined): Promise<Result<void>> => {
    if (disposed) return Promise.resolve(err(WorkerSchedulerDisposedError()));
    if (!paused) return Promise.resolve(ok());
    return new Promise((resolve) => {
      // Aborted to detach the abort listener once the scheduler resumes.
      const detach = new AbortController();
      const waiter = (): void => {
        detach.abort();
        resolve(disposed ? err(WorkerSchedulerDisposedError()) : ok());
      };
      signal?.addEventListener(
        'abort',
        () => {
          resumeWaiters.delete(waiter);
          resolve(err(AbortedError({ cause: signal.reason })));
        },
        { once: true, signal: detach.signal },
      );
      resumeWaiters.add(waiter);
    });
  };

  return {
    get paused() {
      return paused;
    },
    get disposed() {
      return disposed;
    },
    get pending() {
      return PRIORITIES.reduce((sum, p) => sum + queues[p].length, 0);
    },
    get running() {
      return running;
    },
    longTasks,
    postTask<T>(fn: (signal: AbortSignal) => T | Promise<T>, taskOptions: WorkerTaskOptions = {}): Promise<Result<T>> {
      const priority = taskOptions.priority ?? 'visible';
      const name = taskOptions.name ?? `task:${priority}`;
      const signal = taskOptions.signal ?? new AbortController().signal;
      if (disposed) return Promise.resolve(err(WorkerSchedulerDisposedError()));
      if (signal.aborted) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      return new Promise((resolve) => {
        const queue = queues[priority];
        // Aborted to detach the abort listener once the task leaves the queue.
        const detach = new AbortController();
        const entry: QueuedTask = {
          run() {
            detach.abort();
            running = priority;
            const start = now();
            let value: T | Promise<T>;
            try {
              value = fn(signal);
            } catch (error) {
              resolve(err(toSfError(error)));
              return;
            } finally {
              running = undefined;
              longTasks.record(name, start, now());
            }
            if (value instanceof Promise) {
              value.then(
                (v: T) => resolve(ok(v)),
                (error: unknown) => resolve(err(signal.aborted ? AbortedError({ cause: error }) : toSfError(error))),
              );
            } else resolve(ok(value));
          },
          cancel() {
            detach.abort();
            resolve(err(WorkerSchedulerDisposedError()));
          },
        };
        signal.addEventListener(
          'abort',
          () => {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            resolve(err(AbortedError({ cause: signal.reason })));
          },
          { once: true, signal: detach.signal },
        );
        queue.push(entry);
        scheduleLoop();
      });
    },
    async yield(signal) {
      if (disposed) return err(WorkerSchedulerDisposedError());
      if (signal?.aborted === true) return err(AbortedError({ cause: signal.reason }));
      await yieldFn();
      // Re-read after the await (the signal may have aborted meanwhile).
      if (isAborted(signal)) return err(AbortedError({ cause: signal?.reason }));
      const resumed = await waitForResume(signal);
      sliceStart = now();
      return resumed;
    },
    shouldYield: () => paused || now() - sliceStart >= sliceMs || (queues.interaction.length > 0 && running !== 'interaction'),
    pause() {
      if (paused || disposed) return;
      paused = true;
      telemetry.event('worker-scheduler.paused', { subsystem: SUB, level: 'verbose' });
    },
    resume() {
      if (!paused || disposed) return;
      paused = false;
      telemetry.event('worker-scheduler.resumed', { subsystem: SUB, level: 'verbose' });
      for (const waiter of [...resumeWaiters]) waiter();
      resumeWaiters.clear();
      scheduleLoop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      longTasks.stop();
      for (const priority of PRIORITIES) for (const entry of queues[priority].splice(0)) entry.cancel();
      for (const waiter of [...resumeWaiters]) waiter();
      resumeWaiters.clear();
    },
  };
}

export const WorkerSchedulerToken = /* @__PURE__ */ token('runtime/worker-scheduler').type<WorkerScheduler>();

/** The worker scheduler as a DI unit (worker-scoped injector); disposed with its scope. */
export function workerSchedulerUnit(
  options: Omit<WorkerSchedulerOptions, 'telemetry'> & { readonly probe?: boolean } = {},
): UnitDefinition<WorkerScheduler, Record<never, never>, 'runtime/worker-scheduler'> {
  return unit<WorkerScheduler, Record<never, never>, 'runtime/worker-scheduler'>({
    id: 'runtime/worker-scheduler-unit',
    provides: WorkerSchedulerToken,
    scope: 'app',
    description: 'Worker-side priority scheduler with scheduler.yield/MessageChannel yielding and a long-task detector (SF-Δ28).',
    create: (_deps, ctx) => {
      const scheduler = createWorkerScheduler({ ...options, telemetry: ctx.telemetry });
      if (options.probe === true) scheduler.longTasks.start();
      ctx.scope.defer(() => scheduler.dispose());
      return scheduler;
    },
  });
}
