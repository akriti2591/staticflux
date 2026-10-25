import { attachCell, createCell } from '@staticflux/worker/pipeline';
import { describe, expect, it } from 'vitest';
import { cellTicks, createMainTick, DEFAULT_RENDER_PACING, driveMainTick, MAIN_TICK_PACING, manualTicks, RAF_ONLY_PACING, rafTicks } from './pacing.js';
import { RenderTickCell } from './protocol.js';
import { createFakeRaf } from './testing/oracle-subject.js';

describe('pacing presets', () => {
  it('default draws on arrival with a 1 ms coalesce on the worker rAF; the experiment ticks from main', () => {
    expect(DEFAULT_RENDER_PACING).toEqual({ arrival: true, coalesceMs: 1, tick: 'worker-raf', latchMs: 0 });
    expect(MAIN_TICK_PACING).toMatchObject({ arrival: true, coalesceMs: 0, tick: 'main-raf' });
    expect(RAF_ONLY_PACING.arrival).toBe(false);
    expect(Object.isFrozen(DEFAULT_RENDER_PACING)).toBe(true);
  });
});

describe('rafTicks', () => {
  it('resolves on the next rAF with an absolute time, and aborts cleanly', async () => {
    const raf = createFakeRaf();
    const ticks = rafTicks(raf.raf, 1_000);
    const stop = new AbortController();
    const next = ticks.next(stop.signal);
    raf.flush(16);
    expect(await next).toEqual({ ok: true, value: { time: 1_016, inputTarget: undefined } });
    const pending = ticks.next(stop.signal);
    stop.abort();
    const aborted = await pending;
    expect(!aborted.ok && aborted.error.code).toBe('SF-CORE-002');
    const already = await ticks.next(stop.signal);
    expect(already.ok).toBe(false);
  });
});

describe('manualTicks', () => {
  it('delivers a tick to every waiter and aborts', async () => {
    const ticks = manualTicks();
    const stop = new AbortController();
    const a = ticks.next(stop.signal);
    const b = ticks.next(stop.signal);
    ticks.tick(5, 9);
    expect(await a).toEqual({ ok: true, value: { time: 5, inputTarget: 9 } });
    expect((await b).ok).toBe(true);
    const c = ticks.next(stop.signal);
    stop.abort();
    expect((await c).ok).toBe(false);
    expect((await ticks.next(stop.signal)).ok).toBe(false);
  });
});

describe('createMainTick / cellTicks / driveMainTick', () => {
  it('main writes ticks into the cell; the render side reads each new one', async () => {
    const cell = createCell(RenderTickCell, { medium: 'local' });
    if (!cell.ok) throw cell.error;
    const endpoint = cell.value.endpoint();
    if (!endpoint.ok) throw endpoint.error;
    const reader = await attachCell(RenderTickCell, endpoint.value);
    if (!reader.ok) throw reader.error;
    const main = createMainTick(cell.value);
    const ticks = cellTicks(reader.value);
    const stop = new AbortController();
    const first = ticks.next(stop.signal);
    main.pulse(100, 7);
    expect(await first).toEqual({ ok: true, value: { time: 100, inputTarget: 7 } });
    main.pulse(116, 9);
    expect(await ticks.next(stop.signal)).toEqual({ ok: true, value: { time: 116, inputTarget: 9 } });
    expect(main.ticks).toBe(2);

    const raf = createFakeRaf();
    let target = 0;
    driveMainTick({ tick: main, raf: raf.raf, timeOrigin: 1_000, inputTarget: () => (target += 1), signal: stop.signal });
    raf.flush(16);
    raf.flush(32);
    expect(main.ticks).toBe(4);
    expect(await ticks.next(stop.signal)).toEqual({ ok: true, value: { time: 1_032, inputTarget: 2 } });
    stop.abort();
    raf.flush(48);
    expect(main.ticks).toBe(4); // stopped
    const after = await ticks.next(stop.signal);
    expect(after.ok).toBe(false);
  });
});
