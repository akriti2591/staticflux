import { createMemorySink, createTelemetry } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type AiAvailability,
  type BuiltInAiGlobals,
  type CreateMonitorLike,
  createBrowserAiProvider,
  detectBuiltInAi,
  type DownloadProgressEventLike,
} from './index.js';

interface FakeApiOptions {
  availability: AiAvailability;
  createError?: Error;
  progress?: readonly number[];
}

function fakeApi<I extends { destroy(): void }>(options: FakeApiOptions, instance: () => I) {
  const state = { availability: options.availability };
  const created: unknown[] = [];
  const destroyed = { count: 0 };
  const api = {
    state,
    created,
    destroyed,
    availability: vi.fn(async () => state.availability),
    create: vi.fn(async (createOptions?: { monitor?: (m: CreateMonitorLike) => void; signal?: AbortSignal }) => {
      created.push(createOptions);
      if (options.createError !== undefined) throw options.createError;
      if (createOptions?.monitor !== undefined) {
        const target = new EventTarget();
        createOptions.monitor(target as unknown as CreateMonitorLike);
        for (const loaded of options.progress ?? []) {
          const event = Object.assign(new Event('downloadprogress'), { loaded, total: 1 }) as DownloadProgressEventLike;
          target.dispatchEvent(event);
        }
      }
      state.availability = 'available';
      const value = instance();
      const original = value.destroy.bind(value);
      value.destroy = () => {
        destroyed.count += 1;
        original();
      };
      return value;
    }),
  };
  return api;
}

function fakeGlobals(overrides: Partial<Record<'lm' | 'sum' | 'tr' | 'det', FakeApiOptions>> = {}) {
  const prompts: { input: string; options: unknown }[] = [];
  const lm = fakeApi(overrides.lm ?? { availability: 'available' }, () => ({
    prompt: vi.fn(async (input: string, options?: { responseConstraint?: unknown }) => {
      prompts.push({ input, options });
      return options?.responseConstraint === undefined
        ? `echo:${input}`
        : JSON.stringify({ probabilities: { yes: 3, no: 1 }, explanation: 'mostly yes' });
    }),
    destroy: () => undefined,
  }));
  const sum = fakeApi(overrides.sum ?? { availability: 'available' }, () => ({
    summarize: vi.fn(async (text: string) => `summary:${text.length}`),
    destroy: () => undefined,
  }));
  const tr = fakeApi(overrides.tr ?? { availability: 'available' }, () => ({
    translate: vi.fn(async (text: string) => `hola:${text}`),
    destroy: () => undefined,
  }));
  const det = fakeApi(overrides.det ?? { availability: 'available' }, () => ({
    detect: vi.fn(async () => [
      { detectedLanguage: 'fr', confidence: 0.2 },
      { detectedLanguage: 'en', confidence: 0.8 },
    ]),
    destroy: () => undefined,
  }));
  const globals = { LanguageModel: lm, Summarizer: sum, Translator: tr, LanguageDetector: det } as unknown as BuiltInAiGlobals;
  return { globals, lm, sum, tr, det, prompts };
}

describe('browser built-in AI: detection', () => {
  it('feature-detects current globals, the legacy namespace, and absence (Safari/Firefox)', async () => {
    const { globals } = fakeGlobals();
    expect(detectBuiltInAi(globals)).toEqual({ generate: true, decide: true, summarize: true, translate: true, 'detect-language': true });
    expect(detectBuiltInAi({})).toEqual({ generate: false, decide: false, summarize: false, translate: false, 'detect-language': false });
    expect(detectBuiltInAi({ LanguageModel: { create: async () => ({}) } } as unknown as BuiltInAiGlobals).generate).toBe(false);

    const legacy = {
      ai: {
        summarizer: {
          capabilities: async () => ({ available: 'after-download' }),
          create: async () => ({ summarize: async () => 's', destroy: () => undefined }),
        },
      },
    } as unknown as BuiltInAiGlobals;
    expect(detectBuiltInAi(legacy).summarize).toBe(true);
    const provider = createBrowserAiProvider({ globals: legacy });
    expect(provider.facts.of('generate').state).toBe('unavailable');
    await provider.probe();
    expect(provider.facts.of('summarize').state).toBe('downloadable');
  });

  it('probes availability into reactive facts (translate needs a probe pair)', async () => {
    const { globals, tr } = fakeGlobals({ sum: { availability: 'downloadable' }, det: { availability: 'unavailable' } });
    const provider = createBrowserAiProvider({ globals });
    const seen: string[] = [];
    provider.facts.subscribe((facts) => seen.push(facts.summarize.state));
    expect(provider.facts.of('summarize').state).toBe('unknown');
    await provider.probe();
    expect(provider.facts.get()).toMatchObject({
      generate: { state: 'available' },
      decide: { state: 'available' },
      summarize: { state: 'downloadable' },
      'detect-language': { state: 'unavailable' },
      translate: { state: 'unknown' },
    });
    expect(seen).toContain('probing');
    expect(tr.availability).not.toHaveBeenCalled();

    const paired = createBrowserAiProvider({ globals, probeLanguages: { from: 'en', to: 'es' } });
    await paired.probe();
    expect(tr.availability).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'es' });
    expect(paired.facts.of('translate').state).toBe('available');
  });

  it('a throwing probe resets the fact to unknown', async () => {
    const { globals, lm } = fakeGlobals();
    lm.availability.mockRejectedValueOnce(new Error('flaky'));
    const provider = createBrowserAiProvider({ globals });
    await provider.probe();
    expect(provider.facts.of('generate').state).toBe('unknown');
  });
});

