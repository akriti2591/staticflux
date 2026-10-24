/**
 * Store replication across threads (R11.2–R11.4, invariant I-9).
 *
 *   Owner (one per store)                         Replica (read-only, many)
 *   source.onPatches ──batch per flush──► event {patches, fromVersion, toVersion, epoch}
 *                                    ◄── request hello{haveVersion, epoch}
 *                    snapshot | patchesSince (ring buffer) ──►
 *                                    ◄── request intent{action, args}
 *   source.applyIntent → flush → response {value, version}
 *
 * - Versions count flushes; one flush = one version (patches batched per microtask / frame).
 * - The owner epoch is a random id per publisher instance: a respawned owner has a
 *   new epoch, so replicas resnapshot (gap or epoch mismatch → resnapshot).
 * - Ordering: the owner flushes pending patches before answering hello or an intent,
 *   so a replica has applied an intent's patches when `intent()` resolves.
 * - Frozen/throttled tabs: flushes coalesce while the scheduler does not run; a
 *   replica that missed versions (ring overflow) gets a snapshot.
 */
import {
  box,
  createNoopTelemetry,
  createDeferred,
  err,
  ok,
  type Result,
  type Scope,
  type Telemetry,
  AbortedError,
} from '@staticflux/core';
import { type FlushScheduler, microtaskScheduler } from './clock.js';
import { type ChannelId, replicaChannel } from './envelope.js';
import { InvalidEnvelopeError, PortClosedError, ReplicaMutationError, UnknownIntentError } from './errors.js';
import type { Link } from './link.js';
import { applyPatches, type DeepReadonly, isPatch, type Patch } from './patches.js';

// ---------------------------------------------------------------- definitions

/** Intents a replica may send: action → { args, result }. */
export type IntentMap = Readonly<Record<string, { readonly args: unknown; readonly result: unknown }>>;

declare const replicaTypes: unique symbol;

export interface ReplicaDefinition<Id extends ChannelId = ChannelId, S = unknown, I extends IntentMap = IntentMap> {
  readonly kind: 'replica';
  readonly id: Id;
  readonly channel: `sf/replica/${Id}`;
  /** Phantom type carrier; never present at runtime. */
  readonly [replicaTypes]?: { readonly state: S; readonly intents: I };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyReplicaDefinition = ReplicaDefinition<ChannelId, any, any>;
export type StateOf<D> = D extends ReplicaDefinition<ChannelId, infer S, IntentMap> ? S : never;
export type IntentsOf<D> = D extends ReplicaDefinition<ChannelId, unknown, infer I> ? I : never;

/**
 * Declare a replicated store id with its state and intent types.
 * @example export const DocReplica = defineReplica('studio/document').type<DocView, DocIntents>();
 */
/* @__NO_SIDE_EFFECTS__ */
export function defineReplica<const Id extends ChannelId>(
  id: Id,
): { type<S, I extends IntentMap = Record<never, never>>(): ReplicaDefinition<Id, S, I> } {
  return {
    type: <S, I extends IntentMap = Record<never, never>>() =>
      Object.freeze({ kind: 'replica', id, channel: replicaChannel(id) }) as ReplicaDefinition<Id, S, I>,
  };
}

/**
 * What an owner store must offer to be replicated. `@staticflux/data` stores
 * and `@staticflux/document` engines implement this.
 */
export interface ReplicableSource<S = unknown> {
  getSnapshot(): S;
  /** Called with each batch of patches the store produces (in order). Returns unsubscribe. */
  onPatches(listener: (patches: readonly Patch[]) => void): () => void;
  /** Apply a replica's write intent on the owner. */
  applyIntent(action: string, args: unknown, signal?: AbortSignal): Result<unknown> | Promise<Result<unknown>>;
}

// ---------------------------------------------------------------- wire messages

interface HelloRequest {
  readonly type: 'hello';
  readonly epoch: string | null;
  readonly haveVersion: number;
}

interface IntentRequest {
  readonly type: 'intent';
  readonly action: string;
  readonly args: unknown;
}

export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly epoch: string;
  readonly version: number;
  readonly state: unknown;
}

export interface PatchesMessage {
  readonly type: 'patches';
  readonly epoch: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly patches: readonly Patch[];
}

export type ReplicationMessage = SnapshotMessage | PatchesMessage;

interface IntentResponse {
  readonly value: unknown;
  readonly version: number;
}

function isReplicationMessage(value: unknown): value is ReplicationMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['epoch'] !== 'string') return false;
  if (v['type'] === 'snapshot') return typeof v['version'] === 'number' && 'state' in v;
  if (v['type'] === 'patches') {
    return (
      typeof v['fromVersion'] === 'number' &&
      typeof v['toVersion'] === 'number' &&
      Array.isArray(v['patches']) &&
      (v['patches'] as unknown[]).every(isPatch)
    );
  }
  return false;
}

