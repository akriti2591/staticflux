import { box, createMemorySink, createTelemetry, err, metric, ok, type TelemetryRecord } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  BrokerDeniedError,
  CoreContexts,
  createBrokerClient,
  createContextHub,
  createForwardingSink,
  createLeaderElection,
  createLink,
  createPortPair,
  createTokenBroker,
  createWorkerContexts,
  defineContext,
  detectLocks,
  findSecretPaths,
  frameScheduler,
  type LockManagerLike,
  provideContext,
  reactiveSource,
  receiveForwardedTelemetry,
  staticSource,
  stripSecrets,
} from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function links() {
  const pair = createPortPair();
  return { pair, main: createLink({ port: pair.a, name: 'main' }), worker: createLink({ port: pair.b, name: 'worker' }) };
}

describe('core contexts', () => {
  it('snapshots every context and pushes changes to attached links', async () => {
    const session = box({ status: 'guest' });
    const hub = createContextHub({
      entries: [
        provideContext(CoreContexts.session, reactiveSource(() => session.get())),
        provideContext(CoreContexts.flags, staticSource({ 'studio/ai': true })),
      ],
    });
    expect(hub.ids).toEqual(['core/session', 'core/flags']);
    const snapshot = hub.snapshot();
    expect(snapshot['core/session']).toEqual({ version: 1, value: { status: 'guest' } });

    const { main, worker } = links();
    hub.attach(main);
    const contexts = createWorkerContexts(snapshot);
    contexts.attach(worker);
    expect(contexts.get(CoreContexts.session)?.status).toBe('guest');
    expect(contexts.get(CoreContexts.flags)).toEqual({ 'studio/ai': true });
    expect(contexts.has(CoreContexts.user)).toBe(false);
    expect(contexts.get(CoreContexts.user)).toBeUndefined();
    const missing = contexts.require(CoreContexts.user);
    expect(!missing.ok && missing.error.code).toBe('SF-WK-008');

    const changes: unknown[] = [];
    contexts.subscribe(CoreContexts.session, (value) => changes.push(value));
    session.set({ status: 'authenticated' });
    await tick();
    expect(contexts.require(CoreContexts.session)).toEqual(ok({ status: 'authenticated' }));
    expect(contexts.version(CoreContexts.session)).toBe(2);
    expect(changes).toEqual([{ status: 'authenticated' }]);
    hub.dispose();
  });

  it('ignores stale updates and accepts contexts that appear later', async () => {
    const { main, worker } = links();
    const contexts = createWorkerContexts({ 'core/user': { version: 5, value: { id: 'u5' } } });
    contexts.attach(worker);
    main.send('sf/context', { id: 'core/user', version: 4, value: { id: 'old' } });
    main.send('sf/context', { id: 'test/new', version: 1, value: 1 });
    main.send('sf/context', 'garbage');
    await tick();
    expect(contexts.get(CoreContexts.user)).toEqual({ id: 'u5' });
    expect(contexts.get(defineContext('test/new').type<number>())).toBe(1);
  });

  it('never replicates raw credentials (SF-WK-012) unless allowed', () => {
    const onError = vi.fn();
    const sink = createMemorySink();
    const telemetry = createTelemetry();
    telemetry.addSink(sink);
    const hub = createContextHub({
      telemetry,
      onError,
      entries: [
        provideContext(CoreContexts.session, staticSource({ status: 'authenticated', accessToken: 'secret!', nested: { refresh_token: 'x', keep: 1 } })),
        provideContext(defineContext('test/allowed').type<{ token: string }>(), staticSource({ token: 't' }), { allowSecrets: true }),
        provideContext(defineContext('test/serialized').type<{ a: number }>(), staticSource({ a: 1 }), { serialize: (v) => v.a * 10 }),
      ],
    });
    const snapshot = hub.snapshot();
    expect(snapshot['core/session']?.value).toEqual({ status: 'authenticated', nested: { keep: 1 } });
    expect(snapshot['test/allowed']?.value).toEqual({ token: 't' });
    expect(snapshot['test/serialized']?.value).toBe(10);
    expect(onError.mock.calls[0]?.[0].code).toBe('SF-WK-012');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'context.secrets-stripped')).toBe(true);
  });

  it('secret helpers', () => {
    expect(findSecretPaths({ a: { password: 'x' }, list: [{ apiKey: 1 }] })).toEqual(['a.password', 'list.0.apiKey']);
    expect(stripSecrets([{ Authorization: 'b', ok: 1 }])).toEqual([{ ok: 1 }]);
    expect(stripSecrets(3)).toBe(3);
  });
});

