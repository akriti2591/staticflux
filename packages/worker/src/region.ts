/**
 * Regions: the memory under every sequenced pipe (SF-Δ18, D15). A region is one
 * buffer — Int32 control words at the front, data after them — seen by an owner
 * side (the writer) and one or more attached sides (readers). Cells, record rings
 * and delta streams are written once against `RegionSide` and run unchanged on
 * three media, so one worker or two is a boot-time choice, not a code path:
 *
 * - **local**   both ends in one thread (colocated topology). A plain ArrayBuffer;
 *               `publish()` wakes in-thread waiters on a microtask.
 * - **shared**  ends in different threads, cross-origin isolated. A SharedArrayBuffer;
 *               `publish()` is `Atomics.notify`, waits use `Atomics.waitAsync` (polling
 *               fallback) or the blocking `Atomics.wait` in workers.
 * - **message** ends in different threads without shared memory. Each side keeps a
 *               mirror; `publish()` posts the changed words and byte ranges over a
 *               port, the other side applies them in order (no torn reads possible).
 *
 * Protocol rule for pipe authors: store data first, then the control word that
 * publishes it (`Atomics.store`), then call `publish([word], [range])`.
 *
 * @example
 * const medium = selectMedium({ topology: 'split', isolation });   // 'shared' | 'message'
 * const region = unwrap(createRegion({ medium, byteLength: 4096 }));
 * const endpoint = unwrap(region.endpoint());                       // post it to the reader
 * peer.send(PipeChannel, endpoint, { transfer: regionTransferList(endpoint) });
 * const side = unwrap(await attachRegion(endpoint));                // in the reader
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import { SharedMemoryUnavailableError } from './channel-errors.js';
import { type Clock, systemClock } from './clock.js';
import { detectIsolationFacts, type IsolationFacts, type SharedMemoryGlobals, sharedMemoryAvailable } from './isolation.js';
import { PipeClosedError, PipeEndpointTakenError, PipeMismatchError } from './pipeline-errors.js';
import { createPortPair, fromMessagePort, type Port } from './port.js';

export const PIPE_MEDIA = ['local', 'shared', 'message'] as const;
export type PipeMedium = (typeof PIPE_MEDIA)[number];

/** D15: editor and render modules in one worker (`colocated`) or two (`split`). */
export type Topology = 'colocated' | 'split';

export interface SelectMediumOptions {
  readonly topology: Topology;
  /** Isolation facts (default: detected from globals). Split pipes use shared memory only when isolated. */
  readonly isolation?: IsolationFacts;
  readonly globals?: SharedMemoryGlobals;
}

/** Pick the medium for a pipe: colocated → local; split → shared when isolated, else message. */
export function selectMedium(options: SelectMediumOptions): PipeMedium {
  if (options.topology === 'colocated') return 'local';
  const isolation = options.isolation ?? detectIsolationFacts(options.globals);
  return sharedMemoryAvailable(isolation, options.globals) ? 'shared' : 'message';
}

export type ByteRange = readonly [start: number, end: number];

export interface RegionWaitOptions {
  readonly signal?: AbortSignal;
  /** Give up after this many ms (resolves `ok(false)`). Default: wait forever. */
  readonly timeoutMs?: number;
}

/** One side's view of a region. */
export interface RegionSide {
  readonly medium: PipeMedium;
  readonly byteLength: number;
  readonly buffer: ArrayBuffer | SharedArrayBuffer;
  /** Int32 words over the whole buffer (pipes use the first few as control words). */
  readonly words: Int32Array;
  readonly bytes: Uint8Array;
  readonly view: DataView;
  /** Make stored words (and data ranges) visible to the other side(s) and wake their waiters. */
  publish(words: readonly number[], ranges?: readonly ByteRange[]): void;
  /** Resolve `ok(true)` once `words[index] !== observed`, `ok(false)` on timeout. */
  wait(index: number, observed: number, options?: RegionWaitOptions): Promise<Result<boolean>>;
  /** Blocking wait (shared medium, worker threads only). */
  waitSync(index: number, observed: number, timeoutMs: number): 'ok' | 'timed-out' | 'unsupported';
  /** Called after another side published (local and message media; shared memory has no callback — use `wait`). */
  onRemote(listener: () => void): () => void;
  readonly closed: boolean;
  onClose(listener: () => void): () => void;
  close(): void;
}

