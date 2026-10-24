/**
 * Frame scheduler (R12.1, R12.13, R12.15, R12.18).
 *
 * - One coalesced flush per animation frame: `update` jobs (store patches, URL sync,
 *   reactive batches — deduplicated by identity) → `measure` (DOM reads) → `mutate`
 *   (DOM writes, renders). Reads are always batched before writes; a read requested
 *   from a write runs in the next frame, so layouts are never forced mid-frame.
 * - Prioritized task queue: `interaction` → `critical` → `visible` → `idle`, run in
 *   time slices on the best macrotask primitive available (scheduler.postTask →
 *   MessageChannel → setTimeout). `idle` uses requestIdleCallback when present.
 *   R12.1 lists boot tiers critical → visible → idle → interaction: "interaction"
 *   *work that waits for input* is deferred with `idleUntilUrgent`/functional deps;
 *   work *triggered by* input is scheduled as `interaction` and runs first (R12.18).
 * - `yieldToMain()`: scheduler.yield → scheduler.postTask → MessageChannel → setTimeout.
 * - `idleUntilUrgent(fn)`: run on idle, or synchronously on first `get()`.
 * - `pause()`/`resume()`: nothing runs while paused (I-1); `yieldToMain` waits for resume.
 * - Every timing source (raf, now, macrotask, idle, yield) is injectable for tests.
 */
import { AbortedError, createNoopTelemetry, err, ok, type Result, type SfError, type Telemetry, toSfError } from '@staticflux/core';
import { SchedulerDisposedError } from './errors.js';
import { defaultNow } from './hooks.js';
import { RUNTIME_SUBSYSTEMS, runtimeMetrics } from './telemetry.js';

const SUB = RUNTIME_SUBSYSTEMS.scheduler;