let epochCounter = 0;
function defaultEpoch(): string {
  epochCounter += 1;
  const random = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `${random}-${epochCounter}`;
}

// ---------------------------------------------------------------- owner side

export interface PublisherOptions<S> {
  readonly definition: ReplicaDefinition<ChannelId, S, IntentMap>;
  readonly source: ReplicableSource<S>;
  /** Versions kept for `patchesSince`. Default 128. */
  readonly ringSize?: number;
  /** Batching. Default: microtask. Use `frameScheduler()` for per-frame batching. */
  readonly schedule?: FlushScheduler;
  /** Owner instance id. Default random. */
  readonly epoch?: string;
  /** A single flush larger than this is sent as a snapshot instead. Default 1000. */
  readonly maxBatchPatches?: number;
  readonly telemetry?: Telemetry;
}

export interface Publisher<S = unknown> {
  readonly definition: ReplicaDefinition<ChannelId, S, IntentMap>;
  readonly epoch: string;
  readonly version: number;
  /** Attached links (peers). */
  readonly peers: number;
  /** Serve replicas on `link`; detaches when the link closes or the scope is disposed. */
  attach(link: Link, scope?: Scope): () => void;
  /** Send pending patches now. */
  flush(): void;
  dispose(): void;
}

const SUBSYSTEM = 'worker/replication';

export function createPublisher<S>(options: PublisherOptions<S>): Publisher<S> {
  const { definition, source } = options;
  const ringSize = options.ringSize ?? 128;
  const schedule = options.schedule ?? microtaskScheduler;
  const maxBatch = options.maxBatchPatches ?? 1000;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const epoch = options.epoch ?? defaultEpoch();
  let version = 0;
  let pending: Patch[] = [];
  let scheduled = false;
  let disposed = false;
  const ring: { readonly from: number; readonly patches: readonly Patch[] }[] = [];
  const peers = new Map<Link, () => void>();

  const snapshotMessage = (): SnapshotMessage => ({ type: 'snapshot', epoch, version, state: source.getSnapshot() });

  const flush = (): void => {
    scheduled = false;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const from = version;
    version += 1;
    ring.push({ from, patches: batch });
    if (ring.length > ringSize) ring.shift();
    const message: ReplicationMessage =
      batch.length > maxBatch
        ? snapshotMessage()
        : { type: 'patches', epoch, fromVersion: from, toVersion: version, patches: batch };
    for (const link of peers.keys()) link.send(definition.channel, message, { version });
  };

  const unsubscribe = source.onPatches((patches) => {
    if (disposed || patches.length === 0) return;
    pending.push(...patches);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  });

  const answerHello = (hello: HelloRequest): ReplicationMessage => {
    if (hello.epoch === epoch && hello.haveVersion === version) {
      return { type: 'patches', epoch, fromVersion: version, toVersion: version, patches: [] };
    }
    const oldest = ring[0];
    if (hello.epoch === epoch && oldest !== undefined && hello.haveVersion >= oldest.from && hello.haveVersion < version) {
      const patches = ring.filter((entry) => entry.from >= hello.haveVersion).flatMap((entry) => entry.patches);
      return { type: 'patches', epoch, fromVersion: hello.haveVersion, toVersion: version, patches };
    }
    telemetry.event('replication.snapshot', {
      subsystem: SUBSYSTEM,
      level: 'verbose',
      attrs: { store: definition.id, reason: hello.epoch === epoch ? 'gap' : 'epoch', version },
    });
    return snapshotMessage();
  };

  const publisher: Publisher<S> = {
    definition,
    epoch,
    get version() {
      return version;
    },
    get peers() {
      return peers.size;
    },
    flush,
    attach(link, scope) {
      const existing = peers.get(link);
      if (existing !== undefined) return existing;
      const unhandle = link.handle(definition.channel, async (payload, context) => {
        const message = payload as HelloRequest | IntentRequest;
        if (message?.type === 'hello') {
          flush();
          return ok(answerHello(message));
        }
        if (message?.type === 'intent') {
          const span = telemetry.span('replication.intent', {
            subsystem: SUBSYSTEM,
            level: 'verbose',
            attrs: { store: definition.id, action: message.action },
            parent: context.parent,
          });
          const result = await source.applyIntent(message.action, message.args, context.signal);
          flush();
          span.end(result.ok ? 'ok' : 'error', result.ok ? undefined : result.error);
          if (!result.ok) return result;
          const response: IntentResponse = { value: result.value, version };
          return ok(response);
        }
        return err(InvalidEnvelopeError({ message: 'Unknown replication request.', details: { store: definition.id } }));
      });
      const offClose = link.onClose(() => detach());
      const detach = (): void => {
        if (!peers.has(link)) return;
        peers.delete(link);
        unhandle();
        offClose();
      };
      peers.set(link, detach);
      scope?.defer(detach);
      return detach;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const detach of [...peers.values()]) detach();
    },
  };
  return publisher;
}

