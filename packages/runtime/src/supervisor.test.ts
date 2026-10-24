import {
  createDeferred,
  createInjector,
  createMemorySink,
  createTelemetry,
  defineError,
  err,
  ok,
  type Result,
  sleep,
  token,
  unit,
} from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type AppState,
  createSupervisor,
  defineSubsystem,
  type Subsystem,
  type SubsystemContext,
  type SubsystemState,
  type SupervisorOptions,
} from './index.js';

const Crash = defineError('SF-TEST-CRASH', 'unavailable', 'crash', 'test');
const noSleep = vi.fn(async (_ms: number, signal?: AbortSignal): Promise<Result<void>> =>
  signal?.aborted === true ? err(Crash()) : ok(),
);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function recorder(): { log: string[]; sub(id: `${string}/${string}`, extra?: Partial<Subsystem>): Subsystem } {
  const log: string[] = [];
  return {
    log,
    sub: (id, extra = {}) =>
      defineSubsystem({
        id,
        start: () => {
          log.push(`start:${id}`);
        },
        pause: () => {
          log.push(`pause:${id}`);
        },
        resume: () => {
          log.push(`resume:${id}`);
        },
        stop: (reason) => {
          log.push(`stop:${id}:${reason}`);
        },
        ...extra,
      }),
  };
}

function make(options: SupervisorOptions = {}) {
  return createSupervisor({ sleep: noSleep, random: () => 0.5, ...options });
}

describe('supervisor: boot', () => {
  it('starts critical subsystems before core-ready, the rest after, in dependency order', async () => {
    const { log, sub } = recorder();
    const states: AppState[] = [];
    const supervisor = make({
      subsystems: [
        sub('test/stores', { dependsOn: ['test/transport'] }),
        sub('test/transport', { critical: true }),
        sub('test/telemetry', { critical: true }),
      ],
    });
    supervisor.onTransition(({ to }) => states.push(to));
    expect(supervisor.state).toBe('starting');
    const result = await supervisor.start();
    expect(result).toEqual(ok());
    await supervisor.settled();
    expect(states).toEqual(['core-ready', 'running']);
    expect(log.indexOf('start:test/transport')).toBeLessThan(log.indexOf('start:test/stores'));
    expect(supervisor.stateOf('test/stores')).toBe('running');
    expect(supervisor.inspect().map((i) => i.state)).toEqual(['running', 'running', 'running']);
  });

  it('runs the core phase first and fails boot (SF-APP-006) when it fails', async () => {
    const core = vi.fn(async () => err(Crash()));
    const supervisor = make({ core });
    const result = await supervisor.start();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SF-APP-006');
      expect((result.error.cause as { code: string }).code).toBe('SF-TEST-CRASH');
    }
    expect(core).toHaveBeenCalledWith(expect.objectContaining({ reason: 'boot' }));
    expect(supervisor.state).toBe('terminated');
  });

  it('fails boot when a critical subsystem gives up', async () => {
    const supervisor = make({
      subsystems: [{ id: 'test/db', critical: true, restart: { maxRestarts: 1, windowMs: 1000 }, start: () => err(Crash()) }],
    });
    const result = await supervisor.start();
    expect(!result.ok && result.error.code).toBe('SF-APP-006');
    expect(supervisor.state).toBe('terminated');
  });

  it.each([
    ['unknown dependency', [{ id: 'test/a', dependsOn: ['test/missing'], start: () => undefined }]],
    [
      'cycle',
      [
        { id: 'test/a', dependsOn: ['test/b'], start: () => undefined },
        { id: 'test/b', dependsOn: ['test/a'], start: () => undefined },
      ],
    ],
    [
      'critical depends on non-critical',
      [
        { id: 'test/a', critical: true, dependsOn: ['test/b'], start: () => undefined },
        { id: 'test/b', start: () => undefined },
      ],
    ],
  ] as const)('rejects an invalid graph: %s (SF-APP-005)', async (_name, subsystems) => {
    const supervisor = make({ subsystems: subsystems as unknown as Subsystem[] });
    const result = await supervisor.start();
    expect(!result.ok && result.error.code).toBe('SF-APP-005');
    expect(supervisor.state).toBe('terminated');
  });

  it('rejects duplicate registration and a second start', async () => {
    const supervisor = make();
    expect(supervisor.register({ id: 'test/a', start: () => undefined }).ok).toBe(true);
    const dup = supervisor.register({ id: 'test/a', start: () => undefined });
    expect(!dup.ok && dup.error.code).toBe('SF-APP-005');
    await supervisor.start();
    const again = await supervisor.start();
    expect(!again.ok && again.error.code).toBe('SF-APP-002');
  });

  it('starts late-registered subsystems immediately; rejects late critical ones', async () => {
    const supervisor = make();
    await supervisor.start();
    const start = vi.fn();
    expect(supervisor.register({ id: 'test/late', start }).ok).toBe(true);
    await supervisor.settled();
    expect(start).toHaveBeenCalled();
    expect(supervisor.stateOf('test/late')).toBe('running');
    const critical = supervisor.register({ id: 'test/late-critical', critical: true, start: () => undefined });
    expect(!critical.ok && critical.error.code).toBe('SF-APP-005');
    const unknownDep = supervisor.register({ id: 'test/late-2', dependsOn: ['test/nope'], start: () => undefined });
    expect(unknownDep.ok).toBe(false);
  });

  it('fails a start attempt that exceeds startTimeoutMs', async () => {
    const supervisor = createSupervisor({
      subsystems: [
        {
          id: 'test/slow',
          startTimeoutMs: 5,
          restart: { mode: 'temporary', maxRestarts: 0, windowMs: 1 },
          start: () => new Promise<void>(() => undefined),
        },
      ],
    });
    await supervisor.start();
    await supervisor.settled();
    expect(supervisor.stateOf('test/slow')).toBe('given-up');
    const info = supervisor.inspect()[0];
    expect((info?.error?.['code'] as string | undefined) ?? '').toBe('SF-APP-004');
  });
});

