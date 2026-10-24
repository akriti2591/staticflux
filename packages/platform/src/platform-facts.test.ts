import { createMemorySink, createScope, createTelemetry, effect } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import { createFakePlatformEnv, createPlatformFacts, listenMedia, shallowEqual } from './index.js';

describe('createPlatformFacts', () => {
  it('starts from a full snapshot', () => {
    const scope = createScope('t');
    const facts = createPlatformFacts({ env: createFakePlatformEnv({ width: 390, height: 844 }), scope });
    expect(facts.state).toBe('listening');
    expect(facts.display.width).toBe(390);
    expect(facts.current.display).toEqual(facts.snapshot().display);
    expect(facts.aiProbeState).toBe('idle');
  });

  it('updates reactively and fine-grained per group', () => {
    const scope = createScope('t');
    const env = createFakePlatformEnv({ connection: { effectiveType: '4g' } });
    const facts = createPlatformFacts({ env, scope });
    const prefRuns = vi.fn();
    const netRuns = vi.fn();
    effect(() => prefRuns(facts.preferences.reducedMotion), scope);
    effect(() => netRuns(facts.network.quality), scope);
    expect(prefRuns).toHaveBeenCalledTimes(1);

    env.setMedia('(prefers-reduced-motion: reduce)', true);
    expect(facts.preferences.reducedMotion).toBe(true);
    expect(prefRuns).toHaveBeenLastCalledWith(true);
    expect(netRuns).toHaveBeenCalledTimes(1); // network untouched

    env.setConnection({ effectiveType: '2g' });
    expect(netRuns).toHaveBeenLastCalledWith('slow');
    env.setOnline(false);
    expect(facts.network.quality).toBe('offline');
    env.setOnline(true);
    expect(facts.network.online).toBe(true);
    expect(prefRuns).toHaveBeenCalledTimes(2);
  });

  it('resize updates display and device class; equal values do not notify', () => {
    const scope = createScope('t');
    const env = createFakePlatformEnv({ width: 1280, height: 800, media: ['(pointer: coarse)'], navigator: { maxTouchPoints: 5 } });
    const facts = createPlatformFacts({ env, scope });
    expect(facts.device.class).toBe('tablet');
    const runs = vi.fn();
    effect(() => runs(facts.display), scope);
    env.resize(1280, 800);
    expect(runs).toHaveBeenCalledTimes(1);
    env.resize(390, 844);
    expect(facts.display.orientation).toBe('portrait');
    expect(facts.device.class).toBe('mobile');
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it('onChange reports groups; refresh re-reads everything', () => {
    const scope = createScope('t');
    const env = createFakePlatformEnv();
    const facts = createPlatformFacts({ env, scope });
    const seen: string[] = [];
    const off = facts.onChange((group) => seen.push(group));
    env.setMedia('(prefers-color-scheme: dark)', true);
    expect(seen).toEqual(['preferences']);
    env.setGlobal('SharedWorker', class {});
    facts.refresh();
    expect(facts.capabilities.sharedWorker).toBe(true);
    expect(seen).toEqual(['preferences', 'capabilities']);
    off();
    env.setMedia('(prefers-color-scheme: dark)', false);
    expect(seen).toHaveLength(2);
  });

  it('emits telemetry for changes', () => {
    const scope = createScope('t');
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const env = createFakePlatformEnv();
    createPlatformFacts({ env, scope, telemetry });
    env.setMedia('(forced-colors: active)', true);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'platform.facts-changed')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'platform/fact-changes')).toBe(true);
  });

  it('removes every listener when the scope is disposed', async () => {
    const scope = createScope('t');
    const env = createFakePlatformEnv({ connection: { effectiveType: '4g' } });
    const facts = createPlatformFacts({ env, scope });
    expect(env.listenerCount()).toBeGreaterThan(10);
    await scope.dispose();
    expect(env.listenerCount()).toBe(0);
    expect(facts.state).toBe('disposed');
    expect(facts.aiProbeState).toBe('disposed');
  });

  it('supports legacy media listeners (Safari < 14) and no matchMedia at all', async () => {
    const scope = createScope('t');
    const env = createFakePlatformEnv({ legacyMediaListeners: true });
    const facts = createPlatformFacts({ env, scope });
    env.setMedia('(prefers-reduced-motion: reduce)', true);
    expect(facts.preferences.reducedMotion).toBe(true);
    await scope.dispose();
    expect(env.listenerCount()).toBe(0);
    const bare = createPlatformFacts({ env: createFakePlatformEnv({ noMatchMedia: true }), scope: createScope('b') });
    expect(bare.preferences.colorScheme).toBe('light');
    // A media list without any listener API is ignored.
    listenMedia({ matches: false }, () => undefined, createScope('x'));
  });

  it('tolerates matchMedia throwing on unsupported query syntax', () => {
    const env = createFakePlatformEnv();
    const throwing = {
      ...env,
      matchMedia: () => {
        throw new SyntaxError('bad');
      },
    };
    expect(() => createPlatformFacts({ env: throwing, scope: createScope('t') })).not.toThrow();
  });

  it('works without window/navigator (worker-like)', () => {
    const facts = createPlatformFacts({ env: { window: undefined, navigator: undefined, matchMedia: undefined, globals: {} }, scope: createScope('t') });
    expect(facts.network.online).toBe(true);
    expect(facts.capabilities.popups).toBe(false);
  });

  it('ignores updates after disposal', async () => {
    const scope = createScope('t');
    const env = createFakePlatformEnv();
    const facts = createPlatformFacts({ env, scope });
    await scope.dispose();
    facts.refresh();
    expect(facts.preferences.colorScheme).toBe('light');
  });

  it('shallowEqual', () => {
    const a = { x: 1 };
    expect(shallowEqual(a, a)).toBe(true);
    expect(shallowEqual({ x: 1 }, { x: 1 })).toBe(true);
    expect(shallowEqual({ x: 1 }, { x: 2 })).toBe(false);
    expect(shallowEqual({ x: 1 } as object, { x: 1, y: 2 })).toBe(false);
  });
});

