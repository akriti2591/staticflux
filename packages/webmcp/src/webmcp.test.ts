import {
  type CapabilityConfirmPort,
  CapabilityConfirmPortToken,
  CapabilityDecidePortToken,
  CapabilityRegistryToken,
  capabilityUnits,
  createCapabilityRegistry,
  allowAllDecidePort,
  alwaysActivePort,
  decidePort,
  defineCapability,
  failClosedConfirmPort,
  implementCapability,
  s,
  unmeteredPort,
} from '@staticflux/capabilities';
import { createInjector, createMachine, createMemorySink, createScope, createTelemetry, ok, unit } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  adapterFor,
  createWebMcpPublisher,
  defaultToolName,
  detectModelContext,
  ModelContextAdapterToken,
  publisherMachine,
  toToolResult,
  type WebMcpToolDescriptor,
  webMcpConfirmPort,
  WebMcpPublisherToken,
  webMcpUnits,
} from './index.js';

const InsertImage = defineCapability({
  id: 'agent/insert-image',
  title: 'Insert image',
  description: 'Insert an image block.',
  input: s.object({ src: s.string({ format: 'uri' }) }),
  output: s.object({ blockId: s.string() }),
  requiresConfirmation: false,
  destructive: false,
});
const DeleteDoc = defineCapability({
  id: 'studio/delete-doc',
  description: 'Delete the open document.',
  input: s.object({ id: s.string() }),
  output: s.object({ deleted: s.boolean() }),
  requiresConfirmation: false,
  destructive: true,
});
const Internal = defineCapability({
  id: 'studio/internal',
  description: 'Not for agents.',
  input: s.object({}),
  output: s.object({}),
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: false,
});

/** Fake `navigator.modelContext` in the registerTool/unregisterTool style. */
function fakeRegisterToolContext(handles = true) {
  const tools = new Map<string, WebMcpToolDescriptor>();
  return {
    tools,
    registerTool: vi.fn((tool: WebMcpToolDescriptor) => {
      if (tools.has(tool.name)) throw new DOMException('duplicate', 'InvalidStateError');
      tools.set(tool.name, tool);
      return handles ? { unregister: () => tools.delete(tool.name) } : undefined;
    }),
    unregisterTool: vi.fn((name: string) => tools.delete(name)),
  };
}

/** Fake document-scoped context in the provideContext (replace-all) style. */
function fakeProvideContext() {
  const state = { tools: [] as readonly WebMcpToolDescriptor[], cleared: 0 };
  return {
    state,
    provideContext: vi.fn((context: { tools: readonly WebMcpToolDescriptor[] }) => {
      state.tools = context.tools;
    }),
    clearContext: vi.fn(() => {
      state.tools = [];
      state.cleared += 1;
    }),
  };
}

function setupRegistry(options: { confirm?: CapabilityConfirmPort; telemetry?: ReturnType<typeof createTelemetry> } = {}) {
  const decide = vi.fn(allowAllDecidePort.decide);
  const registry = createCapabilityRegistry({
    decide: { decide },
    confirm: options.confirm ?? failClosedConfirmPort,
    meter: unmeteredPort,
    activation: alwaysActivePort,
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    implementations: [
      implementCapability(InsertImage, (input) => ok({ blockId: `b:${input.src}` })),
      implementCapability(DeleteDoc, () => ok({ deleted: true })),
      implementCapability(Internal, () => ok({})),
    ],
  });
  return { registry, decide };
}

