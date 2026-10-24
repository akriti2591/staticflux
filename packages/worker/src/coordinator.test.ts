import { createInjector, createMemorySink, createTelemetry, createMachine, err, ok, token } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createFakeTabLifecycle, createMemoryBroadcastHub, createMemoryLocks } from './coordinator-fakes.js';
import {
  createJsonSource,
  createPortPair,
  defineReplica,
  inMemorySpawner,
  type Port,
  type Spawner,
  WorkerUnsupportedError,
} from './index.js';
import {
  createMemorySnapshotStore,
  documentTabLifecycle,
  ownedResource,
  CoordinatorRoleLifecycle,
  createCoordinatorHost,
  createTabCoordinator,
  type TabCoordinator,
  type TabCoordinatorOptions,
  tabCoordinatorUnit,
} from './coordinator-entry.js';

interface Todos {
  readonly items: readonly string[];
}
type TodoIntents = {
  readonly add: { readonly args: { readonly text: string }; readonly result: number };
};
const TodoReplica = defineReplica('test/todos').type<Todos, TodoIntents>();
const OtherReplica = defineReplica('test/other').type<{ readonly n: number }, Record<never, never>>();

const todos = ownedResource(
  TodoReplica,
  ({ restored }) =>
    createJsonSource<Todos>(restored ?? { items: [] }, {
      add: (args, api) => {
        const text = (args as { text: string }).text;
        const applied = api.apply([{ op: 'add', path: ['items', '-'], value: text }]);
        return applied.ok ? ok(api.state.items.length) : applied;
      },
    }),
  { initial: { items: [] } },
);

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await tick();
}

const ID = 'test/tabs' as const;

function world() {
  const locks = createMemoryLocks();
  const hub = createMemoryBroadcastHub();
  const sink = createMemorySink();
  const telemetry = createTelemetry({ defaultLevel: 'debug' });
  telemetry.addSink(sink);
  const tabs = new Map<string, TabCoordinator>();
  const lifecycles = new Map<string, ReturnType<typeof createFakeTabLifecycle>>();
  const open = (tabId: string, extra: Partial<TabCoordinatorOptions> = {}): TabCoordinator => {
    const lifecycle = createFakeTabLifecycle();
    lifecycles.set(tabId, lifecycle);
    const tab = createTabCoordinator({
      id: ID,
      owned: [todos],
      transport: 'leader-tab',
      tabId,
      locks: locks.forTab(tabId),
      broadcast: hub.forTab(tabId),
      lifecycle,
      rejoinMs: 20,
      telemetry,
      ...extra,
    });
    tabs.set(tabId, tab);
    return tab;
  };
  const crash = (tabId: string): void => {
    hub.crashTab(tabId);
    locks.crashTab(tabId);
  };
  const items = (tab: TabCoordinator): readonly string[] => {
    const replica = tab.replica(TodoReplica);
    return replica.ok ? [...replica.value.state.items] : [];
  };
  return { locks, hub, sink, telemetry, open, crash, items, lifecycles };
}

describe('CoordinatorRoleLifecycle', () => {
  it('allows only the documented transitions', () => {
    const m = createMachine(CoordinatorRoleLifecycle);
    expect(m.send('elected').ok).toBe(false);
    expect(m.send('start')).toEqual(ok('candidate'));
    expect(m.send('leader-found')).toEqual(ok('follower'));
    expect(m.send('leader-found')).toEqual(ok('follower'));
    expect(m.send('elected').ok).toBe(false);
    expect(m.send('leader-lost')).toEqual(ok('candidate'));
    expect(m.send('elected')).toEqual(ok('leader'));
    expect(m.send('stop').ok).toBe(false);
    expect(m.send('step-down')).toEqual(ok('stepping-down'));
    expect(m.send('stepped-down')).toEqual(ok('candidate'));
    expect(m.send('stop')).toEqual(ok('stopped'));
    expect(m.send('start').ok).toBe(false);
  });
});

