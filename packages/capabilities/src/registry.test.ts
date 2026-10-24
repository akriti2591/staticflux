import {
  createDeferred,
  createMachine,
  createMemorySink,
  createScope,
  createTelemetry,
  defineError,
  err,
  ok,
  type Result,
  type SpanEndRecord,
} from '@staticflux/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type ActivationLease,
  allowAllDecidePort,
  alwaysActivePort,
  type CapabilityConfirmPort,
  type CapabilityDecision,
  type CapabilityMeterPort,
  type CapabilityRegistryOptions,
  capabilityDecisionFrom,
  createCapabilityRegistry,
  defineCapability,
  failClosedConfirmPort,
  type FeatureActivationPort,
  implementCapability,
  invocationMachine,
  type MeterLease,
  s,
  unmeteredPort,
} from './index.js';

const InsertImage = defineCapability({
  id: 'agent/insert-image',
  title: 'Insert image',
  description: 'Insert an image block.',
  input: s.object({ src: s.string({ format: 'uri' }), alt: s.optional(s.string()) }),
  output: s.object({ blockId: s.string() }),
  feature: { id: 'studio/desktop' },
  requiresConfirmation: false,
  destructive: false,
  costEstimate: () => ({ meter: 'credits', amount: 2 }),
});

const DeleteDoc = defineCapability({
  id: 'studio/delete-doc',
  description: 'Delete a document.',
  input: s.object({ id: s.string() }),
  output: s.object({ deleted: s.boolean() }),
  policy: { resource: 'studio/docs', action: 'delete' },
  requiresConfirmation: false,
  destructive: true,
});

const Summarize = defineCapability({
  id: 'studio/summarize',
  description: 'Summarize the document.',
  input: s.object({}),
  output: s.object({ text: s.string() }),
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
  timeoutMs: 20,
});

const insertImpl = implementCapability(InsertImage, (input) => ok({ blockId: `b:${input.src}` }));
const deleteImpl = implementCapability(DeleteDoc, () => ok({ deleted: true }));

function fakeMeter(options: { deny?: boolean } = {}) {
  const calls: string[] = [];
  const lease: MeterLease = {
    commit: vi.fn(async (actual: number) => {
      calls.push(`commit:${actual}`);
      return ok();
    }),
    release: vi.fn(async () => {
      calls.push('release');
      return ok();
    }),
  };
  const QuotaDenied = defineError('SF-TESTCAP-001', 'quota', 'quota', 'buy credits');
  const port: CapabilityMeterPort = {
    reserve: vi.fn(async (cost) => {
      calls.push(`reserve:${cost.meter}:${cost.amount}`);
      return options.deny === true ? err(QuotaDenied()) : ok(lease);
    }),
  };
  return { port, lease, calls };
}

function confirmer(answer: boolean): CapabilityConfirmPort & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    confirm: async (request) => {
      calls.push(request.reason);
      return ok(answer);
    },
  };
}

function setup(overrides: Partial<CapabilityRegistryOptions> = {}) {
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  const registry = createCapabilityRegistry({
    decide: allowAllDecidePort,
    confirm: failClosedConfirmPort,
    meter: unmeteredPort,
    activation: alwaysActivePort,
    telemetry,
    ...overrides,
  });
  return { registry, sink };
}

