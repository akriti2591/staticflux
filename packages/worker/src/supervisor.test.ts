import { box, createInjector, createMemorySink, createTelemetry, err, ok, type Result, token } from '@staticflux/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoreContexts,
  createContextHub,
  createJsonSource,
  createPortPair,
  createPublisher,
  createReplica,
  defineProtocol,
  defineReplica,
  event,
  inMemorySpawner,
  type PortPair,
  provideContext,
  reactiveSource,
  request,
  runWorker,
  type RunWorkerOptions,
  SpawnFailedError,
  type Spawner,
  createSupervisedWorker,
  supervisedWorkerUnit,
  type SupervisedWorker,
  type WorkerRuntime,
  type WorkerSpec,
  WorkerLifecycle,
  contextHubUnit,
  ContextHubToken,
  tokenBrokerUnit,
  TokenBrokerToken,
  staticSource,
} from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i += 1) await tick();
};

const Proto = defineProtocol({
  id: 'test/svc',
  version: 1,
  requests: {
    echo: request<{ text: string }, { text: string; attempt: number; epoch: number }>({ idempotent: true }),
    write: request<{ n: number }, number>(),
    hang: request<null, null>({ idempotent: true }),
    session: request<null, string>({ idempotent: true }),
    log: request<null, null>(),
  },
  events: { tick: event<{ attempt: number }>() },
});
type P = typeof Proto;

interface Harness {
  readonly pairs: PortPair[];
  readonly runtimes: WorkerRuntime<P>[];
  readonly hooks: { pause: number; resume: number; refresh: number[]; shutdown: number; setupSession: (string | undefined)[] };
  readonly spawn: Spawner;
}

function harness(overrides: Partial<RunWorkerOptions<P>> = {}): Harness {
  const pairs: PortPair[] = [];
  const runtimes: WorkerRuntime<P>[] = [];
  const hooks = { pause: 0, resume: 0, refresh: [] as number[], shutdown: 0, setupSession: [] as (string | undefined)[] };
  const spawn = inMemorySpawner((port, context) => {
    pairs.push(context.pair);
    void runWorker<P>({
      port,
      protocol: Proto,
      contexts: [CoreContexts.session],
      handlers: (runtime) => {
        // Feature code: core contexts are already present here.
        hooks.setupSession.push(runtime.contexts.get(CoreContexts.session)?.status);
        return {
          echo: ({ text }) => ok({ text, attempt: runtime.attempt, epoch: runtime.epoch }),
          write: ({ n }) => ok(n * 2),
          hang: () => new Promise<Result<null>>(() => undefined),
          session: () => ok(runtime.contexts.get(CoreContexts.session)?.status ?? 'none'),
          log: () => {
            runtime.telemetry.event('worker.did-work', { subsystem: 'test/worker' });
            return ok(null);
          },
        };
      },
      setup: (runtime) => {
        runtime.emit('tick', { attempt: runtime.attempt });
        return ok();
      },
      onPause: () => {
        hooks.pause += 1;
      },
      onResume: () => {
        hooks.resume += 1;
      },
      onRefresh: (epoch) => {
        hooks.refresh.push(epoch);
      },
      onShutdown: () => {
        hooks.shutdown += 1;
      },
      ...overrides,
    }).then((result) => {
      if (result.ok) runtimes.push(result.value);
    });
  });
  return { pairs, runtimes, hooks, spawn };
}

const session = box({ status: 'authenticated' });
const contexts = () =>
  createContextHub({ entries: [provideContext(CoreContexts.session, reactiveSource(() => session.get()))] });

