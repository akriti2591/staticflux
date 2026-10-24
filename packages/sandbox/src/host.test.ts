import {
  allowAllDecidePort,
  alwaysActivePort,
  type CapabilityConfirmPort,
  capabilityUnits,
  CapabilityImplementationsToken,
  createCapabilityRegistry,
  decidePort,
  defineCapability,
  failClosedConfirmPort,
  implementCapability,
  s,
  unmeteredPort,
  type CapabilityDecidePort,
} from '@staticflux/capabilities';
import { AbortedError, box, contribution, createInjector, createMachine, createMemorySink, createTelemetry, err, ok, token } from '@staticflux/core';
import { createLink, type Link, type Port, type PortPair } from '@staticflux/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectToHost,
  createPluginHost,
  definePluginEvent,
  definePluginManifest,
  inMemoryRealm,
  type PluginClient,
  type PluginHostOptions,
  type PluginInstance,
  PluginLifecycle,
  pluginHostUnit,
  PluginHostToken,
  pluginSubjectOf,
  pluginUnit,
  type PluginViolation,
  type RealmFactory,
} from './index.js';

const Echo = defineCapability({
  id: 'test/echo',
  description: 'Echo text.',
  input: s.object({ text: s.string() }),
  output: s.object({ text: s.string() }),
  requiresConfirmation: false,
  destructive: false,
});
const Slow = defineCapability({
  id: 'test/slow',
  description: 'Waits until aborted.',
  input: s.object({}),
  output: s.object({}),
  requiresConfirmation: false,
  destructive: false,
});
const Wipe = defineCapability({
  id: 'test/wipe',
  description: 'Destroys data.',
  input: s.object({}),
  output: s.object({ wiped: s.boolean() }),
  requiresConfirmation: false,
  destructive: true,
});
const Secret = defineCapability({
  id: 'test/secret',
  description: 'Not requested by the plugin.',
  input: s.object({}),
  output: s.object({}),
  requiresConfirmation: false,
  destructive: false,
});

const Selection = definePluginEvent('studio/selection').type<{ readonly ids: readonly string[] }>();
const Private = definePluginEvent('studio/private').type<{ readonly x: number }>();