describe('registry: declarations and implementations', () => {
  it('declares, describes and notifies; scope disposal undeclares', async () => {
    const { registry } = setup();
    const changes: string[] = [];
    registry.onChange((c) => changes.push(`${c.type}:${c.capability.id}`));
    const scope = createScope('feature');
    expect(registry.declare(InsertImage, { scope }).ok).toBe(true);
    expect(registry.declare(InsertImage).ok).toBe(true); // idempotent (ref-counted)
    expect(registry.list()).toEqual([InsertImage]);
    const [descriptor] = registry.describe();
    expect(descriptor).toMatchObject({
      id: 'agent/insert-image',
      title: 'Insert image',
      feature: 'studio/desktop',
      metered: true,
      destructive: false,
      exposeToAgents: true,
      policy: { resource: 'agent/insert-image' },
      inputSchema: { type: 'object', required: ['src'] },
    });
    await scope.dispose();
    expect(registry.get(InsertImage.id)).toBe(InsertImage); // second ref still alive
    expect(changes).toEqual(['declared:agent/insert-image']);
  });

  it('rejects conflicting declarations and double implementations', () => {
    const { registry } = setup();
    registry.declare(InsertImage);
    const clone = defineCapability({ ...InsertImage, policy: InsertImage.policy, feature: { id: 'studio/desktop' } });
    expect(registry.declare(clone)).toMatchObject({ ok: false, error: { code: 'SF-CAP-009' } });
    expect(registry.provide(implementCapability(clone, () => ok({ blockId: 'x' })))).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-009' },
    });
    expect(registry.provide(insertImpl).ok).toBe(true);
    expect(registry.provide(insertImpl)).toMatchObject({ ok: false, error: { code: 'SF-CAP-009' } });
  });

  it('provide implies declare; unprovide removes both (scope-bound)', async () => {
    const { registry } = setup();
    const changes: string[] = [];
    registry.onChange((c) => changes.push(c.type));
    const scope = createScope('feature');
    expect(registry.provide(deleteImpl, { scope }).ok).toBe(true);
    expect(registry.isImplemented(DeleteDoc.id)).toBe(true);
    await scope.dispose();
    expect(registry.isImplemented(DeleteDoc.id)).toBe(false);
    expect(registry.get(DeleteDoc.id)).toBeUndefined();
    expect(changes).toEqual(['declared', 'implemented', 'unimplemented', 'undeclared']);
  });

  it('accepts initial declarations and implementations', () => {
    const { registry } = setup({ declarations: [Summarize], implementations: [deleteImpl] });
    expect(registry.list().map((c) => c.id)).toEqual(['studio/summarize', 'studio/delete-doc']);
  });
});