describe('AI availability probe', () => {
  it('probes present APIs and updates facts', async () => {
    const scope = createScope('t');
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const env = createFakePlatformEnv({
      globals: {
        LanguageModel: { availability: () => Promise.resolve('downloadable') },
        Summarizer: { availability: () => Promise.resolve('available') },
        Writer: { availability: () => Promise.reject(new Error('needs options')) },
        Rewriter: {},
        Translator: { availability: () => Promise.resolve('weird') },
      },
    });
    const facts = createPlatformFacts({ env, scope, telemetry });
    expect(facts.ai.languageModel).toBe('unknown');
    const result = await facts.probeAi();
    expect(result.ok).toBe(true);
    expect(facts.ai).toEqual({
      languageModel: 'downloadable',
      summarizer: 'available',
      writer: 'unknown',
      rewriter: 'unknown',
      translator: 'unknown',
      languageDetector: 'unavailable',
    });
    expect(facts.aiProbeState).toBe('settled');
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'platform.ai-probe' && r.status === 'ok')).toBe(true);
    // re-probe allowed after settle
    expect((await facts.probeAi()).ok).toBe(true);
  });

  it('times out slow availability() calls', async () => {
    vi.useFakeTimers();
    try {
      const env = createFakePlatformEnv({ globals: { LanguageModel: { availability: () => new Promise(() => undefined) } } });
      const facts = createPlatformFacts({ env, scope: createScope('t'), aiProbeTimeoutMs: 50 });
      const pending = facts.probeAi();
      await vi.advanceTimersByTimeAsync(60);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(facts.ai.languageModel).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborted probe fails with SF-PLAT-003; probing twice concurrently is rejected', async () => {
    const env = createFakePlatformEnv({ globals: { LanguageModel: { availability: () => Promise.resolve('available') } } });
    const facts = createPlatformFacts({ env, scope: createScope('t') });
    const controller = new AbortController();
    controller.abort();
    const aborted = await facts.probeAi(controller.signal);
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.error.code).toBe('SF-PLAT-003');
    expect(facts.aiProbeState).toBe('failed');
    const first = facts.probeAi();
    const second = await facts.probeAi();
    expect(second.ok).toBe(false);
    expect((await first).ok).toBe(true);
  });

  it('probeAiOnStart runs the probe immediately; disposed source cannot probe', async () => {
    const scope = createScope('t');
    const env = createFakePlatformEnv({ globals: { Summarizer: { availability: () => Promise.resolve('available') } } });
    const facts = createPlatformFacts({ env, scope, probeAiOnStart: true });
    expect(facts.aiProbeState).toBe('probing');
    await vi.waitFor(() => expect(facts.ai.summarizer).toBe('available'));
    await scope.dispose();
    expect((await facts.probeAi()).ok).toBe(false);
  });

  it('a throwing global getter counts as unavailable', async () => {
    const globals = Object.defineProperty({}, 'LanguageModel', {
      enumerable: true,
      get() {
        throw new Error('blocked');
      },
    });
    const env = { ...createFakePlatformEnv(), globals };
    const facts = createPlatformFacts({ env, scope: createScope('t') });
    await facts.probeAi();
    expect(facts.ai.languageModel).toBe('unavailable');
  });
});