/** Structured-cloneable description of a region, sent to the reader. `local` endpoints never leave their thread. */
export type RegionEndpoint =
  | { readonly sf: 'region'; readonly medium: 'local'; readonly byteLength: number; readonly hub: unknown }
  | { readonly sf: 'region'; readonly medium: 'shared'; readonly byteLength: number; readonly buffer: SharedArrayBuffer }
  | { readonly sf: 'region'; readonly medium: 'message'; readonly byteLength: number; readonly port: unknown };

/** A port pair for message regions: `local` stays with the owner, `remote` goes into the endpoint. */
export interface MessageEndpointPair {
  readonly local: Port;
  readonly remote: unknown;
}

export interface RegionTiming {
  readonly clock?: Clock;
  /** Poll interval when `Atomics.waitAsync` is missing. Default 2 ms. */
  readonly pollMs?: number;
}

export interface CreateRegionOptions extends RegionTiming {
  readonly medium: PipeMedium;
  readonly byteLength: number;
  /** Port pairs for the message medium. Default: a real MessageChannel (in-memory pair without one). */
  readonly channel?: () => MessageEndpointPair;
}

/** The owner side: creates endpoints for readers. */
export interface OwnedRegion extends RegionSide {
  /** A new endpoint for one reader (message medium: one port per call). */
  endpoint(): Result<RegionEndpoint>;
}

export interface AttachRegionOptions extends RegionTiming {
  readonly signal?: AbortSignal;
  /** Message medium: how long to wait for the initial sync. Default 10 s. */
  readonly timeoutMs?: number;
}

type WaitAsyncFn = (
  array: Int32Array,
  index: number,
  value: number,
  timeout?: number,
) => { readonly async: false; readonly value: 'not-equal' | 'timed-out' } | { readonly async: true; readonly value: Promise<'ok' | 'timed-out'> };

const nativeWaitAsync = (): WaitAsyncFn | undefined => {
  const fn = (Atomics as unknown as { waitAsync?: WaitAsyncFn }).waitAsync;
  return typeof fn === 'function' ? fn : undefined;
};

/**
 * True for a platform MessagePort (by shape: `instanceof` fails across realms, e.g.
 * Node's MessageChannel under a DOM shim), as opposed to an in-memory `Port`.
 */
export function isMessagePortLike(value: unknown): value is MessagePort {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['postMessage'] === 'function' && typeof v['start'] === 'function' && typeof v['addEventListener'] === 'function' && typeof v['onMessage'] !== 'function';
}

/** Transferables to list when posting an endpoint (the message port, if any). */
export function regionTransferList(endpoint: RegionEndpoint): Transferable[] {
  if (endpoint.medium !== 'message') return [];
  return isMessagePortLike(endpoint.port) ? [endpoint.port] : [];
}

/** True for a value shaped like a region endpoint (guards for endpoints received over a link). */
export function isRegionEndpoint(value: unknown): value is RegionEndpoint {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['sf'] === 'region' && typeof v['byteLength'] === 'number' && PIPE_MEDIA.includes(v['medium'] as PipeMedium);
}

const isPortLike = (value: unknown): value is Port =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Port).postMessage === 'function' &&
  typeof (value as Port).onMessage === 'function' &&
  typeof (value as Port).close === 'function';

/** Turn a received port value (MessagePort or in-memory Port) into a Port. */
export function toPort(value: unknown): Port | undefined {
  if (isPortLike(value)) return value;
  return isMessagePortLike(value) ? fromMessagePort(value) : undefined;
}

function defaultChannel(): MessageEndpointPair {
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    return { local: fromMessagePort(channel.port1), remote: channel.port2 };
  }
  const pair = createPortPair({ clone: false });
  return { local: pair.a, remote: pair.b };
}

// ---------------------------------------------------------------- shared helpers

interface Waiter {
  check(): void;
}