describe('telemetry forwarding', () => {
  it('batches worker records and re-emits them on the main thread tagged with the worker id', async () => {
    const { main, worker } = links();
    const workerTelemetry = createTelemetry({ defaultLevel: 'debug' });
    const forwarding = createForwardingSink(worker);
    workerTelemetry.addSink(forwarding);

    const mainSink = createMemorySink();
    const mainTelemetry = createTelemetry({ defaultLevel: 'debug' });
    const mainTelemetrySink = createMemorySink();
    mainTelemetry.addSink(mainTelemetrySink);
    receiveForwardedTelemetry(main, { sink: mainSink, telemetry: mainTelemetry }, 'test/worker');

    const span = workerTelemetry.span('doc.apply', { subsystem: 'document/engine' });
    workerTelemetry.event('doc.changed', { subsystem: 'document/engine', parent: span });
    workerTelemetry.record(metric.counter('document/ops'), 3);
    span.end();
    workerTelemetry.event('orphan', { subsystem: 'document/engine' });
    expect(forwarding.buffered).toBe(5);
    await tick();
    await tick();
    expect(mainSink.records.map((r) => r.type)).toEqual(['span-start', 'event', 'metric', 'span', 'event']);
    expect(mainSink.records.every((r) => r.attrs['worker.id'] === 'test/worker')).toBe(true);
    const names = mainTelemetrySink.records.map((r: TelemetryRecord) => (r.type === 'metric' ? r.metric : r.type === 'event' ? r.name : r.type));
    expect(names).toEqual(['doc.changed', 'document/ops', 'worker.span', 'orphan']);
    const joined = mainTelemetrySink.records.find((r) => r.type === 'event' && r.name === 'doc.changed');
    expect(joined?.type === 'event' && joined.traceId).toBe(span.context?.traceId);
  });

  it('drops the oldest records beyond the limit and reports drops', async () => {
    const { main, worker } = links();
    const forwarding = createForwardingSink(worker, { limit: 2, schedule: () => undefined });
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(forwarding);
    for (let i = 0; i < 4; i += 1) telemetry.event(`e${i}`, { subsystem: 'test/x' });
    const mainTelemetry = createTelemetry({ defaultLevel: 'debug' });
    const sink = createMemorySink();
    mainTelemetry.addSink(sink);
    receiveForwardedTelemetry(main, { telemetry: mainTelemetry }, 'w');
    forwarding.flush();
    main.send('sf/telemetry', { nope: true });
    await tick();
    const names = sink.records.map((r) => (r.type === 'event' ? r.name : r.type));
    expect(names).toEqual(['e2', 'e3', 'worker.telemetry-dropped']);
  });
});