const manifest = definePluginManifest({
  id: 'acme/counter',
  version: '1.0.0',
  name: 'Counter',
  entry: { kind: 'iframe', url: 'https://plugins.example/counter.js' },
  capabilities: ['test/echo', 'test/slow', 'test/wipe'],
  events: ['studio/selection', 'studio/private'],
  permissions: ['render', 'resize'],
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await tick();
}

interface Harness {
  readonly host: ReturnType<typeof createPluginHost>;
  readonly sink: ReturnType<typeof createMemorySink>;
  readonly calls: { subject: string; plugin: string | undefined }[];
  readonly clients: PluginClient[];
  readonly pairs: PortPair[];
  readonly violations: PluginViolation[];
  readonly events: (name: string) => ReturnType<typeof createMemorySink>['records'];
}

function harness(
  options: {
    host?: Partial<PluginHostOptions>;
    decide?: CapabilityDecidePort;
    confirm?: CapabilityConfirmPort;
    realm?: RealmFactory;
    pluginId?: string;
  } = {},
): Harness {
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  const calls: { subject: string; plugin: string | undefined }[] = [];
  const registry = createCapabilityRegistry({
    decide: options.decide ?? allowAllDecidePort,
    confirm: options.confirm ?? failClosedConfirmPort,
    meter: unmeteredPort,
    activation: alwaysActivePort,
    telemetry,
    implementations: [
      implementCapability(Echo, (input, context) => {
        calls.push({ subject: context.subject, plugin: pluginSubjectOf(context.origin)?.id });
        return ok({ text: input.text });
      }),
      implementCapability(
        Slow,
        (_input, context) =>
          new Promise((resolve) => context.signal.addEventListener('abort', () => resolve(err(AbortedError())), { once: true })),
      ),
      implementCapability(Wipe, () => ok({ wiped: true })),
      implementCapability(Secret, () => ok({})),
    ],
  });
  const clients: PluginClient[] = [];
  const pairs: PortPair[] = [];
  const realm =
    options.realm ??
    inMemoryRealm((port, context) => {
      pairs.push(context.pair);
      void connectToHost({ port, pluginId: options.pluginId ?? context.manifest.id }).then((result) => {
        if (result.ok) clients.push(result.value);
      });
    });
  const host = createPluginHost({
    registry,
    realms: { iframe: realm, worker: realm },
    events: [Selection],
    telemetry,
    heartbeatMs: false,
    ...options.host,
  });
  const violations: PluginViolation[] = [];
  host.onViolation((v) => violations.push(v));
  return {
    host,
    sink,
    calls,
    clients,
    pairs,
    violations,
    events: (name) => sink.records.filter((r) => r.type === 'event' && r.name === name),
  };
}

/** A realm whose "plugin" is driven by the test through a raw Link (bypasses the SDK's checks). */
function rawRealm(): { realm: RealmFactory; link: () => Link; pair: () => PortPair } {
  let port: Port | undefined;
  let pair: PortPair | undefined;
  return {
    realm: inMemoryRealm((p, context) => {
      port = p;
      pair = context.pair;
    }),
    link: () => createLink({ port: port as Port, name: 'raw' }),
    pair: () => pair as PortPair,
  };
}

async function startRaw(h: Harness, raw: ReturnType<typeof rawRealm>, m: unknown = manifest): Promise<{ instance: PluginInstance; link: Link }> {
  const registered = h.host.register(m);
  if (!registered.ok) throw registered.error;
  const running = registered.value.start();
  const link = raw.link();
  link.handle('sandbox/ping', () => ok(null));
  const ack = await link.request('sandbox/hello', { plugin: registered.value.id, protocol: 1 });
  expect(ack.ok).toBe(true);
  expect(await running).toEqual(ok());
  return { instance: registered.value, link };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PluginLifecycle', () => {
  it('allows only the documented transitions', () => {
    const m = createMachine(PluginLifecycle);
    expect(m.send('ready').ok).toBe(false);
    expect(m.send('load')).toEqual(ok('loading'));
    expect(m.send('loaded')).toEqual(ok('handshaking'));
    expect(m.send('ready')).toEqual(ok('running'));
    expect(m.send('crash')).toEqual(ok('crashed'));
    expect(m.send('restart')).toEqual(ok('restarting'));
    expect(m.send('load')).toEqual(ok('loading'));
    expect(m.send('crash')).toEqual(ok('crashed'));
    expect(m.send('give-up')).toEqual(ok('failed'));
    expect(m.send('kill')).toEqual(ok('killed'));
    expect(m.send('restart')).toEqual(ok('restarting'));
    expect(m.send('stop')).toEqual(ok('stopped'));
    expect(m.send('restart').ok).toBe(false);
  });
});