/** Waiting by re-checking on notifications (local and message media). */
function notifiedWait(
  read: () => number,
  waiters: Set<Waiter>,
  isClosed: () => boolean,
  clock: Clock,
  observed: number,
  options: RegionWaitOptions,
): Promise<Result<boolean>> {
  return new Promise((resolve) => {
    const { signal } = options;
    let timer: unknown;
    // Aborted to detach the abort listener once the wait settles.
    const detach = new AbortController();
    const waiter: Waiter = {
      check() {
        if (signal?.aborted === true) return finish(err(AbortedError({ cause: signal.reason })));
        if (read() !== observed) return finish(ok(true));
        if (isClosed()) return finish(err(PipeClosedError()));
      },
    };
    const finish = (result: Result<boolean>): void => {
      waiters.delete(waiter);
      clock.clearTimeout(timer);
      detach.abort();
      resolve(result);
    };
    waiters.add(waiter);
    signal?.addEventListener('abort', () => waiter.check(), { once: true, signal: detach.signal });
    if (options.timeoutMs !== undefined) timer = clock.setTimeout(() => finish(ok(false)), options.timeoutMs);
    waiter.check();
  });
}

function runAll(waiters: Set<Waiter>): void {
  for (const waiter of [...waiters]) waiter.check();
}

// ---------------------------------------------------------------- local medium

interface LocalHub {
  readonly kind: 'sf-local-region';
  readonly buffer: ArrayBuffer;
  readonly waiters: Set<Waiter>;
  readonly listeners: Map<number, Set<() => void>>;
  readonly closeListeners: Set<() => void>;
  closed: boolean;
  scheduled: boolean;
  pendingFrom: Set<number>;
  sides: number;
}

function localSide(hub: LocalHub, clock: Clock, owner: boolean): RegionSide {
  const sideId = (hub.sides += 1);
  const words = new Int32Array(hub.buffer, 0, Math.floor(hub.buffer.byteLength / 4));
  const ownListeners = new Set<() => void>();
  hub.listeners.set(sideId, ownListeners);
  // An attached side closes only itself; the owner closes the hub for everyone.
  let sideClosed = false;
  const sideCloseListeners = new Set<() => void>();
  const isClosed = (): boolean => hub.closed || sideClosed;
  const deliver = (): void => {
    hub.scheduled = false;
    const from = hub.pendingFrom;
    hub.pendingFrom = new Set();
    runAll(hub.waiters);
    for (const [id, set] of hub.listeners) {
      // A side is notified when anyone other than itself published.
      if ([...from].some((source) => source !== id)) for (const listener of [...set]) listener();
    }
  };
  return {
    medium: 'local',
    byteLength: hub.buffer.byteLength,
    buffer: hub.buffer,
    words,
    bytes: new Uint8Array(hub.buffer),
    view: new DataView(hub.buffer),
    publish() {
      if (isClosed()) return;
      hub.pendingFrom.add(sideId);
      if (hub.scheduled) return;
      hub.scheduled = true;
      queueMicrotask(deliver);
    },
    wait: (index, observed, options = {}) =>
      notifiedWait(() => Atomics.load(words, index), hub.waiters, isClosed, clock, observed, options),
    waitSync: (index, observed) => (Atomics.load(words, index) !== observed ? 'ok' : 'unsupported'),
    onRemote(listener) {
      ownListeners.add(listener);
      return () => ownListeners.delete(listener);
    },
    get closed() {
      return isClosed();
    },
    onClose(listener) {
      if (isClosed()) {
        listener();
        return () => undefined;
      }
      hub.closeListeners.add(listener);
      sideCloseListeners.add(listener);
      return () => {
        hub.closeListeners.delete(listener);
        sideCloseListeners.delete(listener);
      };
    },
    close() {
      if (isClosed()) return;
      hub.listeners.delete(sideId);
      if (!owner) {
        sideClosed = true;
        runAll(hub.waiters);
        for (const listener of [...sideCloseListeners]) {
          hub.closeListeners.delete(listener);
          listener();
        }
        sideCloseListeners.clear();
        return;
      }
      hub.closed = true;
      runAll(hub.waiters);
      for (const listener of [...hub.closeListeners]) listener();
      hub.closeListeners.clear();
    },
  };
}

// ---------------------------------------------------------------- shared medium