describe('token broker', () => {
  it('performs authenticated calls on the owning side; workers never see tokens', async () => {
    const { main, worker } = links();
    const execute = vi.fn(async (call: { operation: string }) => ok({ status: 200, body: { op: call.operation, auth: 'attached-by-owner' } }));
    createTokenBroker({ execute, allow: (call) => call.operation !== 'admin/delete' }).attach(main);
    const client = createBrokerClient(worker);
    const result = await client.call({ operation: 'data/docs.list', url: '/api/docs', method: 'GET' });
    expect(result).toEqual(ok({ status: 200, body: { op: 'data/docs.list', auth: 'attached-by-owner' } }));
    const denied = await client.call({ operation: 'admin/delete' });
    expect(!denied.ok && denied.error.code).toBe(BrokerDeniedError.code);
    const smuggled = await client.call({ operation: 'data/x', headers: { Authorization: 'Bearer stolen' } });
    expect(!smuggled.ok && smuggled.error.code).toBe('SF-WK-011');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('passes owner-side failures through and detaches with the link', async () => {
    const { main, worker } = links();
    const detach = createTokenBroker({ execute: async () => err(BrokerDeniedError({ message: 'expired' })) }).attach(main);
    const client = createBrokerClient(worker);
    const failed = await client.call({ operation: 'data/x' });
    expect(!failed.ok && failed.error.message).toBe('expired');
    detach();
    const gone = await client.call({ operation: 'data/x' });
    expect(!gone.ok && gone.error.code).toBe('SF-WK-008');
  });
});

describe('leader election', () => {
  function fakeLocks(): LockManagerLike & { holders: number } {
    const queue: { callback: (lock: unknown) => Promise<unknown>; signal?: AbortSignal; resolve: (v: unknown) => void }[] = [];
    let held = false;
    const state = { holders: 0 };
    const next = (): void => {
      if (held) return;
      const entry = queue.shift();
      if (entry === undefined) return;
      held = true;
      state.holders += 1;
      void entry.callback({}).then((value) => {
        held = false;
        entry.resolve(value);
        next();
      });
    };
    return Object.assign(state, {
      request(_name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<unknown>) {
        return new Promise<unknown>((resolve, reject) => {
          const entry = { callback, resolve, ...(options.signal === undefined ? {} : { signal: options.signal }) };
          options.signal?.addEventListener('abort', () => {
            const i = queue.indexOf(entry);
            if (i >= 0) {
              queue.splice(i, 1);
              reject(new DOMException('aborted', 'AbortError'));
            }
          });
          queue.push(entry);
          next();
        });
      },
    });
  }

  it('one tab leads; the next takes over when the leader resigns', async () => {
    const locks = fakeLocks();
    const tabA = createLeaderElection({ name: 'test/owner', locks });
    const tabB = createLeaderElection({ name: 'test/owner', locks });
    expect(tabA.mode).toBe('web-locks');
    expect((await tabA.whenLeader()).ok).toBe(true);
    await tick();
    expect(tabA.isLeader).toBe(true);
    expect(tabB.isLeader).toBe(false);
    const changes: boolean[] = [];
    tabB.onChange((v) => changes.push(v));
    const becomesLeader = tabB.whenLeader();
    tabA.resign();
    expect(tabA.isLeader).toBe(false);
    expect((await becomesLeader).ok).toBe(true);
    expect(changes).toEqual([true]);
    expect((await tabA.whenLeader()).ok).toBe(false);
  });

  it('falls back to single-tab mode without Web Locks', async () => {
    const election = createLeaderElection({ name: 'test/owner', locks: null });
    expect(election.mode).toBe('single-tab');
    expect(election.isLeader).toBe(true);
    expect((await election.whenLeader()).ok).toBe(true);
    expect(detectLocks() === undefined || typeof detectLocks()?.request === 'function').toBe(true);
  });

  it('waiting is abortable; the election signal resigns', async () => {
    const locks = fakeLocks();
    const controller = new AbortController();
    createLeaderElection({ name: 'test/x', locks });
    const follower = createLeaderElection({ name: 'test/x', locks, signal: controller.signal });
    const waitController = new AbortController();
    const waiting = follower.whenLeader(waitController.signal);
    waitController.abort();
    expect((await waiting).ok).toBe(false);
    controller.abort();
    await tick();
    expect(follower.isLeader).toBe(false);
  });
});

describe('schedulers', () => {
  it('frameScheduler flushes once via rAF or the timeout fallback', async () => {
    vi.useFakeTimers();
    try {
      const flush = vi.fn();
      frameScheduler(10)(flush);
      await vi.advanceTimersByTimeAsync(50);
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