describe('createPluginHost — capability calls', () => {
  it('loads, handshakes and invokes granted capabilities through the registry as a plugin subject', async () => {
    const h = harness();
    const loaded = await h.host.load(manifest);
    expect(loaded.ok && loaded.value.state).toBe('running');
    await settle();
    const client = h.clients[0] as PluginClient;
    expect(client.pluginId).toBe('acme/counter');
    expect(client.grants).toEqual(['test/echo', 'test/slow', 'test/wipe']);
    expect(client.events).toEqual(['studio/selection']); // the host does not offer studio/private
    expect(await client.invoke(Echo, { text: 'hi' })).toEqual(ok({ text: 'hi' }));
    expect(h.calls).toEqual([{ subject: 'agent', plugin: 'acme/counter' }]);
    const spans = h.sink.records.filter((r) => r.type === 'span' && r.name === 'sandbox.call');
    expect(spans).toHaveLength(1);
    const capSpan = h.sink.records.find((r) => r.type === 'span-start' && r.name === 'capability.invoke');
    const callSpan = h.sink.records.find((r) => r.type === 'span-start' && r.name === 'sandbox.call');
    expect(capSpan?.type === 'span-start' && callSpan?.type === 'span-start' && capSpan.context.traceId === callSpan.context.traceId).toBe(true);
    expect(capSpan?.type === 'span-start' && callSpan?.type === 'span-start' && capSpan.parentSpanId === callSpan.context.spanId).toBe(true);
    expect(h.sink.records.some((r) => r.type === 'metric' && r.metric === 'sandbox/calls' && r.attrs['outcome'] === 'ok')).toBe(true);
    // schema validation still applies
    const bad = await client.invoke('test/echo', { text: 1 });
    expect(!bad.ok && bad.error.code).toBe('SF-CAP-002');
    await h.host.dispose();
  });

  it('gating and confirmation apply: destructive calls need confirmation, denials pass through', async () => {
    const confirm = vi.fn<CapabilityConfirmPort['confirm']>(async () => ok(true));
    const h = harness({
      confirm: { confirm },
      decide: decidePort(({ capability }) => (capability.id === 'test/echo' ? { effect: 'deny', reason: 'forbidden' } : { effect: 'allow' })),
    });
    await h.host.load(manifest);
    await settle();
    const client = h.clients[0] as PluginClient;
    expect(await client.invoke(Wipe, {})).toEqual(ok({ wiped: true }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ subject: 'agent', reason: 'destructive', origin: { channel: 'sandbox/plugin' } });
    const denied = await client.invoke(Echo, { text: 'x' });
    expect(!denied.ok && denied.error.code).toBe('SF-CAP-003');
    await h.host.dispose();
  });

  it('grant/revoke at runtime; the host enforces grants even when the plugin bypasses the SDK', async () => {
    const raw = rawRealm();
    const h = harness({ realm: raw.realm, host: { autoGrant: false } });
    const { instance, link } = await startRaw(h, raw);
    expect(instance.grants).toEqual([]);
    const denied = await link.request('sandbox/invoke', { capability: 'test/echo', input: { text: 'a' } });
    expect(!denied.ok && denied.error.code).toBe('SF-SBX-002');
    expect(h.violations.map((v) => v.kind)).toEqual(['not-granted']);
    const first = h.events('violation')[0];
    expect(first?.type === 'event' && first.level).toBe('critical');

    const grantsSeen: unknown[] = [];
    link.on('sandbox/grants', (payload) => grantsSeen.push(payload));
    expect(instance.grant(Echo)).toEqual(ok());
    expect(instance.grant('test/echo')).toEqual(ok());
    const notRequested = instance.grant(Secret);
    expect(!notRequested.ok && notRequested.error.code).toBe('SF-SBX-002');
    expect(await link.request('sandbox/invoke', { capability: 'test/echo', input: { text: 'a' } })).toEqual(ok({ text: 'a' }));
    instance.revoke(Echo);
    instance.revoke(Echo);
    await settle();
    expect(grantsSeen).toEqual([{ grants: ['test/echo'] }, { grants: [] }]);
    const again = await link.request('sandbox/invoke', { capability: 'test/echo', input: { text: 'a' } });
    expect(!again.ok && again.error.code).toBe('SF-SBX-002');
    await h.host.dispose();
  });

  it('SDK pre-checks grants and follows grant updates', async () => {
    const h = harness({ host: { grantPolicy: () => ['test/echo'] } });
    const loaded = await h.host.load(manifest);
    await settle();
    const client = h.clients[0] as PluginClient;
    expect(client.grants).toEqual(['test/echo']);
    const pre = await client.invoke(Slow, {});
    expect(!pre.ok && pre.error.code).toBe('SF-SBX-002');
    expect(h.violations).toEqual([]); // never sent
    const seen: (readonly string[])[] = [];
    client.onGrantsChange((g) => seen.push(g));
    if (loaded.ok) loaded.value.grant(Slow);
    await settle();
    expect(seen).toEqual([['test/echo', 'test/slow']]);
    await h.host.dispose();
  });

  it('revoking aborts in-flight calls of that capability', async () => {
    const h = harness();
    const loaded = await h.host.load(manifest);
    await settle();
    const client = h.clients[0] as PluginClient;
    const pending = client.invoke(Slow, {});
    await settle();
    expect(loaded.ok && loaded.value.inspect().activeCalls).toBe(1);
    if (loaded.ok) loaded.value.revoke(Slow);
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('SF-SBX-002');
    await h.host.dispose();
  });

  it('call timeout cancels the capability (SF-SBX-005)', async () => {
    const h = harness();
    await h.host.load({ ...manifest, limits: { callTimeoutMs: 20 } });
    await settle();
    const client = h.clients[0] as PluginClient;
    expect(client.limits.callTimeoutMs).toBe(20);
    const result = await client.invoke(Slow, {});
    expect(!result.ok && result.error.code).toBe('SF-SBX-005');
    expect(h.sink.records.some((r) => r.type === 'metric' && r.metric === 'sandbox/calls' && r.attrs['outcome'] === 'SF-SBX-005')).toBe(true);
    await h.host.dispose();
  });

  it('limits concurrent calls', async () => {
    const h = harness();
    await h.host.load({ ...manifest, limits: { maxConcurrentCalls: 1 } });
    await settle();
    const client = h.clients[0] as PluginClient;
    void client.invoke(Slow, {});
    await settle();
    const second = await client.invoke(Slow, {});
    expect(!second.ok && second.error.code).toBe('SF-SBX-004');
    expect(h.violations.map((v) => v.kind)).toEqual(['concurrency']);
    await h.host.dispose();
  });

  it('clamps requested limits to the host ceiling', async () => {
    const h = harness({ host: { limits: { maxMessagesPerSecond: 10, maxPayloadBytes: 1000, callTimeoutMs: 50, maxConcurrentCalls: 2 } } });
    const loaded = await h.host.load({ ...manifest, limits: { callTimeoutMs: 999_999, maxPayloadBytes: 900 } });
    expect(loaded.ok && loaded.value.limits).toEqual({ maxMessagesPerSecond: 10, maxPayloadBytes: 900, callTimeoutMs: 50, maxConcurrentCalls: 2 });
    await h.host.dispose();
  });
});