describe('registry: invoke pipeline', () => {
  it('runs the full pipeline and returns typed output', async () => {
    const meter = fakeMeter();
    const { registry, sink } = setup({ meter: meter.port, implementations: [insertImpl] });
    const result = await registry.invoke(InsertImage, { src: 'https://x.test/i.png' }, { subject: 'user' });
    expectTypeOf(result).toEqualTypeOf<Result<{ readonly blockId: string }>>();
    expect(result).toEqual(ok({ blockId: 'b:https://x.test/i.png' }));
    expect(meter.calls).toEqual(['reserve:credits:2', 'commit:2']);
    const span = sink.records.find((r): r is SpanEndRecord => r.type === 'span' && r.name === 'capability.invoke');
    expect(span?.status).toBe('ok');
    expect(span?.attrs).toMatchObject({ capability: 'agent/insert-image', subject: 'user', channel: 'direct' });
    const lifecycle = sink.records.filter((r) => r.type === 'event').map((r) => (r.type === 'event' ? r.name : ''));
    expect(lifecycle).toContain('lifecycle.capabilities/invocation.running→verifying');
    expect(
      sink.records.some((r) => r.type === 'metric' && r.metric === 'capabilities/invocations' && r.attrs['outcome'] === 'ok'),
    ).toBe(true);
  });

  it('invokes by id with untrusted input (validated)', async () => {
    const { registry } = setup({ implementations: [insertImpl] });
    expect(await registry.invoke('agent/insert-image', { src: 'https://a.test' }, { subject: 'agent' })).toEqual(
      ok({ blockId: 'b:https://a.test' }),
    );
    const bad = await registry.invoke('agent/insert-image', { src: 42 }, { subject: 'agent' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'SF-CAP-002' } });
    const unknown = await registry.invoke('nope/x', {}, { subject: 'agent' });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'SF-CAP-001', kind: 'not-found' } });
  });

  it('passes subject, origin and parsed input to the decide port and maps deny reasons', async () => {
    const decisions: Record<string, CapabilityDecision> = {
      login: { effect: 'deny', reason: 'login' },
      upgrade: { effect: 'deny', reason: 'upgrade', meta: { plan: 'pro' } },
      quota: { effect: 'deny', reason: 'quota' },
      rate: { effect: 'deny', reason: 'rate' },
      unavailable: { effect: 'deny', reason: 'unavailable' },
      forbidden: { effect: 'deny', reason: 'forbidden' },
    };
    const expected = {
      login: ['SF-CAP-011', 'auth'],
      upgrade: ['SF-CAP-003', 'forbidden'],
      quota: ['SF-CAP-012', 'quota'],
      rate: ['SF-CAP-013', 'rate'],
      unavailable: ['SF-CAP-014', 'unavailable'],
      forbidden: ['SF-CAP-003', 'forbidden'],
    } as const;
    for (const [reason, decision] of Object.entries(decisions)) {
      const decide = vi.fn(() => decision);
      const run = vi.fn(() => ok({ blockId: 'x' }));
      const { registry } = setup({ decide: { decide }, implementations: [implementCapability(InsertImage, run)] });
      const result = await registry.invoke(InsertImage, { src: 'https://a.test', alt: 'a' }, {
        subject: 'agent',
        origin: { channel: 'webmcp' },
      });
      const [code, kind] = expected[reason as keyof typeof expected];
      expect(result).toMatchObject({ ok: false, error: { code, kind, details: { reason } } });
      expect(run).not.toHaveBeenCalled();
      expect(decide).toHaveBeenCalledWith({
        capability: InsertImage,
        input: { src: 'https://a.test', alt: 'a' },
        subject: 'agent',
        origin: { channel: 'webmcp' },
      });
    }
  });

  it('fails closed when the decide port throws', async () => {
    const { registry } = setup({
      decide: {
        decide: () => {
          throw new Error('boom');
        },
      },
      implementations: [deleteImpl],
    });
    expect(await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CORE-000' },
    });
    expect(await registry.preview(DeleteDoc, { id: '1' }, 'user')).toEqual({
      effect: 'deny',
      reason: 'unavailable',
      meta: { code: 'SF-CORE-000' },
    });
  });

  it('previews decisions without running', async () => {
    const run = vi.fn(() => ok({ deleted: true }));
    const { registry } = setup({
      decide: { decide: async ({ subject }) => (subject === 'agent' ? { effect: 'deny', reason: 'forbidden' } : { effect: 'allow' }) },
      implementations: [implementCapability(DeleteDoc, run)],
    });
    expect(await registry.preview(DeleteDoc, { id: '1' }, 'agent')).toEqual({ effect: 'deny', reason: 'forbidden' });
    expect(await registry.preview(DeleteDoc, { id: '1' }, 'user')).toEqual({ effect: 'allow' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('registry: confirmation', () => {
  it('destructive agent calls need confirmation; destructive user calls do not', async () => {
    const confirm = confirmer(true);
    const { registry } = setup({ confirm, implementations: [deleteImpl] });
    expect(await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'user' })).toEqual(ok({ deleted: true }));
    expect(confirm.calls).toEqual([]);
    expect(await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'agent' })).toEqual(ok({ deleted: true }));
    expect(confirm.calls).toEqual(['destructive']);
  });

  it('declined confirmation stops the call', async () => {
    const run = vi.fn(() => ok({ deleted: true }));
    const { registry, sink } = setup({ confirm: confirmer(false), implementations: [implementCapability(DeleteDoc, run)] });
    expect(await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'agent' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-004' },
    });
    expect(run).not.toHaveBeenCalled();
    expect(
      sink.records.some((r) => r.type === 'metric' && r.metric === 'capabilities/confirmations' && r.attrs['outcome'] === 'declined'),
    ).toBe(true);
  });

  it('the default confirm port fails closed (SF-CAP-005)', async () => {
    const { registry } = setup({ implementations: [deleteImpl] });
    expect(await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'agent' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-005' },
    });
  });

  it('declared and policy-requested confirmations apply to users too', async () => {
    const Declared = defineCapability({ ...Summarize, id: 'studio/publish', requiresConfirmation: true, timeoutMs: undefined });
    const confirm = confirmer(true);
    const { registry } = setup({
      confirm,
      decide: { decide: ({ capability }) => ({ effect: 'allow', requiresConfirmation: capability.id === 'studio/summarize' }) },
      implementations: [
        implementCapability(Declared, () => ok({ text: 'p' })),
        implementCapability(Summarize, () => ok({ text: 's' })),
      ],
    });
    await registry.invoke(Declared, {}, { subject: 'user' });
    await registry.invoke(Summarize, {}, { subject: 'user' });
    expect(confirm.calls).toEqual(['declared', 'policy']);
  });
});