export const PRIORITIES = ['interaction', 'critical', 'visible', 'idle'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type FramePhase = 'idle' | 'update' | 'measure' | 'mutate';

/** A coalesced per-frame job. Scheduling the same function several times in one frame runs it once. */
export type FrameJob = () => void;

export interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

export interface SchedulerEnvironment {
  /** requestAnimationFrame. Default: global rAF → setTimeout(16). */
  readonly raf?: (callback: (time: number) => void) => unknown;
  readonly now?: () => number;
  /** Queue a macrotask at a priority. Default: scheduler.postTask → MessageChannel → setTimeout. */
  readonly macrotask?: (callback: () => void, priority: Priority) => void;
  /** Idle callback. Default: requestIdleCallback → setTimeout fallback. */
  readonly idle?: (callback: (deadline: IdleDeadline) => void, timeoutMs: number) => void;
  /** Yield primitive. Default: `yieldToMain`. */
  readonly yield?: () => Promise<void>;
}

export interface FrameSchedulerOptions extends SchedulerEnvironment {
  readonly telemetry?: Telemetry;
  /** Max time spent running queued tasks before yielding to the browser (default 5 ms). */
  readonly sliceMs?: number;
  /** Frames longer than this emit a `frame.long` event (default 16 ms). */
  readonly longFrameMs?: number;
  /** Idle tasks run at the latest after this long (default 1000 ms). */
  readonly idleTimeoutMs?: number;
}

export interface TaskOptions {
  readonly priority?: Priority;
  readonly signal?: AbortSignal;
}

export interface IdleUntilUrgent<T> {
  /** True once the value has been computed. */
  readonly done: boolean;
  /** The value; computed synchronously now if the idle run has not happened yet. */
  get(): T;
  /** Drop the queued idle run (a later `get()` still computes on demand). */
  cancel(): void;
}

export interface FrameScheduler {
  readonly phase: FramePhase;
  readonly paused: boolean;
  /** Queued frame jobs + tasks. */
  readonly pending: number;
  /** Coalesced job for the next frame's `update` phase (R12.13). */
  schedule(job: FrameJob, signal?: AbortSignal): void;
  /** DOM read in the next frame's `measure` phase. */
  measure<T>(read: () => T, signal?: AbortSignal): Promise<Result<T>>;
  /** DOM write in the `mutate` phase (after every measure of the same frame). */
  mutate<T>(write: () => T, signal?: AbortSignal): Promise<Result<T>>;
  /** Prioritized task (not frame-bound). Resolves with the task's value. */
  postTask<T>(fn: (signal: AbortSignal) => T | Promise<T>, options?: TaskOptions): Promise<Result<T>>;
  /** Yield to the main thread; while paused, waits for resume. */
  yieldToMain(signal?: AbortSignal): Promise<Result<void>>;
  idleUntilUrgent<T>(fn: () => T, options?: { readonly signal?: AbortSignal }): IdleUntilUrgent<T>;
  /** Run one frame flush now (tests, forced sync points). */
  flush(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

// ---------------------------------------------------------------- environment detection

interface PostTaskScheduler {
  yield?: () => Promise<void>;
  postTask?: (callback: () => void, options: { priority: 'user-blocking' | 'user-visible' | 'background' }) => Promise<unknown>;
}

function nativeScheduler(): PostTaskScheduler | undefined {
  const candidate = (globalThis as { scheduler?: PostTaskScheduler }).scheduler;
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

const POST_TASK_PRIORITY: Record<Priority, 'user-blocking' | 'user-visible' | 'background'> = {
  interaction: 'user-blocking',
  critical: 'user-blocking',
  visible: 'user-visible',
  idle: 'background',
};

let channel: { port: MessagePort; queue: (() => void)[] } | undefined;

function messageChannelTask(callback: () => void): boolean {
  if (typeof MessageChannel !== 'function') return false;
  if (channel === undefined) {
    const mc = new MessageChannel();
    const queue: (() => void)[] = [];
    mc.port1.onmessage = () => {
      queue.shift()?.();
    };
    // Node/happy-dom: do not keep the process alive for an idle channel.
    (mc.port1 as unknown as { unref?: () => void }).unref?.();
    (mc.port2 as unknown as { unref?: () => void }).unref?.();
    channel = { port: mc.port2, queue };
  }
  channel.queue.push(callback);
  channel.port.postMessage(null);
  return true;
}

/** Best available macrotask: scheduler.postTask(priority) → MessageChannel → setTimeout(0). */
export function defaultMacrotask(callback: () => void, priority: Priority): void {
  const native = nativeScheduler();
  if (typeof native?.postTask === 'function') {
    void native.postTask(callback, { priority: POST_TASK_PRIORITY[priority] });
    return;
  }
  if (messageChannelTask(callback)) return;
  setTimeout(callback, 0);
}

/** Yield to the main thread: scheduler.yield → scheduler.postTask → MessageChannel → setTimeout (Safari has neither API). */
export function yieldToMain(): Promise<void> {
  const native = nativeScheduler();
  if (typeof native?.yield === 'function') return native.yield();
  return new Promise((resolve) => {
    if (typeof native?.postTask === 'function') {
      void native.postTask(resolve, { priority: 'user-visible' });
      return;
    }
    if (messageChannelTask(resolve)) return;
    setTimeout(resolve, 0);
  });
}

/** requestIdleCallback → setTimeout fallback with a synthetic 50 ms deadline. */
export function defaultIdle(callback: (deadline: IdleDeadline) => void, timeoutMs: number): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: (d: IdleDeadline) => void, o: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') {
    ric(callback, { timeout: timeoutMs });
    return;
  }
  setTimeout(() => {
    const start = defaultNow();
    callback({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (defaultNow() - start)) });
  }, 1);
}

function defaultRaf(callback: (time: number) => void): unknown {
  const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number }).requestAnimationFrame;
  if (typeof raf === 'function') return raf.call(globalThis, callback);
  return setTimeout(() => callback(defaultNow()), 16);
}

// ---------------------------------------------------------------- implementation

interface QueuedTask {
  readonly run: () => void;
  readonly cancel: (error: SfError) => void;
}

