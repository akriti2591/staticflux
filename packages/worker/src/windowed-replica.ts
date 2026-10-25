/**
 * Query / windowed replicas (SF-Δ19): a replica that holds only the entities
 * inside a **window** the reader chooses — a viewport rectangle, a subtree root,
 * a time range — instead of the whole store (`replication.ts`). The owner keeps,
 * per peer, the window and the set of keys it sent; every change batch becomes
 * per-peer `upserts` (entered or changed inside the window) and `removes` (left
 * the window or deleted). Moving the window sends only the difference.
 *
 * - Versions are per peer and per owner epoch; a gap or a new owner epoch (respawn)
 *   makes the replica re-request its window and receive a `reset` (resnapshot of
 *   the window), like whole-store replicas (R11.3).
 * - Reads are local and synchronous (`entries`); writes still go through the owner
 *   (I-9) with whatever intent channel the store offers.
 *
 * @example
 * export const VisibleNodes = defineWindowedReplica('instaflow/visible-nodes').type<NodeView, Rect>();
 * createWindowedPublisher({ definition: VisibleNodes, source: sceneIndex }).attach(link);   // editor
 * const visible = createWindowedReplica(VisibleNodes);                                     // main (a11y layer)
 * await visible.attach(link);
 * await visible.setWindow(viewportRect);
 * for (const [id, node] of visible.entries) layer.update(id, node);
 */
import { AbortedError, createNoopTelemetry, err, ok, type Result, type Scope, type Telemetry } from '@staticflux/core';
import { type FlushScheduler, microtaskScheduler } from './clock.js';
import type { ChannelId } from './envelope.js';
import { InvalidEnvelopeError, PortClosedError } from './errors.js';
import type { Link } from './link.js';

export type WindowKey = string | number;

declare const windowTypes: unique symbol;

export interface WindowedReplicaDefinition<Id extends ChannelId = ChannelId, E = unknown, W = unknown, K extends WindowKey = WindowKey> {
  readonly kind: 'windowed-replica';
  readonly id: Id;
  readonly channel: `sf/windowed/${Id}`;
  /** Phantom type carrier; never present at runtime. */
  readonly [windowTypes]?: { readonly entity: E; readonly window: W; readonly key: K };
}

/** Declare a windowed replica: `defineWindowedReplica('app/visible').type<Entity, Window, Key>()`. */
/* @__NO_SIDE_EFFECTS__ */
export function defineWindowedReplica<const Id extends ChannelId>(
  id: Id,
): { type<E, W, K extends WindowKey = string>(): WindowedReplicaDefinition<Id, E, W, K> } {
  return {
    type: <E, W, K extends WindowKey = string>() =>
      Object.freeze({ kind: 'windowed-replica', id, channel: `sf/windowed/${id}` }) as WindowedReplicaDefinition<Id, E, W, K>,
  };
}

export interface WindowChange<K extends WindowKey, E> {
  readonly key: K;
  /** Undefined: the entity was deleted. */
  readonly entity: E | undefined;
}

/** What an owner store offers to windowed replicas (e.g. a spatial index over the scene). */
export interface WindowedSource<K extends WindowKey, E, W> {
  /** Entities inside `window`. */
  query(window: W): Iterable<readonly [K, E]>;
  /** Whether one entity is inside `window` (routes changes). */
  contains(window: W, key: K, entity: E): boolean;
  /** Changes in commit order. Returns unsubscribe. */
  onChanges(listener: (changes: readonly WindowChange<K, E>[]) => void): () => void;
}

type Def<K extends WindowKey, E, W> = WindowedReplicaDefinition<ChannelId, E, W, K>;

interface WindowRequest {
  readonly type: 'window';
  readonly window: unknown;
  /** The replica's epoch/version; a mismatch (or `resync`) yields a reset. */
  readonly epoch: string | null;
  readonly version: number;
  readonly resync?: boolean;
}

