/**
 * Brokered peer channels (SF-Δ19, REQUIREMENTS open question 4: direct
 * MessageChannel between workers, brokered by main). The main thread's broker
 * creates the channel between two workers and **re-wires it on every respawn**;
 * each worker holds one `PeerChannel` object that survives re-wires, so feature
 * code subscribes once and re-sends its state in `onConnect`.
 *
 *   worker A ──ready{session}──► broker ◄──ready{session}── worker B
 *   broker: both ready → generation += 1 → offer{port a} to A, offer{port b} to B
 *   B crashes → broker sends down{generation} to A → B respawns, says ready → new generation
 *
 * - Colocated topology (D15): `createPeerPair(def)` gives both ends in one worker
 *   with the same `PeerChannel` API and no broker.
 * - A worker announces itself with a per-instance `session`; the broker probes
 *   every new link, so neither side can miss the other's announcement.
 * - Requests in flight when a link goes away fail with SF-WK-009; pass
 *   `{ waitForConnection: true }` to wait for the next generation instead of
 *   failing with SF-WK-040 while disconnected.
 *
 * @example
 * export const EditorRender = definePeer('instaflow/editor-render');
 * // main
 * const broker = createPeerBroker();
 * broker.connect(EditorRender, workerHost(editorWorker), workerHost(renderWorker));
 * // editor worker (and render worker likewise)
 * const peer = acceptPeer(runtime.link, EditorRender);
 * peer.onConnect((link) => link.send(Pipes, endpoints, { transfer }));
 */
import {
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  type Machine,
  ok,
  type Result,
  type Telemetry,
} from '@staticflux/core';
import type { ChannelId } from './envelope.js';
import { NoHandlerError } from './errors.js';
import {
  createLink,
  type Link,
  type LinkEventListener,
  type LinkRequestHandler,
  type LinkRequestOptions,
  type MessageContext,
  type SendOptions,
} from './link.js';
import { PeerNotConnectedError } from './pipeline-errors.js';
import { createPortPair, type Port } from './port.js';
import { isMessagePortLike, toPort } from './region.js';

export const PeerChannels = {
  offer: 'sf/peer-offer',
  down: 'sf/peer-down',
  ready: 'sf/peer-ready',
  probe: 'sf/peer-probe',
} as const satisfies Record<string, ChannelId>;

export interface PeerDefinition<Id extends ChannelId = ChannelId> {
  readonly kind: 'peer';
  readonly id: Id;
}

export function definePeer<const Id extends ChannelId>(id: Id): PeerDefinition<Id> {
  return Object.freeze({ kind: 'peer', id });
}

export type PeerSide = 'a' | 'b';

interface OfferMessage {
  readonly peer: string;
  readonly generation: number;
  readonly side: PeerSide;
  readonly port: unknown;
}
interface PeerMessage {
  readonly peer: string;
  readonly generation?: number;
  readonly session?: string;
}

const isPeerMessage = (value: unknown): value is PeerMessage =>
  typeof value === 'object' && value !== null && typeof (value as PeerMessage).peer === 'string';

export const PeerChannelLifecycle = defineMachine({
  id: 'worker/peer-channel',
  initial: 'waiting',
  states: ['waiting', 'connected', 'disconnected', 'closed'],
  transitions: {
    waiting: { connect: 'connected', close: 'closed' },
    connected: { connect: 'connected', disconnect: 'disconnected', close: 'closed' },
    disconnected: { connect: 'connected', close: 'closed' },
  },
  terminal: ['closed'],
});

export type PeerChannelState = (typeof PeerChannelLifecycle.states)[number];
export type PeerChannelEvent = 'connect' | 'disconnect' | 'close';

export interface PeerRequestOptions extends LinkRequestOptions {
  /** Wait for the next connection instead of failing with SF-WK-040 while disconnected. */
  readonly waitForConnection?: boolean;
}

/** Runs on every (re)connection; may return a cleanup that runs when that link goes away. */
export type PeerConnectListener = (link: Link, generation: number) => void | (() => void);

