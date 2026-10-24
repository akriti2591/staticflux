/**
 * Multi-tab coordinator (R11.9, research §6 "Notion pattern"): ONE owner per
 * designated store/resource across all tabs of an origin; every other tab is a
 * read-only replica whose writes are intents routed to the current owner (I-9).
 *
 *   transport 'shared-worker'  SharedWorker hosts the owners (`createCoordinatorHost`);
 *                              every tab (incl. this one) connects as a replica.
 *   transport 'leader-tab'     Web Locks elect an owner tab; it hosts the owners and
 *                              serves replicas over BroadcastChannel (virtual
 *                              point-to-point ports per peer tab).
 *   transport 'auto'           SharedWorker when a spawner is given and it connects,
 *                              otherwise leader-tab. Without Web Locks or
 *                              BroadcastChannel: 'single-tab' (this tab owns, alone).
 *
 * The local tab ALWAYS reads through a `Replica` — the leader tab attaches its own
 * replicas to its host over an in-memory port pair — so feature code is identical
 * in every role.
 *
 * Role machine (`worker/tab-coordinator`):
 *   idle → candidate → leader | follower; follower → candidate on leader loss;
 *   leader → stepping-down → candidate; * → stopped.
 *
 * Terms (epochs): each leadership has a term (monotonic across tabs). Bus
 * messages and link envelopes carry it; messages from another term are dropped
 * (SF-WK-030 telemetry). A newly elected leader that picked a too-low term (it
 * missed announcements while frozen) is told so by followers (`stale`) and
 * re-keys with a higher term.
 *
 * Failover: when the leader tab closes (lock released by the browser), freezes
 * or hides (it steps down on `freeze`/`pagehide`), the next queued tab acquires
 * the lock, restores every owned store from its own replica's last state (or
 * the snapshot store), announces the new term, and the replicas re-handshake
 * (new owner epoch → snapshot). Frozen followers resync on resume.
 */
import {
  AbortedError,
  anySignal,
  box,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  type Machine,
  metric,
  ok,
  type Result,
  type SfError,
  type Telemetry,
  type TransitionRecord,
} from '@staticflux/core';
import { type Clock, type FlushScheduler, systemClock } from './clock.js';
import { CoordinatorStoppedError, CoordinatorTransportError, UnknownCoordinatedResourceError } from './coordinator-errors.js';
import { PortClosedError } from './errors.js';
import { createLeaderElection, detectLocks, type LeaderElection, type LockManagerLike } from './leader.js';
import { createLink, type Link } from './link.js';
import { createPortPair, type Port } from './port.js';
import {
  type AnyReplicaDefinition,
  createPublisher,
  createReplica,
  type IntentMap,
  type IntentsOf,
  type Publisher,
  type ReplicableSource,
  type Replica,
  type StateOf,
} from './replication.js';
import type { Spawner } from './spawn.js';

const SUBSYSTEM = 'worker/tabs';

// ---------------------------------------------------------------- lifecycle

export const CoordinatorRoleLifecycle = defineMachine({
  id: 'worker/tab-coordinator',
  initial: 'idle',
  states: ['idle', 'candidate', 'leader', 'follower', 'stepping-down', 'stopped'],
  transitions: {
    idle: { start: 'candidate', stop: 'stopped' },
    candidate: { elected: 'leader', 'leader-found': 'follower', stop: 'stopped' },
    follower: { 'leader-found': 'follower', 'leader-lost': 'candidate', stop: 'stopped' },
    leader: { 'step-down': 'stepping-down' },
    'stepping-down': { 'stepped-down': 'candidate', stop: 'stopped' },
  },
  terminal: ['stopped'],
});

export type CoordinatorRole = (typeof CoordinatorRoleLifecycle.states)[number];
type CoordinatorEvent = 'start' | 'elected' | 'leader-found' | 'leader-lost' | 'step-down' | 'stepped-down' | 'stop';

export type CoordinatorTransport = 'shared-worker' | 'leader-tab' | 'single-tab';

export const TabCoordinatorMetrics = {
  failovers: metric.counter('worker/tabs-failovers', { description: 'Leadership changes after a previous owner (tab or SharedWorker) was lost.' }),
  term: metric.gauge('worker/tabs-term', { description: 'Current leadership term seen by this tab.' }),
  staleDropped: metric.counter('worker/tabs-stale-dropped', { description: 'Cross-tab messages dropped because of an old term (SF-WK-030).' }),
} as const;

// ---------------------------------------------------------------- platform ports

/** BroadcastChannel shape (injectable for tests / older browsers). */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type BroadcastFactory = (name: string) => BroadcastChannelLike;