describe('createTabCoordinator — single tab', () => {
  it('owns everything locally when Web Locks or BroadcastChannel are missing', async () => {
    const tab = createTabCoordinator({ id: ID, owned: [todos], transport: 'leader-tab', locks: null, broadcast: null, lifecycle: null });
    expect(tab.role).toBe('idle');
    expect(await tab.start()).toEqual(ok());
    expect(tab.role).toBe('leader');
    expect(tab.isLeader).toBe(true);
    expect(tab.transport).toBe('single-tab');
    expect(tab.term).toBe(1);
    expect(await tab.intent(TodoReplica, 'add', { text: 'a' })).toEqual(ok(1));
    const replica = tab.replica(TodoReplica);
    expect(replica.ok && replica.value.state.items).toEqual(['a']);
    expect(() => {
      if (replica.ok) (replica.value.state as { items: unknown }).items = [];
    }).toThrow(/SF-WK-002|read-only|Replica/);
    expect(tab.inspect()).toMatchObject({ role: 'leader', transport: 'single-tab', resources: [{ id: 'test/todos', status: 'live', version: 1 }] });
    await tab.dispose();
    expect(tab.role).toBe('stopped');
    const late = await tab.intent(TodoReplica, 'add', { text: 'b' });
    expect(!late.ok && late.error.code).toBe('SF-WK-027');
    expect(await tab.start()).toEqual(err(expect.objectContaining({ code: 'SF-WK-027' })));
  });

  it('reports unknown resources (SF-WK-028)', async () => {
    const tab = createTabCoordinator({ id: ID, owned: [todos], locks: null, broadcast: null, lifecycle: null });
    const replica = tab.replica(OtherReplica);
    expect(!replica.ok && replica.error.code).toBe('SF-WK-028');
    const intent = await tab.intent(OtherReplica, 'x' as never, undefined as never);
    expect(!intent.ok && intent.error.code).toBe('SF-WK-028');
    await tab.dispose();
  });

  it('restores from and saves to the snapshot store', async () => {
    const snapshots = createMemorySnapshotStore();
    snapshots.save('test/todos', { items: ['saved'] });
    const tab = createTabCoordinator({ id: ID, owned: [todos], locks: null, broadcast: null, lifecycle: null, snapshots });
    await tab.start();
    expect(await tab.intent(TodoReplica, 'add', { text: 'new' })).toEqual(ok(2));
    await settle(2);
    expect(snapshots.entries.get('test/todos')).toEqual({ items: ['saved', 'new'] });
    await tab.dispose();
  });
});