describe('registry: feature activation', () => {
  it('activates the owning feature, which registers the implementation, and releases the lease', async () => {
    const released = vi.fn();
    const scope = createScope('studio');
    let registryRef: ReturnType<typeof createCapabilityRegistry> | undefined;
    const activation: FeatureActivationPort = {
      ensureActive: vi.fn(async (featureId: string) => {
        expect(featureId).toBe('studio/desktop');
        if (registryRef !== undefined && !registryRef.isImplemented(InsertImage.id)) {
          registryRef.provide(insertImpl, { scope });
        }
        return ok<ActivationLease>({ release: released });
      }),
    };
    const { registry } = setup({ activation, declarations: [InsertImage] });
    registryRef = registry;
    expect(registry.isImplemented(InsertImage.id)).toBe(false);
    expect(await registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'user' })).toEqual(
      ok({ blockId: 'b:https://a.test' }),
    );
    expect(released).toHaveBeenCalledTimes(1);
    await scope.dispose();
    expect(registry.isImplemented(InsertImage.id)).toBe(false);
  });

  it('does not activate (or fetch) when denied, and reports activation failures', async () => {
    const ensureActive = vi.fn(async () => err(defineError('SF-TESTCAP-002', 'network', 'chunk', 'retry')()));
    const denied = setup({
      activation: { ensureActive },
      decide: { decide: () => ({ effect: 'deny', reason: 'upgrade' }) },
      declarations: [InsertImage],
    });
    await denied.registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'user' });
    expect(ensureActive).not.toHaveBeenCalled();
    const failing = setup({ activation: { ensureActive }, declarations: [InsertImage] });
    expect(await failing.registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-008', details: { code: 'SF-TESTCAP-002' } },
    });
  });

  it('reports a declared-but-unimplemented capability', async () => {
    const { registry } = setup({ declarations: [DeleteDoc] });
    expect(await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-006' },
    });
  });
});

describe('registry: metering', () => {
  it('commits the reported actual cost', async () => {
    const meter = fakeMeter();
    const impl = implementCapability(InsertImage, (_input, ctx) => {
      expect(ctx.reserved).toEqual({ meter: 'credits', amount: 2 });
      ctx.reportCost(1);
      return ok({ blockId: 'x' });
    });
    const { registry } = setup({ meter: meter.port, implementations: [impl] });
    await registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'agent' });
    expect(meter.calls).toEqual(['reserve:credits:2', 'commit:1']);
  });

  it('policy cost overrides the estimate; zero cost skips the meter', async () => {
    const meter = fakeMeter();
    const { registry } = setup({
      meter: meter.port,
      decide: {
        decide: ({ capability }) =>
          capabilityDecisionFrom({
            effect: 'allow',
            cost: capability.id === InsertImage.id ? { meter: 'tokens', amount: 5 } : { meter: 'tokens', amount: 0 },
            requiresConfirmation: false,
          }),
      },
      implementations: [insertImpl, deleteImpl],
    });
    await registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'user' });
    await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'user' });
    expect(meter.calls).toEqual(['reserve:tokens:5', 'commit:5']);
  });

  it('releases the reservation when the run fails, and propagates reserve denials', async () => {
    const Failing = defineError('SF-TESTCAP-003', 'network', 'down', 'retry');
    const meter = fakeMeter();
    const run = vi.fn(() => err(Failing()));
    const { registry } = setup({ meter: meter.port, implementations: [implementCapability(InsertImage, run)] });
    expect(await registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'SF-TESTCAP-003' },
    });
    expect(meter.calls).toEqual(['reserve:credits:2', 'release']);

    const denying = fakeMeter({ deny: true });
    const run2 = vi.fn(() => ok({ blockId: 'x' }));
    const second = setup({ meter: denying.port, implementations: [implementCapability(InsertImage, run2)] });
    expect(await second.registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'user' })).toMatchObject({
      ok: false,
      error: { kind: 'quota' },
    });
    expect(run2).not.toHaveBeenCalled();
  });

  it('releases on invalid output (SF-CAP-007)', async () => {
    const meter = fakeMeter();
    const impl = implementCapability(InsertImage, () => ok({ blockId: 3 } as unknown as { blockId: string }));
    const { registry } = setup({ meter: meter.port, implementations: [impl] });
    expect(await registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-007', kind: 'invariant' },
    });
    expect(meter.calls).toEqual(['reserve:credits:2', 'release']);
  });
});