interface ResetMessage {
  readonly type: 'reset';
  readonly epoch: string;
  readonly version: number;
  readonly entries: readonly (readonly [WindowKey, unknown])[];
}

interface DeltaMessage {
  readonly type: 'delta';
  readonly epoch: string;
  readonly from: number;
  readonly to: number;
  readonly upserts: readonly (readonly [WindowKey, unknown])[];
  readonly removes: readonly WindowKey[];
}

type WindowMessage = ResetMessage | DeltaMessage;

const isWindowMessage = (value: unknown): value is WindowMessage => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['epoch'] !== 'string') return false;
  if (v['type'] === 'reset') return typeof v['version'] === 'number' && Array.isArray(v['entries']);
  if (v['type'] === 'delta') return typeof v['from'] === 'number' && typeof v['to'] === 'number' && Array.isArray(v['upserts']) && Array.isArray(v['removes']);
  return false;
};

let epochs = 0;
const newEpoch = (): string => {
  epochs += 1;
  return `${Math.floor(Math.random() * 0xffffffff).toString(16)}-w${epochs}`;
};

const SUBSYSTEM = 'worker/windowed-replica';

// ---------------------------------------------------------------- owner

export interface WindowedPublisher {
  readonly epoch: string;
  readonly peers: number;
  attach(link: Link, scope?: Scope): () => void;
  /** Route pending changes now. */
  flush(): void;
  dispose(): void;
}

export interface WindowedPublisherOptions<K extends WindowKey, E, W> {
  readonly definition: Def<K, E, W>;
  readonly source: WindowedSource<K, E, W>;
  /** Batching of change routing. Default: microtask. */
  readonly schedule?: FlushScheduler;
  readonly epoch?: string;
  readonly telemetry?: Telemetry;
}

interface Peer<K extends WindowKey, W> {
  window: W | undefined;
  members: Set<K>;
  version: number;
}

export function createWindowedPublisher<K extends WindowKey, E, W>(options: WindowedPublisherOptions<K, E, W>): WindowedPublisher {
  const { definition, source } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const schedule = options.schedule ?? microtaskScheduler;
  const epoch = options.epoch ?? newEpoch();
  const peers = new Map<Link, { state: Peer<K, W>; detach: () => void }>();
  let pending = new Map<K, E | undefined>();
  let scheduled = false;
  let disposed = false;

  const send = (link: Link, peer: Peer<K, W>, upserts: [K, E][], removes: K[]): void => {
    if (upserts.length === 0 && removes.length === 0) return;
    const from = peer.version;
    peer.version += 1;
    link.send(definition.channel, { type: 'delta', epoch, from, to: peer.version, upserts, removes } satisfies DeltaMessage, { version: peer.version });
  };

  const flush = (): void => {
    scheduled = false;
    if (pending.size === 0) return;
    const changes = pending;
    pending = new Map();
    for (const [link, { state: peer }] of peers) {
      if (peer.window === undefined) continue;
      const upserts: [K, E][] = [];
      const removes: K[] = [];
      for (const [key, entity] of changes) {
        const inside = entity !== undefined && source.contains(peer.window, key, entity);
        if (inside) {
          peer.members.add(key);
          upserts.push([key, entity]);
        } else if (peer.members.delete(key)) {
          removes.push(key);
        }
      }
      send(link, peer, upserts, removes);
    }
  };

  const unsubscribe = source.onChanges((changes) => {
    if (disposed) return;
    for (const change of changes) pending.set(change.key, change.entity);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  });

  const answer = (peer: Peer<K, W>, request: WindowRequest): WindowMessage => {
    flush(); // read-your-writes: route queued changes against the old window first
    const window = request.window as W;
    const inWindow = new Map<K, E>();
    for (const [key, entity] of source.query(window)) inWindow.set(key, entity);
    const continuous = request.resync !== true && request.epoch === epoch && request.version === peer.version && peer.window !== undefined;
    peer.window = window;
    if (!continuous) {
      peer.members = new Set(inWindow.keys());
      peer.version += 1;
      telemetry.event('windowed-replica.reset', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { store: definition.id, size: inWindow.size } });
      return { type: 'reset', epoch, version: peer.version, entries: [...inWindow] };
    }
    const removes = [...peer.members].filter((key) => !inWindow.has(key));
    const upserts = [...inWindow].filter(([key]) => !peer.members.has(key));
    peer.members = new Set(inWindow.keys());
    const from = peer.version;
    peer.version += 1;
    return { type: 'delta', epoch, from, to: peer.version, upserts, removes };
  };

  return {
    epoch,
    get peers() {
      return peers.size;
    },
    flush,
    attach(link, scope) {
      const existing = peers.get(link);
      if (existing !== undefined) return existing.detach;
      const state: Peer<K, W> = { window: undefined, members: new Set(), version: 0 };
      const unhandle = link.handle(definition.channel, (payload) => {
        const request = payload as Partial<WindowRequest> | null;
        if (request?.type !== 'window') return err(InvalidEnvelopeError({ message: 'Unknown windowed replica request.', details: { store: definition.id } }));
        return ok(answer(state, request as WindowRequest));
      });
      const offClose = link.onClose(() => detach());
      const detach = (): void => {
        if (!peers.has(link)) return;
        peers.delete(link);
        unhandle();
        offClose();
      };
      peers.set(link, { state, detach });
      scope?.defer(detach);
      return detach;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const { detach } of [...peers.values()]) detach();
    },
  };
}

