import { ok } from '@staticflux/core';
import { createWorkerScheduler } from '@staticflux/runtime/worker';
import { describe, expect, it } from 'vitest';
import { manualTilePrepLane, workerSchedulerLane } from './raster-lane.js';

describe('manualTilePrepLane', () => {
  it('runs nothing until run(), then continues jobs that report more work', () => {
    const lane = manualTilePrepLane();
    let remaining = 3;
    const done: number[] = [];
    lane.schedule((budget) => {
      while (remaining > 0) {
        done.push(remaining--);
        if (budget.shouldYield()) break;
      }
      return remaining > 0;
    }, new AbortController().signal);
    expect(lane.pending).toBe(1);
    expect(done).toEqual([]);
    expect(lane.run()).toBe(3); // one tile per slice by default
    expect(done).toEqual([3, 2, 1]);
    expect(lane.pending).toBe(0);
  });

  it('honours tilesPerSlice, maxSlices and abort', () => {
    const lane = manualTilePrepLane();
    let count = 0;
    const controller = new AbortController();
    lane.schedule((budget) => {
      do count++;
      while (!budget.shouldYield());
      return true;
    }, controller.signal);
    lane.run({ maxSlices: 2, tilesPerSlice: 3 });
    expect(count).toBe(6);
    controller.abort();
    expect(lane.run()).toBe(0);
    lane.schedule(() => true, controller.signal); // aborted: dropped
    expect(lane.pending).toBe(0);
  });
});

describe('workerSchedulerLane', () => {
  it('runs work as idle tasks and re-posts it while it has more', async () => {
    const tasks: (() => void)[] = [];
    const scheduler = createWorkerScheduler({ macrotask: (fn) => tasks.push(fn), now: () => 0 });
    const lane = workerSchedulerLane(scheduler);
    let calls = 0;
    lane.schedule(() => ++calls < 3, new AbortController().signal);
    for (let i = 0; i < 20 && calls < 3; i++) {
      while (tasks.length > 0) tasks.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(calls).toBe(3);
    scheduler.dispose();
  });

  it('passes shouldYield through and drops work after abort', async () => {
    const posted: string[] = [];
    const lane = workerSchedulerLane({
      postTask: (fn, options) => {
        posted.push(String(options?.priority));
        return Promise.resolve(ok(fn(new AbortController().signal) as never));
      },
      shouldYield: () => true,
    });
    const controller = new AbortController();
    let yielded: boolean | undefined;
    lane.schedule((budget) => {
      yielded = budget.shouldYield();
      controller.abort();
      return true;
    }, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(yielded).toBe(true);
    expect(posted).toEqual(['idle']);
    lane.schedule(() => true, controller.signal);
    expect(posted).toEqual(['idle']);
  });
});