// ---------------------------------------------------------------- replica side

export type ReplicaStatus = 'detached' | 'syncing' | 'live';

export type ReplicaEvent<S> =
  | { readonly type: 'snapshot'; readonly state: DeepReadonly<S>; readonly version: number }
  | { readonly type: 'patches'; readonly patches: readonly Patch[]; readonly state: DeepReadonly<S>; readonly version: number };

export interface IntentOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface Replica<S = unknown, I extends IntentMap = IntentMap> {
  readonly definition: ReplicaDefinition<ChannelId, S, I>;
  /** Current state (reactive). Read-only: mutation throws SF-WK-002 in dev. */
  readonly state: DeepReadonly<S>;
  readonly version: number;
  readonly epoch: string | undefined;
  /** Reactive. */
  readonly status: ReplicaStatus;
  /** Bind to a link and handshake; resolves when live. Replaces a previous link. */
  attach(link: Link, scope?: Scope): Promise<Result<void>>;
  detach(): void;
  /** Re-handshake (e.g. after a long freeze). */
  resync(): Promise<Result<void>>;
  /** Writes are intents to the owner (I-9). Resolves after the owner's patches are applied here. */
  intent<K extends keyof I & string>(action: K, args: I[K]['args'], options?: IntentOptions): Promise<Result<I[K]['result']>>;
  subscribe(listener: (event: ReplicaEvent<S>) => void): () => void;
  whenLive(signal?: AbortSignal): Promise<Result<void>>;
}

export interface ReplicaOptions<S> {
  /** State before the first snapshot. */
  readonly initial?: S;
  /** Throw SF-WK-002 on mutation attempts (Proxy view). Default true (dev). */
  readonly devGuards?: boolean;
  readonly helloTimeoutMs?: number;
  readonly telemetry?: Telemetry;
}

const views = new WeakMap<object, object>();

function readonlyView<T>(value: T, store: string): T {
  if (typeof value !== 'object' || value === null) return value;
  const cached = views.get(value);
  if (cached !== undefined) return cached as T;
  const fail = (): never => {
    throw ReplicaMutationError({ details: { store } });
  };
  const proxy = new Proxy(value, {
    get(target, key, receiver) {
      return readonlyView(Reflect.get(target, key, receiver) as unknown, store);
    },
    set: fail,
    deleteProperty: fail,
    defineProperty: fail,
    setPrototypeOf: fail,
  });
  views.set(value, proxy);
  return proxy;
}