describe('createPluginHost — message guard and violations', () => {
  it('drops oversized payloads (SF-SBX-003) and answers the request', async () => {
    const raw = rawRealm();
    const h = harness({ realm: raw.realm });
    const { link } = await startRaw(h, raw, { ...manifest, limits: { maxPayloadBytes: 2000 } });
    const result = await link.request('sandbox/invoke', { capability: 'test/echo', input: { text: 'x'.repeat(5000) } });
    expect(!result.ok && result.error.code).toBe('SF-SBX-003');
    expect(h.violations.map((v) => v.kind)).toEqual(['payload']);
    await h.host.dispose();
  });

  it('rate-limits messages (SF-SBX-004)', async () => {
    const raw = rawRealm();
    const h = harness({ realm: raw.realm });
    const { link } = await startRaw(h, raw, { ...manifest, limits: { maxMessagesPerSecond: 3 } });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => link.request('sandbox/invoke', { capability: 'test/echo', input: { text: 'a' } })),
    );
    const limited = results.filter((r) => !r.ok && r.error.code === 'SF-SBX-004');
    expect(limited.length).toBeGreaterThanOrEqual(3);
    expect(h.violations.every((v) => v.kind === 'rate')).toBe(true);
    await h.host.dispose();
  });

  it('rejects non-envelopes, disallowed channels and malformed payloads', async () => {
    const raw = rawRealm();
    const h = harness({ realm: raw.realm });
    const { link } = await startRaw(h, raw);
    raw.pair().b.postMessage('not an envelope');
    const other = await link.request('app/secret-channel', {});
    expect(!other.ok && other.error.code).toBe('SF-WK-008');
    link.send('sandbox/event', { event: 'x', payload: null }); // host→plugin channel, not plugin→host
    const malformed = await link.request('sandbox/invoke', { nope: true });
    expect(!malformed.ok && malformed.error.code).toBe('SF-WK-001');
    link.send('sandbox/resize', { height: 'tall' });
    const second = await link.request('sandbox/hello', { plugin: 'acme/counter', protocol: 1 });
    expect(!second.ok && second.error.code).toBe('SF-SBX-008');
    await settle();
    expect(h.violations.map((v) => v.kind)).toEqual(['malformed', 'malformed', 'malformed', 'malformed', 'malformed', 'handshake']);
    await h.host.dispose();
  });

  it('kills a plugin that exceeds its violation budget', async () => {
    const raw = rawRealm();
    const h = harness({ realm: raw.realm, host: { maxViolations: 2 } });
    const { instance } = await startRaw(h, raw);
    for (let i = 0; i < 3; i += 1) raw.pair().b.postMessage(i);
    await settle();
    expect(instance.state).toBe('killed');
    const running = await instance.whenRunning();
    expect(!running.ok && running.error.code).toBe('SF-SBX-011');
    expect(h.events('plugin.killed')[0]?.type === 'event' && h.events('plugin.killed')[0]?.attrs['reason']).toBe('violations');
    await h.host.dispose();
  });

  it('resize needs the permission; with it the realm is resized', async () => {
    const resized: number[] = [];
    let pluginPort: Port | undefined;
    const realm: RealmFactory = (context) => {
      const inner = inMemoryRealm((port) => {
        pluginPort = port;
      })(context);
      return inner.ok ? ok({ ...inner.value, resize: (height: number) => resized.push(height) }) : inner;
    };
    const h = harness({ realm });
    const registered = h.host.register({ ...manifest, permissions: ['render'] });
    if (!registered.ok) throw registered.error;
    const started = registered.value.start();
    const client = await connectToHost({ port: pluginPort as Port, pluginId: manifest.id });
    await started;
    expect(client.ok).toBe(true);
    if (!client.ok) return;
    const refused = client.value.resize(100);
    expect(!refused.ok && refused.error.code).toBe('SF-SBX-012');
    createLink({ port: pluginPort as Port, name: 'sneaky' }).send('sandbox/resize', { height: 100 });
    await settle();
    expect(h.violations.map((v) => v.kind)).toEqual(['permission']);
    registered.value.stop();

    const h2 = harness({ realm });
    const second = h2.host.register(manifest);
    if (!second.ok) throw second.error;
    const started2 = second.value.start();
    const client2 = await connectToHost({ port: pluginPort as Port, pluginId: manifest.id });
    await started2;
    expect(client2.ok && client2.value.resize(240)).toEqual(ok());
    await settle();
    expect(resized).toEqual([240]);
    await h.host.dispose();
    await h2.host.dispose();
  });
});