function sharedSide(buffer: SharedArrayBuffer, timing: RegionTiming): RegionSide {
  const clock = timing.clock ?? systemClock;
  const pollMs = timing.pollMs ?? 2;
  const words = new Int32Array(buffer, 0, Math.floor(buffer.byteLength / 4));
  const waitAsync = nativeWaitAsync();
  const closeListeners = new Set<() => void>();
  const wakers = new Set<Waiter>();
  let closed = false;

  const waitAtomics = async (index: number, observed: number, options: RegionWaitOptions): Promise<Result<boolean>> => {
    const { signal } = options;
    const deadline = options.timeoutMs === undefined ? undefined : clock.now() + options.timeoutMs;
    // Abort (or close) wakes our own waitAsync by notifying the word.
    const detach = new AbortController();
    const wake: Waiter = { check: () => void Atomics.notify(words, index) };
    wakers.add(wake);
    signal?.addEventListener('abort', () => wake.check(), { once: true, signal: detach.signal });
    try {
      for (;;) {
        if (signal?.aborted === true) return err(AbortedError({ cause: signal.reason }));
        if (Atomics.load(words, index) !== observed) return ok(true);
        if (closed) return err(PipeClosedError());
        const remaining = deadline === undefined ? Infinity : deadline - clock.now();
        if (remaining <= 0) return ok(false);
        const outcome = (waitAsync as WaitAsyncFn)(words, index, observed, remaining);
        if (outcome.async) await outcome.value;
      }
    } finally {
      wakers.delete(wake);
      detach.abort();
    }
  };

  const waitPolling = (index: number, observed: number, options: RegionWaitOptions): Promise<Result<boolean>> =>
    new Promise((resolve) => {
      const { signal } = options;
      const deadline = options.timeoutMs === undefined ? undefined : clock.now() + options.timeoutMs;
      let timer: unknown;
      // Aborted to detach the abort listener once the wait settles.
      const detach = new AbortController();
      const finish = (result: Result<boolean>): void => {
        clock.clearTimeout(timer);
        wakers.delete(waker);
        detach.abort();
        resolve(result);
      };
      const check = (): void => {
        clock.clearTimeout(timer);
        if (signal?.aborted === true) return finish(err(AbortedError({ cause: signal.reason })));
        if (Atomics.load(words, index) !== observed) return finish(ok(true));
        if (closed) return finish(err(PipeClosedError()));
        if (deadline !== undefined && clock.now() >= deadline) return finish(ok(false));
        timer = clock.setTimeout(check, pollMs);
      };
      const waker: Waiter = { check };
      wakers.add(waker);
      signal?.addEventListener('abort', check, { once: true, signal: detach.signal });
      check();
    });

  return {
    medium: 'shared',
    byteLength: buffer.byteLength,
    buffer,
    words,
    bytes: new Uint8Array(buffer),
    view: new DataView(buffer),
    publish(changed) {
      for (const index of changed) Atomics.notify(words, index);
    },
    wait: (index, observed, options = {}) =>
      waitAsync === undefined ? waitPolling(index, observed, options) : waitAtomics(index, observed, options),
    waitSync(index, observed, timeoutMs) {
      if (Atomics.load(words, index) !== observed) return 'ok';
      try {
        const outcome = Atomics.wait(words as Int32Array<SharedArrayBuffer>, index, observed, timeoutMs);
        return outcome === 'timed-out' ? 'timed-out' : 'ok';
      } catch {
        return 'unsupported'; // main thread: Atomics.wait is not allowed
      }
    },
    onRemote: () => () => undefined,
    get closed() {
      return closed;
    },
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
      runAll(wakers);
      for (const listener of [...closeListeners]) listener();
      closeListeners.clear();
    },
  };
}

// ---------------------------------------------------------------- message medium

type RegionMessage =
  | { readonly sf: 'region'; readonly t: 'hello' }
  | { readonly sf: 'region'; readonly t: 'sync'; readonly b: ArrayBuffer }
  | { readonly sf: 'region'; readonly t: 'pub'; readonly w: readonly number[]; readonly d: readonly (readonly [number, ArrayBuffer])[] }
  | { readonly sf: 'region'; readonly t: 'close' };

const isRegionMessage = (value: unknown): value is RegionMessage =>
  typeof value === 'object' && value !== null && (value as { sf?: unknown }).sf === 'region';

interface MessageCore {
  readonly side: RegionSide;
  apply(message: RegionMessage, from: Port): void;
  addPort(port: Port): void;
  readonly ready: boolean;
  markReady(): void;
}