describe('supervisor: restart policy', () => {
  it('restarts with exponential backoff and a fresh scope per run', async () => {
    let attempts = 0;
    const scopes: SubsystemContext[] = [];
    const delays: number[] = [];
    const supervisor = make({
      sleep: async (ms) => {
        delays.push(ms);
        return ok();
      },
      subsystems: [
        {
          id: 'test/flaky',
          restart: { maxRestarts: 5, windowMs: 10_000, baseDelayMs: 100, jitter: 'none' },
          start: (ctx) => {
            scopes.push(ctx);
            attempts += 1;
            return attempts < 3 ? err(Crash()) : ok();
          },
        },
      ],
    });
    await supervisor.start();
    await supervisor.settled();
    expect(supervisor.stateOf('test/flaky')).toBe('running');
    expect(delays).toEqual([100, 200]);
    expect(scopes.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(scopes[0]?.scope.disposed).toBe(true);
    expect(scopes[2]?.scope.disposed).toBe(false);
    expect(supervisor.inspect()[0]?.restarts).toBe(2);
  });

  it('gives up after max intensity → app degraded, dependents notified', async () => {
    const notified: [string, SubsystemState][] = [];
    const supervisor = make({
      subsystems: [
        { id: 'test/worker', restart: { maxRestarts: 2, windowMs: 10_000 }, start: () => err(Crash()) },
        {
          id: 'test/editor',
          start: () => undefined,
          onDependencyState: (dep, state) => notified.push([dep, state]),
        },
      ],
    });
    await supervisor.start();
    await supervisor.settled();
    expect(supervisor.stateOf('test/worker')).toBe('given-up');
    expect(supervisor.state).toBe('degraded');
    expect(supervisor.impaired()).toEqual(['test/worker']);
    expect(supervisor.inspect()[0]?.restarts).toBe(2);
    // editor has no dependsOn on worker → not notified
    expect(notified).toEqual([]);
  });

  it('notifies dependents on failure, give-up and recovery', async () => {
    const notified: string[] = [];
    let ctx: SubsystemContext | undefined;
    let fails = 0;
    const supervisor = make({
      subsystems: [
        {
          id: 'test/transport',
          restart: { maxRestarts: 3, windowMs: 10_000 },
          start: (c) => {
            ctx = c;
            return fails-- > 0 ? err(Crash()) : ok();
          },
        },
        {
          id: 'test/store',
          dependsOn: ['test/transport'],
          start: () => undefined,
          onDependencyState: (dep, state) => notified.push(`${dep}:${state}`),
        },
      ],
    });
    await supervisor.start();
    await supervisor.settled();
    fails = 1;
    ctx?.fail(Crash());
    await supervisor.settled();
    await tick();
    expect(notified).toEqual(['test/transport:failed', 'test/transport:failed', 'test/transport:running']);
    expect(supervisor.state).toBe('running');
  });

  it('runtime failure (ctx.fail) restarts; stale contexts are ignored', async () => {
    const contexts: SubsystemContext[] = [];
    const supervisor = make({ subsystems: [{ id: 'test/ws', start: (c) => void contexts.push(c) }] });
    await supervisor.start();
    await supervisor.settled();
    contexts[0]?.fail(Crash());
    await tick();
    await supervisor.settled();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.signal.aborted).toBe(true);
    contexts[0]?.fail(Crash()); // stale generation: ignored
    await tick();
    expect(contexts).toHaveLength(2);
    expect(supervisor.stateOf('test/ws')).toBe('running');
  });

  it('temporary subsystems give up on first failure', async () => {
    const supervisor = make({
      subsystems: [{ id: 'test/once', restart: { mode: 'temporary', maxRestarts: 5, windowMs: 1000 }, start: () => err(Crash()) }],
    });
    await supervisor.start();
    await supervisor.settled();
    expect(supervisor.stateOf('test/once')).toBe('given-up');
  });

  it('only counts restarts inside the window', async () => {
    let time = 0;
    const contexts: SubsystemContext[] = [];
    const supervisor = make({
      now: () => time,
      subsystems: [{ id: 'test/w', restart: { maxRestarts: 1, windowMs: 100 }, start: (c) => void contexts.push(c) }],
    });
    await supervisor.start();
    await supervisor.settled();
    contexts.at(-1)?.fail(Crash());
    await supervisor.settled();
    expect(supervisor.stateOf('test/w')).toBe('running');
    time = 500; // previous restart left the window
    contexts.at(-1)?.fail(Crash());
    await supervisor.settled();
    expect(supervisor.stateOf('test/w')).toBe('running');
    contexts.at(-1)?.fail(Crash()); // second restart within window → give up
    await supervisor.settled();
    expect(supervisor.stateOf('test/w')).toBe('given-up');
    expect(supervisor.state).toBe('degraded');
  });
});