describe('model context detection', () => {
  it('detects navigator- and document-scoped contexts in preference order', () => {
    const nav = { modelContext: fakeRegisterToolContext() };
    const doc = { modelContext: fakeProvideContext() };
    expect(detectModelContext({ navigator: nav, document: doc })).toMatchObject({ kind: 'navigator', style: 'register-tool', supported: true });
    expect(detectModelContext({ navigator: nav, document: doc, prefer: ['document', 'navigator'] })).toMatchObject({
      kind: 'document',
      style: 'provide-context',
    });
    expect(detectModelContext({ navigator: {}, document: doc })).toMatchObject({ kind: 'document' });
    const none = detectModelContext({ navigator: { modelContext: { somethingElse: 1 } }, document: undefined });
    expect(none).toMatchObject({ kind: 'none', supported: false });
    expect(none.registerTool({} as WebMcpToolDescriptor)).toMatchObject({ ok: false, error: { code: 'SF-MCP-001' } });
    // happy-dom has no WebMCP
    expect(detectModelContext().supported).toBe(false);
  });

  it('registerTool style: handle.unregister or unregisterTool(name); duplicates rejected', () => {
    const withHandle = fakeRegisterToolContext(true);
    const adapter = adapterFor('navigator', withHandle);
    const tool = { name: 't', description: 'd', inputSchema: {}, execute: async () => ({ content: [] }) };
    const registered = adapter.registerTool(tool);
    expect(registered.ok).toBe(true);
    expect(adapter.registerTool(tool)).toMatchObject({ ok: false, error: { code: 'SF-MCP-002' } });
    if (registered.ok) registered.value();
    expect(withHandle.tools.size).toBe(0);
    expect(withHandle.unregisterTool).not.toHaveBeenCalled();

    const byName = fakeRegisterToolContext(false);
    const second = adapterFor('navigator', byName).registerTool(tool);
    if (second.ok) {
      second.value();
      second.value(); // idempotent
    }
    expect(byName.unregisterTool).toHaveBeenCalledTimes(1);
  });

  it('provideContext style keeps the full tool set and clears when empty', () => {
    const context = fakeProvideContext();
    const adapter = adapterFor('document', context);
    const make = (name: string) => ({ name, description: 'd', inputSchema: {}, execute: async () => ({ content: [] }) });
    const a = adapter.registerTool(make('a'));
    const b = adapter.registerTool(make('b'));
    expect(context.state.tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(adapter.registerTool(make('a'))).toMatchObject({ ok: false, error: { code: 'SF-MCP-002' } });
    if (a.ok) a.value();
    expect(context.state.tools.map((t) => t.name)).toEqual(['b']);
    if (b.ok) b.value();
    expect(context.state.cleared).toBe(1);
  });
});

describe('publisher', () => {
  it('publishes agent-exposed capabilities with JSON Schema and annotations', () => {
    const { registry } = setupRegistry();
    const context = fakeRegisterToolContext();
    const publisher = createWebMcpPublisher({ registry, adapter: adapterFor('navigator', context) });
    expect(publisher.state).toBe('idle');
    publisher.start();
    expect(publisher.state).toBe('publishing');
    expect(publisher.tools()).toEqual([
      { name: 'agent.insert-image', capability: 'agent/insert-image' },
      { name: 'studio.delete-doc', capability: 'studio/delete-doc' },
    ]);
    const tool = context.tools.get('agent.insert-image');
    expect(tool).toMatchObject({
      description: 'Insert an image block.',
      inputSchema: { type: 'object', properties: { src: { type: 'string', format: 'uri' } }, required: ['src'], additionalProperties: false },
      outputSchema: { type: 'object', required: ['blockId'] },
      annotations: { title: 'Insert image', destructiveHint: false },
    });
    expect(context.tools.get('studio.delete-doc')?.annotations?.destructiveHint).toBe(true);
    publisher.start(); // idempotent
    expect(context.registerTool).toHaveBeenCalledTimes(2);
  });

  it('tool calls run the capability pipeline as subject "agent" (validation, gating, confirmation)', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const { registry, decide } = setupRegistry({ telemetry });
    const context = fakeRegisterToolContext();
    createWebMcpPublisher({ registry, adapter: adapterFor('navigator', context), telemetry }).start();
    const insert = context.tools.get('agent.insert-image');
    const client = {};
    expect(await insert?.execute({ src: 'https://a.test/x.png' }, client)).toEqual({
      content: [{ type: 'text', text: '{"blockId":"b:https://a.test/x.png"}' }],
      structuredContent: { blockId: 'b:https://a.test/x.png' },
    });
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'agent', origin: { channel: 'webmcp', details: { tool: 'agent.insert-image', client } } }),
    );
    const invalid = await insert?.execute({ src: 3 });
    expect(invalid?.isError).toBe(true);
    expect(JSON.parse(invalid?.content[0]?.text ?? '{}')).toMatchObject({ error: { code: 'SF-CAP-002', kind: 'validation' } });
    // destructive + agent → confirmation; the default confirm port fails closed
    const deleted = await context.tools.get('studio.delete-doc')?.execute({ id: '1' });
    expect(JSON.parse(deleted?.content[0]?.text ?? '{}')).toMatchObject({ error: { code: 'SF-CAP-005' } });
    const spans = sink.records.filter((r) => r.type === 'span').map((r) => (r.type === 'span' ? r.name : ''));
    expect(spans).toEqual(expect.arrayContaining(['webmcp.tool-call', 'capability.invoke']));
    const invokeSpan = sink.records.find((r) => r.type === 'span' && r.name === 'capability.invoke');
    const toolSpan = sink.records.find((r) => r.type === 'span' && r.name === 'webmcp.tool-call');
    if (invokeSpan?.type === 'span' && toolSpan?.type === 'span') expect(invokeSpan.parentSpanId).toBe(toolSpan.context.spanId);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'webmcp/tool-calls')).toBe(true);
  });

  it('follows the registry: feature-scoped declarations register and unregister tools', async () => {
    const { registry } = setupRegistry();
    const context = fakeRegisterToolContext();
    createWebMcpPublisher({ registry, adapter: adapterFor('navigator', context) }).start();
    const Summarize = defineCapability({
      id: 'studio/summarize',
      description: 'Summarize.',
      input: s.object({}),
      output: s.object({ text: s.string() }),
      requiresConfirmation: false,
      destructive: false,
    });
    const feature = createScope('studio');
    registry.provide(implementCapability(Summarize, () => ok({ text: 'sum' })), { scope: feature });
    expect(context.tools.has('studio.summarize')).toBe(true);
    await feature.dispose();
    expect(context.tools.has('studio.summarize')).toBe(false);
  });

  it('filter, custom names, unsupported adapters and registration failures', () => {
    const { registry } = setupRegistry();
    const context = fakeRegisterToolContext();
    context.tools.set('x-studio/delete-doc', {} as WebMcpToolDescriptor); // pre-existing → duplicate
    const onError = vi.fn();
    const publisher = createWebMcpPublisher({
      registry,
      adapter: adapterFor('navigator', context),
      toolName: (c) => `x-${c.id}`,
      filter: (c) => c.id.startsWith('studio/'),
      onError,
    });
    publisher.start();
    expect(publisher.tools()).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'SF-MCP-002' }), DeleteDoc);

    const unsupported = createWebMcpPublisher({ registry, adapter: detectModelContext({ navigator: undefined, document: undefined }) });
    unsupported.start();
    expect(unsupported.state).toBe('unsupported');
    expect(defaultToolName(defineCapability({ ...Internal, id: 'a b/c$d' }))).toBe('a_b.c_d');
  });

  it('dispose (or its scope ending) unregisters every tool and aborts in-flight calls', async () => {
    const { registry } = setupRegistry();
    const context = fakeRegisterToolContext();
    const scope = createScope('app');
    const publisher = createWebMcpPublisher({ registry, adapter: adapterFor('navigator', context), scope });
    publisher.start();
    expect(context.tools.size).toBe(2);
    await scope.dispose();
    expect(context.tools.size).toBe(0);
    expect(publisher.state).toBe('disposed');
    await publisher.dispose();
    const late = await context.registerTool.mock.calls[0]?.[0].execute({ src: 'https://a.test' });
    expect(JSON.parse(late?.content[0]?.text ?? '{}')).toMatchObject({ error: { kind: 'aborted' } });
  });

  it('maps results', () => {
    expect(toToolResult(ok(undefined))).toEqual({ content: [{ type: 'text', text: 'null' }] });
  });

  it('publisher machine', () => {
    const machine = createMachine(publisherMachine);
    expect(machine.send('dispose').ok).toBe(true);
    expect(machine.can('start')).toBe(false);
  });
});