/** `new BroadcastChannel(name)` when available. */
export function detectBroadcastChannel(): BroadcastFactory | undefined {
  const ctor = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }).BroadcastChannel;
  return typeof ctor === 'function' ? (name) => new ctor(name) : undefined;
}

/** Page Lifecycle signals the coordinator reacts to. */
export interface TabLifecyclePort {
  /** The tab is being frozen or hidden (`freeze`, `pagehide`): a leader steps down. */
  onSuspend(listener: () => void): () => void;
  /** The tab runs again (`resume`, `pageshow`): rejoin and resync. */
  onResume(listener: () => void): () => void;
}

/** Page Lifecycle events of `document`/`window` (feature-detected). */
export function documentTabLifecycle(
  targets: { readonly document?: EventTarget | undefined; readonly window?: EventTarget | undefined } = {
    document: (globalThis as { document?: EventTarget }).document,
    window: globalThis as unknown as EventTarget,
  },
): TabLifecyclePort | undefined {
  const doc = targets.document;
  const win = targets.window;
  if (doc === undefined && win === undefined) return undefined;
  const on = (pairs: readonly (readonly [EventTarget | undefined, string])[], listener: () => void): (() => void) => {
    const controller = new AbortController();
    for (const [target, type] of pairs) target?.addEventListener(type, listener, { signal: controller.signal });
    return () => controller.abort();
  };
  return {
    onSuspend: (listener) => on([[doc, 'freeze'], [win, 'pagehide']], listener),
    onResume: (listener) => on([[doc, 'resume'], [win, 'pageshow']], listener),
  };
}

/** Optional durable snapshots (e.g. IndexedDB/OPFS adapter) used when no replica state exists. */
export interface SnapshotStore {
  load(resourceId: string): unknown;
  save(resourceId: string, state: unknown): void;
}

export function createMemorySnapshotStore(): SnapshotStore & { readonly entries: ReadonlyMap<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    load: (id) => entries.get(id),
    save: (id, state) => {
      entries.set(id, state);
    },
  };
}

// ---------------------------------------------------------------- owned resources

export interface OwnedResourceContext<S> {
  /** Last known state (previous owner's replica view, or the snapshot store). */
  readonly restored: S | undefined;
  readonly term: number;
  /** Aborted when this tab stops owning the resource. */
  readonly signal: AbortSignal;
}

export interface OwnedSource<S> extends ReplicableSource<S> {
  /** Called when ownership ends (step-down, failover to another tab, stop). */
  dispose?(): void;
}

export interface OwnedResource<D extends AnyReplicaDefinition = AnyReplicaDefinition> {
  readonly definition: D;
  /** Replica state before the first snapshot. */
  readonly initial?: StateOf<D>;
  /** Build the owner store for one leadership term. */
  create(context: OwnedResourceContext<StateOf<D>>): OwnedSource<StateOf<D>>;
}

/** Declare a resource the coordinator owns (one owner across all tabs). */
export function ownedResource<D extends AnyReplicaDefinition>(
  definition: D,
  create: (context: OwnedResourceContext<StateOf<D>>) => OwnedSource<StateOf<D>>,
  options: { readonly initial?: StateOf<D> } = {},
): OwnedResource<D> {
  return Object.freeze({ definition, create, ...(options.initial === undefined ? {} : { initial: options.initial }) });
}

// ---------------------------------------------------------------- owner host

export interface CoordinatorHostOptions {
  readonly id: string;
  readonly owned: readonly OwnedResource[];
  /** Leadership term; stamped as link epoch. Default 1. */
  readonly term?: number;
  /** Restored state per resource (wins over the snapshot store). */
  readonly restore?: (definition: AnyReplicaDefinition) => unknown;
  readonly snapshots?: SnapshotStore;
  readonly schedule?: FlushScheduler;
  readonly requestTimeoutMs?: number;
  readonly telemetry?: Telemetry;
}

export interface CoordinatorHost {
  readonly id: string;
  readonly term: number;
  /** Connected peers (tabs). */
  readonly peers: number;
  /** Serve one peer on `port` (all owned resources). Returns the peer's link. */
  connect(port: Port, name?: string): Link;
  publisher(definition: AnyReplicaDefinition): Publisher | undefined;
  /** Current owner state of a resource. */
  snapshot(definition: AnyReplicaDefinition): unknown;
  dispose(): void;
}

/**
 * Owners of every declared resource, serving any number of peers. Runs inside
 * a SharedWorker (`acceptSharedConnections(self, (port) => host.connect(port))`)
 * or inside the leader tab.
 */