export function createReplica<D extends AnyReplicaDefinition>(
  definition: D,
  options: ReplicaOptions<StateOf<D>> = {},
): Replica<StateOf<D>, IntentsOf<D>> {
  type S = StateOf<D>;
  const devGuards = options.devGuards ?? true;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const raw = box<unknown>(options.initial);
  const status = box<ReplicaStatus>('detached');
  let version = 0;
  let epoch: string | undefined;
  let link: Link | undefined;
  let linkCleanup: (() => void) | undefined;
  let generation = 0;
  const listeners = new Set<(event: ReplicaEvent<S>) => void>();
  let liveWaiters: { resolve(result: Result<void>): void }[] = [];

  const view = (): DeepReadonly<S> => (devGuards ? readonlyView(raw.get(), definition.id) : raw.get()) as DeepReadonly<S>;

  const emit = (event: ReplicaEvent<S>): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const setLive = (): void => {
    status.set('live');
    const waiters = liveWaiters;
    liveWaiters = [];
    for (const waiter of waiters) waiter.resolve(ok());
  };

  const apply = (message: ReplicationMessage, fromSync: boolean): Result<'applied' | 'resync'> => {
    if (message.type === 'snapshot') {
      raw.set(message.state);
      version = message.version;
      epoch = message.epoch;
      emit({ type: 'snapshot', state: view(), version });
      return ok('applied');
    }
    if (!fromSync && message.epoch !== epoch) {
      telemetry.event('replication.epoch-mismatch', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { store: definition.id } });
      return ok('resync');
    }
    if (fromSync) epoch = message.epoch;
    if (message.toVersion <= version && !fromSync) return ok('applied'); // duplicate
    if (message.fromVersion !== version) {
      telemetry.event('replication.gap', {
        subsystem: SUBSYSTEM,
        level: 'verbose',
        attrs: { store: definition.id, have: version, from: message.fromVersion },
      });
      return ok('resync');
    }
    if (message.patches.length > 0) {
      const next = applyPatches(raw.get(), message.patches);
      if (!next.ok) return ok('resync');
      raw.set(next.value);
    }
    version = message.toVersion;
    if (message.patches.length > 0) emit({ type: 'patches', patches: message.patches, state: view(), version });
    return ok('applied');
  };

  const sync = async (): Promise<Result<void>> => {
    const current = link;
    if (current === undefined || current.closed) return err(PortClosedError({ details: { store: definition.id } }));
    generation += 1;
    const myGeneration = generation;
    status.set('syncing');
    const hello: HelloRequest = { type: 'hello', epoch: epoch ?? null, haveVersion: version };
    const response = await current.request(definition.channel, hello, { timeoutMs: options.helloTimeoutMs });
    if (myGeneration !== generation || link !== current) return ok();
    if (!response.ok) {
      status.set('detached');
      return response;
    }
    if (!isReplicationMessage(response.value)) {
      status.set('detached');
      return err(InvalidEnvelopeError({ message: 'Malformed replication handshake.', details: { store: definition.id } }));
    }
    const applied = apply(response.value, true);
    if (applied.ok && applied.value === 'resync') {
      // The owner answered from a base we do not have: force a snapshot.
      epoch = undefined;
      version = -1;
      return sync();
    }
    setLive();
    return ok();
  };

  const detach = (): void => {
    linkCleanup?.();
    linkCleanup = undefined;
    link = undefined;
    generation += 1;
    status.set('detached');
  };

  const replica: Replica<S, IntentsOf<D>> = {
    definition: definition as ReplicaDefinition<ChannelId, S, IntentsOf<D>>,
    get state() {
      return view();
    },
    get version() {
      return version;
    },
    get epoch() {
      return epoch;
    },
    get status() {
      return status.get();
    },
    attach(next, scope) {
      detach();
      link = next;
      const offEvent = next.on(definition.channel, (payload) => {
        if (status.get() !== 'live' || link !== next) return;
        if (!isReplicationMessage(payload)) return;
        const applied = apply(payload, false);
        if (applied.ok && applied.value === 'resync') void sync();
      });
      const offClose = next.onClose(() => {
        if (link === next) detach();
      });
      linkCleanup = () => {
        offEvent();
        offClose();
      };
      scope?.defer(() => {
        if (link === next) detach();
      });
      return sync();
    },
    detach,
    resync: sync,
    async intent(action, args, intentOptions = {}) {
      const current = link;
      if (current === undefined) return err(PortClosedError({ message: 'Replica is not attached to an owner.', details: { store: definition.id } }));
      const request: IntentRequest = { type: 'intent', action, args };
      const response = await current.request(definition.channel, request, {
        signal: intentOptions.signal,
        timeoutMs: intentOptions.timeoutMs,
      });
      if (!response.ok) return response;
      return ok((response.value as IntentResponse).value as IntentsOf<D>[typeof action]['result']);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    whenLive(signal) {
      if (status.get() === 'live') return Promise.resolve(ok());
      if (signal?.aborted === true) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      const deferred = createDeferred<Result<void>>();
      // Aborted to detach the abort listener once the waiter is resolved.
      const detach = new AbortController();
      const waiter = {
        resolve: (result: Result<void>) => {
          detach.abort();
          deferred.resolve(result);
        },
      };
      liveWaiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          liveWaiters = liveWaiters.filter((w) => w !== waiter);
          deferred.resolve(err(AbortedError({ cause: signal.reason })));
        },
        { once: true, signal: detach.signal },
      );
      return deferred.promise;
    },
  };
  return replica;
}

// ---------------------------------------------------------------- simple JSON source

export interface JsonSourceApi<S> {
  readonly state: S;
  /** Apply patches to the owner state and publish them. */
  apply(patches: readonly Patch[]): Result<void>;
}

export type JsonIntentHandler<S> = (args: unknown, api: JsonSourceApi<S>) => Result<unknown> | Promise<Result<unknown>>;

export interface JsonSource<S> extends ReplicableSource<S> {
  readonly state: S;
  apply(patches: readonly Patch[]): Result<void>;
}

/**
 * A minimal owner store over plain JSON state, for small replicated stores
 * (and tests). Intents produce patches through `api.apply()`.
 */
export function createJsonSource<S>(initial: S, intents: Readonly<Record<string, JsonIntentHandler<S>>> = {}): JsonSource<S> {
  let state = initial;
  const listeners = new Set<(patches: readonly Patch[]) => void>();
  const apply = (patches: readonly Patch[]): Result<void> => {
    const next = applyPatches(state, patches);
    if (!next.ok) return next;
    state = next.value;
    for (const listener of [...listeners]) listener(patches);
    return ok();
  };
  const api: JsonSourceApi<S> = {
    get state() {
      return state;
    },
    apply,
  };
  return {
    get state() {
      return state;
    },
    apply,
    getSnapshot: () => state,
    onPatches(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyIntent(action, args) {
      const handler = intents[action];
      if (handler === undefined) return err(UnknownIntentError({ details: { action } }));
      return handler(args, api);
    },
  };
}

