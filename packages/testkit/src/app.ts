/**
 * `bootTestApp` — run the real runtime `bootApp` with fakes:
 * recording telemetry, deterministic time (optional), a fake session (optional),
 * an in-memory router (when `routes` are given) and overrides at top precedence.
 *
 *   const t = await bootTestApp({ units: [...appUnits], routes: [home, doc], initialUrl: '/doc/1', session: { initial: 'ada' } });
 *   expect(t.router?.current?.route).toBe(doc);
 *   await t.session?.logout();
 *   t.expectNoViolations();
 *   await t.shutdown();
 *
 * Boot failures throw `SF-TEST-001` (cause = the boot error) so tests fail loudly.
 */
import { type Injector, type LevelName, type Registration, type Token, unit } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { type App, bootApp, createFrameScheduler, type FrameScheduler, FrameSchedulerToken, type Subsystem } from '@staticflux/runtime';
import {
  type AnyRoute,
  createMemoryHistory,
  HistoryAdapterToken,
  type MemoryHistory,
  type Router,
  RouterToken,
  routeUnit,
  routerSubsystemUnit,
  routerUnitWith,
  type RouterUnitOptions,
} from '@staticflux/router';
import { TestBootFailedError, TestResolveFailedError } from './errors.js';
import { asOverrides } from './injector.js';
import { createFakeSession, type FakeSession, type FakeSessionOptions } from './session.js';
import { createTestTelemetry, type TestTelemetry } from './telemetry.js';
import { createFakeTime, type FakeTime } from './time.js';

/** Runtime frame scheduler driven by fake time (frames, macrotasks, idle). */
export function fakeFrameSchedulerUnit(time: FakeTime) {
  return unit({
    id: 'testkit/fake-frame-scheduler-unit',
    provides: FrameSchedulerToken,
    scope: 'app',
    create: (_deps, ctx): FrameScheduler => {
      const scheduler = createFrameScheduler({ ...time.schedulerEnv, telemetry: ctx.telemetry });
      ctx.scope.defer(() => scheduler.dispose());
      return scheduler;
    },
    description: 'Frame scheduler on fake time (testkit).',
  });
}

export interface BootTestAppOptions {
  readonly units?: readonly Registration[];
  /** Bound at `experiment` precedence (beat every regular binding). */
  readonly overrides?: readonly Registration[];
  readonly subsystems?: readonly Subsystem[];
  /**
   * Adds the router unit, its subsystem, a memory history and one `routeUnit` per route.
   * Leave it out when `units` already register the router.
   */
  readonly routes?: readonly AnyRoute[];
  readonly router?: RouterUnitOptions;
  /** Memory-history start url (default `/`). */
  readonly initialUrl?: string;
  /** A fake session, or options to create one. Its units are bound as overrides. */
  readonly session?: FakeSession | FakeSessionOptions;
  /**
   * Fake time (or `true` to create one): drives `bootApp`'s now/sleep/idle and the frame
   * scheduler. Restart back-offs and start timeouts then only elapse via `time.advance()`.
   */
  readonly time?: FakeTime | true;
  readonly telemetryLevel?: LevelName;
}

export interface TestApp extends TestTelemetry {
  readonly app: App;
  readonly injector: Injector;
  /** Present when `routes` were given. */
  readonly router: Router | undefined;
  readonly history: MemoryHistory | undefined;
  readonly session: FakeSession | undefined;
  readonly time: FakeTime | undefined;
  /** Resolve and unwrap; throws `SF-TEST-002`. */
  get<T>(token: Token<T>): Promise<T>;
  /** Shut the app down and detach the telemetry sink. */
  shutdown(): Promise<void>;
}

/**
 * Wait for background subsystem starts. On fake time a start that sleeps (restart
 * back-off, start timeout) would never settle, so drain work that needs no time
 * to pass and return; the test then moves time with `time.advance()`.
 */
async function waitForStarts(app: App, time: FakeTime | undefined): Promise<void> {
  if (time === undefined) {
    await app.supervisor.settled();
    return;
  }
  let settled = false;
  void app.supervisor.settled().then(() => {
    settled = true;
  });
  for (let round = 0; round < 100 && !settled; round += 1) await time.flush();
}

function isFakeSession(value: FakeSession | FakeSessionOptions): value is FakeSession {
  return 'units' in value && 'provider' in value;
}

export async function bootTestApp(options: BootTestAppOptions = {}): Promise<TestApp> {
  const time = options.time === true ? createFakeTime() : options.time;
  const recording = createTestTelemetry({
    level: options.telemetryLevel ?? 'debug',
    ...(time === undefined ? {} : { now: () => time.clock.now() }),
  });
  const session =
    options.session === undefined
      ? undefined
      : isFakeSession(options.session)
        ? options.session
        : createFakeSession({ ...(time === undefined ? {} : { clock: time.clock }), ...options.session });

  let history: MemoryHistory | undefined;
  const routing: Registration[] =
    options.routes === undefined
      ? []
      : [
          routerUnitWith(options.router ?? {}),
          routerSubsystemUnit,
          unit({
            id: 'testkit/memory-history-unit',
            provides: HistoryAdapterToken,
            scope: 'app',
            create: () => {
              history = createMemoryHistory({ initial: options.initialUrl ?? '/' });
              return history;
            },
          }),
          ...options.routes.map((route) => routeUnit(route)),
        ];

  const overrides: Registration[] = [
    ...(time === undefined ? [] : [fakeFrameSchedulerUnit(time)]),
    ...(session === undefined ? [] : session.units),
    ...(options.overrides ?? []),
  ];

  const booted = await bootApp({
    units: [...(options.units ?? []), ...routing, ...asOverrides(overrides)],
    telemetry: recording.telemetry,
    injectorName: 'test-app',
    random: () => 0.5,
    ...(options.subsystems === undefined ? {} : { subsystems: options.subsystems }),
    ...(time === undefined ? {} : { now: () => time.clock.now(), sleep: (ms, signal) => time.clock.sleep(ms, signal), idle: time.injectorIdle }),
  });
  if (!booted.ok) {
    recording.dispose();
    throw TestBootFailedError({ message: `bootTestApp: ${booted.error.code} ${booted.error.message}`, cause: booted.error });
  }
  const app = booted.value;
  await waitForStarts(app, time);

  let router: Router | undefined;
  if (options.routes !== undefined) {
    const resolved = await app.injector.get(RouterToken);
    if (!resolved.ok) throw TestResolveFailedError({ message: `router: ${resolved.error.message}`, cause: resolved.error });
    router = resolved.value;
  }
  if (session !== undefined) {
    // Resolve through the injector so contributed listeners / upgrade hooks are attached.
    const resolved = await app.injector.get(SessionToken);
    if (!resolved.ok) throw TestResolveFailedError({ message: `session: ${resolved.error.message}`, cause: resolved.error });
    await session.ready();
  }

  return {
    ...recording,
    get records() {
      return recording.records;
    },
    app,
    injector: app.injector,
    router,
    get history() {
      return history;
    },
    session,
    time,
    async get<T>(token: Token<T>): Promise<T> {
      const result = await app.injector.get(token);
      if (!result.ok) throw TestResolveFailedError({ message: `Could not resolve "${token.id}": ${result.error.message}`, cause: result.error });
      return result.value;
    },
    async shutdown() {
      await app.shutdown();
      recording.dispose();
    },
  };
}