export function createCoordinatorHost(options: CoordinatorHostOptions): CoordinatorHost {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const term = options.term ?? 1;
  const controller = new AbortController();
  const links = new Set<Link>();
  const entries = new Map<string, { readonly source: OwnedSource<unknown>; readonly publisher: Publisher; readonly off: () => void }>();
  let disposed = false;

  for (const resource of options.owned) {
    const id = resource.definition.id;
    const restored = options.restore?.(resource.definition) ?? options.snapshots?.load(id);
    const source = resource.create({ restored, term, signal: controller.signal }) as OwnedSource<unknown>;
    const publisher = createPublisher({
      definition: resource.definition,
      source,
      telemetry,
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    });
    let saveScheduled = false;
    const off =
      options.snapshots === undefined
        ? () => undefined
        : source.onPatches(() => {
            if (saveScheduled) return;
            saveScheduled = true;
            queueMicrotask(() => {
              saveScheduled = false;
              if (!disposed) options.snapshots?.save(id, source.getSnapshot());
            });
          });
    entries.set(id, { source, publisher, off });
  }

  return {
    id: options.id,
    term,
    get peers() {
      return links.size;
    },
    connect(port, name = 'peer') {
      const link = createLink({
        port,
        name: `${options.id}:${name}`,
        epoch: term,
        telemetry,
        ...(options.requestTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.requestTimeoutMs }),
      });
      if (disposed) {
        link.close();
        return link;
      }
      links.add(link);
      link.onClose(() => links.delete(link));
      for (const entry of entries.values()) entry.publisher.attach(link);
      return link;
    },
    publisher: (definition) => entries.get(definition.id)?.publisher,
    snapshot: (definition) => entries.get(definition.id)?.source.getSnapshot(),
    dispose() {
      if (disposed) return;
      for (const [id, entry] of entries) {
        entry.publisher.flush();
        options.snapshots?.save(id, entry.source.getSnapshot());
      }
      disposed = true;
      controller.abort(new DOMException('ownership ended', 'AbortError'));
      for (const link of [...links]) link.close();
      for (const entry of entries.values()) {
        entry.off();
        entry.publisher.dispose();
        entry.source.dispose?.();
      }
    },
  };
}

// ---------------------------------------------------------------- bus (BroadcastChannel → virtual ports)

const BUS_TAG = 'sf/tabs';

type BusType = 'announce' | 'join' | 'bye' | 'stale' | 'data';

interface BusMessage {
  readonly sf: typeof BUS_TAG;
  readonly type: BusType;
  readonly from: string;
  readonly to?: string;
  readonly term: number;
  readonly data?: unknown;
}

function isBusMessage(value: unknown): value is BusMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['sf'] === BUS_TAG && typeof v['type'] === 'string' && typeof v['from'] === 'string' && typeof v['term'] === 'number';
}

interface BusPort extends Port {
  deliver(data: unknown): void;
}