describe('createTabCoordinator — leader tab over BroadcastChannel', () => {
  it('elects one owner; other tabs replicate and route intents to it', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    expect(a.role).toBe('leader');
    expect(a.transport).toBe('leader-tab');
    const b = w.open('B');
    const c = w.open('C');
    expect(await b.start()).toEqual(ok());
    expect(await c.start()).toEqual(ok());
    expect(b.role).toBe('follower');
    expect(c.role).toBe('follower');
    expect(b.leaderId).toBe('A');
    expect(b.term).toBe(1);
    expect(w.locks.holder(ID)).toBe('A');
    expect(w.locks.queue(ID)).toEqual(['B', 'C']);

    expect(await b.intent(TodoReplica, 'add', { text: 'from-b' })).toEqual(ok(1));
    expect(w.items(b)).toEqual(['from-b']); // read-your-writes
    expect(await a.intent(TodoReplica, 'add', { text: 'from-a' })).toEqual(ok(2));
    await settle();
    for (const tab of [a, b, c]) expect(w.items(tab)).toEqual(['from-b', 'from-a']);
    expect(a.inspect().peers).toBe(3); // local + B + C
    await Promise.all([a.dispose(), b.dispose(), c.dispose()]);
  });

  it('fails over when the leader tab closes without a goodbye; the new leader restores the last state', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    const c = w.open('C');
    await b.start();
    await c.start();
    await c.intent(TodoReplica, 'add', { text: 'one' });
    await settle();

    w.crash('A');
    await settle();
    expect(b.role).toBe('leader');
    expect(b.term).toBe(2);
    expect(c.role).toBe('follower');
    expect(c.leaderId).toBe('B');
    expect(c.term).toBe(2);
    expect(w.items(b)).toEqual(['one']);
    expect(w.items(c)).toEqual(['one']);
    expect(await c.intent(TodoReplica, 'add', { text: 'two' })).toEqual(ok(2));
    await settle();
    expect(w.items(b)).toEqual(['one', 'two']);

    const failovers = w.sink.records.filter((r) => r.type === 'metric' && r.metric === 'worker/tabs-failovers');
    expect(failovers.length).toBeGreaterThanOrEqual(2);
    const roles = w.sink.records.filter((r) => r.type === 'event' && r.name === 'tabs.role' && r.attrs['tab'] === 'B');
    expect(roles.map((r) => (r.type === 'event' ? r.attrs['to'] : ''))).toEqual(['candidate', 'follower', 'candidate', 'leader']);
    await Promise.all([b.dispose(), c.dispose()]);
  });

  it('hands over gracefully on dispose (bye → leader-lost → candidate → new leader)', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    await a.intent(TodoReplica, 'add', { text: 'x' });
    await settle();
    await a.dispose();
    expect(a.role).toBe('stopped');
    await settle();
    expect(b.role).toBe('leader');
    expect(w.items(b)).toEqual(['x']);
    await b.dispose();
  });

  it('stepDown() passes ownership to the next queued tab and re-queues', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    a.stepDown();
    await settle();
    expect(b.role).toBe('leader');
    expect(a.role).toBe('follower');
    expect(a.leaderId).toBe('B');
    expect(w.locks.queue(ID)).toEqual(['A']);
    b.stepDown();
    await settle();
    expect(a.role).toBe('leader');
    expect(a.term).toBe(3);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('a frozen leader steps down; on resume it rejoins as follower and resyncs', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    await b.intent(TodoReplica, 'add', { text: 'before' });
    w.lifecycles.get('A')?.suspend();
    await settle();
    expect(b.role).toBe('leader');
    expect(a.role).toBe('follower'); // a hidden tab that still runs keeps following
    expect(a.leaderId).toBe('B');
    expect(w.locks.queue(ID)).toEqual([]); // suspended tabs do not queue for the lock
    await b.intent(TodoReplica, 'add', { text: 'while-frozen' });
    w.lifecycles.get('A')?.resume();
    await settle();
    expect(a.role).toBe('follower');
    expect(w.items(a)).toEqual(['before', 'while-frozen']);
    expect(w.locks.queue(ID)).toEqual(['A']);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('a frozen follower catches up after thaw/resume', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    w.hub.freeze('B');
    w.lifecycles.get('B')?.suspend();
    await a.intent(TodoReplica, 'add', { text: 'p1' });
    await a.intent(TodoReplica, 'add', { text: 'p2' });
    await settle();
    expect(w.items(b)).toEqual([]);
    w.hub.thaw('B');
    w.lifecycles.get('B')?.resume();
    await settle();
    expect(w.items(b)).toEqual(['p1', 'p2']);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('drops messages from a stale term (SF-WK-030)', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    const before = w.items(b);
    w.hub.inject(`sf-tabs:${ID}`, 'A', {
      sf: 'sf/tabs',
      type: 'data',
      from: 'A',
      to: 'B',
      term: 0,
      data: { kind: 'event', channel: 'sf/replica/test/todos', id: 'x', epoch: 0, payload: {} },
    });
    w.hub.inject(`sf-tabs:${ID}`, 'Z', { sf: 'sf/tabs', type: 'data', from: 'Z', to: 'A', term: 0, data: null });
    w.hub.inject(`sf-tabs:${ID}`, 'Z', 'garbage');
    await settle();
    expect(w.items(b)).toEqual(before);
    const stale = w.sink.records.filter((r) => r.type === 'event' && r.name === 'tabs.stale-dropped');
    expect(stale.length).toBe(2);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('a leader that picked a too-low term re-keys when told (stale/join with a higher term)', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    await b.intent(TodoReplica, 'add', { text: 'kept' });
    // A tab that saw term 7 (e.g. it was frozen through other leaderships) asks to join.
    w.hub.inject(`sf-tabs:${ID}`, 'Q', { sf: 'sf/tabs', type: 'join', from: 'Q', term: 7 });
    await settle();
    expect(a.term).toBe(8);
    expect(a.role).toBe('leader');
    expect(b.term).toBe(8);
    expect(b.leaderId).toBe('A');
    expect(w.items(b)).toEqual(['kept']);
    expect(await b.intent(TodoReplica, 'add', { text: 'after' })).toEqual(ok(2));
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('a follower answers an announcement with an old term with `stale`', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    w.hub.inject(`sf-tabs:${ID}`, 'OLD', { sf: 'sf/tabs', type: 'announce', from: 'OLD', term: 0 });
    await settle();
    expect(b.leaderId).toBe('A');
    expect(w.sink.records.some((r) => r.type === 'event' && r.name === 'tabs.stale-dropped' && r.attrs['from'] === 'OLD')).toBe(true);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('split brain: a resumed leader with an older term yields to the newer leader', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    // A hangs (no lifecycle event) and the browser drops its lock; B takes over.
    w.hub.freeze('A');
    w.locks.crashTab('A');
    await settle();
    expect(b.role).toBe('leader');
    expect(b.term).toBe(2);
    await b.intent(TodoReplica, 'add', { text: 'b-owned' });
    w.hub.thaw('A');
    await settle();
    expect(a.role).toBe('follower');
    expect(a.leaderId).toBe('B');
    expect(w.items(a)).toEqual(['b-owned']);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('intents wait for an owner during failover; idempotent ones are resent when the owner is lost mid-call', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    w.crash('A');
    const pending = b.intent(TodoReplica, 'add', { text: 'during' }, { idempotent: true, timeoutMs: 1000 });
    expect(await pending).toEqual(ok(1));
    expect(b.role).toBe('leader');
    await b.dispose();
  });

  it('intent budget expires when no owner appears', async () => {
    const w = world();
    const a = w.open('A');
    await a.start();
    const b = w.open('B');
    await b.start();
    w.lifecycles.get('B')?.suspend(); // B will not take the lock
    w.crash('A');
    await settle();
    const result = await b.intent(TodoReplica, 'add', { text: 'never' }, { timeoutMs: 30 });
    expect(!result.ok && result.error.kind).toBe('aborted');
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await b.intent(TodoReplica, 'add', { text: 'never' }, { signal: aborted.signal });
    expect(!cancelled.ok && cancelled.error.kind).toBe('aborted');
    await b.dispose();
  });
});

describe('createTabCoordinator — SharedWorker transport', () => {
  function sharedWorld(options: { failFirst?: number } = {}) {
    const snapshots = createMemorySnapshotStore();
    let host = createCoordinatorHost({ id: ID, owned: [todos], snapshots });
    const connected: Port[] = [];
    let calls = 0;
    const pairs: { crash(): void }[] = [];
    const spawner: Spawner = (context) => {
      calls += 1;
      if (calls <= (options.failFirst ?? 0)) return err(WorkerUnsupportedError({ details: { kind: 'SharedWorker' } }));
      return inMemorySpawner((port, ctx) => {
        connected.push(port);
        pairs.push(ctx.pair);
        host.connect(port);
      })(context);
    };
    return {
      spawner,
      snapshots,
      get calls() {
        return calls;
      },
      /** The SharedWorker died: every port crashes, the next one is a fresh host. */
      restartWorker() {
        host.dispose();
        host = createCoordinatorHost({ id: ID, owned: [todos], snapshots });
        for (const pair of pairs.splice(0)) pair.crash();
      },
      get host() {
        return host;
      },
    };
  }

  it('every tab is a replica of the SharedWorker-hosted owner', async () => {
    const s = sharedWorld();
    const a = createTabCoordinator({ id: ID, owned: [todos], transport: 'shared-worker', sharedWorker: s.spawner, lifecycle: null });
    const b = createTabCoordinator({ id: ID, owned: [todos], transport: 'auto', sharedWorker: s.spawner, lifecycle: null });
    expect(await a.start()).toEqual(ok());
    expect(await b.start()).toEqual(ok());
    expect(a.transport).toBe('shared-worker');
    expect(a.role).toBe('follower');
    expect(a.leaderId).toBe('shared-worker');
    expect(a.isLeader).toBe(false);
    expect(await a.intent(TodoReplica, 'add', { text: 'sw' })).toEqual(ok(1));
    await settle();
    const replica = b.replica(TodoReplica);
    expect(replica.ok && replica.value.state.items).toEqual(['sw']);
    expect(s.host.peers).toBe(2);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('reconnects when the SharedWorker dies; the new host restores from snapshots', async () => {
    const s = sharedWorld();
    const a = createTabCoordinator({ id: ID, owned: [todos], sharedWorker: s.spawner, lifecycle: null, reconnectDelayMs: 1 });
    await a.start();
    await a.intent(TodoReplica, 'add', { text: 'persisted' });
    await settle(2);
    s.restartWorker();
    await settle();
    expect(a.role).toBe('follower');
    expect(a.term).toBe(2);
    const replica = a.replica(TodoReplica);
    expect(replica.ok && replica.value.state.items).toEqual(['persisted']);
    expect(replica.ok && replica.value.status).toBe('live');
    await a.dispose();
  });

  it("'auto' falls back to leader-tab when the SharedWorker is unavailable; 'shared-worker' fails (SF-WK-029)", async () => {
    const s = sharedWorld({ failFirst: 100 });
    const locks = createMemoryLocks();
    const hub = createMemoryBroadcastHub();
    const auto = createTabCoordinator({
      id: ID,
      owned: [todos],
      sharedWorker: s.spawner,
      locks: locks.forTab('A'),
      broadcast: hub.forTab('A'),
      lifecycle: null,
    });
    expect(await auto.start()).toEqual(ok());
    expect(auto.transport).toBe('leader-tab');
    expect(auto.role).toBe('leader');
    await auto.dispose();

    const strict = createTabCoordinator({ id: ID, owned: [todos], transport: 'shared-worker', sharedWorker: s.spawner, lifecycle: null });
    const failed = await strict.start();
    expect(!failed.ok && failed.error.code).toBe('SF-WK-029');
    const none = createTabCoordinator({ id: ID, owned: [todos], transport: 'shared-worker', lifecycle: null });
    const missing = await none.start();
    expect(!missing.ok && missing.error.code).toBe('SF-WK-029');
    await strict.dispose();
    await none.dispose();
  });

  it('falls back to leader-tab after too many reconnect failures', async () => {
    let calls = 0;
    const host = createCoordinatorHost({ id: ID, owned: [todos] });
    let pair: { crash(): void } | undefined;
    const spawner: Spawner = (context) => {
      calls += 1;
      if (calls > 1) return err(WorkerUnsupportedError());
      return inMemorySpawner((port, ctx) => {
        pair = ctx.pair;
        host.connect(port);
      })(context);
    };
    const tab = createTabCoordinator({
      id: ID,
      owned: [todos],
      sharedWorker: spawner,
      locks: null,
      broadcast: null,
      lifecycle: null,
      reconnectDelayMs: 1,
      maxReconnects: 2,
    });
    await tab.start();
    pair?.crash();
    await settle(30);
    expect(tab.transport).toBe('single-tab');
    expect(tab.role).toBe('leader');
    await tab.dispose();
  });
});

describe('createCoordinatorHost', () => {
  it('serves several peers, exposes publishers/snapshots and closes links on dispose', async () => {
    const host = createCoordinatorHost({ id: ID, owned: [todos], term: 4 });
    expect(host.term).toBe(4);
    const pair = createPortPair();
    const link = host.connect(pair.a);
    expect(host.peers).toBe(1);
    expect(host.publisher(TodoReplica)?.definition.id).toBe('test/todos');
    expect(host.publisher(OtherReplica)).toBeUndefined();
    expect(host.snapshot(TodoReplica)).toEqual({ items: [] });
    host.dispose();
    expect(link.closed).toBe(true);
    expect(host.peers).toBe(0);
    const late = host.connect(createPortPair().a);
    expect(late.closed).toBe(true);
    host.dispose();
  });
});

describe('documentTabLifecycle', () => {
  it('maps freeze/pagehide to suspend and resume/pageshow to resume', () => {
    const doc = new EventTarget();
    const win = new EventTarget();
    const port = documentTabLifecycle({ document: doc, window: win });
    expect(port).toBeDefined();
    const seen: string[] = [];
    const offS = port?.onSuspend(() => seen.push('suspend'));
    const offR = port?.onResume(() => seen.push('resume'));
    doc.dispatchEvent(new Event('freeze'));
    win.dispatchEvent(new Event('pagehide'));
    doc.dispatchEvent(new Event('resume'));
    win.dispatchEvent(new Event('pageshow'));
    offS?.();
    offR?.();
    doc.dispatchEvent(new Event('freeze'));
    expect(seen).toEqual(['suspend', 'suspend', 'resume', 'resume']);
    expect(documentTabLifecycle({})).toBeUndefined();
  });
});

describe('tabCoordinatorUnit', () => {
  it('starts on init and disposes with its scope', async () => {
    const Tabs = token('test/tabs').type<TabCoordinator>();
    const injector = createInjector({
      units: [
        tabCoordinatorUnit({
          id: 'test/tabs-unit',
          provides: Tabs,
          critical: false,
          options: () => ({ id: ID, owned: [todos], locks: null, broadcast: null, lifecycle: null }),
        }),
      ],
    });
    const tabs = await injector.get(Tabs);
    expect(tabs.ok && tabs.value.role).toBe('leader');
    await injector.scope.dispose();
    expect(tabs.ok && tabs.value.role).toBe('stopped');
  });
});
