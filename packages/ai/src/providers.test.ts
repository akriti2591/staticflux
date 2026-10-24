import { createInjector, createMachine, defineError, err, ok, type Result, watch } from '@staticflux/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  aiUnits,
  availabilityMachine,
  classify,
  createAiFactsStore,
  createDecisionModelProvider,
  createMockProvider,
  createModelRouter,
  createRemoteLlmProvider,
  type DecisionResult,
  type LlmCompletionRequest,
  mapAiError,
  mockModelProviderUnit,
  ModelProviderToken,
  validateDecision,
} from './index.js';

describe('availability facts', () => {
  it('follow the availability machine and are reactive', () => {
    const facts = createAiFactsStore('p', { generate: 'downloadable' });
    const seen: string[] = [];
    const stop = watch(() => facts.get().generate.state, (state) => seen.push(state));
    expect(facts.of('summarize').state).toBe('unknown');
    expect(facts.send('generate', 'available')).toBe(false); // downloadable → available is not a transition
    expect(facts.send('generate', 'downloading')).toBe(true);
    facts.progress('generate', 0.4);
    expect(facts.of('generate')).toEqual({ state: 'downloading', progress: 0.4 });
    facts.progress('generate', 7);
    expect(facts.of('generate').progress).toBe(1);
    facts.send('generate', 'available');
    expect(facts.of('generate')).toEqual({ state: 'available', progress: undefined });
    facts.progress('generate', 0.5); // ignored outside downloading
    facts.settle('generate', 'unavailable');
    expect(seen).toEqual(['downloading', 'available', 'probing', 'unavailable']);
    stop();
  });

  it('machine rejects undocumented transitions', () => {
    const machine = createMachine(availabilityMachine);
    expect(machine.send('downloading').ok).toBe(false);
    expect(machine.send('probe').ok).toBe(true);
    expect(machine.send('fail').ok).toBe(true);
    expect(machine.state).toBe('unknown');
  });
});

describe('decision validation', () => {
  it('accepts arrays in option order and records keyed by option', () => {
    expect(validateDecision(['a', 'b'] as const, { probabilities: [1, 3] })).toEqual(ok({ probabilities: { a: 0.25, b: 0.75 }, confidence: 0.75 }));
    expect(validateDecision(['a', 'b'] as const, { probabilities: { a: 2, z: 9 }, confidence: 2, explanation: 'e' })).toEqual(
      ok({ probabilities: { a: 1, b: 0 }, confidence: 1, explanation: 'e' }),
    );
  });
  it('rejects wrong length, negatives and zero mass', () => {
    for (const probabilities of [[1], [1, -1], [0, 0], [Number.NaN, 1]]) {
      expect(validateDecision(['a', 'b'], { probabilities })).toMatchObject({ ok: false, error: { code: 'SF-AI-003' } });
    }
  });
  it('classify picks the top option', () => {
    const result: DecisionResult<'a' | 'b'> = { probabilities: { a: 0.2, b: 0.8 }, confidence: 0.8 };
    expect(classify(result, ['a', 'b'])).toBe('b');
    expect(classify({ probabilities: { a: 0, b: 0 }, confidence: 0 }, ['a', 'b'])).toBeUndefined();
  });
  it('maps unknown throwables', () => {
    expect(mapAiError(defineError('SF-X-9', 'network', 'n', 'f')(), 'generate').code).toBe('SF-X-9');
  });
});

