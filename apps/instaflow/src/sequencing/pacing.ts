/**
 * When the render module draws (S2 findings, D15).
 *
 * - **Draw on arrival** (`arrival: true`): wake when a view frame lands, wait `coalesceMs`
 *   for the rest of the burst, draw. A renderer that draws only in its own rAF is always one
 *   frame late (S2: 32.7 ms p95 vs 16.0 ms), because the worker rAF runs before the editor has
 *   seen that frame's input.
 * - **Ticks** pace presentation and catch-up draws. `worker-raf`: the render worker's own
 *   `requestAnimationFrame` (default). `main-raf`: **the main-rAF tick experiment** — main writes a
 *   tick cell in its rAF after forwarding input and `Atomics.notify`s the render worker, which
 *   may wait up to `latchMs` for the editor to consume that input and then draws. The owner run
 *   found the split topology misses the budget because the worker rAF phase lands late
 *   (`workerRafAfterMainRafMs` p95 10.4 ms); this switch tests whether a main-driven phase fixes it.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import type { CellReader, CellWriter } from '@staticflux/worker/pipeline';
import type { RenderTickFields } from './protocol.js';

export type TickDriver = 'worker-raf' | 'main-raf';

export interface RenderPacing {
  /** Draw as soon as a view frame arrives (S2 rule 2). */
  readonly arrival: boolean;
  /** Wait after a wake-up before drawing (burst coalescing; S2: 1 ms gives 1.00–1.03 draws per vsync). */
  readonly coalesceMs: number;
  readonly tick: TickDriver;
  /** On a main tick: wait up to this long for the editor to consume the tick's input (0 = do not wait). */
  readonly latchMs: number;
}

/** D15 default: draw on arrival with a 1 ms coalesce, paced by the worker's rAF. */
export const DEFAULT_RENDER_PACING: RenderPacing = Object.freeze({ arrival: true, coalesceMs: 1, tick: 'worker-raf', latchMs: 0 });

/** The main-rAF tick experiment for the split topology (owner's next step after the S2 real-GPU run). */
export const MAIN_TICK_PACING: RenderPacing = Object.freeze({ arrival: true, coalesceMs: 0, tick: 'main-raf', latchMs: 4 });

/** rAF-only drawing (the S2 control that is always one frame late). */
export const RAF_ONLY_PACING: RenderPacing = Object.freeze({ arrival: false, coalesceMs: 0, tick: 'worker-raf', latchMs: 0 });

export interface Tick {
  /** Frame timestamp, absolute ms (timeOrigin + rAF time). */
  readonly time: number;
  /** Input records main had pushed when it ticked (main-raf only). */
  readonly inputTarget: number | undefined;
}

/** A source of display ticks (vsyncs). */
export interface TickSource {
  next(signal: AbortSignal): Promise<Result<Tick>>;
}

export type RafLike = (callback: (time: number) => void) => unknown;

/** Ticks from a rAF function (the worker's own `requestAnimationFrame`). */
export function rafTicks(raf: RafLike, timeOrigin: number): TickSource {
  return {
    next: (signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve(err(AbortedError({ cause: signal.reason })));
        // Aborted when this wait settles, so the listener does not pile up on a long-lived signal.
        const detach = new AbortController();
        let done = false;
        const finish = (result: Result<Tick>): void => {
          if (done) return;
          done = true;
          detach.abort();
          resolve(result);
        };
        signal.addEventListener('abort', () => finish(err(AbortedError({ cause: signal.reason }))), { once: true, signal: detach.signal });
        raf((time) => finish(ok({ time: timeOrigin + time, inputTarget: undefined })));
      }),
  };
}

/** Ticks written by main into the render tick cell (main-rAF experiment). */
export function cellTicks(reader: CellReader<RenderTickFields>): TickSource {
  return {
    async next(signal) {
      for (;;) {
        if (reader.latest !== reader.generation) {
          const snapshot = reader.read();
          if (snapshot !== undefined) return ok({ time: snapshot.record.frameTime, inputTarget: snapshot.record.inputTarget });
        }
        const waited = await reader.wait({ signal });
        if (!waited.ok) return waited;
      }
    },
  };
}

/** Manual ticks (tests and the in-process oracle subject). */
export interface ManualTicks extends TickSource {
  tick(time: number, inputTarget?: number): void;
}

export function manualTicks(): ManualTicks {
  const waiting = new Set<(tick: Tick) => void>();
  return {
    next: (signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve(err(AbortedError({ cause: signal.reason })));
        const detach = new AbortController();
        const deliver = (tick: Tick): void => {
          waiting.delete(deliver);
          detach.abort();
          resolve(ok(tick));
        };
        waiting.add(deliver);
        signal.addEventListener(
          'abort',
          () => {
            waiting.delete(deliver);
            resolve(err(AbortedError({ cause: signal.reason })));
          },
          { once: true, signal: detach.signal },
        );
      }),
    tick(time, inputTarget) {
      for (const deliver of [...waiting]) deliver({ time, inputTarget });
    },
  };
}

/** Main side of the main-rAF experiment: one write per frame, after input was forwarded. */
export interface MainTick {
  readonly ticks: number;
  pulse(frameTime: number, inputTarget: number): void;
}

export function createMainTick(writer: CellWriter<RenderTickFields>): MainTick {
  let ticks = 0;
  return {
    get ticks() {
      return ticks;
    },
    pulse(frameTime, inputTarget) {
      ticks += 1;
      writer.write(({ record }) => {
        record.frameTime = frameTime;
        record.inputTarget = inputTarget;
        record.tick = ticks;
      });
    },
  };
}

/** Run `tick.pulse` in every main rAF until `signal` aborts. */
export function driveMainTick(options: {
  readonly tick: MainTick;
  readonly raf: RafLike;
  readonly timeOrigin: number;
  readonly inputTarget: () => number;
  readonly signal: AbortSignal;
}): void {
  const loop = (time: number): void => {
    if (options.signal.aborted) return;
    options.tick.pulse(options.timeOrigin + time, options.inputTarget());
    options.raf(loop);
  };
  options.raf(loop);
}
