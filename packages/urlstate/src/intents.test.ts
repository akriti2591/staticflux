import { createMemorySink, createScope, createTelemetry, err, ok, type Result } from '@staticflux/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { defineIntent } from './binding.js';
import { codec } from './codec.js';
import { createMemoryHistory } from './history.js';
import { createIntentService, type HeldIntent, type IntentDelivery, type IntentHoldPort } from './intents.js';
import { defineError } from '@staticflux/core';

const ChatPrompt = defineIntent({
  id: 'agent-chat/prompt',
  owner: 'agent-chat',
  params: { panel: codec.enum(['chat']), prompt: codec.string({ maxLength: 50 }) },
  required: ['panel'],
});
const OpenInspector = defineIntent({ id: 'studio/open-inspector', owner: 'studio', params: { 'open-panel': codec.enum(['inspector']) }, safe: true });

function memoryHold(): IntentHoldPort & { stored: readonly HeldIntent[] | undefined } {
  const port = {
    stored: undefined as readonly HeldIntent[] | undefined,
    async hold(intents: readonly HeldIntent[]): Promise<Result<void>> {
      port.stored = JSON.parse(JSON.stringify(intents)) as HeldIntent[];
      return ok();
    },
    async release(): Promise<Result<readonly HeldIntent[] | undefined>> {
      const out = port.stored;
      port.stored = undefined;
      return ok(out);
    },
  };
  return port;
}

