/**
 * Tile preparation lanes (S1 lesson: a 512 px tile costs ≈ 6.7 ms CPU, more than a 120 Hz frame
 * can spare). Tiles the frame could not afford are prepared **off the frame**: in idle slices of
 * the render worker's scheduler, between frames. A lane runs one job at a time; the job renders
 * tiles until `shouldYield()` and returns `true` while it has more to do.
 *
 * A helper-worker lane fits the same port once a backend can prepare tiles without the GPU device
 * (Vello's strip generation is CPU-only); `vello_gpu` 0.3 renders strips and pixels in one call, so
 * the M1 lane is the idle lane of the render worker.
 */
import type { WorkerScheduler } from '@staticflux/runtime/worker';

export interface TilePrepBudget {
  /** True when the current slice is used up or more urgent work is waiting. */
  shouldYield(): boolean;
}

export interface TilePrepLane {
  /** Run `work` off the frame; it is called again while it returns `true` and `signal` is not aborted. */
  schedule(work: (budget: TilePrepBudget) => boolean, signal: AbortSignal): void;
}

/** Idle lane over the worker scheduler (`@staticflux/runtime/worker`): priority `idle`, sliced. */
export function workerSchedulerLane(scheduler: Pick<WorkerScheduler, 'postTask' | 'shouldYield'>): TilePrepLane {
  const lane: TilePrepLane = {
    schedule(work, signal) {
      if (signal.aborted) return;
      void scheduler
        .postTask(() => work({ shouldYield: () => scheduler.shouldYield() }), { priority: 'idle', signal, name: 'surface/tile-prep' })
        .then((result) => {
          if (result.ok && result.value && !signal.aborted) lane.schedule(work, signal);
        });
    },
  };
  return lane;
}

export interface ManualTilePrepLane extends TilePrepLane {
  /** Jobs waiting to run. */
  readonly pending: number;
  /**
   * Run queued jobs (and their continuations) until none is left or `maxSlices` slices ran.
   * Each slice yields after `tilesPerSlice` `shouldYield()` checks (default: 1 tile per slice).
   */
  run(options?: { readonly maxSlices?: number; readonly tilesPerSlice?: number }): number;
}

/** A deterministic lane for tests: nothing runs until `run()`. */
export function manualTilePrepLane(): ManualTilePrepLane {
  const queue: { work: (budget: TilePrepBudget) => boolean; signal: AbortSignal }[] = [];
  return {
    get pending() {
      return queue.length;
    },
    schedule(work, signal) {
      if (!signal.aborted) queue.push({ work, signal });
    },
    run(options = {}) {
      const maxSlices = options.maxSlices ?? 10_000;
      const perSlice = Math.max(1, options.tilesPerSlice ?? 1);
      let slices = 0;
      while (queue.length > 0 && slices < maxSlices) {
        const job = queue.shift()!;
        if (job.signal.aborted) continue;
        let checks = 0;
        slices += 1;
        const more = job.work({ shouldYield: () => ++checks >= perSlice });
        if (more && !job.signal.aborted) queue.push(job);
      }
      return slices;
    },
  };
}