describe('webMcpConfirmPort', () => {
  it('runs the inner confirmation inside the client user interaction for WebMCP calls', async () => {
    const inner = { confirm: vi.fn(async () => ok(true)) };
    const port = webMcpConfirmPort(inner);
    const requestUserInteraction = vi.fn(async (cb: () => Promise<unknown>) => cb());
    const { registry } = setupRegistry({ confirm: port });
    const context = fakeRegisterToolContext();
    createWebMcpPublisher({ registry, adapter: adapterFor('navigator', context) }).start();
    const result = await context.tools.get('studio.delete-doc')?.execute({ id: '1' }, { requestUserInteraction });
    expect(result?.structuredContent).toEqual({ deleted: true });
    expect(requestUserInteraction).toHaveBeenCalledTimes(1);
    expect(inner.confirm).toHaveBeenCalledWith(expect.objectContaining({ reason: 'destructive', subject: 'agent' }), expect.any(AbortSignal));

    // no client → straight through; client throws → error result
    await context.tools.get('studio.delete-doc')?.execute({ id: '1' });
    expect(inner.confirm).toHaveBeenCalledTimes(2);
    const failing = await context.tools.get('studio.delete-doc')?.execute(
      { id: '1' },
      { requestUserInteraction: () => Promise.reject(new Error('no ui')) },
    );
    expect(failing?.isError).toBe(true);
    // non-webmcp origins pass through
    expect(await port.confirm({ capability: DeleteDoc, input: {}, subject: 'user', origin: undefined, reason: 'declared' }, new AbortController().signal)).toEqual(ok(true));
  });
});