describe('registry: cancellation, timeouts, failures', () => {
  it('a pre-aborted signal never runs', async () => {
    const run = vi.fn(() => ok({ deleted: true }));
    const { registry } = setup({ implementations: [implementCapability(DeleteDoc, run)] });
    const controller = new AbortController();
    controller.abort();
    expect(await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'user', signal: controller.signal })).toMatchObject({
      ok: false,
      error: { kind: 'aborted' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('aborting mid-run cancels, releases and shows in-flight state', async () => {
    const meter = fakeMeter();
    const gate = createDeferred<void>();
    const impl = implementCapability(InsertImage, async (_input, ctx) => {
      gate.resolve();
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      return ok({ blockId: 'late' });
    });
    const { registry, sink } = setup({ meter: meter.port, implementations: [impl] });
    const controller = new AbortController();
    const pending = registry.invoke(InsertImage, { src: 'https://a.test' }, { subject: 'user', signal: controller.signal });
    await gate.promise;
    expect(registry.inFlight()).toEqual([
      { invocationId: 'cap-1', capability: 'agent/insert-image', subject: 'user', state: 'running' },
    ]);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(meter.calls).toEqual(['reserve:credits:2', 'release']);
    expect(registry.inFlight()).toEqual([]);
    const span = sink.records.find((r): r is SpanEndRecord => r.type === 'span' && r.name === 'capability.invoke');
    expect(span?.status).toBe('cancelled');
  });

  it('times out slow implementations and aborts their signal', async () => {
    let seen: AbortSignal | undefined;
    const impl = implementCapability(Summarize, (_input, ctx) => {
      seen = ctx.signal;
      return new Promise<Result<{ text: string }>>(() => undefined);
    });
    const { registry } = setup({ implementations: [impl] });
    expect(await registry.invoke(Summarize, {}, { subject: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'SF-ASYNC-001', kind: 'timeout' },
    });
    expect(seen?.aborted).toBe(true);
  });

  it('maps throwing implementations to SF-CAP-010', async () => {
    const impl = implementCapability(DeleteDoc, () => {
      throw new Error('kaput');
    });
    const { registry } = setup({ implementations: [impl] });
    expect(await registry.invoke(DeleteDoc, { id: '1' }, { subject: 'user' })).toMatchObject({
      ok: false,
      error: { code: 'SF-CAP-010' },
    });
  });

  it('dispose aborts in-flight invocations and clears the registry', async () => {
    const started = createDeferred<void>();
    const impl = implementCapability(DeleteDoc, async (_input, ctx) => {
      started.resolve();
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      return ok({ deleted: false });
    });
    const { registry } = setup({ implementations: [impl] });
    const pending = registry.invoke(DeleteDoc, { id: '1' }, { subject: 'user' });
    await started.promise;
    await registry.dispose();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(registry.list()).toEqual([]);
  });
});

describe('invocation machine', () => {
  it('only allows documented transitions', () => {
    const machine = createMachine(invocationMachine);
    expect(machine.send('run')).toMatchObject({ ok: false, error: { code: 'SF-CORE-010' } });
    expect(machine.send('validate')).toEqual(ok('validating'));
    expect(machine.send('authorize')).toEqual(ok('authorizing'));
    expect(machine.send('activate')).toEqual(ok('activating'));
    expect(machine.send('run')).toEqual(ok('running'));
    expect(machine.send('verify')).toEqual(ok('verifying'));
    expect(machine.can('cancel')).toBe(false);
    expect(machine.send('succeed')).toEqual(ok('succeeded'));
    expect(machine.can('fail')).toBe(false);
  });
});