function messageCore(byteLength: number, timing: RegionTiming, onHello: (port: Port) => void, onReady?: () => void): MessageCore {
  const clock = timing.clock ?? systemClock;
  const buffer = new ArrayBuffer(byteLength);
  const words = new Int32Array(buffer, 0, Math.floor(byteLength / 4));
  const bytes = new Uint8Array(buffer);
  const waiters = new Set<Waiter>();
  const listeners = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  const ports = new Set<Port>();
  let closed = false;
  let ready = false;

  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    runAll(waiters);
    for (const listener of [...closeListeners]) listener();
    closeListeners.clear();
  };
  const post = (message: RegionMessage, transfer: Transferable[] = []): void => {
    for (const port of ports) port.postMessage(message, transfer.length > 0 && ports.size === 1 ? transfer : undefined);
  };
  const dirtyWords = new Set<number>();
  let dirtyRanges: ByteRange[] = [];
  let flushScheduled = false;
  const flushPublish = (): void => {
    flushScheduled = false;
    if (closed || ports.size === 0 || (dirtyWords.size === 0 && dirtyRanges.length === 0)) return;
    const w: number[] = [];
    for (const index of dirtyWords) w.push(index, words[index] as number);
    dirtyWords.clear();
    const d: [number, ArrayBuffer][] = dirtyRanges.map(([s, e]) => [s, bytes.slice(s, e).buffer]);
    dirtyRanges = [];
    post({ sf: 'region', t: 'pub', w, d }, d.map(([, b]) => b));
  };

  const side: RegionSide = {
    medium: 'message',
    byteLength,
    buffer,
    words,
    bytes,
    view: new DataView(buffer),
    publish(changed, ranges = []) {
      if (closed || ports.size === 0) return;
      // Batched per microtask: the post carries the current bytes and words, data before words.
      for (const index of changed) dirtyWords.add(index);
      for (const range of ranges) if (range[1] > range[0]) dirtyRanges.push(range);
      if (flushScheduled) return;
      flushScheduled = true;
      queueMicrotask(flushPublish);
    },
    wait: (index, observed, options = {}) => notifiedWait(() => words[index] as number, waiters, () => closed, clock, observed, options),
    waitSync: (index, observed) => (words[index] !== observed ? 'ok' : 'unsupported'),
    onRemote(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get closed() {
      return closed;
    },
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
      flushPublish();
      post({ sf: 'region', t: 'close' });
      for (const port of ports) port.close();
      ports.clear();
      markClosed();
    },
  };

  // The owner outlives its readers; an attached side closes when its only port goes away.
  const isOwner = onReady === undefined;
  const portGone = (port: Port): void => {
    ports.delete(port);
    if (!isOwner) markClosed();
  };
  const core: MessageCore = {
    side,
    get ready() {
      return ready;
    },
    markReady() {
      ready = true;
      onReady?.();
    },
    addPort(port) {
      ports.add(port);
      port.onMessage((data) => {
        if (closed || !isRegionMessage(data)) return;
        core.apply(data, port);
      });
      port.onClose(() => portGone(port));
    },
    apply(message, from) {
      switch (message.t) {
        case 'hello':
          onHello(from);
          return;
        case 'sync':
          bytes.set(new Uint8Array(message.b).subarray(0, byteLength));
          if (!ready) core.markReady();
          break;
        case 'pub':
          for (const [offset, chunk] of message.d) bytes.set(new Uint8Array(chunk), offset);
          for (let i = 0; i + 1 < message.w.length; i += 2) words[message.w[i] as number] = message.w[i + 1] as number;
          break;
        case 'close':
          from.close();
          portGone(from);
          return;
      }
      runAll(waiters);
      for (const listener of [...listeners]) listener();
    },
  };
  return core;
}

// ---------------------------------------------------------------- create / attach

const MAX_BYTES = 1 << 30;

