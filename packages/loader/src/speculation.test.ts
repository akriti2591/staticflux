import { createMemorySink, createScope, createTelemetry } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createChunkLoader,
  createSpeculationEngine,
  defineSpeculationRule,
  type IntersectionObserverFactory,
  lowerEagerness,
  MANIFEST_FORMAT,
  NOMINAL_WARMUP_FACTS,
  reaction,
  type SfManifest,
  type SpeculationRule,
  type TimerFn,
  type WarmupAdvisor,
  type WarmupFacts,
} from './index.js';

const manifest: SfManifest = {
  format: MANIFEST_FORMAT,
  buildId: 'b',
  base: '/',
  chunks: {
    'feature:billing': { id: 'feature:billing', files: ['billing.js'], css: [], deps: [], tier: 'speculative', load: 'lazy' },
    'lib:pdf': { id: 'lib:pdf', files: ['pdf.js'], css: [], deps: [], tier: 'speculative', load: 'lazy' },
    'lib:share': { id: 'lib:share', files: ['share.js'], css: [], deps: [], tier: 'speculative', load: 'lazy' },
  },
};

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

const upgradeCta = defineSpeculationRule({ id: 'billing/upgrade-cta', chunks: ['feature:billing'] });
const exportPdf = defineSpeculationRule({ id: 'studio/export-pdf', chunks: ['lib:pdf'], eagerness: 'conservative', action: 'load' });
const shareEager = defineSpeculationRule({ id: 'studio/share', chunks: ['lib:share', 'lib:pdf'], eagerness: 'eager' });
const immediate = defineSpeculationRule({ id: 'studio/immediate', chunks: ['lib:share'], eagerness: 'immediate' });

function setup(options: { facts?: WarmupFacts; rules?: readonly SpeculationRule[]; advisor?: WarmupAdvisor; io?: IntersectionObserverFactory; canLoad?: (id: string) => boolean } = {}) {
  const sink = createMemorySink();
  const telemetry = createTelemetry({ random: () => 0.5 });
  telemetry.addSink(sink);
  const importer = vi.fn(async (url: string) => ({ url }));
  const loader = createChunkLoader({ manifest, telemetry, importer, document: undefined, retry: { attempts: 1 }, ...(options.canLoad === undefined ? {} : { canLoad: options.canLoad }) });
  const timer = manualTimer();
  let facts = options.facts ?? NOMINAL_WARMUP_FACTS;
  const engine = createSpeculationEngine({
    loader,
    rules: options.rules ?? [upgradeCta, exportPdf, shareEager, immediate],
    facts: () => facts,
    timer,
    telemetry,
    intersectionObserver: options.io,
    ...(options.advisor === undefined ? {} : { advisor: options.advisor }),
  });
  return { loader, importer, timer, engine, sink, setFacts: (f: WarmupFacts) => (facts = f) };
}

describe('eagerness model', () => {
  it('maps signals to reactions per eagerness', () => {
    expect(reaction('eager', 'viewport')).toBe('trigger');
    expect(reaction('immediate', 'hover')).toBe('trigger');
    expect(reaction('moderate', 'hover')).toBe('dwell');
    expect(reaction('moderate', 'viewport')).toBe('ignore');
    expect(reaction('moderate', 'focus')).toBe('trigger');
    expect(reaction('moderate', 'prediction')).toBe('trigger');
    expect(reaction('conservative', 'hover')).toBe('ignore');
    expect(reaction('conservative', 'pointerdown')).toBe('trigger');
    expect(reaction('eager', 'leave')).toBe('cancel');
  });

  it('lowers eagerness by steps, past conservative = off', () => {
    expect(lowerEagerness('eager', 1)).toBe('moderate');
    expect(lowerEagerness('moderate', 2)).toBeUndefined();
    expect(lowerEagerness('immediate', 0)).toBe('immediate');
  });

  it('rule defaults', () => {
    expect(upgradeCta).toMatchObject({ kind: 'speculation-rule', eagerness: 'moderate', action: 'preload', dwellMs: 200 });
  });
});