describe('decision-model provider (Jev-like)', () => {
  it('sends model, question and options; validates; supports only decide', async () => {
    const transport = { decide: vi.fn(async () => ok({ probabilities: [0.1, 0.9] })) };
    const provider = createDecisionModelProvider({ id: 'jev', model: 'jev-small', transport });
    const result = await provider.decide({ question: { idle: 3 }, options: ['keep', 'evict'] as const });
    expectTypeOf(result).toEqualTypeOf<Result<DecisionResult<'keep' | 'evict'>>>();
    expect(result).toEqual(ok({ probabilities: { keep: 0.1, evict: 0.9 }, confidence: 0.9 }));
    expect(transport.decide).toHaveBeenCalledWith({ model: 'jev-small', question: { idle: 3 }, options: ['keep', 'evict'] }, expect.any(AbortSignal));
    expect(provider.kind).toBe('decision');
    expect(provider.facts.of('decide').state).toBe('available');
    expect(provider.facts.of('generate').state).toBe('unavailable');
    expect(await provider.generate({ prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    expect(await provider.summarize({ text: 'x' })).toMatchObject({ ok: false });
    expect(await provider.translate({ text: 'x', from: 'en', to: 'de' })).toMatchObject({ ok: false });
    expect(await provider.detectLanguage({ text: 'x' })).toMatchObject({ ok: false });
    expect((await provider.prepare('decide')).ok).toBe(true);
    expect((await provider.prepare('generate')).ok).toBe(false);
    expect((await provider.probe()).ok).toBe(true);
  });

  it('passes transport errors and aborts on dispose', async () => {
    let seen: AbortSignal | undefined;
    const Down = defineError('SF-TESTAI-001', 'network', 'down', 'retry');
    const provider = createDecisionModelProvider({
      id: 'jev',
      model: 'm',
      transport: {
        decide: async (_request, signal) => {
          seen = signal;
          return err(Down());
        },
      },
    });
    expect(await provider.decide({ question: 1, options: ['a'] })).toMatchObject({ ok: false, error: { code: 'SF-TESTAI-001' } });
    await provider.dispose();
    expect(seen?.aborted).toBe(true);
  });
});

describe('remote LLM provider', () => {
  function transport(reply: (request: LlmCompletionRequest) => string) {
    const requests: LlmCompletionRequest[] = [];
    return {
      requests,
      complete: vi.fn(async (request: LlmCompletionRequest) => {
        requests.push(request);
        return ok({ text: reply(request) });
      }),
    };
  }

  it('shapes prompts for every task and parses structured replies', async () => {
    const t = transport((request) => {
      if (request.responseSchema === undefined) return `reply:${request.messages.at(-1)?.content ?? ''}`;
      const schema = JSON.stringify(request.responseSchema);
      return schema.includes('candidates')
        ? JSON.stringify({ candidates: [{ language: 'de', confidence: 0.3 }, { language: 'en', confidence: 0.9 }, { bad: 1 }] })
        : JSON.stringify({ probabilities: { a: 1, b: 1 } });
    });
    const provider = createRemoteLlmProvider({ id: 'llm', transport: t, maxTokens: 64 });
    expect(await provider.generate({ prompt: 'p', system: 's' })).toEqual(ok({ text: 'reply:p' }));
    expect(t.requests[0]).toEqual({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'p' }], maxTokens: 64 });
    expect(await provider.summarize({ text: 'long', type: 'headline', context: 'news' })).toEqual(ok({ text: 'reply:long' }));
    expect(t.requests[1]?.messages[0]?.content).toContain('single headline');
    expect(t.requests[1]?.messages[0]?.content).toContain('Context: news');
    expect(await provider.translate({ text: 'hi', from: 'en', to: 'fr' })).toEqual(ok({ text: 'reply:hi' }));
    expect(await provider.detectLanguage({ text: 'x' })).toEqual(
      ok({ candidates: [{ language: 'en', confidence: 0.9 }, { language: 'de', confidence: 0.3 }] }),
    );
    expect(await provider.decide({ question: 'q', options: ['a', 'b'] })).toEqual(ok({ probabilities: { a: 0.5, b: 0.5 }, confidence: 0.5 }));
    expect(provider.facts.of('decide').state).toBe('available');
  });

  it('rejects unparseable structured output and honours the task list', async () => {
    const provider = createRemoteLlmProvider({ id: 'llm', transport: transport(() => 'not json'), tasks: ['decide', 'detect-language'] });
    expect(await provider.decide({ question: 'q', options: ['a'] })).toMatchObject({ ok: false, error: { code: 'SF-AI-005' } });
    expect(await provider.detectLanguage({ text: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-005' } });
    expect(await provider.generate({ prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    expect(await provider.summarize({ text: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    expect(await provider.translate({ text: 'x', from: 'a', to: 'b' })).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    expect(provider.facts.of('generate').state).toBe('unavailable');
    const shapeless = createRemoteLlmProvider({ id: 'llm', transport: transport(() => '{"x":1}') });
    expect(await shapeless.decide({ question: 'q', options: ['a'] })).toMatchObject({ ok: false, error: { code: 'SF-AI-005' } });
    expect(await shapeless.detectLanguage({ text: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-005' } });
  });
});

describe('mock provider', () => {
  it('answers deterministically and records calls', async () => {
    const provider = createMockProvider({ decide: () => ({ yes: 1 }) });
    expect(await provider.generate({ prompt: 'p' })).toEqual(ok({ text: 'mock: p' }));
    expect(await provider.summarize({ text: 'a'.repeat(50) })).toEqual(ok({ text: 'a'.repeat(40) }));
    expect(await provider.translate({ text: 't', from: 'en', to: 'de' })).toEqual(ok({ text: '[de] t' }));
    expect(await provider.detectLanguage({ text: 'x' })).toEqual(ok({ candidates: [{ language: 'en', confidence: 1 }] }));
    expect(await provider.decide({ question: 1, options: ['yes', 'no'] })).toEqual(ok({ probabilities: { yes: 1, no: 0 }, confidence: 1 }));
    expect(provider.calls.map((c) => c.task)).toEqual(['generate', 'summarize', 'translate', 'detect-language', 'decide']);
  });

  it('simulates downloads, unavailability, failures, latency and abort', async () => {
    const provider = createMockProvider({ availability: { summarize: 'downloadable', translate: 'unavailable' }, latencyMs: 5 });
    expect(await provider.summarize({ text: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    const progress: number[] = [];
    expect((await provider.prepare('summarize', { onProgress: (f) => progress.push(f) })).ok).toBe(true);
    expect(progress).toEqual([0.5, 1]);
    expect(provider.facts.of('summarize').state).toBe('available');
    expect((await provider.prepare('summarize')).ok).toBe(true);
    expect((await provider.prepare('translate')).ok).toBe(false);
    const controller = new AbortController();
    const pending = provider.generate({ prompt: 'x', signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    provider.setAvailability('generate', 'unavailable');
    expect(provider.facts.of('generate').state).toBe('unavailable');
    const aborted = new AbortController();
    aborted.abort();
    provider.setAvailability('decide', 'downloadable');
    expect(await provider.prepare('decide', { signal: aborted.signal })).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(provider.facts.of('decide').state).toBe('downloadable');
    const failing = createMockProvider({ failWith: defineError('SF-TESTAI-002', 'network', 'x', 'y')() });
    expect(await failing.generate({ prompt: 'x' })).toMatchObject({ ok: false, error: { code: 'SF-TESTAI-002' } });
  });
});

describe('model router', () => {
  it('routes by availability, falls through on SF-AI-001, merges facts', async () => {
    const builtIn = createMockProvider({ id: 'built-in', availability: { generate: 'downloadable', summarize: 'available' } });
    const remote = createMockProvider({ id: 'remote', generate: () => 'remote!', availability: { summarize: 'unavailable' } });
    const router = createModelRouter({ providers: [builtIn, remote] });
    expect(await router.generate({ prompt: 'x' })).toEqual(ok({ text: 'remote!' }));
    expect(await router.summarize({ text: 'abc' })).toEqual(ok({ text: 'abc' }));
    expect(router.facts.of('generate').state).toBe('available');
    // built-in finishes downloading → preferred again
    const changes = vi.fn();
    const stop = router.facts.subscribe(changes);
    await builtIn.prepare('generate');
    expect(changes).toHaveBeenCalled();
    stop();
    expect(await router.generate({ prompt: 'x' })).toEqual(ok({ text: 'mock: x' }));
    // fall-through when the first candidate reports unavailable at call time
    builtIn.setAvailability('translate', 'unavailable');
    remote.setAvailability('translate', 'unavailable');
    expect(await router.translate({ text: 'x', from: 'a', to: 'b' })).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
    expect(router.kind).toBe('router');
    expect((await router.probe()).ok).toBe(true);
    expect(await router.detectLanguage({ text: 'x' })).toMatchObject({ ok: true });
    expect(await router.decide({ question: 1, options: ['a'] })).toMatchObject({ ok: true });
    await router.dispose();
  });

  it('prepare targets a downloadable provider', async () => {
    const a = createMockProvider({ id: 'a', availability: { generate: 'unavailable' } });
    const b = createMockProvider({ id: 'b', availability: { generate: 'downloadable' } });
    const router = createModelRouter({ providers: [a, b] });
    expect((await router.prepare('generate')).ok).toBe(true);
    expect(b.facts.of('generate').state).toBe('available');
    expect((await router.prepare('generate')).ok).toBe(true);
    a.setAvailability('summarize', 'unavailable');
    b.setAvailability('summarize', 'unavailable');
    expect(await router.prepare('summarize')).toMatchObject({ ok: false, error: { code: 'SF-AI-001' } });
  });
});

describe('ai units', () => {
  it('one-line opt-in + mock provider; browser provider is unavailable in happy-dom', async () => {
    const injector = createInjector({ units: [...aiUnits, mockModelProviderUnit({ generate: () => 'from mock' })] });
    const provider = await injector.get(ModelProviderToken);
    if (!provider.ok) throw provider.error;
    expect(await provider.value.generate({ prompt: 'x' })).toEqual(ok({ text: 'from mock' }));
    expect(provider.value.facts.of('generate').state).toBe('available');
    await injector.dispose();
  });
});