/** Create a region (owner side). Fails with SF-WK-025 for `shared` without SharedArrayBuffer. */
export function createRegion(options: CreateRegionOptions): Result<OwnedRegion> {
  const { medium, byteLength } = options;
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > MAX_BYTES || byteLength % 8 !== 0) {
    return err(PipeMismatchError({ message: `Region byteLength must be a multiple of 8 in [16, 2^30], got ${String(byteLength)}.`, details: { byteLength } }));
  }
  const clock = options.clock ?? systemClock;
  if (medium === 'local') {
    const hub: LocalHub = {
      kind: 'sf-local-region',
      buffer: new ArrayBuffer(byteLength),
      waiters: new Set(),
      listeners: new Map(),
      closeListeners: new Set(),
      closed: false,
      scheduled: false,
      pendingFrom: new Set(),
      sides: 0,
    };
    const side = localSide(hub, clock, true);
    return ok(Object.assign(side, { endpoint: () => ok({ sf: 'region', medium: 'local', byteLength, hub } as const) }));
  }
  if (medium === 'shared') {
    if (typeof SharedArrayBuffer !== 'function') return err(SharedMemoryUnavailableError());
    const buffer = new SharedArrayBuffer(byteLength);
    const side = sharedSide(buffer, options);
    return ok(Object.assign(side, { endpoint: () => ok({ sf: 'region', medium: 'shared', byteLength, buffer } as const) }));
  }
  const channel = options.channel ?? defaultChannel;
  const core = messageCore(byteLength, options, (port) => {
    port.postMessage({ sf: 'region', t: 'sync', b: core.side.bytes.slice().buffer } satisfies RegionMessage);
  });
  core.markReady();
  return ok(
    Object.assign(core.side, {
      endpoint: (): Result<RegionEndpoint> => {
        if (core.side.closed) return err(PipeClosedError());
        const pair = channel();
        core.addPort(pair.local);
        return ok({ sf: 'region', medium: 'message', byteLength, port: pair.remote });
      },
    }),
  );
}

const attachedHubs = new WeakSet<object>();

/** Attach to a region from its endpoint (reader side). Message regions resolve after the initial sync. */
export async function attachRegion(endpoint: RegionEndpoint, options: AttachRegionOptions = {}): Promise<Result<RegionSide>> {
  if (!isRegionEndpoint(endpoint)) return err(PipeMismatchError({ message: 'Not a region endpoint.' }));
  const clock = options.clock ?? systemClock;
  if (endpoint.medium === 'local') {
    const hub = endpoint.hub as LocalHub | undefined;
    if (hub?.kind !== 'sf-local-region') {
      return err(PipeMismatchError({ message: 'A local region endpoint was posted to another thread; use the shared or message medium across threads.' }));
    }
    if (hub.closed) return err(PipeClosedError());
    return ok(localSide(hub, clock, false));
  }
  if (endpoint.medium === 'shared') {
    if (typeof SharedArrayBuffer !== 'function' || !(endpoint.buffer instanceof SharedArrayBuffer)) {
      return err(SharedMemoryUnavailableError({ message: 'The shared region arrived without its SharedArrayBuffer (not isolated?).' }));
    }
    return ok(sharedSide(endpoint.buffer, options));
  }
  const port = toPort(endpoint.port);
  if (port === undefined) return err(PipeMismatchError({ message: 'The message region endpoint carries no port (list it in the transfer list).' }));
  const portObject = endpoint.port as object;
  if (attachedHubs.has(portObject)) return err(PipeEndpointTakenError());
  attachedHubs.add(portObject);
  let resolveReady: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const core = messageCore(endpoint.byteLength, options, () => undefined, () => resolveReady?.());
  core.addPort(port);
  port.postMessage({ sf: 'region', t: 'hello' } satisfies RegionMessage);
  const { signal } = options;
  if (signal?.aborted === true) {
    core.side.close();
    return err(AbortedError({ cause: signal.reason }));
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const outcome = await new Promise<'ready' | 'timeout' | 'aborted' | 'closed'>((resolve) => {
    let timer: unknown;
    // Aborted to detach the listeners once the handshake settles.
    const detach = new AbortController();
    const done = (value: 'ready' | 'timeout' | 'aborted' | 'closed'): void => {
      clock.clearTimeout(timer);
      detach.abort();
      offClose();
      resolve(value);
    };
    void readyPromise.then(() => done('ready'));
    const offClose = core.side.onClose(() => done('closed'));
    signal?.addEventListener('abort', () => done('aborted'), { once: true, signal: detach.signal });
    timer = clock.setTimeout(() => done('timeout'), timeoutMs);
  });
  if (outcome === 'ready') return ok(core.side);
  core.side.close();
  if (outcome === 'aborted') return err(AbortedError({ cause: signal?.reason }));
  if (outcome === 'closed') return err(PipeClosedError({ message: 'The region owner closed before the reader synced.' }));
  return err(PipeClosedError({ message: `The region owner did not answer within ${timeoutMs} ms.`, details: { timeoutMs } }));
}