describe('createPluginHost — events', () => {
  it('delivers only declared and offered events', async () => {
    const h = harness();
    const loaded = await h.host.load(manifest);
    await settle();
    const client = h.clients[0] as PluginClient;
    const seen: unknown[] = [];
    client.on(Selection, (payload) => seen.push(payload));
    const offPrivate = client.on(Private, () => seen.push('private'));
    offPrivate();
    expect(h.host.emit(Selection, { ids: ['a'] })).toBe(1);
    if (!loaded.ok) return;
    const undeclared = loaded.value.emit(Private, { x: 1 });
    expect(!undeclared.ok && undeclared.error.code).toBe('SF-SBX-009');
    expect(h.host.emit(Private, { x: 1 })).toBe(0);
    await settle();
    expect(seen).toEqual([{ ids: ['a'] }]);
    loaded.value.stop();
    const stopped = loaded.value.emit(Selection, { ids: [] });
    expect(!stopped.ok && stopped.error.code).toBe('SF-SBX-006');
    await h.host.dispose();
  });
});

describe('createPluginHost — supervision', () => {
  it('restarts a crashed realm with backoff and runs again', async () => {
    const h = harness({ host: { restart: { baseDelayMs: 1 } } });
    const loaded = await h.host.load(manifest);
    if (!loaded.ok) throw loaded.error;
    const states: string[] = [];
    loaded.value.onStateChange((r) => states.push(r.to));
    h.pairs[0]?.crash();
    await settle();
    expect(loaded.value.state).toBe('running');
    expect(states).toEqual(['crashed', 'restarting', 'loading', 'handshaking', 'running']);
    expect(loaded.value.inspect().attempt).toBe(2);
    expect(h.sink.records.some((r) => r.type === 'metric' && r.metric === 'sandbox/crashes')).toBe(true);
    await h.host.dispose();
  });

  it('gives up after the restart intensity (failed), and restart() recovers', async () => {
    let healthy = false;
    const realm = inMemoryRealm((port, context) => {
      if (healthy) void connectToHost({ port, pluginId: context.manifest.id });
      else queueMicrotask(() => context.pair.crash());
    });
    const h = harness({ realm, host: { restart: { intensity: 2, baseDelayMs: 1 } } });
    const loaded = await h.host.load(manifest);
    expect(!loaded.ok && loaded.error.code).toBe('SF-SBX-007');
    const instance = h.host.get('acme/counter') as PluginInstance;
    expect(instance.state).toBe('failed');
    expect(instance.inspect().attempt).toBe(3);
    healthy = true;
    expect(await instance.restart()).toEqual(ok());
    expect(instance.state).toBe('running');
    await h.host.dispose();
  });

  it('crashes on handshake timeout and on a wrong plugin id', async () => {
    vi.useFakeTimers();
    const silent = inMemoryRealm(() => undefined);
    const h = harness({ realm: silent, host: { handshakeTimeoutMs: 100, restart: { intensity: 0 } } });
    const pending = h.host.load(manifest);
    await vi.advanceTimersByTimeAsync(150);
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('SF-SBX-007');
    expect(h.violations.map((v) => v.kind)).toEqual(['handshake']);
    vi.useRealTimers();

    const h2 = harness({ pluginId: 'evil/impostor', host: { restart: { intensity: 0 } } });
    const impostor = await h2.host.load(manifest);
    expect(!impostor.ok && impostor.error.code).toBe('SF-SBX-007');
    expect(h2.violations.map((v) => v.kind)).toEqual(['handshake']);
    await h.host.dispose();
    await h2.host.dispose();
  });

  it('treats two missed heartbeats as a crash (frozen realm)', async () => {
    vi.useFakeTimers();
    const h = harness({ host: { heartbeatMs: 100, restart: { intensity: 0 } } });
    const pending = h.host.load(manifest);
    await vi.advanceTimersByTimeAsync(1);
    const loaded = await pending;
    if (!loaded.ok) throw loaded.error;
    await vi.advanceTimersByTimeAsync(250);
    expect(loaded.value.state).toBe('running'); // pings answered
    h.pairs[0]?.b.freeze();
    await vi.advanceTimersByTimeAsync(500);
    expect(loaded.value.state).toBe('failed');
    expect(h.violations.map((v) => v.kind)).toEqual(['unresponsive']);
    await h.host.dispose();
  });

  it('kill() is a hard stop; restart() brings it back', async () => {
    const h = harness();
    const loaded = await h.host.load(manifest);
    if (!loaded.ok) throw loaded.error;
    await settle();
    const client = h.clients[0] as PluginClient;
    loaded.value.kill('test');
    loaded.value.kill('again');
    expect(loaded.value.state).toBe('killed');
    expect(client.closed).toBe(true);
    expect(await loaded.value.restart()).toEqual(ok());
    expect(loaded.value.state).toBe('running');
    loaded.value.stop();
    expect(h.host.get('acme/counter')).toBeUndefined();
    const after = await loaded.value.restart();
    expect(!after.ok && after.error.code).toBe('SF-SBX-006');
    await h.host.dispose();
  });

  it('the kill switch kills every plugin and refuses loads while engaged', async () => {
    const engaged = box(false);
    const h = harness({ host: { killSwitch: () => engaged.get() } });
    const loaded = await h.host.load(manifest);
    if (!loaded.ok) throw loaded.error;
    engaged.set(true);
    expect(loaded.value.state).toBe('killed');
    expect(h.events('sandbox.kill-switch')).toHaveLength(1);
    const restart = await loaded.value.restart();
    expect(!restart.ok && restart.error.code).toBe('SF-SBX-011');
    loaded.value.stop();
    const refused = await h.host.load(manifest);
    expect(!refused.ok && refused.error.code).toBe('SF-SBX-011');
    engaged.set(false);
    expect((await h.host.load(manifest)).ok).toBe(true);
    h.host.killAll();
    expect(h.host.list().every((p) => p.state === 'killed')).toBe(true);
    await h.host.dispose();
  });

  it('whenRunning honours an abort signal', async () => {
    const h = harness({ realm: inMemoryRealm(() => undefined) });
    const registered = h.host.register(manifest);
    if (!registered.ok) throw registered.error;
    const controller = new AbortController();
    const pending = registered.value.start(controller.signal);
    controller.abort();
    const result = await pending;
    expect(!result.ok && result.error.code).toBe('SF-SBX-006');
    const pre = await registered.value.whenRunning(controller.signal);
    expect(!pre.ok && pre.error.code).toBe('SF-SBX-006');
    await h.host.dispose();
  });
});