describe('supervisor: commands', () => {
  it('pause broadcasts in reverse order, resume forward; I-1 guard', async () => {
    const { log, sub } = recorder();
    const supervisor = make({ subsystems: [sub('test/a'), sub('test/b', { dependsOn: ['test/a'] })] });
    await supervisor.start();
    await supervisor.settled();
    log.length = 0;
    expect(await supervisor.pause()).toEqual(ok());
    expect(supervisor.state).toBe('paused');
    expect(log).toEqual(['pause:test/b', 'pause:test/a']);
    const guard = supervisor.assertRunnable('fetch');
    expect(!guard.ok && guard.error.code).toBe('SF-APP-001');
    const refresh = await supervisor.refresh();
    expect(!refresh.ok && refresh.error.code).toBe('SF-APP-002');
    expect(supervisor.can('resume')).toBe(true);
    log.length = 0;
    await supervisor.resume();
    expect(log).toEqual(['resume:test/a', 'resume:test/b']);
    expect(supervisor.state).toBe('running');
    expect(supervisor.assertRunnable()).toEqual(ok());
  });

  it('whenRunnable queues reads until resume and rejects non-idempotent mutations', async () => {
    const supervisor = make();
    await supervisor.start();
    expect(await supervisor.whenRunnable({ kind: 'mutation' })).toEqual(ok());
    await supervisor.pause();
    const rejected = await supervisor.whenRunnable({ kind: 'mutation' });
    expect(!rejected.ok && rejected.error.code).toBe('SF-APP-001');
    let released = false;
    const queued = supervisor.whenRunnable({ kind: 'read' }).then((r) => {
      released = true;
      return r;
    });
    const idempotent = supervisor.whenRunnable({ kind: 'mutation', idempotent: true });
    const controller = new AbortController();
    const cancelled = supervisor.whenRunnable({ kind: 'read' }, controller.signal);
    controller.abort();
    expect((await cancelled).ok).toBe(false);
    await tick();
    expect(released).toBe(false);
    await supervisor.resume();
    expect(await queued).toEqual(ok());
    expect(await idempotent).toEqual(ok());
  });

  it('custom paused-request policy and command policy via usePolicies', async () => {
    const supervisor = make();
    await supervisor.start();
    supervisor.usePolicies({ pausedRequest: () => 'reject', command: () => ({ allow: true }) });
    await supervisor.pause();
    expect((await supervisor.whenRunnable({ kind: 'read' })).ok).toBe(false);
    await supervisor.resume();
    expect(await supervisor.request({ command: 'reinitialize', source: 'shell/test' })).toEqual(ok());
    expect(supervisor.state).toBe('running');
  });

  it('request() is decided by the default command policy (R4.5)', async () => {
    const supervisor = make();
    await supervisor.start();
    expect(await supervisor.request({ command: 'refresh', source: 'auth/session' })).toEqual(ok());
    const denied = await supervisor.request({ command: 'shutdown', source: 'studio/desktop' });
    expect(!denied.ok && denied.error.code).toBe('SF-APP-003');
    expect(supervisor.state).toBe('running');
    expect(await supervisor.request({ command: 'pause', source: 'studio/desktop' })).toEqual(ok());
    expect(supervisor.state).toBe('paused');
  });

  it('abort fires one root signal, notifies subsystems, then installs a fresh signal', async () => {
    const aborted = vi.fn();
    const supervisor = make({ subsystems: [{ id: 'test/net', start: () => undefined, abort: aborted }] });
    await supervisor.start();
    await supervisor.settled();
    const before = supervisor.signal;
    await supervisor.abort('user cancelled');
    expect(before.aborted).toBe(true);
    expect(before.reason).toBe('user cancelled');
    expect(supervisor.signal.aborted).toBe(false);
    expect(aborted).toHaveBeenCalledWith('user cancelled', expect.anything());
    expect(supervisor.state).toBe('running');
  });

  it('abort during starting cancels boot and terminates', async () => {
    const gate = createDeferred<void>();
    const supervisor = make({
      core: async ({ signal }) => {
        await gate.promise;
        return signal.aborted ? err(Crash()) : ok();
      },
    });
    const boot = supervisor.start();
    expect(supervisor.can('abort')).toBe(true);
    expect(supervisor.can('pause')).toBe(false);
    const aborting = supervisor.abort();
    gate.resolve();
    await aborting;
    const result = await boot;
    expect(result.ok).toBe(false);
    expect(supervisor.state).toBe('terminated');
  });

  it('refresh bumps the injector epoch, refreshes epoch units and subsystems', async () => {
    const T = token('test/clock').type<{ n: number }>();
    let inits = 0;
    const injector = createInjector({
      units: [unit({ id: 'test/clock-unit', provides: T, scope: 'app', refreshOn: ['epoch'], create: () => ({ n: 0 }), init: () => ((inits += 1), ok()) })],
    });
    await injector.get(T);
    const epochs: number[] = [];
    const supervisor = make({ injector, subsystems: [{ id: 'test/s', start: () => undefined, refresh: (e) => void epochs.push(e) }] });
    await supervisor.start();
    await supervisor.settled();
    expect(supervisor.epoch).toBe(0);
    expect(await supervisor.refresh()).toEqual(ok());
    expect(supervisor.epoch).toBe(1);
    expect(injector.epoch).toBe(1);
    expect(epochs).toEqual([1]);
    expect(inits).toBe(2);
  });

  it('a failed subsystem refresh counts as a failure and restarts it', async () => {
    let starts = 0;
    const supervisor = make({
      subsystems: [{ id: 'test/s', start: () => void (starts += 1), refresh: () => err(Crash()) }],
    });
    await supervisor.start();
    await supervisor.settled();
    const result = await supervisor.refresh();
    expect(result.ok).toBe(false);
    expect(supervisor.epoch).toBe(1);
    await tick();
    await supervisor.settled();
    expect(starts).toBe(2);
  });

  it('reinitialize tears down in reverse order and re-boots (given-up subsystems get a fresh start)', async () => {
    const { log, sub } = recorder();
    let healthy = false;
    const core = vi.fn(() => ok());
    const supervisor = make({
      core,
      subsystems: [
        sub('test/a', { critical: true }),
        sub('test/b', { dependsOn: ['test/a'] }),
        sub('test/worker', { restart: { mode: 'temporary', maxRestarts: 0, windowMs: 1 }, start: () => (healthy ? ok() : err(Crash())) }),
      ],
    });
    await supervisor.start();
    await supervisor.settled();
    expect(supervisor.state).toBe('degraded');
    healthy = true;
    log.length = 0;
    const states: AppState[] = [];
    supervisor.onTransition(({ to }) => states.push(to));
    expect(await supervisor.reinitialize()).toEqual(ok());
    await supervisor.settled();
    expect(log.slice(0, 2)).toEqual(['stop:test/b:reinitialize', 'stop:test/a:reinitialize']);
    expect(log).toContain('start:test/a');
    expect(states).toEqual(['reinitializing', 'core-ready', 'running']);
    expect(core).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'reinitialize' }));
    expect(supervisor.stateOf('test/worker')).toBe('running');
    expect(supervisor.state).toBe('running');
    expect(supervisor.epoch).toBe(1);
  });

  it('shutdown stops in reverse order, runs onShutdown, terminates', async () => {
    const { log, sub } = recorder();
    const onShutdown = vi.fn();
    const supervisor = make({ onShutdown, subsystems: [sub('test/a'), sub('test/b', { dependsOn: ['test/a'] })] });
    await supervisor.start();
    await supervisor.settled();
    log.length = 0;
    const signal = supervisor.signal;
    expect(await supervisor.shutdown()).toEqual(ok());
    expect(log).toEqual(['stop:test/b:shutdown', 'stop:test/a:shutdown']);
    expect(onShutdown).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    expect(supervisor.state).toBe('terminated');
    expect(supervisor.inspect().map((i) => i.state)).toEqual(['stopped', 'stopped']);
    const after = await supervisor.whenRunnable({ kind: 'read' });
    expect(!after.ok && after.error.code).toBe('SF-APP-007');
    expect(supervisor.register({ id: 'test/c', start: () => undefined }).ok).toBe(false);
    expect((await supervisor.shutdown()).ok).toBe(false);
  });

  it('shutdown while paused releases queued requests with SF-APP-007', async () => {
    const supervisor = make();
    await supervisor.start();
    await supervisor.pause();
    const queued = supervisor.whenRunnable({ kind: 'read' });
    await supervisor.shutdown();
    const result = await queued;
    expect(!result.ok && result.error.code).toBe('SF-APP-007');
  });

  it('a stop() that hangs is abandoned after stopTimeoutMs', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const supervisor = createSupervisor({
      telemetry,
      subsystems: [{ id: 'test/hang', stopTimeoutMs: 5, start: () => undefined, stop: () => new Promise<void>(() => undefined) }],
    });
    await supervisor.start();
    await supervisor.settled();
    await supervisor.shutdown();
    expect(supervisor.state).toBe('terminated');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'subsystem.stop-timeout')).toBe(true);
  });

  it('a subsystem started while the app is paused is paused immediately (I-1)', async () => {
    const paused = vi.fn();
    let ctx: SubsystemContext | undefined;
    const supervisor = make({ subsystems: [{ id: 'test/s', start: (c) => void (ctx = c), pause: paused }] });
    await supervisor.start();
    await supervisor.settled();
    await supervisor.pause();
    expect(paused).toHaveBeenCalledTimes(1);
    ctx?.fail(Crash());
    await tick();
    // the restart waits for resume
    expect(supervisor.stateOf('test/s')).toBe('restarting');
    await supervisor.resume();
    await supervisor.settled();
    expect(supervisor.stateOf('test/s')).toBe('running');
    await sleep(0);
  });
});

describe('supervisor: telemetry', () => {
  it('emits lifecycle events for every app and subsystem transition', async () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const supervisor = make({ telemetry, subsystems: [{ id: 'test/a', start: () => undefined }] });
    await supervisor.start();
    await supervisor.settled();
    await supervisor.pause();
    const names = sink.records.filter((r) => r.type === 'event').map((r) => r.name);
    expect(names).toContain('lifecycle.app.starting→core-ready');
    expect(names).toContain('lifecycle.app.core-ready→running');
    expect(names).toContain('lifecycle.app.running→paused');
    expect(names).toContain('lifecycle.subsystem.idle→starting');
    expect(names).toContain('lifecycle.subsystem.starting→running');
    const spans = sink.records.filter((r) => r.type === 'span').map((r) => r.name);
    expect(spans).toContain('supervisor.boot');
    expect(spans).toContain('app.command');
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'runtime/core-ready')).toBe(true);
    const subsystems = new Set(sink.records.filter((r) => r.type === 'event').map((r) => (r as { subsystem: string }).subsystem));
    expect([...subsystems]).toEqual(['runtime/app']);
  });
});
