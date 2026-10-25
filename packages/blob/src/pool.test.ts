import { describe, expect, it } from 'vitest';
import { runPool } from './pool.js';

describe('runPool', () => {
  it('runs every item with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(item * 10 + index);
      active -= 1;
    });
    expect(peak).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual([10, 21, 32, 43, 54, 65, 76]);
  });

  it('handles an empty list', async () => {
    let calls = 0;
    await runPool([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });
});