describe('createPluginHost — registration', () => {
  it('validates manifests, permissions and realms; dedupes by id and version', async () => {
    const h = harness({ host: { allowedPermissions: ['resize'] } });
    const invalid = h.host.register({ id: 'nope' });
    expect(!invalid.ok && invalid.error.code).toBe('SF-SBX-001');
    expect(h.events('plugin.rejected')).toHaveLength(1);
    const perm = h.host.register(manifest);
    expect(!perm.ok && perm.error.code).toBe('SF-SBX-012');
    const headless = { ...manifest, permissions: [] };
    const first = h.host.register(headless);
    expect(first.ok).toBe(true);
    const same = h.host.register(headless);
    expect(same.ok && first.ok && same.value === first.value).toBe(true);
    const other = h.host.register({ ...headless, version: '2.0.0' });
    expect(!other.ok && other.error.code).toBe('SF-SBX-001');
    await h.host.dispose();

    const noRealm = createPluginHost({
      registry: createCapabilityRegistry({ decide: allowAllDecidePort, confirm: failClosedConfirmPort, meter: unmeteredPort, activation: alwaysActivePort }),
      realms: {},
    });
    const unsupported = noRealm.register(manifest);
    expect(!unsupported.ok && unsupported.error.code).toBe('SF-SBX-010');
    await noRealm.dispose();
  });

  it('a realm that fails to start counts as a crash', async () => {
    const failing: RealmFactory = () => err(AbortedError());
    const h = harness({ realm: failing, host: { restart: { intensity: 0 } } });
    const result = await h.host.load(manifest);
    expect(!result.ok && result.error.code).toBe('SF-SBX-007');
    await h.host.dispose();
  });
});