export interface PeerChannel {
  readonly id: ChannelId;
  /** Increments on every (re)connection. */
  readonly generation: number;
  readonly state: PeerChannelState;
  readonly machine: Machine<PeerChannelState, PeerChannelEvent>;
  /** Current link to the peer (undefined while waiting or disconnected). */
  readonly link: Link | undefined;
  send(channel: ChannelId, payload: unknown, options?: SendOptions): Result<void>;
  /** Event listener that survives re-wires. */
  on(channel: ChannelId, listener: LinkEventListener): () => void;
  /** Request handler that survives re-wires (one per channel). */
  handle(channel: ChannelId, handler: LinkRequestHandler): () => void;
  request(channel: ChannelId, payload: unknown, options?: PeerRequestOptions): Promise<Result<unknown>>;
  onConnect(listener: PeerConnectListener): () => void;
  whenConnected(signal?: AbortSignal): Promise<Result<Link>>;
  close(): void;
}

export interface PeerChannelOptions {
  readonly telemetry?: Telemetry;
  /** Default request timeout on peer links. */
  readonly defaultTimeoutMs?: number;
}

const SUBSYSTEM = 'worker/peer';

interface PeerCore extends PeerChannel {
  adopt(port: Port, generation: number): void;
  drop(generation?: number): void;
}