function supervise(h: Harness, spec: Partial<WorkerSpec<P>> = {}): SupervisedWorker<P> {
  return createSupervisedWorker<P>({
    id: 'test/worker',
    protocol: Proto,
    spawn: h.spawn,
    contexts: contexts(),
    heartbeat: false,
    restart: { baseDelayMs: 0, jitter: 'none' },
    fallback: { description: 'run in-thread' },
    ...spec,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('worker lifecycle machine', () => {
  it('matches docs/LIFECYCLES.md §3', () => {
    expect(WorkerLifecycle.transitions.ready).toMatchObject({ work: 'busy', 'heartbeat-missed': 'unresponsive', drain: 'draining' });
    expect(WorkerLifecycle.transitions.unresponsive).toMatchObject({ crash: 'crashed' });
    expect(WorkerLifecycle.transitions.crashed).toEqual({ respawn: 'respawning', 'give-up': 'failed', drain: 'draining' });
    expect(WorkerLifecycle.transitions.respawning?.spawn).toBe('spawning');
    expect(WorkerLifecycle.terminal).toEqual(['terminated']);
  });
});

describe('supervised worker', () => {
  it('spawning → handshaking → ready; core contexts arrive before feature code', async () => {
    const h = harness();
    const worker = supervise(h);
    const states: string[] = [];
    worker.onStateChange((r) => states.push(r.to));
    expect(worker.state).toBe('idle');
    expect((await worker.start()).ok).toBe(true);
    expect(states).toEqual(['spawning', 'handshaking', 'ready']);
    expect(h.hooks.setupSession).toEqual(['authenticated']);
    expect(worker.id).toBe('test/worker');
    expect(worker.dependsOn).toEqual([]);
    expect(worker.link).toBeDefined();
    const echo = await worker.request('echo', { text: 'hi' });
    expect(echo).toEqual(ok({ text: 'hi', attempt: 1, epoch: 0 }));
    expect(states).toContain('busy');
    expect(worker.state).toBe('ready');
    expect((await worker.start()).ok).toBe(true);
  });

  it('keeps core contexts in sync after spawn', async () => {
    const h = harness();
    const worker = supervise(h);
    await worker.start();
    session.set({ status: 'guest' });
    await settle();
    expect(await worker.request('session', null)).toEqual(ok('guest'));
    session.set({ status: 'authenticated' });
  });

  it('pause/resume propagate to the worker; requests queue while paused', async () => {
    const h = harness();
    const worker = supervise(h);
    await worker.start();
    worker.pause();
    worker.pause();
    await settle();
    expect(h.hooks.pause).toBe(1);
    expect(worker.paused).toBe(true);
    let done = false;
    const pending = worker.request('write', { n: 2 }).then((r) => {
      done = true;
      return r;
    });
    await settle();
    expect(done).toBe(false);
    expect(worker.inspect().queued).toBe(1);
    worker.resume();
    worker.resume();
    expect(await pending).toEqual(ok(4));
    await settle();
    expect(h.hooks.resume).toBe(1);
  });

  it('refresh(epoch) reaches the worker and stamps envelopes', async () => {
    const h = harness();
    const worker = supervise(h);
    expect((await worker.refresh(1)).ok).toBe(true); // before start: stored only
    await worker.start({ epoch: 2 });
    expect((await worker.request('echo', { text: 'x' })).ok && worker.epoch).toBe(2);
    expect((await worker.refresh(3)).ok).toBe(true);
    expect(h.hooks.refresh).toEqual([3]);
    const echo = await worker.request('echo', { text: 'x' });
    expect(echo.ok && echo.value.epoch).toBe(3);
  });

  it('crash → respawn: idempotent in-flight requests retry, others fail with SF-WK-004', async () => {
    const h = harness();
    const worker = supervise(h);
    const telemetry = createTelemetry();
    void telemetry;
    await worker.start();
    const states: string[] = [];
    worker.onStateChange((r) => states.push(r.to));
    h.pairs[0]?.b.freeze(); // requests reach the port but are not handled yet
    const retried = worker.request('echo', { text: 'again' });
    const lost = worker.request('write', { n: 1 });
    await settle();
    expect(worker.inspect().inFlight).toBe(2);
    h.pairs[0]?.crash(new Error('OOM'));
    const lostResult = await lost;
    expect(!lostResult.ok && lostResult.error.code).toBe('SF-WK-004');
    expect(await retried).toEqual(ok({ text: 'again', attempt: 2, epoch: 0 }));
    expect(states.slice(0, 6)).toEqual(['crashed', 'respawning', 'spawning', 'handshaking', 'ready', 'busy']);
    expect(worker.inspect()).toMatchObject({ attempt: 2, restarts: 1, state: 'ready' });
    expect(h.hooks.setupSession).toEqual(['authenticated', 'authenticated']);
  });

  it('protocol events survive respawns', async () => {
    const h = harness();
    const worker = supervise(h);
    const ticks: number[] = [];
    worker.on('tick', (payload) => ticks.push(payload.attempt));
    await worker.start();
    h.pairs[0]?.crash();
    await worker.whenReady();
    await settle();
    expect(ticks).toEqual([1, 2]);
  });

  it('gives up after the restart intensity: failed + declared fallback (SF-WK-005); restart() recovers', async () => {
    let failing = true;
    const h = harness();
    const spawn: Spawner = (context) => (failing ? err(SpawnFailedError()) : h.spawn(context));
    const activate = vi.fn();
    const deactivate = vi.fn();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const worker = supervise(h, { spawn, restart: { intensity: 2, baseDelayMs: 0, jitter: 'none' }, fallback: { description: 'in-thread engine', activate, deactivate }, telemetry });
    const started = await worker.start();
    expect(!started.ok && started.error.code).toBe('SF-WK-005');
    expect(worker.state).toBe('failed');
    expect(activate.mock.calls[0]?.[0].code).toBe('SF-WK-005');
    expect(worker.inspect()).toMatchObject({ restarts: 2, fallback: { description: 'in-thread engine', active: true } });
    const rejected = await worker.request('echo', { text: 'x' });
    expect(!rejected.ok && rejected.error.code).toBe('SF-WK-005');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'worker.failed' && r.level === 'critical')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'worker/restarts')).toBe(true);
    failing = false;
    expect((await worker.restart()).ok).toBe(true);
    expect(deactivate).toHaveBeenCalledOnce();
    expect(worker.state).toBe('ready');
    expect((await worker.restart()).ok).toBe(true);
  });

  it('heartbeat: missed → unresponsive → recovers; too many misses → crashed → respawned', async () => {
    vi.useFakeTimers();
    const h = harness();
    const worker = supervise(h, { heartbeat: { intervalMs: 100, timeoutMs: 50, maxMissed: 2 } });
    const started = worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect((await started).ok).toBe(true);
    h.pairs[0]?.b.freeze();
    await vi.advanceTimersByTimeAsync(160);
    expect(worker.state).toBe('unresponsive');
    h.pairs[0]?.b.thaw();
    await vi.advanceTimersByTimeAsync(110);
    expect(worker.state).toBe('ready');
    h.pairs[0]?.b.freeze();
    await vi.advanceTimersByTimeAsync(400);
    expect(worker.inspect().attempt).toBe(2);
    expect(worker.lastError?.code).toBe('SF-WK-017');
    expect(worker.state).toBe('ready');
    await worker.stop();
  });

  it('heartbeat skips judging intervals when our own thread was frozen (late timer)', async () => {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const clock = {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const t = { at: now + ms, fn };
        timers.push(t);
        return t;
      },
      clearTimeout: (handle: unknown) => {
        const i = timers.indexOf(handle as never);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const h = harness();
    const worker = supervise(h, { clock, heartbeat: { intervalMs: 100, timeoutMs: 50, maxMissed: 1 } });
    void worker.start();
    await settle();
    expect(worker.state).toBe('ready');
    h.pairs[0]?.b.freeze();
    // The tab was frozen for 10 s: the heartbeat timer fires very late.
    now = 10_000;
    const due = timers.filter((t) => t.at <= now);
    for (const t of due) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    await settle();
    expect(worker.state).toBe('ready');
    expect(worker.inspect().attempt).toBe(1);
  });

  it('handshake timeout (SF-WK-003) counts as a crash', async () => {
    const silent: Spawner = () => {
      const pair = createPortPair();
      return ok({ port: pair.a, terminate: () => pair.close() });
    };
    const worker = createSupervisedWorker<P>({
      id: 'test/silent',
      protocol: Proto,
      spawn: silent,
      heartbeat: false,
      handshakeTimeoutMs: 10,
      restart: { intensity: 0 },
      fallback: { description: 'none' },
    });
    const result = await worker.start();
    expect(!result.ok && result.error.code).toBe('SF-WK-005');
    expect((result.ok ? undefined : (result.error.cause as { code?: string } | undefined))?.code).toBe('SF-WK-003');
  });

  it('protocol mismatch (SF-WK-018) fails the handshake', async () => {
    const h = harness({ protocol: { ...Proto, version: 2 } });
    const worker = supervise(h, { restart: { intensity: 0 } });
    const result = await worker.start();
    expect(!result.ok && (result.error.cause as { code?: string }).code).toBe('SF-WK-018');
  });

  it('missing required core context fails the handshake', async () => {
    const h = harness();
    const worker = supervise(h, { contexts: createContextHub({ entries: [] }), restart: { intensity: 0 } });
    const result = await worker.start();
    expect(!result.ok && (result.error.cause as { code?: string }).code).toBe('SF-WK-008');
  });

  it('stop drains (worker onShutdown) → terminated; later requests are rejected (SF-WK-010)', async () => {
    const h = harness();
    const worker = supervise(h);
    await worker.start();
    const states: string[] = [];
    worker.onStateChange((r) => states.push(r.to));
    expect((await worker.stop('test')).ok).toBe(true);
    expect(states).toEqual(['draining', 'terminated']);
    expect(h.hooks.shutdown).toBe(1);
    const after = await worker.request('echo', { text: 'x' });
    expect(!after.ok && after.error.code).toBe('SF-WK-010');
    expect((await worker.whenReady()).ok).toBe(false);
    expect((await worker.stop()).ok).toBe(true);
  });

  it('stop from idle and during respawn', async () => {
    const idle = supervise(harness());
    expect((await idle.stop()).ok).toBe(true);
    expect(idle.state).toBe('terminated');

    const h = harness();
    const worker = supervise(h, { restart: { baseDelayMs: 10_000, jitter: 'none' } });
    await worker.start();
    h.pairs[0]?.crash();
    await settle();
    expect(worker.state).toBe('respawning');
    const waiting = worker.whenReady();
    expect((await worker.stop()).ok).toBe(true);
    expect(worker.state).toBe('terminated');
    expect((await waiting).ok).toBe(false);
  });

  it('queued requests are abortable; aborted signals are rejected immediately', async () => {
    const h = harness();
    const worker = supervise(h);
    const controller = new AbortController();
    const queued = worker.request('echo', { text: 'x' }, { signal: controller.signal });
    controller.abort();
    expect((await queued).ok).toBe(false);
    const already = await worker.request('echo', { text: 'x' }, { signal: controller.signal });
    expect(!already.ok && already.error.kind).toBe('aborted');
    const readyAbort = new AbortController();
    readyAbort.abort();
    expect((await worker.whenReady(readyAbort.signal)).ok).toBe(false);
    await worker.start();
    await worker.stop();
  });

  it('forwards worker telemetry into the main timeline (R11.6)', async () => {
    const h = harness();
    const sink = createMemorySink();
    const worker = supervise(h, { telemetryTarget: { sink } });
    await worker.start();
    await worker.request('log', null);
    await settle();
    const forwarded = sink.records.find((r) => r.type === 'event' && r.name === 'worker.did-work');
    expect(forwarded?.attrs['worker.id']).toBe('test/worker');
  });
});

describe('replication across respawns', () => {
  interface Doc {
    readonly title: string;
    readonly edits: number;
  }
  type DocIntents = { readonly rename: { readonly args: string; readonly result: number } };
  const DocReplica = defineReplica('test/doc').type<Doc, DocIntents>();
  const SettingsReplica = defineReplica('test/settings').type<{ theme: string }>();

  it('worker-owned store → main replica; rehydrates from the last archive after a crash', async () => {
    let archive: Doc | undefined;
    const settings = createJsonSource({ theme: 'dark' });
    const settingsPublisher = createPublisher({ definition: SettingsReplica, source: settings });
    const workerSawTheme: string[] = [];
    const h = harness({
      setup: async (runtime) => {
        const initial = (runtime.rehydrate as Doc | undefined) ?? { title: 'untitled', edits: 0 };
        const source = createJsonSource<Doc>(initial, {
          rename: (args, api) => {
            const applied = api.apply([
              { op: 'replace', path: ['title'], value: args },
              { op: 'replace', path: ['edits'], value: api.state.edits + 1 },
            ]);
            return applied.ok ? ok(api.state.edits) : applied;
          },
        });
        source.onPatches(() => {
          archive = source.state; // stands in for "send archive to main / persist"
        });
        runtime.publish(createPublisher({ definition: DocReplica, source }));
        const theme = await runtime.replicate(SettingsReplica);
        if (theme.ok) workerSawTheme.push(theme.value.state.theme);
        return ok();
      },
    });
    const replica = createReplica(DocReplica);
    const worker = supervise(h, { replicas: [replica], publishers: [settingsPublisher], rehydrate: () => archive });
    expect((await worker.start()).ok).toBe(true);
    expect(replica.state).toEqual({ title: 'untitled', edits: 0 });
    expect(workerSawTheme).toEqual(['dark']);
    expect(await replica.intent('rename', 'Draft')).toEqual(ok(1));
    expect(replica.state.title).toBe('Draft');

    const firstEpoch = replica.epoch;
    h.pairs[0]?.crash();
    expect(replica.status).toBe('detached');
    expect(replica.state.title).toBe('Draft'); // stale but readable while respawning
    expect((await worker.whenReady()).ok).toBe(true);
    expect(replica.status).toBe('live');
    expect(replica.epoch).not.toBe(firstEpoch);
    expect(replica.state).toEqual({ title: 'Draft', edits: 1 });
    expect(await replica.intent('rename', 'Final')).toEqual(ok(2));
    expect(workerSawTheme).toEqual(['dark', 'dark']);
  });
});

describe('DI units', () => {
  it('supervisedWorkerUnit starts on init and stops with its scope', async () => {
    const h = harness();
    const WorkerToken = token('test/worker').type<SupervisedWorker<P>>();
    const injector = createInjector({
      units: [
        supervisedWorkerUnit({
          id: 'test/worker-unit',
          provides: WorkerToken,
          description: 'test worker',
          critical: false,
          spec: () => ({
            id: 'test/worker',
            protocol: Proto,
            spawn: h.spawn,
            contexts: contexts(),
            heartbeat: false,
            fallback: { description: 'none' },
          }),
        }),
        contextHubUnit({ id: 'test/hub-unit', entries: () => [provideContext(CoreContexts.flags, staticSource({}))] }),
        tokenBrokerUnit({ id: 'test/broker-unit', scope: 'app', broker: () => ({ execute: async () => ok({ status: 204 }) }) }),
      ],
    });
    const worker = await injector.get(WorkerToken);
    expect(worker.ok && worker.value.state).toBe('ready');
    const hub = await injector.get(ContextHubToken);
    expect(hub.ok && hub.value.ids).toEqual(['core/flags']);
    expect((await injector.get(TokenBrokerToken)).ok).toBe(true);
    await injector.scope.dispose();
    expect(worker.ok && worker.value.state).toBe('terminated');
  });
});