// ---------------------------------------------------------------- reference source

export interface MemoryWindowedSource<K extends WindowKey, E, W> extends WindowedSource<K, E, W> {
  readonly size: number;
  get(key: K): E | undefined;
  set(key: K, entity: E): void;
  delete(key: K): boolean;
  /** Apply several changes as one batch. */
  batch(changes: readonly WindowChange<K, E>[]): void;
}

/**
 * A Map-backed `WindowedSource` with a linear scan (small stores, tests, and the
 * reference implementation contract suites compare against). Real stores answer
 * `query` from an index (rbush for viewports, parent links for subtrees).
 */
export function createMemoryWindowedSource<K extends WindowKey, E, W>(
  contains: (window: W, key: K, entity: E) => boolean,
  initial: Iterable<readonly [K, E]> = [],
): MemoryWindowedSource<K, E, W> {
  const entities = new Map<K, E>(initial);
  const listeners = new Set<(changes: readonly WindowChange<K, E>[]) => void>();
  const publish = (changes: readonly WindowChange<K, E>[]): void => {
    for (const change of changes) {
      if (change.entity === undefined) entities.delete(change.key);
      else entities.set(change.key, change.entity);
    }
    for (const listener of [...listeners]) listener(changes);
  };
  return {
    get size() {
      return entities.size;
    },
    get: (key) => entities.get(key),
    set: (key, entity) => publish([{ key, entity }]),
    delete(key) {
      if (!entities.has(key)) return false;
      publish([{ key, entity: undefined }]);
      return true;
    },
    batch: publish,
    *query(window) {
      for (const [key, entity] of entities) if (contains(window, key, entity)) yield [key, entity] as const;
    },
    contains,
    onChanges(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ---------------------------------------------------------------- replica

export interface WindowedReplicaEvent<K extends WindowKey, E> {
  readonly reset: boolean;
  readonly upserts: readonly (readonly [K, E])[];
  readonly removes: readonly K[];
  readonly version: number;
}

export type WindowedReplicaStatus = 'detached' | 'syncing' | 'live';

export interface WindowedReplica<K extends WindowKey, E, W> {
  readonly window: W | undefined;
  /** Entities inside the window (read-only; do not mutate). */
  readonly entries: ReadonlyMap<K, E>;
  readonly version: number;
  readonly epoch: string | undefined;
  readonly status: WindowedReplicaStatus;
  /** Bind to the owner's link; re-requests the current window (respawned owner → reset). */
  attach(link: Link, scope?: Scope): Promise<Result<void>>;
  detach(): void;
  /** Move the window; resolves once its entries are applied. */
  setWindow(window: W, options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<Result<void>>;
  subscribe(listener: (event: WindowedReplicaEvent<K, E>) => void): () => void;
}

export function createWindowedReplica<K extends WindowKey, E, W>(
  definition: Def<K, E, W>,
  options: { readonly telemetry?: Telemetry } = {},
): WindowedReplica<K, E, W> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const entries = new Map<K, E>();
  const listeners = new Set<(event: WindowedReplicaEvent<K, E>) => void>();
  let link: Link | undefined;
  let cleanup: (() => void) | undefined;
  let window: W | undefined;
  let version = 0;
  let epoch: string | undefined;
  let status: WindowedReplicaStatus = 'detached';
  let requestSeq = 0;

  const emit = (event: WindowedReplicaEvent<K, E>): void => {
    for (const listener of [...listeners]) listener(event);
  };
  /** Apply a message; returns false on a gap / epoch change (caller resyncs). */
  const apply = (message: WindowMessage): boolean => {
    if (message.type === 'reset') {
      entries.clear();
      for (const [key, entity] of message.entries) entries.set(key as K, entity as E);
      epoch = message.epoch;
      version = message.version;
      emit({ reset: true, upserts: message.entries as readonly (readonly [K, E])[], removes: [], version });
      return true;
    }
    if (message.epoch !== epoch || message.from !== version) {
      telemetry.event('windowed-replica.gap', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { store: definition.id, have: version, from: message.from } });
      return false;
    }
    for (const key of message.removes) entries.delete(key as K);
    for (const [key, entity] of message.upserts) entries.set(key as K, entity as E);
    version = message.to;
    emit({ reset: false, upserts: message.upserts as readonly (readonly [K, E])[], removes: message.removes as readonly K[], version });
    return true;
  };

  const request = async (next: W, resync: boolean, requestOptions: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Result<void>> => {
    const current = link;
    if (current === undefined || current.closed) return err(PortClosedError({ message: 'The windowed replica is not attached.', details: { store: definition.id } }));
    requestSeq += 1;
    const mine = requestSeq;
    status = 'syncing';
    const body: WindowRequest = { type: 'window', window: next, epoch: epoch ?? null, version, resync };
    const response = await current.request(definition.channel, body, requestOptions);
    if (link !== current) return err(PortClosedError({ details: { store: definition.id } }));
    if (!response.ok) {
      if (mine === requestSeq) status = 'detached';
      return response;
    }
    if (!isWindowMessage(response.value)) return err(InvalidEnvelopeError({ message: 'Malformed windowed replica response.', details: { store: definition.id } }));
    if (!apply(response.value)) return request(next, true, requestOptions);
    if (mine === requestSeq) status = 'live';
    return ok();
  };

  const detach = (): void => {
    cleanup?.();
    cleanup = undefined;
    link = undefined;
    status = 'detached';
  };

  return {
    get window() {
      return window;
    },
    entries,
    get version() {
      return version;
    },
    get epoch() {
      return epoch;
    },
    get status() {
      return status;
    },
    attach(next, scope) {
      detach();
      link = next;
      const offEvent = next.on(definition.channel, (payload) => {
        if (link !== next || status === 'detached' || !isWindowMessage(payload) || window === undefined) return;
        // While a window request is in flight, continuous deltas still apply; others are settled by its answer.
        if (!apply(payload) && status === 'live') void request(window, true);
      });
      const offClose = next.onClose(() => {
        if (link === next) detach();
      });
      cleanup = () => {
        offEvent();
        offClose();
      };
      scope?.defer(() => {
        if (link === next) detach();
      });
      return window === undefined ? Promise.resolve(ok()) : request(window, false);
    },
    detach,
    setWindow(next, setOptions = {}) {
      if (setOptions.signal?.aborted === true) return Promise.resolve(err(AbortedError({ cause: setOptions.signal.reason })));
      window = next;
      return request(next, false, setOptions);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