describe('speculation engine', () => {
  it('moderate: hover dwell triggers a preload; leave before dwell cancels', async () => {
    const { engine, timer, loader, importer, sink } = setup();
    expect(engine.signal('billing/upgrade-cta', 'hover')).toBe('dwelling');
    expect(engine.signal('billing/upgrade-cta', 'hover')).toBe('dwelling');
    timer.advance(100);
    expect(engine.signal('billing/upgrade-cta', 'leave')).toBe('cancelled');
    timer.advance(500);
    expect(loader.state('feature:billing')).toBe('idle');
    expect(engine.signal('billing/upgrade-cta', 'leave')).toBe('ignored');
    engine.signal('billing/upgrade-cta', 'hover');
    timer.advance(200);
    await engine.settled();
    expect(loader.state('feature:billing')).toBe('preloaded');
    expect(importer).not.toHaveBeenCalled();
    expect(engine.fired.has('billing/upgrade-cta')).toBe(true);
    expect(engine.signal('billing/upgrade-cta', 'focus')).toBe('done');
    const trigger = sink.records.find((r) => r.type === 'event' && r.name === 'speculation.trigger');
    expect(trigger?.type === 'event' && trigger.attrs).toMatchObject({ rule: 'billing/upgrade-cta', signal: 'hover', eagerness: 'moderate' });
  });

  it('conservative: only pointerdown; action load executes (pre-warms a functional dep)', async () => {
    const { engine, loader, importer } = setup();
    expect(engine.signal('studio/export-pdf', 'hover')).toBe('ignored');
    expect(engine.signal('studio/export-pdf', 'pointerdown')).toBe('triggered');
    await engine.settled();
    expect(importer).toHaveBeenCalledWith('/pdf.js');
    expect(loader.state('lib:pdf')).toBe('loaded');
  });

  it('eager: viewport triggers; advisor reorders candidates within the time box', async () => {
    const advisor: WarmupAdvisor = { id: 'adv', rank: () => ['lib:pdf', 'lib:share'] };
    const { engine, loader } = setup({ advisor });
    const order: string[] = [];
    const preload = loader.preload.bind(loader);
    loader.preload = (id, o) => (order.push(id), preload(id, o));
    expect(engine.signal('studio/share', 'viewport')).toBe('triggered');
    await engine.settled();
    expect(order).toEqual(['lib:pdf', 'lib:share']);
  });

  it('backoff: saveData skips; 3g drops one step (moderate → conservative); low tier + 3g turns moderate off', async () => {
    const saving = setup({ facts: { ...NOMINAL_WARMUP_FACTS, saveData: true } });
    expect(saving.engine.signal('studio/share', 'viewport')).toBe('skipped');
    expect(saving.sink.records.some((r) => r.type === 'metric' && r.metric === 'loader/warmup-skipped')).toBe(true);

    const slow = setup({ facts: { ...NOMINAL_WARMUP_FACTS, effectiveType: '3g' } });
    expect(slow.engine.signal('billing/upgrade-cta', 'hover')).toBe('ignored');
    expect(slow.engine.signal('billing/upgrade-cta', 'pointerdown')).toBe('triggered');
    expect(slow.engine.signal('studio/share', 'viewport')).toBe('ignored');

    const weak = setup({ facts: { ...NOMINAL_WARMUP_FACTS, effectiveType: '3g', deviceTier: 'low' } });
    expect(weak.engine.signal('billing/upgrade-cta', 'pointerdown')).toBe('skipped');
    expect(weak.engine.activate('studio/immediate')).toBe('ignored');
  });

  it('immediate rules fire on activate; activate is a no-op for others; unknown rules reported', async () => {
    const { engine, loader } = setup();
    expect(engine.activate('billing/upgrade-cta')).toBe('ignored');
    expect(engine.activate('studio/immediate')).toBe('triggered');
    await engine.settled();
    expect(loader.state('lib:share')).toBe('preloaded');
    expect(engine.activate('studio/immediate')).toBe('done');
    expect(engine.activate('nope')).toBe('unknown-rule');
    expect(engine.signal('nope', 'hover')).toBe('unknown-rule');
    const saving = setup({ facts: { ...NOMINAL_WARMUP_FACTS, online: false } });
    expect(saving.engine.activate('studio/immediate')).toBe('skipped');
  });

  it('gated chunks are never fetched by speculation (I-8)', async () => {
    const { engine, importer, loader } = setup({ canLoad: (id) => id !== 'lib:pdf' });
    engine.signal('studio/export-pdf', 'pointerdown');
    await engine.settled();
    expect(importer).not.toHaveBeenCalled();
    expect(loader.state('lib:pdf')).toBe('idle');
  });

  it('observe binds DOM intent events and viewport for the scope lifetime', async () => {
    let ioCallback: ((e: readonly { isIntersecting: boolean }[]) => void) | undefined;
    const disconnect = vi.fn();
    const io: IntersectionObserverFactory = (cb) => {
      ioCallback = cb;
      return { observe: vi.fn(), disconnect };
    };
    const { engine, timer, loader } = setup({ io });
    const target = new EventTarget();
    const scope = createScope('test');
    engine.observe(target, 'billing/upgrade-cta', scope);
    target.dispatchEvent(new Event('pointerenter'));
    timer.advance(50);
    target.dispatchEvent(new Event('pointerleave'));
    timer.advance(500);
    expect(loader.state('feature:billing')).toBe('idle');
    target.dispatchEvent(new Event('focusin'));
    await engine.settled();
    expect(loader.state('feature:billing')).toBe('preloaded');

    const scope2 = createScope('test2');
    engine.observe(target, 'studio/share', scope2);
    ioCallback?.([{ isIntersecting: false }]);
    expect(engine.fired.has('studio/share')).toBe(false);
    ioCallback?.([{ isIntersecting: true }]);
    expect(engine.fired.has('studio/share')).toBe(true);

    const scope3 = createScope('test3');
    engine.observe(target, 'studio/export-pdf', scope3);
    await scope3.dispose();
    target.dispatchEvent(new Event('pointerdown'));
    expect(engine.fired.has('studio/export-pdf')).toBe(false);
    await scope.dispose();
    await scope2.dispose();
    expect(disconnect).toHaveBeenCalledTimes(3);

    const scope4 = createScope('test4');
    engine.observe(target, 'studio/export-pdf', scope4);
    target.dispatchEvent(new Event('touchstart'));
    expect(engine.fired.has('studio/export-pdf')).toBe(true);
    await scope4.dispose();
  });

  it('dispose cancels dwell timers and stops work', async () => {
    const { engine, timer, loader } = setup({ io: undefined });
    engine.signal('billing/upgrade-cta', 'hover');
    engine.dispose();
    timer.advance(1_000);
    await engine.settled();
    expect(loader.state('feature:billing')).toBe('idle');
  });
});