function createBusPort(post: (message: BusMessage) => void, self: string, peer: string, term: number): BusPort {
  const messageListeners = new Set<(data: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  return {
    postMessage(data) {
      if (closed) return;
      post({ sf: BUS_TAG, type: 'data', from: self, to: peer, term, data });
    },
    deliver(data) {
      if (closed) return;
      for (const listener of [...messageListeners]) listener(data);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onError: () => () => undefined,
    onClose(listener) {
      if (closed) {
        listener();
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      messageListeners.clear();
      const listeners = [...closeListeners];
      closeListeners.clear();
      for (const listener of listeners) listener();
    },
  };
}

/** Plain copy of a (possibly read-only proxied) replica state, for restoring an owner. */
function plainCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainCopy);
  if (typeof value === 'object' && value !== null) {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = plainCopy((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function randomTabId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof c?.randomUUID === 'function' ? c.randomUUID() : `tab-${Math.floor(Math.random() * 1e12).toString(36)}`;
}

// ---------------------------------------------------------------- coordinator

export interface TabCoordinatorOptions {
  /** Namespaced id; also the Web Lock name and BroadcastChannel name. */
  readonly id: `${string}/${string}`;
  readonly owned: readonly OwnedResource[];
  /** Default 'auto'. */
  readonly transport?: 'shared-worker' | 'leader-tab' | 'auto';
  /** Connects to the SharedWorker hosting `createCoordinatorHost` (e.g. `sharedWorkerSpawner(...)`). */
  readonly sharedWorker?: Spawner;
  /** `null` disables Web Locks (single-tab). Default `detectLocks()`. */
  readonly locks?: LockManagerLike | null;
  /** `null` disables BroadcastChannel (single-tab). Default `detectBroadcastChannel()`. */
  readonly broadcast?: BroadcastFactory | null;
  /** `null` ignores page lifecycle. Default `documentTabLifecycle()`. */
  readonly lifecycle?: TabLifecyclePort | null;
  readonly snapshots?: SnapshotStore;
  /** Stable id of this tab (default random). */
  readonly tabId?: string;
  readonly clock?: Clock;
  readonly schedule?: FlushScheduler;
  /** Link request timeout (handshakes, intents). Default 30 s. */
  readonly requestTimeoutMs?: number;
  /** A candidate re-sends `join` this often until it finds a leader. Default 2000 ms. */
  readonly rejoinMs?: number;
  /** SharedWorker reconnect delay after its port closed. Default 500 ms. */
  readonly reconnectDelayMs?: number;
  /** SharedWorker reconnect attempts before falling back ('auto') or giving up. Default 5. */
  readonly maxReconnects?: number;
  /** Replica mutation guards (SF-WK-002). Default true. */
  readonly devGuards?: boolean;
  readonly telemetry?: Telemetry;
}

export interface CoordinatorIntentOptions {
  readonly signal?: AbortSignal;
  /** Overall budget, including waiting for an owner during failover. */
  readonly timeoutMs?: number;
  /** Safe to resend when the owner was lost mid-call (default false: fail with SF-WK-009). */
  readonly idempotent?: boolean;
}

export interface TabCoordinatorInspection {
  readonly id: string;
  readonly tabId: string;
  readonly role: CoordinatorRole;
  readonly transport: CoordinatorTransport | undefined;
  readonly term: number;
  readonly leaderId: string | undefined;
  readonly peers: number;
  readonly resources: readonly { readonly id: string; readonly status: string; readonly version: number }[];
}

export interface TabCoordinator {
  readonly id: string;
  readonly tabId: string;
  /** Reactive. */
  readonly role: CoordinatorRole;
  /** Reactive; undefined before `start()`. */
  readonly transport: CoordinatorTransport | undefined;
  /** Current leadership term known to this tab. */
  readonly term: number;
  /** Owner tab id (`'shared-worker'` in SharedWorker mode). */
  readonly leaderId: string | undefined;
  readonly isLeader: boolean;
  /** Start coordinating; resolves when every replica is live. */
  start(signal?: AbortSignal): Promise<Result<void>>;
  /** The local read-only view of an owned resource (same object across failovers). */
  replica<D extends AnyReplicaDefinition>(definition: D): Result<Replica<StateOf<D>, IntentsOf<D>>>;
  /** Route a write to the current owner, waiting for one during failover. */
  intent<D extends AnyReplicaDefinition, K extends keyof IntentsOf<D> & string>(
    definition: D,
    action: K,
    args: IntentsOf<D>[K]['args'],
    options?: CoordinatorIntentOptions,
  ): Promise<Result<IntentsOf<D>[K]['result']>>;
  /** All replicas live. */
  whenReady(signal?: AbortSignal): Promise<Result<void>>;
  /** Leader: hand ownership to the next queued tab (re-queues). No-op otherwise. */
  stepDown(): void;
  onRoleChange(listener: (record: TransitionRecord<CoordinatorRole, CoordinatorEvent>) => void): () => void;
  inspect(): TabCoordinatorInspection;
  dispose(): Promise<void>;
}

export function createTabCoordinator(options: TabCoordinatorOptions): TabCoordinator {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const clock = options.clock ?? systemClock;
  const tabId = options.tabId ?? randomTabId();
  const rejoinMs = options.rejoinMs ?? 2000;
  const reconnectDelayMs = options.reconnectDelayMs ?? 500;
  const maxReconnects = options.maxReconnects ?? 5;
  const lifecyclePort = options.lifecycle === null ? undefined : (options.lifecycle ?? documentTabLifecycle());
  const controller = new AbortController();

  const machine: Machine<CoordinatorRole, CoordinatorEvent> = createMachine(CoordinatorRoleLifecycle, {
    onInvalid: (state, event) =>
      telemetry.event('tabs.invalid-transition', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { state, event, tab: tabId } }),
  });
  machine.onTransition((record) =>
    telemetry.event('tabs.role', {
      subsystem: SUBSYSTEM,
      level: 'standard',
      attrs: { coordinator: options.id, tab: tabId, from: record.from, to: record.to, event: record.event, term: knownTerm },
    }),
  );
  const send = (event: CoordinatorEvent): void => {
    if (machine.can(event)) machine.send(event);
  };

  const transport = box<CoordinatorTransport | undefined>(undefined);
  const replicas = new Map<string, Replica<unknown, IntentMap>>();
  for (const resource of options.owned) {
    replicas.set(
      resource.definition.id,
      createReplica(resource.definition, {
        telemetry,
        ...(resource.initial === undefined ? {} : { initial: resource.initial }),
        ...(options.devGuards === undefined ? {} : { devGuards: options.devGuards }),
        ...(options.requestTimeoutMs === undefined ? {} : { helloTimeoutMs: options.requestTimeoutMs }),
      }) as Replica<unknown, IntentMap>,
    );
  }

  let knownTerm = 0;
  let leaderId: string | undefined;
  let lastLeader: string | undefined;
  let everHadLeader = false;
  let stopped = false;
  let suspended = false;

  // follower side
  let followerLink: Link | undefined;
  let followerPort: BusPort | undefined;
  // leader side
  let host: CoordinatorHost | undefined;
  let localLink: Link | undefined;
  const peers = new Map<string, BusPort>();
  // leader-tab plumbing
  let bus: BroadcastChannelLike | undefined;
  let election: LeaderElection | undefined;
  let rejoinTimer: unknown;
  let resolvedLocks: LockManagerLike | undefined;

  const linkOptions = (port: Port, name: string, epoch: number): Parameters<typeof createLink>[0] => ({
    port,
    name: `${options.id}:${tabId}:${name}`,
    epoch,
    telemetry,
    clock,
    ...(options.requestTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.requestTimeoutMs }),
  });

  const setTerm = (term: number): void => {
    knownTerm = term;
    telemetry.record(TabCoordinatorMetrics.term, term, { coordinator: options.id });
  };

  const noteNewLeader = (): void => {
    if (everHadLeader) {
      telemetry.record(TabCoordinatorMetrics.failovers, 1, { coordinator: options.id, transport: transport.get() ?? 'none' });
      telemetry.event('tabs.failover', {
        subsystem: SUBSYSTEM,
        level: 'standard',
        attrs: { coordinator: options.id, tab: tabId, term: knownTerm, leader: leaderId ?? 'none' },
      });
    }
    everHadLeader = true;
  };

  const attachAll = (link: Link): void => {
    for (const replica of replicas.values()) void replica.attach(link);
  };

  const dropStale = (message: BusMessage): void => {
    telemetry.record(TabCoordinatorMetrics.staleDropped, 1, { coordinator: options.id, type: message.type });
    telemetry.event('tabs.stale-dropped', {
      subsystem: SUBSYSTEM,
      level: 'verbose',
      attrs: { code: 'SF-WK-030', coordinator: options.id, from: message.from, term: message.term, current: knownTerm },
    });
  };

  const post = (message: Omit<BusMessage, 'sf' | 'from'>): void => {
    bus?.postMessage({ sf: BUS_TAG, from: tabId, ...message });
  };

  // ---- shared-worker transport

  let sharedAttempt = 0;
  const connectShared = async (spawner: Spawner): Promise<Result<void>> => {
    sharedAttempt += 1;
    const spawned = await spawner({ signal: controller.signal, attempt: sharedAttempt });
    if (stopped) {
      if (spawned.ok) spawned.value.terminate();
      return err(CoordinatorStoppedError());
    }
    if (!spawned.ok) return spawned;
    sharedAttempt = 0;
    setTerm(knownTerm + 1);
    leaderId = 'shared-worker';
    const link = createLink(linkOptions(spawned.value.port, 'shared', knownTerm));
    followerLink = link;
    send('leader-found');
    noteNewLeader();
    attachAll(link);
    link.onClose(() => {
      if (followerLink !== link || stopped) return;
      followerLink = undefined;
      leaderId = undefined;
      send('leader-lost');
      scheduleReconnect(spawner);
    });
    return ok();
  };

  const scheduleReconnect = (spawner: Spawner): void => {
    if (sharedAttempt >= maxReconnects) {
      telemetry.event('tabs.shared-worker-lost', {
        subsystem: SUBSYSTEM,
        level: 'critical',
        attrs: { coordinator: options.id, code: CoordinatorTransportError.code, fallback: options.transport !== 'shared-worker' },
      });
      if (options.transport !== 'shared-worker') startLeaderTab();
      return;
    }
    clock.setTimeout(() => {
      if (stopped) return;
      void connectShared(spawner).then((result) => {
        if (!result.ok && !stopped) scheduleReconnect(spawner);
      });
    }, reconnectDelayMs);
  };

  // ---- leader-tab transport

  const disconnectFollower = (): void => {
    const link = followerLink;
    followerLink = undefined;
    followerPort = undefined;
    link?.close();
  };

  const connectToLeader = (leader: string, term: number): void => {
    disconnectFollower();
    setTerm(term);
    leaderId = leader;
    lastLeader = leader;
    const port = createBusPort((m) => bus?.postMessage(m), tabId, leader, term);
    followerPort = port;
    const link = createLink(linkOptions(port, `to:${leader}`, term));
    followerLink = link;
    stopRejoin();
    send('leader-found');
    noteNewLeader();
    attachAll(link);
  };

  const stopRejoin = (): void => {
    if (rejoinTimer !== undefined) clock.clearTimeout(rejoinTimer);
    rejoinTimer = undefined;
  };

  const scheduleRejoin = (): void => {
    stopRejoin();
    rejoinTimer = clock.setTimeout(() => {
      rejoinTimer = undefined;
      if (stopped || suspended || !machine.is('candidate')) return;
      post({ type: 'join', term: knownTerm });
      scheduleRejoin();
    }, rejoinMs);
  };

  const enqueue = (): void => {
    if (stopped || suspended || election !== undefined || bus === undefined) return;
    const mine = createLeaderElection({ name: options.id, locks: resolvedLocks ?? null, telemetry });
    election = mine;
    const onLeader = (isLeader: boolean): void => {
      if (isLeader && election === mine) onElected();
    };
    mine.onChange(onLeader);
    if (mine.isLeader) onLeader(true);
  };

  const restoreFromReplica = (definition: AnyReplicaDefinition): unknown => {
    const replica = replicas.get(definition.id);
    if (replica === undefined || replica.epoch === undefined) return undefined;
    return plainCopy(replica.state);
  };

  const becomeLeader = (term: number, restore: (definition: AnyReplicaDefinition) => unknown): void => {
    setTerm(term);
    leaderId = tabId;
    lastLeader = tabId;
    host = createCoordinatorHost({
      id: options.id,
      owned: options.owned,
      term,
      restore,
      telemetry,
      ...(options.snapshots === undefined ? {} : { snapshots: options.snapshots }),
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    const pair = createPortPair();
    host.connect(pair.a, `local:${tabId}`);
    localLink = createLink(linkOptions(pair.b, 'local', term));
    attachAll(localLink);
    post({ type: 'announce', term });
  };

  const onElected = (): void => {
    if (stopped) return;
    stopRejoin();
    if (machine.is('follower')) {
      disconnectFollower();
      leaderId = undefined;
      send('leader-lost');
    }
    send('elected');
    becomeLeader(knownTerm + 1, restoreFromReplica);
    noteNewLeader();
  };

  const releaseLeadership = (): void => {
    for (const port of [...peers.values()]) port.close();
    peers.clear();
    localLink?.close();
    localLink = undefined;
    host?.dispose();
    host = undefined;
    leaderId = undefined;
    election?.resign();
    election = undefined;
  };

  const stepDownInternal = (requeue: boolean): void => {
    if (!machine.is('leader')) return;
    send('step-down');
    post({ type: 'bye', term: knownTerm });
    releaseLeadership();
    send('stepped-down');
    if (requeue) {
      enqueue();
      post({ type: 'join', term: knownTerm });
      scheduleRejoin();
    }
  };

  /** Re-key leadership with a higher term without losing owner state. */
  const rekey = (term: number): void => {
    const previous = host;
    const restore = (definition: AnyReplicaDefinition): unknown => previous?.snapshot(definition);
    for (const port of [...peers.values()]) port.close();
    peers.clear();
    localLink?.close();
    localLink = undefined;
    becomeLeader(term, restore);
    previous?.dispose();
  };

  const onLeaderMessage = (message: BusMessage): void => {
    switch (message.type) {
      case 'data': {
        if (message.to !== tabId) return;
        if (message.term !== knownTerm) {
          dropStale(message);
          return;
        }
        let port = peers.get(message.from);
        if (port === undefined) {
          const peer = message.from;
          const created = createBusPort((m) => bus?.postMessage(m), tabId, peer, knownTerm);
          port = created;
          peers.set(peer, created);
          created.onClose(() => {
            if (peers.get(peer) === created) peers.delete(peer);
          });
          host?.connect(created, `peer:${peer}`);
        }
        port.deliver(message.data);
        return;
      }
      case 'join':
        if (message.term > knownTerm) {
          rekey(message.term + 1);
          return;
        }
        post({ type: 'announce', to: message.from, term: knownTerm });
        return;
      case 'bye':
        peers.get(message.from)?.close();
        return;
      case 'stale':
        if (message.to === tabId && message.term >= knownTerm) rekey(message.term + 1);
        return;
      case 'announce':
        if (message.term > knownTerm || (message.term === knownTerm && message.from > tabId)) {
          // Split brain (e.g. we resumed after a freeze): the other leader wins.
          stepDownInternal(true);
          onFollowerMessage(message);
        } else {
          post({ type: 'stale', to: message.from, term: knownTerm });
        }
        return;
    }
  };

  const onFollowerMessage = (message: BusMessage): void => {
    switch (message.type) {
      case 'announce': {
        if (message.to !== undefined && message.to !== tabId) return;
        const accept = message.term > knownTerm || (message.term === knownTerm && message.from === lastLeader);
        if (!accept) {
          dropStale(message);
          post({ type: 'stale', to: message.from, term: knownTerm });
          return;
        }
        if (followerLink !== undefined && leaderId === message.from && message.term === knownTerm) {
          for (const replica of replicas.values()) void replica.resync();
          return;
        }
        connectToLeader(message.from, message.term);
        return;
      }
      case 'data':
        if (message.to !== tabId) return;
        if (message.from !== leaderId || message.term !== knownTerm) {
          dropStale(message);
          return;
        }
        followerPort?.deliver(message.data);
        return;
      case 'bye':
        if (message.from === leaderId && message.term === knownTerm) {
          disconnectFollower();
          leaderId = undefined;
          send('leader-lost');
          post({ type: 'join', term: knownTerm });
          scheduleRejoin();
        }
        return;
      default:
        return;
    }
  };

  const onBus = (event: MessageEvent): void => {
    if (stopped) return;
    const message: unknown = event.data;
    if (!isBusMessage(message) || message.from === tabId) return;
    if (machine.is('leader')) onLeaderMessage(message);
    else if (machine.is('candidate', 'follower')) onFollowerMessage(message);
  };

  const startSingleTab = (): void => {
    transport.set('single-tab');
    send('elected');
    becomeLeader(1, () => undefined);
    noteNewLeader();
  };

  function startLeaderTab(): void {
    const broadcast = options.broadcast === null ? undefined : (options.broadcast ?? detectBroadcastChannel());
    const locks = options.locks === null ? undefined : (options.locks ?? detectLocks());
    if (broadcast === undefined || locks === undefined) {
      startSingleTab();
      return;
    }
    transport.set('leader-tab');
    resolvedLocks = locks;
    bus = broadcast(`sf-tabs:${options.id}`);
    // sf-lint-disable-next-line no-bare-listener -- BroadcastChannelLike takes no listener options; removed in dispose()
    bus.addEventListener('message', onBus);
    enqueue();
    if (!machine.is('leader')) {
      post({ type: 'join', term: knownTerm });
      scheduleRejoin();
    }
  }

  // ---- lifecycle (freeze / pagehide / resume)

  const offSuspend = lifecyclePort?.onSuspend(() => {
    if (stopped || suspended) return;
    suspended = true;
    telemetry.event('tabs.suspend', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { tab: tabId, role: machine.state } });
    if (machine.is('leader') && transport.get() === 'leader-tab') {
      stepDownInternal(false);
      return;
    }
    stopRejoin();
    election?.resign();
    election = undefined;
  });
  const offResume = lifecyclePort?.onResume(() => {
    if (stopped || !suspended) return;
    suspended = false;
    telemetry.event('tabs.resume', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { tab: tabId, role: machine.state } });
    if (transport.get() === 'leader-tab') {
      enqueue();
      if (!machine.is('leader')) {
        post({ type: 'join', term: knownTerm });
        if (machine.is('candidate')) scheduleRejoin();
      }
    }
    if (!machine.is('leader')) for (const replica of replicas.values()) if (replica.status === 'live') void replica.resync();
  });

  // ---- public API

  const whenReady = async (signal?: AbortSignal): Promise<Result<void>> => {
    const combined = anySignal(signal, controller.signal);
    for (const replica of replicas.values()) {
      const live = await replica.whenLive(combined);
      if (!live.ok) return stopped ? err(CoordinatorStoppedError({ cause: live.error })) : live;
    }
    return ok();
  };

  let started: Promise<Result<void>> | undefined;

  const coordinator: TabCoordinator = {
    id: options.id,
    tabId,
    get role() {
      return machine.state;
    },
    get transport() {
      return transport.get();
    },
    get term() {
      return knownTerm;
    },
    get leaderId() {
      return leaderId;
    },
    get isLeader() {
      return machine.is('leader');
    },
    start(signal) {
      if (stopped) return Promise.resolve(err(CoordinatorStoppedError()));
      started ??= (async (): Promise<Result<void>> => {
        send('start');
        const mode = options.transport ?? 'auto';
        if (mode !== 'leader-tab' && options.sharedWorker !== undefined) {
          transport.set('shared-worker');
          const connected = await connectShared(options.sharedWorker);
          if (!connected.ok) {
            if (stopped) return connected;
            if (mode === 'shared-worker') {
              return err(CoordinatorTransportError({ cause: connected.error, details: { coordinator: options.id } }));
            }
            telemetry.event('tabs.fallback', {
              subsystem: SUBSYSTEM,
              level: 'standard',
              attrs: { coordinator: options.id, code: connected.error.code, to: 'leader-tab' },
            });
            startLeaderTab();
          }
        } else if (mode === 'shared-worker') {
          return err(CoordinatorTransportError({ message: 'No SharedWorker spawner was given.', details: { coordinator: options.id } }));
        } else {
          startLeaderTab();
        }
        return ok();
      })();
      return started.then((result) => (result.ok ? whenReady(signal) : result));
    },
    replica<D extends AnyReplicaDefinition>(definition: D) {
      const replica = replicas.get(definition.id);
      if (replica === undefined) {
        return err(UnknownCoordinatedResourceError({ details: { resource: definition.id, coordinator: options.id } }));
      }
      return ok(replica as unknown as Replica<StateOf<D>, IntentsOf<D>>);
    },
    async intent(definition, action, args, intentOptions = {}) {
      type R = IntentsOf<typeof definition>[typeof action]['result'];
      const replica = replicas.get(definition.id);
      if (replica === undefined) {
        return err(UnknownCoordinatedResourceError({ details: { resource: definition.id, coordinator: options.id } }));
      }
      if (stopped) return err(CoordinatorStoppedError());
      const budget = new AbortController();
      const timer =
        intentOptions.timeoutMs === undefined
          ? undefined
          : clock.setTimeout(() => budget.abort(new DOMException('intent timed out', 'TimeoutError')), intentOptions.timeoutMs);
      const signal = anySignal(intentOptions.signal, controller.signal, budget.signal);
      const span = telemetry.span('tabs.intent', {
        subsystem: SUBSYSTEM,
        level: 'verbose',
        attrs: { coordinator: options.id, resource: definition.id, action, role: machine.state },
      });
      const finish = (result: Result<unknown>): Result<R> => {
        if (timer !== undefined) clock.clearTimeout(timer);
        span.set('term', knownTerm);
        span.end(result.ok ? 'ok' : result.error.kind === 'aborted' ? 'cancelled' : 'error', result.ok ? undefined : result.error);
        return result as Result<R>;
      };
      for (let attempt = 1; ; attempt += 1) {
        const live = await replica.whenLive(signal);
        if (!live.ok) return finish(err(stopped ? CoordinatorStoppedError({ cause: live.error }) : abortReason(signal, live.error)));
        const result = await replica.intent(action, args, { signal });
        const lost = !result.ok && result.error.code === PortClosedError.code;
        if (lost && intentOptions.idempotent === true && attempt < 3 && !signal.aborted) continue;
        if (!result.ok && signal.aborted) return finish(err(abortReason(signal, result.error)));
        return finish(result);
      }
    },
    whenReady,
    stepDown() {
      stepDownInternal(true);
    },
    onRoleChange: (listener) => machine.onTransition(listener),
    inspect() {
      return {
        id: options.id,
        tabId,
        role: machine.state,
        transport: transport.get(),
        term: knownTerm,
        leaderId,
        peers: host?.peers ?? 0,
        resources: [...replicas.entries()].map(([id, replica]) => ({ id, status: replica.status, version: replica.version })),
      };
    },
    async dispose() {
      if (stopped) return;
      if (machine.is('leader')) stepDownInternal(false);
      else if (leaderId !== undefined && transport.get() === 'leader-tab') post({ type: 'bye', to: leaderId, term: knownTerm });
      stopped = true;
      stopRejoin();
      offSuspend?.();
      offResume?.();
      disconnectFollower();
      releaseLeadership();
      bus?.removeEventListener('message', onBus);
      bus?.close();
      bus = undefined;
      for (const replica of replicas.values()) replica.detach();
      controller.abort(new DOMException('coordinator disposed', 'AbortError'));
      send('stop');
    },
  };
  return coordinator;
}

function abortReason(signal: AbortSignal, fallback: SfError): SfError {
  const reason: unknown = signal.reason;
  if (reason instanceof DOMException && reason.name === 'TimeoutError') {
    return AbortedError({ message: 'The intent did not reach an owner in time.', cause: reason, details: { reason: 'timeout' } });
  }
  return fallback.kind === 'aborted' ? fallback : AbortedError({ cause: reason });
}