describe('intent service', () => {
  it('captures at resolve, delivers after authorize (prefill), then strips via replace', () => {
    const history = createMemoryHistory('/studio/doc/42?panel=chat&prompt=Summarize+this&tab=comments');
    const service = createIntentService({ history, intents: [ChatPrompt, OpenInspector] });
    const captured = service.capture();
    expect(captured).toEqual([{ id: 'agent-chat/prompt', owner: 'agent-chat', state: 'held', policy: 'prefill-only', keys: ['panel', 'prompt'] }]);
    const deliveries: IntentDelivery<unknown>[] = [];
    service.consume(ChatPrompt, (d) => {
      expectTypeOf(d.params).toEqualTypeOf<{ readonly panel: 'chat' } & { readonly prompt?: string }>();
      deliveries.push(d);
    });
    expect(deliveries).toHaveLength(0); // not before authorize
    service.authorize();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ intent: 'agent-chat/prompt', owner: 'agent-chat', mode: 'prefill', params: { panel: 'chat', prompt: 'Summarize this' } });
    expect(history.url).toBe('/studio/doc/42?tab=comments');
    expect(history.entries).toHaveLength(1); // replace
    expect(service.inspect()[0]?.state).toBe('delivered');
    service.authorize(); // consume-once
    expect(deliveries).toHaveLength(1);
  });

  it('never auto-executes prefill-only intents (I-13, SF-URL-001); safe intents may execute', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const history = createMemoryHistory('/?panel=chat&prompt=delete+everything&open-panel=inspector');
    const service = createIntentService({ history, intents: [ChatPrompt, OpenInspector], telemetry });
    service.capture();
    const action = vi.fn(() => 'ran');
    let blocked: Result<string> | undefined;
    let allowed: Result<string> | undefined;
    service.consume(ChatPrompt, (d) => {
      blocked = d.execute(action);
    });
    service.consume(OpenInspector, (d) => {
      expect(d.mode).toBe('safe');
      allowed = d.execute(action);
    });
    service.authorize();
    expect(blocked !== undefined && !blocked.ok && blocked.error.code).toBe('SF-URL-001');
    expect(allowed).toEqual(ok('ran'));
    expect(action).toHaveBeenCalledTimes(1);
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'urlstate.intent-execute-blocked')).toBe(true);
    // intent text never reaches telemetry
    expect(JSON.stringify(sink.records)).not.toContain('delete everything');
    expect(JSON.stringify(sink.records)).not.toContain('delete+everything');
  });

  it('delivers to a consumer that registers after authorize (lazy chunk), once', () => {
    const history = createMemoryHistory('/?panel=chat');
    const service = createIntentService({ history, intents: [ChatPrompt] });
    service.capture();
    service.authorize('agent-chat');
    expect(history.url).toBe('/');
    const handler = vi.fn();
    const scope = createScope('chat');
    service.consume(ChatPrompt, handler, scope);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ params: { panel: 'chat' } });
    void scope.dispose();
    service.consume(ChatPrompt, handler)();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('authorize(owner) only releases that owner', () => {
    const history = createMemoryHistory('/?panel=chat&open-panel=inspector');
    const service = createIntentService({ history, intents: [ChatPrompt, OpenInspector] });
    service.capture();
    service.authorize('studio');
    expect(history.url).toBe('/?panel=chat');
    expect(service.inspect().map((i) => `${i.id}:${i.state}`)).toEqual(['agent-chat/prompt:held', 'studio/open-inspector:authorized']);
  });

  it('rejects invalid required params, drops invalid optional params, ignores absent intents', () => {
    const history = createMemoryHistory('/');
    const service = createIntentService({ history, intents: [ChatPrompt] });
    expect(service.capture('/?prompt=hi')).toEqual([]); // required panel absent
    expect(service.capture('/?panel=nope')).toEqual([]);
    expect(service.inspect()).toEqual([{ id: 'agent-chat/prompt', owner: 'agent-chat', state: 'rejected', policy: 'prefill-only', keys: ['panel'] }]);
    const captured = service.capture(`/?panel=chat&prompt=${'x'.repeat(60)}`);
    expect(captured[0]?.keys).toEqual(['panel']);
  });

  it('a newer capture replaces the held one; discard() drops held intents', () => {
    const history = createMemoryHistory('/');
    const service = createIntentService({ history, intents: [ChatPrompt] });
    service.capture('/?panel=chat&prompt=one');
    service.capture('/?panel=chat&prompt=two');
    expect(service.inspect().map((i) => i.state)).toEqual(['discarded', 'held']);
    service.discard('agent-chat/prompt');
    const handler = vi.fn();
    service.consume(ChatPrompt, handler);
    service.authorize();
    expect(handler).not.toHaveBeenCalled();
    service.capture('/?panel=chat');
    service.discard();
    expect(service.inspect().every((i) => i.state === 'discarded')).toBe(true);
  });

  it('survives a login redirect through the hold port, re-validating on restore', async () => {
    const hold = memoryHold();
    const before = createIntentService({ history: createMemoryHistory('/studio?panel=chat&prompt=hello&tab=comments'), intents: [ChatPrompt], hold });
    before.capture();
    expect(before.strip('/studio?panel=chat&prompt=hello&tab=comments')).toBe('/studio?tab=comments'); // login returnTo
    expect(await before.persist()).toEqual(ok(1));
    expect(hold.stored).toEqual([{ id: 'agent-chat/prompt', params: { panel: 'chat', prompt: 'hello' }, capturedAt: expect.any(Number) }]);

    // after the redirect: a fresh page, URL without the intent
    const history = createMemoryHistory('/studio?tab=comments');
    const after = createIntentService({ history, intents: [ChatPrompt], hold });
    expect(await after.restore()).toEqual(ok(1));
    const handler = vi.fn();
    after.consume(ChatPrompt, handler);
    after.authorize();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ mode: 'prefill', params: { panel: 'chat', prompt: 'hello' } });
    expect(history.entries).toHaveLength(1); // nothing to strip

    // tampered storage is re-validated
    hold.stored = [
      { id: 'agent-chat/prompt', params: { panel: 'evil' }, capturedAt: 0 },
      { id: 'unknown/intent', params: {}, capturedAt: 0 },
    ];
    const tampered = createIntentService({ history: createMemoryHistory('/'), intents: [ChatPrompt], hold });
    expect(await tampered.restore()).toEqual(ok(0));
  });

  it('persist/restore without a port or intents are no-ops; port failures propagate', async () => {
    const service = createIntentService({ history: createMemoryHistory('/?panel=chat'), intents: [ChatPrompt] });
    service.capture();
    expect(await service.persist()).toEqual(ok(0));
    expect(await service.restore()).toEqual(ok(0));
    const Down = defineError('SF-TEST-URL1', 'unavailable', 'down', 'retry');
    const failing: IntentHoldPort = { hold: async () => err(Down()), release: async () => err(Down()) };
    const withPort = createIntentService({ history: createMemoryHistory('/?panel=chat'), intents: [ChatPrompt], hold: failing });
    expect(await withPort.persist()).toEqual(ok(0)); // nothing held yet
    withPort.capture();
    expect((await withPort.persist()).ok).toBe(false);
    expect((await withPort.restore()).ok).toBe(false);
  });

  it('emits lifecycle transitions', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const service = createIntentService({ history: createMemoryHistory('/?panel=chat'), intents: [ChatPrompt], telemetry });
    service.capture();
    service.consume(ChatPrompt, () => undefined);
    service.authorize();
    const names = sink.records.flatMap((r) => (r.type === 'event' ? [r.name] : []));
    expect(names).toEqual(expect.arrayContaining(['lifecycle.urlstate/intent.captured→held', 'lifecycle.urlstate/intent.held→authorized', 'lifecycle.urlstate/intent.authorized→delivered']));
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'urlstate/intent-delivered')).toBe(true);
  });
});
