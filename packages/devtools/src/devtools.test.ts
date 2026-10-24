import { describe, expect, it } from 'vitest';
import { createInjector, createTelemetry, unit } from '@staticflux/core';
import {
  because,
  createGate,
  createManualFactSource,
  fact,
  GateFacts,
  gateResource,
  GateToken,
  definePolicy,
  definePolicySet,
} from '@staticflux/gate';
import { createJourneyTracker, JourneyTrackerToken } from '@staticflux/perf';
import { createSupervisor, defineSubsystem, SupervisorToken } from '@staticflux/runtime';
import { createDevtools, type InspectableStore, type InspectablePatch } from './devtools.js';

const policies = definePolicySet('studio/policies', [
  definePolicy({
    id: 'studio/route-requires-login',
    resource: gateResource('route', '/studio'),
    when: because(fact(GateFacts.authenticated).eq(true), 'login'),
  }),
]);

function setupGate() {
  const telemetry = createTelemetry({ defaultLevel: 'verbose' });
  const facts = createManualFactSource('test/facts');
  const gate = createGate({ policySets: [policies], sources: [facts], telemetry });
  const login = (): void =>
    facts.setMany([
      [GateFacts.subjectKind, 'user'],
      [GateFacts.authenticated, true],
    ]);
  return { telemetry, gate, login };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeStore(id: string): InspectableStore & { emit(message: InspectablePatch): void; listeners: number } {
  const listeners = new Set<(m: InspectablePatch) => void>();
  let version = 0;
  return {
    id,
    mode: 'owner',
    get version() {
      return version;
    },
    epoch: 0,
    getSnapshot: () => ({ state: { items: [1, 2] }, schemaVersion: 2 }),
    onPatches(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) {
      version = message.version;
      for (const l of listeners) l(message);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

describe('createDevtools', () => {
  it('attaches the collector as a sink and coalesces change notifications', async () => {
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    const devtools = createDevtools({ telemetry });
    let calls = 0;
    devtools.subscribe(() => (calls += 1));
    for (let i = 0; i < 10; i += 1) telemetry.event('x.y', { subsystem: 'test/sub' });
    expect(calls).toBe(0);
    await flush();
    expect(calls).toBe(1);
    expect(devtools.revision).toBe(1);
    await devtools.dispose();
    telemetry.event('x.z', { subsystem: 'test/sub' });
    expect(devtools.collector.events().map((e) => e.name)).not.toContain('x.z');
  });

  it('records decisions from a bound gate (with fact traces) and explains on demand (R6.11)', async () => {
    const { telemetry, gate, login } = setupGate();
    const devtools = createDevtools({ telemetry, gate });
    expect(gate.decide('route', '/studio').effect).toBe('deny');
    login();
    const decisions = devtools.views.decisions();
    expect(decisions.items[0]).toMatchObject({ level: 'route', resourceId: '/studio', effect: 'allow', source: 'gate', determining: ['studio/route-requires-login'] });
    expect(decisions.items[0]?.facts?.length).toBeGreaterThan(0);
    // events are not double-counted when the gate is bound
    expect(decisions.items.filter((d) => d.source === 'event')).toHaveLength(0);

    const explained = devtools.explain('route', '/studio');
    expect(explained.ok && explained.value).toMatchObject({ effect: 'allow', actionId: 'gate/access', source: 'policy', determining: ['studio/route-requires-login'] });
    const unmatched = devtools.explain('route', '/elsewhere', 'test/open', 'agent');
    expect(unmatched.ok && unmatched.value).toMatchObject({ actionId: 'test/open', subject: 'agent', source: 'unmatched' });
    await devtools.dispose();
  });

  it('decision events still work without a gate; explain needs one (SF-DEV-002)', () => {
    const { telemetry, gate, login } = setupGate();
    const devtools = createDevtools({ telemetry });
    gate.decide('route', '/studio');
    login();
    expect(devtools.views.decisions().items[0]).toMatchObject({ resourceId: '/studio', effect: 'allow', source: 'event' });
    const explained = devtools.explain('route', '/studio');
    expect(!explained.ok && explained.error.code).toBe('SF-DEV-002');
  });

  it('requests app commands through the supervisor and its command policy', async () => {
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    const supervisor = createSupervisor({ telemetry, subsystems: [defineSubsystem({ id: 'test/sub', start: () => undefined })] });
    const devtools = createDevtools({ telemetry });
    const unbound = await devtools.command('pause');
    expect(!unbound.ok && unbound.error.code).toBe('SF-DEV-002');
    expect(devtools.canCommand('pause')).toBe(false);
    devtools.bind({ supervisor });
    expect((await supervisor.start()).ok).toBe(true);
    await supervisor.settled();
    expect(devtools.canCommand('pause')).toBe(true);
    expect((await devtools.command('pause', 'debugging')).ok).toBe(true);
    expect(supervisor.state).toBe('paused');
    expect(devtools.views.settings().commands).toEqual([
      { command: 'pause', available: false },
      { command: 'resume', available: true },
      { command: 'refresh', available: false },
    ]);
    expect((await devtools.command('resume')).ok).toBe(true);
    expect(supervisor.state).toBe('running');
    const lifecycles = devtools.views.lifecycles();
    expect(lifecycles.groups[0]?.items[0]).toMatchObject({ machine: 'app', state: 'running', source: 'both' });
    expect(lifecycles.groups[1]?.items[0]).toMatchObject({ instance: 'test/sub', state: 'running' });
    expect(devtools.collector.events().some((e) => e.name === 'devtools.command')).toBe(true);
    await devtools.dispose();
    await supervisor.shutdown();
  });

  it('binds only sources the app already resolved (bindFromInjector never instantiates)', async () => {
    const telemetry = createTelemetry();
    const tracker = createJourneyTracker({ telemetry });
    let created = 0;
    const injector = createInjector({
      telemetry,
      units: [
        unit({ id: 'test/tracker', provides: JourneyTrackerToken, scope: 'app', create: () => tracker }),
        unit({
          id: 'test/supervisor',
          provides: SupervisorToken,
          scope: 'app',
          create: () => {
            created += 1;
            return createSupervisor({ telemetry });
          },
        }),
      ],
    });
    await injector.get(JourneyTrackerToken);
    const devtools = createDevtools({ telemetry });
    expect(await devtools.bindFromInjector(injector)).toEqual(['journeys']);
    expect(created).toBe(0);
    expect(devtools.sources().journeys).toBe(tracker);
    expect(devtools.sources().injector).toBe(injector);
    expect(devtools.views.settings().bound).toMatchObject({ injector: true, journeys: true, supervisor: false, gate: false });
    expect(await devtools.bindFromInjector()).toEqual([]);
    expect(await createDevtools({ telemetry }).bindFromInjector()).toEqual([]);
    // DI graph from the bound injector
    expect(devtools.views.graph().layers.flat().map((n) => n.unitId)).toEqual(['test/tracker']);
    // GateToken unresolved → not bound
    expect(injector.stateOf(GateToken)).toBe('unresolved');
    await devtools.dispose();
  });

  it('inspects stores: snapshot + bounded patch stream, unsubscribed on dispose', async () => {
    const telemetry = createTelemetry();
    const store = fakeStore('data/docs');
    const devtools = createDevtools({ telemetry, stores: [store], patchHistory: 2, now: () => 42 });
    for (let v = 1; v <= 3; v += 1) store.emit({ version: v, epoch: 0, action: `add${v}`, patches: [{ op: 'add', path: ['items', v] }] });
    const [view] = devtools.views.stores();
    expect(view).toMatchObject({ id: 'data/docs', mode: 'owner', version: 3, schemaVersion: 2, state: { items: [1, 2] } });
    expect(view?.patches.map((p) => [p.version, p.action, p.paths[0], p.time])).toEqual([
      [3, 'add3', 'add /items/3', 42],
      [2, 'add2', 'add /items/2', 42],
    ]);
    expect(store.listeners).toBe(1);
    await devtools.dispose();
    expect(store.listeners).toBe(0);
  });

  it('setLevel switches verbosity without reload and the settings view reflects it (R17.14)', async () => {
    const telemetry = createTelemetry({ defaultLevel: 'standard' });
    const devtools = createDevtools({ telemetry });
    telemetry.event('a', { subsystem: 'core/di' });
    expect(telemetry.enabled('core/di', 'verbose')).toBe(false);
    devtools.setLevel('core/di', 'verbose');
    expect(telemetry.enabled('core/di', 'verbose')).toBe(true);
    const settings = devtools.views.settings();
    expect(settings.subsystems.find((s) => s.subsystem === 'core/di')).toEqual({ subsystem: 'core/di', level: 'verbose', overridden: true });
    expect(settings.overrides).toEqual([{ subsystem: 'core/di', level: 'verbose' }]);
    expect(settings.levels).toContain('debug');
    expect(settings.appState).toBeUndefined();
    await devtools.dispose();
  });

  it('views return empty models when nothing is bound or recorded', () => {
    const devtools = createDevtools({ telemetry: createTelemetry() });
    expect(devtools.views.boot().status).toBe('missing');
    expect(devtools.views.journeys()).toEqual([]);
    expect(devtools.views.graph().layers).toEqual([]);
    expect(devtools.views.lifecycles().total).toBe(0);
    expect(devtools.views.stores()).toEqual([]);
    expect(devtools.views.violations().total).toBe(0);
    expect(devtools.views.metrics().metrics).toEqual([]);
  });

  it('bind after dispose is ignored', async () => {
    const devtools = createDevtools({ telemetry: createTelemetry() });
    await devtools.dispose();
    await devtools.dispose();
    devtools.bind({ stores: [fakeStore('x/y')] });
    expect(devtools.sources().stores).toBeUndefined();
  });
});