function createPeerCore(definition: PeerDefinition, options: PeerChannelOptions): PeerCore {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const machine = createMachine(PeerChannelLifecycle);
  const listeners = new Map<ChannelId, Set<LinkEventListener>>();
  const handlers = new Map<ChannelId, LinkRequestHandler>();
  const connectListeners = new Set<PeerConnectListener>();
  let waiters: ((link: Link | undefined) => void)[] = [];
  let link: Link | undefined;
  let generation = 0;
  let linkCleanups: (() => void)[] = [];

  const dispatch = (channel: ChannelId, payload: unknown, context: MessageContext): void => {
    for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload, context);
  };
  const subscribe = (current: Link, channel: ChannelId): void => {
    linkCleanups.push(current.on(channel, (payload, context) => dispatch(channel, payload, context)));
  };
  const delegate = (current: Link, channel: ChannelId): void => {
    linkCleanups.push(
      current.handle(channel, (payload, context) => {
        const handler = handlers.get(channel);
        return handler === undefined ? err(NoHandlerError({ details: { channel, peer: definition.id } })) : handler(payload, context);
      }),
    );
  };
  const runConnect = (current: Link, listener: PeerConnectListener): void => {
    const cleanup = listener(current, generation);
    if (typeof cleanup === 'function') linkCleanups.push(cleanup);
  };
  const settleWaiters = (value: Link | undefined): void => {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter(value);
  };

  const drop = (only?: number): void => {
    if (only !== undefined && only !== generation) return;
    const current = link;
    if (current === undefined) return;
    link = undefined;
    const cleanups = linkCleanups;
    linkCleanups = [];
    for (const cleanup of cleanups.reverse()) cleanup();
    current.close();
    if (machine.can('disconnect')) machine.send('disconnect');
    telemetry.event('worker.peer.disconnected', { subsystem: SUBSYSTEM, level: 'standard', attrs: { peer: definition.id, generation } });
  };

  const core: PeerCore = {
    id: definition.id,
    machine,
    get generation() {
      return generation;
    },
    get state() {
      return machine.state;
    },
    get link() {
      return link;
    },
    adopt(port, nextGeneration) {
      if (machine.state === 'closed' || nextGeneration <= generation) {
        port.close(); // stale offer (an older generation overtaken by a newer one)
        return;
      }
      drop();
      generation = nextGeneration;
      const next = createLink({
        port,
        name: `${definition.id}#${nextGeneration}`,
        telemetry,
        ...(options.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.defaultTimeoutMs }),
      });
      link = next;
      for (const channel of listeners.keys()) subscribe(next, channel);
      for (const channel of handlers.keys()) delegate(next, channel);
      linkCleanups.push(next.onClose(() => link === next && drop()));
      machine.send('connect');
      telemetry.event('worker.peer.connected', { subsystem: SUBSYSTEM, level: 'standard', attrs: { peer: definition.id, generation } });
      for (const listener of [...connectListeners]) runConnect(next, listener);
      settleWaiters(next);
    },
    drop,
    send(channel, payload, sendOptions) {
      if (link === undefined) return err(PeerNotConnectedError({ details: { peer: definition.id, channel } }));
      link.send(channel, payload, sendOptions);
      return ok();
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (set === undefined) {
        set = new Set();
        listeners.set(channel, set);
        if (link !== undefined) subscribe(link, channel);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    handle(channel, handler) {
      const fresh = !handlers.has(channel);
      handlers.set(channel, handler);
      if (fresh && link !== undefined) delegate(link, channel);
      return () => {
        if (handlers.get(channel) === handler) handlers.delete(channel);
      };
    },
    async request(channel, payload, requestOptions = {}) {
      let current = link;
      if (current === undefined) {
        if (requestOptions.waitForConnection !== true) return err(PeerNotConnectedError({ details: { peer: definition.id, channel } }));
        const connected = await core.whenConnected(requestOptions.signal);
        if (!connected.ok) return connected;
        current = connected.value;
      }
      return current.request(channel, payload, requestOptions);
    },
    onConnect(listener) {
      connectListeners.add(listener);
      if (link !== undefined) runConnect(link, listener);
      return () => connectListeners.delete(listener);
    },
    whenConnected(signal) {
      if (link !== undefined) return Promise.resolve(ok(link));
      if (machine.state === 'closed') return Promise.resolve(err(PeerNotConnectedError({ message: 'The peer channel is closed.' })));
      if (signal?.aborted === true) return Promise.resolve(err(PeerNotConnectedError({ cause: signal.reason })));
      return new Promise((resolve) => {
        // Aborted to detach the abort listener once a connection (or close) settles the wait.
        const detach = new AbortController();
        const waiter = (value: Link | undefined): void => {
          detach.abort();
          resolve(value === undefined ? err(PeerNotConnectedError({ message: 'The peer channel is closed.' })) : ok(value));
        };
        waiters.push(waiter);
        signal?.addEventListener(
          'abort',
          () => {
            waiters = waiters.filter((w) => w !== waiter);
            resolve(err(PeerNotConnectedError({ cause: signal.reason })));
          },
          { once: true, signal: detach.signal },
        );
      });
    },
    close() {
      if (machine.state === 'closed') return;
      drop();
      machine.send('close');
      settleWaiters(undefined);
      connectListeners.clear();
      listeners.clear();
      handlers.clear();
    },
  };
  return core;
}

// ---------------------------------------------------------------- worker side

let sessionCounter = 0;
const newSession = (): string => {
  sessionCounter += 1;
  return `${Math.floor(Math.random() * 0xffffffff).toString(16)}-${sessionCounter}`;
};

/**
 * Inside a worker: the peer end of `definition`, fed by the broker over the
 * worker's link to the main thread (`runtime.link`).
 */
export function acceptPeer(link: Link, definition: PeerDefinition, options: PeerChannelOptions = {}): PeerChannel {
  const core = createPeerCore(definition, options);
  const session = newSession();
  const announce = (): void => {
    if (!link.closed && core.state !== 'closed') link.send(PeerChannels.ready, { peer: definition.id, session } satisfies PeerMessage);
  };
  const offs = [
    link.on(PeerChannels.offer, (payload) => {
      const offer = payload as Partial<OfferMessage> | null;
      if (offer?.peer !== definition.id || typeof offer.generation !== 'number') return;
      const port = toPort(offer.port);
      if (port !== undefined) core.adopt(port, offer.generation);
    }),
    link.on(PeerChannels.down, (payload) => {
      if (isPeerMessage(payload) && payload.peer === definition.id) core.drop(payload.generation);
    }),
    link.on(PeerChannels.probe, (payload) => {
      if (isPeerMessage(payload) && payload.peer === definition.id) announce();
    }),
    link.onClose(() => core.drop()),
  ];
  announce();
  const close = core.close;
  return Object.assign(core, {
    close() {
      for (const off of offs) off();
      close();
    },
  });
}