export function createFrameScheduler(options: FrameSchedulerOptions = {}): FrameScheduler {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const now = options.now ?? defaultNow;
  const raf = options.raf ?? defaultRaf;
  const macrotask = options.macrotask ?? defaultMacrotask;
  const idle = options.idle ?? defaultIdle;
  const yieldFn = options.yield ?? yieldToMain;
  const sliceMs = options.sliceMs ?? 5;
  const longFrameMs = options.longFrameMs ?? 16;
  const idleTimeoutMs = options.idleTimeoutMs ?? 1_000;

  let phase: FramePhase = 'idle';
  let paused = false;
  let disposed = false;
  let frameRequested = false;
  let loopScheduled = false;
  let idleScheduled = false;
  const updates = new Set<FrameJob>();
  let reads: QueuedTask[] = [];
  let writes: QueuedTask[] = [];
  const queues: Record<Priority, QueuedTask[]> = { interaction: [], critical: [], visible: [], idle: [] };
  const resumeWaiters = new Set<() => void>();

  const reportJobError = (error: unknown, kind: string): void => {
    telemetry.event('frame.job-failed', {
      subsystem: SUB,
      level: 'standard',
      attrs: { kind, message: toSfError(error).message },
    });
  };

  const requestFrame = (): void => {
    if (frameRequested || paused || disposed) return;
    if (updates.size === 0 && reads.length === 0 && writes.length === 0) return;
    frameRequested = true;
    raf(() => {
      frameRequested = false;
      flushFrame();
    });
  };

  const flushFrame = (): void => {
    if (paused || disposed) return;
    const start = now();
    const counts = { update: updates.size, measure: 0, mutate: 0 };
    try {
      phase = 'update';
      const jobs = [...updates];
      updates.clear();
      for (const job of jobs) {
        try {
          job();
        } catch (error) {
          reportJobError(error, 'update');
        }
      }
      phase = 'measure';
      const frameReads = reads;
      reads = [];
      counts.measure = frameReads.length;
      for (const read of frameReads) read.run();
      phase = 'mutate';
      const frameWrites = writes;
      writes = [];
      counts.mutate = frameWrites.length;
      for (const write of frameWrites) write.run();
    } finally {
      phase = 'idle';
    }
    const duration = now() - start;
    if (telemetry.enabled(SUB, 'debug')) telemetry.record(runtimeMetrics.frameFlush, duration, counts);
    if (duration > longFrameMs) {
      telemetry.event('frame.long', { subsystem: SUB, level: 'standard', attrs: { duration, ...counts } });
    }
    requestFrame();
  };

  const enqueuePhase = <T>(target: 'measure' | 'mutate', fn: () => T, signal: AbortSignal | undefined): Promise<Result<T>> => {
    if (disposed) return Promise.resolve(err(SchedulerDisposedError()));
    if (signal?.aborted === true) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
    return new Promise((resolve) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        resolve(err(AbortedError({ cause: signal?.reason })));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const entry = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        try {
          resolve(ok(fn()));
        } catch (error) {
          reportJobError(error, target);
          resolve(err(toSfError(error)));
        }
      };
      const queued: QueuedTask = {
        run: entry,
        cancel: (error) => {
          signal?.removeEventListener('abort', onAbort);
          if (settled) return;
          settled = true;
          resolve(err(error));
        },
      };
      if (target === 'measure') reads.push(queued);
      else writes.push(queued);
      requestFrame();
    });
  };

  // ------------------------------------------------------------ task loop

  const hasUrgent = (): boolean =>
    queues.interaction.length > 0 || queues.critical.length > 0 || queues.visible.length > 0;

  const nextUrgent = (): QueuedTask | undefined =>
    queues.interaction.shift() ?? queues.critical.shift() ?? queues.visible.shift();

  const scheduleLoop = (): void => {
    if (paused || disposed) return;
    if (hasUrgent()) {
      if (loopScheduled) return;
      loopScheduled = true;
      const top: Priority = queues.interaction.length > 0 ? 'interaction' : queues.critical.length > 0 ? 'critical' : 'visible';
      macrotask(runSlice, top);
      return;
    }
    if (queues.idle.length > 0 && !idleScheduled) {
      idleScheduled = true;
      idle(runIdle, idleTimeoutMs);
    }
  };

  const runSlice = (): void => {
    loopScheduled = false;
    if (paused || disposed) return;
    const start = now();
    while (hasUrgent() && !paused) {
      nextUrgent()?.run();
      if (now() - start >= sliceMs) break;
    }
    scheduleLoop();
  };

  const runIdle = (deadline: IdleDeadline): void => {
    idleScheduled = false;
    if (paused || disposed) return;
    // Urgent work always preempts idle work.
    while (queues.idle.length > 0 && !hasUrgent() && !paused) {
      queues.idle.shift()?.run();
      if (!deadline.didTimeout && deadline.timeRemaining() <= 0) break;
      if (deadline.didTimeout) break;
    }
    scheduleLoop();
  };

  const waitForResume = (signal: AbortSignal | undefined): Promise<Result<void>> => {
    if (disposed) return Promise.resolve(err(SchedulerDisposedError()));
    if (!paused) return Promise.resolve(ok());
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resumeWaiters.delete(waiter);
        resolve(err(AbortedError({ cause: signal?.reason })));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(disposed ? err(SchedulerDisposedError()) : ok());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      resumeWaiters.add(waiter);
    });
  };

  const scheduler: FrameScheduler = {
    get phase() {
      return phase;
    },
    get paused() {
      return paused;
    },
    get pending() {
      return (
        updates.size +
        reads.length +
        writes.length +
        queues.interaction.length +
        queues.critical.length +
        queues.visible.length +
        queues.idle.length
      );
    },
    schedule(job, signal) {
      if (disposed || signal?.aborted === true) return;
      updates.add(job);
      signal?.addEventListener('abort', () => updates.delete(job), { once: true });
      requestFrame();
    },
    measure: (read, signal) => enqueuePhase('measure', read, signal),
    mutate: (write, signal) => enqueuePhase('mutate', write, signal),
    postTask<T>(fn: (signal: AbortSignal) => T | Promise<T>, taskOptions: TaskOptions = {}): Promise<Result<T>> {
      const priority = taskOptions.priority ?? 'visible';
      const signal = taskOptions.signal ?? new AbortController().signal;
      if (disposed) return Promise.resolve(err(SchedulerDisposedError()));
      if (signal.aborted) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      return new Promise((resolve) => {
        const queue = queues[priority];
        const onAbort = (): void => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          resolve(err(AbortedError({ cause: signal.reason })));
        };
        const entry: QueuedTask = {
          run: () => {
            signal.removeEventListener('abort', onAbort);
            try {
              const value = fn(signal);
              if (value instanceof Promise) {
                value.then(
                  (v: T) => resolve(ok(v)),
                  (error: unknown) => resolve(err(signal.aborted ? AbortedError({ cause: error }) : toSfError(error))),
                );
              } else resolve(ok(value));
            } catch (error) {
              resolve(err(toSfError(error)));
            }
          },
          cancel: (error) => {
            signal.removeEventListener('abort', onAbort);
            resolve(err(error));
          },
        };
        signal.addEventListener('abort', onAbort, { once: true });
        queue.push(entry);
        scheduleLoop();
      });
    },
    async yieldToMain(signal) {
      if (disposed) return err(SchedulerDisposedError());
      if (signal?.aborted === true) return err(AbortedError({ cause: signal.reason }));
      await yieldFn();
      if (signal?.aborted === true) return err(AbortedError({ cause: signal.reason }));
      return waitForResume(signal);
    },
    idleUntilUrgent<T>(fn: () => T, idleOptions: { readonly signal?: AbortSignal } = {}): IdleUntilUrgent<T> {
      let done = false;
      let value: T | undefined;
      const controller = new AbortController();
      idleOptions.signal?.addEventListener('abort', () => controller.abort(idleOptions.signal?.reason), { once: true });
      const compute = (): T => {
        if (!done) {
          value = fn();
          done = true;
        }
        return value as T;
      };
      void scheduler.postTask(
        () => {
          if (!done) compute();
        },
        { priority: 'idle', signal: controller.signal },
      );
      return {
        get done() {
          return done;
        },
        get() {
          controller.abort();
          return compute();
        },
        cancel() {
          controller.abort();
        },
      };
    },
    flush() {
      flushFrame();
    },
    pause() {
      if (paused || disposed) return;
      paused = true;
      telemetry.event('scheduler.paused', { subsystem: SUB, level: 'verbose' });
    },
    resume() {
      if (!paused || disposed) return;
      paused = false;
      telemetry.event('scheduler.resumed', { subsystem: SUB, level: 'verbose' });
      for (const waiter of [...resumeWaiters]) waiter();
      resumeWaiters.clear();
      requestFrame();
      scheduleLoop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = SchedulerDisposedError();
      updates.clear();
      for (const entry of [...reads, ...writes]) entry.cancel(error);
      reads = [];
      writes = [];
      for (const priority of PRIORITIES) {
        for (const entry of queues[priority].splice(0)) entry.cancel(error);
      }
      for (const waiter of [...resumeWaiters]) waiter();
      resumeWaiters.clear();
    },
  };
  return scheduler;
}