describe('webmcp units', () => {
  it('one-line opt-in publishes through the DI registry with app-bound ports', async () => {
    const context = fakeRegisterToolContext();
    const adapterUnit = unit({
      id: 'test/model-context',
      provides: ModelContextAdapterToken,
      scope: 'app',
      create: () => adapterFor('navigator', context),
    });
    const decide = unit({
      id: 'test/decide',
      provides: CapabilityDecidePortToken,
      scope: 'app',
      create: () => decidePort(({ subject }) => (subject === 'agent' ? { effect: 'deny', reason: 'upgrade' } : { effect: 'allow' })),
    });
    const confirm = unit({
      id: 'test/confirm',
      provides: CapabilityConfirmPortToken,
      scope: 'app',
      create: () => webMcpConfirmPort({ confirm: async () => ok(true) }),
    });
    const injector = createInjector({ units: [...capabilityUnits, decide, confirm, ...webMcpUnits, adapterUnit] });
    const registry = await injector.get(CapabilityRegistryToken);
    if (!registry.ok) throw registry.error;
    registry.value.provide(implementCapability(InsertImage, (input) => ok({ blockId: input.src })));
    const publisher = await injector.get(WebMcpPublisherToken);
    if (!publisher.ok) throw publisher.error;
    expect(publisher.value.tools().map((t) => t.name)).toEqual(['agent.insert-image']);
    const denied = await context.tools.get('agent.insert-image')?.execute({ src: 'https://a.test' });
    expect(JSON.parse(denied?.content[0]?.text ?? '{}')).toMatchObject({ error: { code: 'SF-CAP-003' } });
    await injector.dispose();
    expect(context.tools.size).toBe(0);
  });

  it('default adapter is a no-op in browsers without WebMCP', async () => {
    const injector = createInjector({ units: [...capabilityUnits, ...webMcpUnits] });
    const publisher = await injector.get(WebMcpPublisherToken);
    if (!publisher.ok) throw publisher.error;
    expect(publisher.value.state).toBe('unsupported');
  });
});