export interface PeerPair {
  readonly a: PeerChannel;
  readonly b: PeerChannel;
  /** Replace the connection with a new generation (tests; mirrors a broker re-wire). */
  rewire(): void;
  /** Disconnect both ends (mirrors one side going away). */
  disconnect(): void;
  close(): void;
}

/** Both ends in one thread (colocated topology): same API, no broker. Messages are passed by reference. */
export function createPeerPair(definition: PeerDefinition, options: PeerChannelOptions & { readonly clone?: boolean } = {}): PeerPair {
  const a = createPeerCore(definition, options);
  const b = createPeerCore(definition, options);
  let generation = 0;
  const rewire = (): void => {
    generation += 1;
    const pair = createPortPair({ clone: options.clone ?? false });
    a.adopt(pair.a, generation);
    b.adopt(pair.b, generation);
  };
  rewire();
  return {
    a,
    b,
    rewire,
    disconnect() {
      a.drop();
      b.drop();
    },
    close() {
      a.close();
      b.close();
    },
  };
}

// ---------------------------------------------------------------- broker (main thread)

/** A worker as the broker sees it: its current link (changes on respawn). */
export interface PeerHost {
  readonly id: string;
  readonly link: Link | undefined;
  onLink(listener: (link: Link | undefined) => void): () => void;
}

/** A fixed link (a worker that is never respawned, or tests). */
export function linkHost(link: Link, id: string = link.name): PeerHost {
  return {
    id,
    get link() {
      return link.closed ? undefined : link;
    },
    onLink(listener) {
      return link.onClose(() => listener(undefined));
    },
  };
}

/** Structural view of a supervised worker (`createSupervisedWorker`). */
export interface SupervisedWorkerLike {
  readonly id: string;
  readonly state: string;
  readonly link: Link | undefined;
  onStateChange(listener: (record: { readonly to: string }) => void): () => void;
}

const LINKED_STATES = new Set(['ready', 'busy', 'unresponsive']);

/** A supervised worker: its link while ready/busy, undefined while (re)spawning or stopped. */
export function workerHost(worker: SupervisedWorkerLike): PeerHost {
  const linkOf = (state: string): Link | undefined => (LINKED_STATES.has(state) ? worker.link : undefined);
  return {
    id: worker.id,
    get link() {
      return linkOf(worker.state);
    },
    onLink(listener) {
      let current = linkOf(worker.state);
      return worker.onStateChange((record) => {
        const next = linkOf(record.to);
        if (next === current) return;
        current = next;
        listener(next);
      });
    },
  };
}

/** How the broker creates a channel between two workers. */
export interface PeerWire {
  create(): { readonly a: unknown; readonly b: unknown };
  transfer(end: unknown): Transferable[];
}

/** Real MessageChannels (cross-worker). */
export const messageChannelWire: PeerWire = {
  create() {
    const channel = new MessageChannel();
    return { a: channel.port1, b: channel.port2 };
  },
  transfer: (end) => (isMessagePortLike(end) ? [end] : []),
};

/** In-memory port pairs (in-thread workers from `inMemorySpawner(…, { clone: false })`, tests). */
export function memoryWire(options: { readonly clone?: boolean } = {}): PeerWire {
  return {
    create() {
      const pair = createPortPair({ clone: options.clone ?? false });
      return { a: pair.a, b: pair.b };
    },
    transfer: () => [],
  };
}

export interface PeerConnection {
  readonly id: ChannelId;
  readonly generation: number;
  readonly connected: boolean;
  /** Times the connection was (re)made. */
  readonly wirings: number;
  /** Force a new generation now (both sides must be linked and ready). */
  rewire(): boolean;
  dispose(): void;
}

