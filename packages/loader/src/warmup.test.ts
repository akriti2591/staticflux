import { createMemorySink, createTelemetry } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  clampOrder,
  createChunkLoader,
  createWarmup,
  type IdleScheduler,
  MANIFEST_FORMAT,
  NOMINAL_WARMUP_FACTS,
  rankCandidates,
  type SfManifest,
  type TimerFn,
  type WarmupAdvisor,
  type WarmupFacts,
  warmupAllowance,
} from './index.js';

const manifest: SfManifest = {
  format: MANIFEST_FORMAT,
  buildId: 'b',
  base: '/',
  chunks: {
    'feature:agent-chat': { id: 'feature:agent-chat', files: ['chat.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
    'feature:settings': { id: 'feature:settings', files: ['settings.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
    'feature:billing': { id: 'feature:billing', files: ['billing.js'], css: [], deps: [], tier: 'likely', load: 'lazy' },
    'feature:studio': { id: 'feature:studio', files: ['studio.js'], css: [], deps: [], tier: 'on-demand', load: 'lazy' },
  },
};

/** Manual idle scheduler: tests flush slots one by one. */
function manualIdle(): IdleScheduler & { flush(): Promise<void>; readonly pending: number } {
  const queue: (() => void)[] = [];
  const idle = ((callback: () => void, signal: AbortSignal) => {
    queue.push(callback);
    signal.addEventListener('abort', () => {
      const i = queue.indexOf(callback);
      if (i >= 0) queue.splice(i, 1);
    });
  }) as IdleScheduler & { flush(): Promise<void>; readonly pending: number };
  Object.defineProperty(idle, 'pending', { get: () => queue.length });
  idle.flush = async () => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      const next = queue.shift();
      if (next === undefined) {
        if (i > 3) return;
        continue;
      }
      next();
    }
  };
  return idle;
}

/** Manual timer: `advance(ms)` fires due callbacks. */
function manualTimer(): TimerFn & { advance(ms: number): void } {
  let now = 0;
  const timers: { at: number; cb: () => void; live: boolean }[] = [];
  const timer = ((cb: () => void, ms: number) => {
    const t = { at: now + ms, cb, live: true };
    timers.push(t);
    return () => {
      t.live = false;
    };
  }) as TimerFn & { advance(ms: number): void };
  timer.advance = (ms) => {
    now += ms;
    for (const t of timers) {
      if (t.live && t.at <= now) {
        t.live = false;
        t.cb();
      }
    }
  };
  return timer;
}

function setup(options: { facts?: WarmupFacts; advisor?: WarmupAdvisor; canLoad?: (id: string) => boolean; action?: 'load' | 'preload' } = {}) {
  const sink = createMemorySink();
  const telemetry = createTelemetry({ random: () => 0.5 });
  telemetry.addSink(sink);
  const importer = vi.fn(async (url: string) => ({ url }));
  const loader = createChunkLoader({ manifest, telemetry, importer, document: undefined, retry: { attempts: 1 }, ...(options.canLoad === undefined ? {} : { canLoad: options.canLoad }) });
  const idle = manualIdle();
  let facts = options.facts ?? NOMINAL_WARMUP_FACTS;
  const warmup = createWarmup({
    loader,
    idle,
    facts: () => facts,
    telemetry,
    ...(options.advisor === undefined ? {} : { advisor: options.advisor }),
    ...(options.action === undefined ? {} : { action: options.action }),
  });
  return { loader, importer, idle, warmup, sink, setFacts: (f: WarmupFacts) => (facts = f) };
}

describe('warmup allowance (network/device aware)', () => {
  it('skips background tiers offline, on saveData and 2g; penalizes speculative on 3g/low tier', () => {
    expect(warmupAllowance({ ...NOMINAL_WARMUP_FACTS, online: false }, 'likely')).toMatchObject({ allowed: false, reason: 'offline' });
    expect(warmupAllowance({ ...NOMINAL_WARMUP_FACTS, saveData: true }, 'speculative')).toMatchObject({ allowed: false, reason: 'save-data' });
    expect(warmupAllowance({ ...NOMINAL_WARMUP_FACTS, effectiveType: '2g' }, 'likely')).toMatchObject({ allowed: false, reason: 'network-2g' });
    expect(warmupAllowance({ ...NOMINAL_WARMUP_FACTS, effectiveType: 'slow-2g' }, 'speculative').allowed).toBe(false);
    expect(warmupAllowance({ ...NOMINAL_WARMUP_FACTS, effectiveType: '3g', deviceTier: 'low' }, 'speculative').eagernessPenalty).toBe(2);
    expect(warmupAllowance({ ...NOMINAL_WARMUP_FACTS, effectiveType: '3g' }, 'likely')).toMatchObject({ allowed: true, eagernessPenalty: 0 });
    expect(warmupAllowance({ ...NOMINAL_WARMUP_FACTS, saveData: true }, 'critical').allowed).toBe(true);
    expect(warmupAllowance({ ...NOMINAL_WARMUP_FACTS, online: false }, 'on-demand').allowed).toBe(true);
  });
});

describe('advisor clamping and time-boxing (R19.7, R19.8)', () => {
  const candidates = ['a:a', 'b:b', 'c:c'] as const;

  it('clamps: unknown ids dropped, duplicates removed, omitted candidates appended', () => {
    expect(clampOrder(candidates, ['c:c', 'zz:zz', 'c:c', 'a:a'])).toEqual(['c:c', 'a:a', 'b:b']);
  });

  it('uses sync and async advice; falls back on timeout and errors', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    expect(await rankCandidates(undefined, candidates, { tier: 'likely' })).toEqual({ order: candidates, source: 'default' });
    expect(await rankCandidates({ id: 'x', rank: () => ['b:b'] }, ['a:a'], { tier: 'likely' })).toEqual({ order: ['a:a'], source: 'default' });
    const sync = await rankCandidates({ id: 'stat', rank: () => ['c:c'] }, candidates, { tier: 'likely', telemetry });
    expect(sync).toEqual({ order: ['c:c', 'a:a', 'b:b'], source: 'advisor' });
    const decision = sink.records.find((r) => r.type === 'event' && r.name === 'advisor.decision');
    expect(decision?.type === 'event' && decision.attrs).toMatchObject({ advisor: 'stat', source: 'advisor', overrodeDefault: true });
    const asyncAdvice = await rankCandidates({ id: 'remote', rank: async () => ['b:b'] }, candidates, { tier: 'likely' });
    expect(asyncAdvice).toEqual({ order: ['b:b', 'a:a', 'c:c'], source: 'advisor' });

    const timer = manualTimer();
    let seenSignal: AbortSignal | undefined;
    const slow = rankCandidates(
      { id: 'slow', rank: (_c, ctx) => ((seenSignal = ctx.signal), new Promise(() => undefined)) },
      candidates,
      { tier: 'likely', timer, budgetMs: 5 },
    );
    timer.advance(5);
    expect(await slow).toEqual({ order: candidates, source: 'timeout' });
    expect(seenSignal?.aborted).toBe(true);
    expect(await rankCandidates({ id: 'bad', rank: () => { throw new Error('x'); } }, candidates, { tier: 'likely' })).toMatchObject({ source: 'error' });
    expect(await rankCandidates({ id: 'bad', rank: async () => Promise.reject(new Error('x')) }, candidates, { tier: 'likely' })).toMatchObject({ source: 'error' });
  });
});

describe('likely tier', () => {
  it('loads likely chunks one per idle slot, in advisor order, skipping loaded ones', async () => {
    const advisor: WarmupAdvisor = { id: 'next-route', rank: () => ['feature:billing', 'feature:agent-chat'] };
    const { loader, importer, idle, warmup } = setup({ advisor });
    await loader.load('feature:settings');
    importer.mockClear();
    const done = warmup.warmLikely();
    expect(warmup.state).toBe('running');
    await new Promise((r) => setTimeout(r, 0));
    expect(importer).not.toHaveBeenCalled();
    await idle.flush();
    const report = await done;
    expect(importer.mock.calls.map((c) => c[0])).toEqual(['/billing.js', '/chat.js']);
    expect(report).toEqual({
      advice: 'advisor',
      skippedReason: undefined,
      results: [
        { id: 'feature:settings', outcome: 'already-loaded' },
        { id: 'feature:billing', outcome: 'loaded' },
        { id: 'feature:agent-chat', outcome: 'loaded' },
      ],
    });
    expect(warmup.state).toBe('idle');
    expect(loader.inspect().find((c) => c.id === 'feature:billing')?.warmedBy).toBe('likely');
  });

  it('explicit ids (e.g. agent-chat after studio first render) and gated chunks are reported denied', async () => {
    const { idle, warmup, importer } = setup({ canLoad: (id) => id !== 'feature:billing' });
    const done = warmup.warmLikely(['feature:agent-chat', 'feature:billing']);
    await idle.flush();
    expect((await done).results).toEqual([
      { id: 'feature:agent-chat', outcome: 'loaded' },
      { id: 'feature:billing', outcome: 'denied' },
    ]);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('skips entirely on saveData, and mid-run when facts degrade', async () => {
    const saving = setup({ facts: { ...NOMINAL_WARMUP_FACTS, saveData: true } });
    const report = await saving.warmup.warmLikely();
    expect(report).toMatchObject({ results: [], skippedReason: 'save-data' });
    expect(saving.sink.records.some((r) => r.type === 'metric' && r.metric === 'loader/warmup-skipped')).toBe(true);

    const degrading = setup();
    const done = degrading.warmup.warmLikely(['feature:agent-chat', 'feature:settings']);
    degrading.setFacts({ ...NOMINAL_WARMUP_FACTS, effectiveType: '2g' });
    await degrading.idle.flush();
    expect((await done).results.map((r) => r.outcome)).toEqual(['skipped', 'skipped']);
  });

  it('preload action injects links only; failures are reported', async () => {
    const { idle, warmup, importer, loader } = setup({ action: 'preload' });
    const done = warmup.warmLikely(['feature:agent-chat', 'x:missing']);
    await idle.flush();
    expect((await done).results).toEqual([
      { id: 'feature:agent-chat', outcome: 'loaded' },
      { id: 'x:missing', outcome: 'failed' },
    ]);
    expect(importer).not.toHaveBeenCalled();
    expect(loader.state('feature:agent-chat')).toBe('preloaded');
  });

  it('dispose aborts pending idle work; concurrent runs are rejected while running', async () => {
    const { idle, warmup, importer } = setup();
    const done = warmup.warmLikely(['feature:agent-chat']);
    expect((await warmup.warmLikely()).skippedReason).toBe('running');
    warmup.dispose();
    await idle.flush();
    expect((await done).results).toEqual([{ id: 'feature:agent-chat', outcome: 'aborted' }]);
    expect(importer).not.toHaveBeenCalled();
    expect(warmup.state).toBe('disposed');
    expect((await warmup.warmLikely()).skippedReason).toBe('disposed');
  });
});