describe('DI units', () => {
  it('pluginHostUnit + pluginUnit load a plugin for the unit scope', async () => {
    const PluginToken = token('test/counter-plugin').type<PluginInstance>();
    const realm = inMemoryRealm((port, context) => {
      void connectToHost({ port, pluginId: context.manifest.id });
    });
    const injector = createInjector({
      units: [
        ...capabilityUnits,
        contribution({
          id: 'test/echo-impl',
          provides: CapabilityImplementationsToken,
          scope: 'app',
          create: () => implementCapability(Echo, (input) => ok({ text: input.text })),
        }),
        pluginHostUnit({ options: () => ({ realms: { iframe: realm }, heartbeatMs: false }) }),
        pluginUnit({ id: 'test/counter-plugin-unit', provides: PluginToken, manifest, scope: 'app', grants: ['test/echo'] }),
      ],
    });
    const plugin = await injector.get(PluginToken);
    expect(plugin.ok && plugin.value.state).toBe('running');
    expect(plugin.ok && plugin.value.grants).toEqual(['test/echo']);
    const host = await injector.get(PluginHostToken);
    expect(host.ok && host.value.list()).toHaveLength(1);
    await injector.scope.dispose();
    expect(plugin.ok && plugin.value.state).toBe('stopped');
  });
});