export interface PeerBroker {
  connect(definition: PeerDefinition, a: PeerHost, b: PeerHost): PeerConnection;
  readonly connections: readonly PeerConnection[];
  dispose(): void;
}

export interface PeerBrokerOptions {
  /** Default: MessageChannel when available, in-memory pairs otherwise. */
  readonly wire?: PeerWire;
  readonly telemetry?: Telemetry;
}

interface BrokerSide {
  readonly name: PeerSide;
  readonly host: PeerHost;
  link: Link | undefined;
  session: string | undefined;
  offs: (() => void)[];
}

export function createPeerBroker(options: PeerBrokerOptions = {}): PeerBroker {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const wire =
    options.wire ?? (typeof MessageChannel === 'function' ? messageChannelWire : memoryWire());
  const connections = new Set<PeerConnection>();

  const connect = (definition: PeerDefinition, hostA: PeerHost, hostB: PeerHost): PeerConnection => {
    const sides: Record<PeerSide, BrokerSide> = {
      a: { name: 'a', host: hostA, link: undefined, session: undefined, offs: [] },
      b: { name: 'b', host: hostB, link: undefined, session: undefined, offs: [] },
    };
    let generation = 0;
    let connected = false;
    let wirings = 0;
    let disposed = false;

    const other = (side: BrokerSide): BrokerSide => (side.name === 'a' ? sides.b : sides.a);
    const tryWire = (): boolean => {
      const { a, b } = sides;
      if (disposed || a.link === undefined || b.link === undefined || a.session === undefined || b.session === undefined) return false;
      generation += 1;
      wirings += 1;
      const ends = wire.create();
      a.link.send(PeerChannels.offer, { peer: definition.id, generation, side: 'a', port: ends.a } satisfies OfferMessage, { transfer: wire.transfer(ends.a) });
      b.link.send(PeerChannels.offer, { peer: definition.id, generation, side: 'b', port: ends.b } satisfies OfferMessage, { transfer: wire.transfer(ends.b) });
      connected = true;
      telemetry.event('worker.peer.wired', {
        subsystem: SUBSYSTEM,
        level: 'standard',
        attrs: { peer: definition.id, generation, a: hostA.id, b: hostB.id },
      });
      return true;
    };
    const lose = (side: BrokerSide): void => {
      if (!connected) return;
      connected = false;
      const survivor = other(side);
      survivor.link?.send(PeerChannels.down, { peer: definition.id, generation } satisfies PeerMessage);
    };
    const setLink = (side: BrokerSide, link: Link | undefined): void => {
      if (link === side.link) return;
      for (const off of side.offs.splice(0)) off();
      lose(side);
      side.link = link;
      side.session = undefined;
      if (link === undefined || disposed) return;
      side.offs.push(
        link.on(PeerChannels.ready, (payload) => {
          if (!isPeerMessage(payload) || payload.peer !== definition.id || typeof payload.session !== 'string') return;
          if (side.session === payload.session && connected) return; // duplicate announcement
          side.session = payload.session;
          tryWire();
        }),
        link.onClose(() => {
          if (side.link === link) setLink(side, undefined);
        }),
      );
      link.send(PeerChannels.probe, { peer: definition.id } satisfies PeerMessage);
    };

    const hostOffs = (['a', 'b'] as const).map((name) => {
      const side = sides[name];
      setLink(side, side.host.link);
      return side.host.onLink((link) => setLink(side, link));
    });

    const connection: PeerConnection = {
      id: definition.id,
      get generation() {
        return generation;
      },
      get connected() {
        return connected;
      },
      get wirings() {
        return wirings;
      },
      rewire: tryWire,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const off of hostOffs) off();
        for (const side of [sides.a, sides.b]) {
          lose(side);
          for (const off of side.offs.splice(0)) off();
        }
        connections.delete(connection);
      },
    };
    connections.add(connection);
    return connection;
  };

  return {
    connect,
    get connections() {
      return [...connections];
    },
    dispose() {
      for (const connection of [...connections]) connection.dispose();
    },
  };
}