describe('browser built-in AI: requests', () => {
  it('generates with a per-call session (system prompt) and destroys it', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const { globals, lm } = fakeGlobals();
    const provider = createBrowserAiProvider({ globals, telemetry });
    expect(await provider.generate({ prompt: 'hi', system: 'be brief' })).toEqual({ ok: true, value: { text: 'echo:hi' } });
    expect(lm.created[0]).toMatchObject({ initialPrompts: [{ role: 'system', content: 'be brief' }] });
    expect(lm.destroyed.count).toBe(1);
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'ai.generate' && r.status === 'ok')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'ai/requests')).toBe(true);
  });

  it('summarizes, translates and detects with cached instances', async () => {
    const { globals, sum, tr, det } = fakeGlobals();
    const provider = createBrowserAiProvider({ globals });
    expect(await provider.summarize({ text: 'abcd', type: 'tldr' })).toEqual({ ok: true, value: { text: 'summary:4' } });
    await provider.summarize({ text: 'abcdef', type: 'tldr' });
    expect(sum.create).toHaveBeenCalledTimes(1);
    expect(sum.created[0]).toMatchObject({ type: 'tldr', format: 'plain-text', length: 'medium' });
    expect(await provider.translate({ text: 'hi', from: 'en', to: 'es' })).toEqual({ ok: true, value: { text: 'hola:hi' } });
    expect(tr.availability).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'es' });
    expect(await provider.detectLanguage({ text: 'hello' })).toEqual({
      ok: true,
      value: { candidates: [{ language: 'en', confidence: 0.8 }, { language: 'fr', confidence: 0.2 }] },
    });
    expect(det.create).toHaveBeenCalledTimes(1);
    await provider.dispose();
    expect(sum.destroyed.count + tr.destroyed.count + det.destroyed.count).toBe(3);
  });

  it('decides with a JSON response constraint over the closed options', async () => {
    const { globals, prompts } = fakeGlobals();
    const provider = createBrowserAiProvider({ globals });
    const result = await provider.decide({ question: { text: 'is it?' }, options: ['yes', 'no'] as const });
    expect(result).toEqual({ ok: true, value: { probabilities: { yes: 0.75, no: 0.25 }, confidence: 0.75, explanation: 'mostly yes' } });
    expect(prompts[0]?.options).toMatchObject({
      responseConstraint: { properties: { probabilities: { required: ['yes', 'no'] } } },
    });
  });

  it('never downloads implicitly: downloadable → SF-AI-001 with a prepare hint; unsupported → SF-AI-001', async () => {
    const { globals, sum } = fakeGlobals({ sum: { availability: 'downloadable' } });
    const provider = createBrowserAiProvider({ globals });
    const result = await provider.summarize({ text: 'x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'SF-AI-001', details: { state: 'downloadable' } } });
    expect(sum.create).not.toHaveBeenCalled();
    expect(provider.facts.of('summarize').state).toBe('downloadable');
    const none = createBrowserAiProvider({ globals: {} });
    expect(await none.generate({ prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    expect(await none.prepare('generate')).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
  });

  it('maps thrown DOMExceptions', async () => {
    const { globals, lm } = fakeGlobals();
    const provider = createBrowserAiProvider({ globals });
    lm.create.mockRejectedValueOnce(new DOMException('gone', 'NotSupportedError'));
    expect(await provider.generate({ prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    lm.create.mockRejectedValueOnce(new DOMException('stop', 'AbortError'));
    expect(await provider.generate({ prompt: 'x' })).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    lm.create.mockRejectedValueOnce(new Error('weird'));
    expect(await provider.generate({ prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-004' } });
  });
});

describe('browser built-in AI: prepare (model download)', () => {
  it('downloads with progress facts, then becomes available', async () => {
    const { globals, lm } = fakeGlobals({ lm: { availability: 'downloadable', progress: [0.25, 1] } });
    const provider = createBrowserAiProvider({ globals });
    await provider.probe();
    const progress: number[] = [];
    const states: string[] = [];
    provider.facts.subscribe((facts) => states.push(`${facts.generate.state}:${facts.generate.progress ?? '-'}`));
    expect(await provider.prepare('generate', { onProgress: (f) => progress.push(f) })).toEqual({ ok: true, value: undefined });
    expect(progress).toEqual([0.25, 1]);
    expect(states).toContain('downloading:0.25');
    expect(provider.facts.get()).toMatchObject({ generate: { state: 'available' }, decide: { state: 'available' } });
    expect(lm.destroyed.count).toBe(1);
  });

  it('needs user activation (NotAllowedError → SF-AI-002) and returns to downloadable', async () => {
    const { globals } = fakeGlobals({ sum: { availability: 'downloadable', createError: new DOMException('gesture', 'NotAllowedError') } });
    const provider = createBrowserAiProvider({ globals });
    expect(await provider.prepare('summarize')).toMatchObject({ ok: false, error: { code: 'SF-AI-002' } });
    expect(provider.facts.of('summarize').state).toBe('downloadable');
  });

  it('translate prepare needs languages and caches the translator; unavailable is reported', async () => {
    const { globals, tr } = fakeGlobals({ tr: { availability: 'downloadable' }, det: { availability: 'unavailable' } });
    const provider = createBrowserAiProvider({ globals });
    expect(await provider.prepare('translate')).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    expect((await provider.prepare('translate', { languages: { from: 'en', to: 'de' } })).ok).toBe(true);
    await provider.translate({ text: 'x', from: 'en', to: 'de' });
    expect(tr.create).toHaveBeenCalledTimes(1);
    expect(await provider.prepare('detect-language')).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    expect(provider.facts.of('detect-language').state).toBe('unavailable');
    expect(await provider.prepare('generate')).toEqual({ ok: true, value: undefined });
  });
});
