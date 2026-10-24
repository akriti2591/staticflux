/**
 * Port abstraction (MessagePort-like). All worker logic talks to a `Port`, so
 * everything is testable with the in-memory pair and runs unchanged over
 * Worker, SharedWorker, MessageChannel or a worker's global scope.
 */
import { type SfError, toSfError } from '@staticflux/core';

export interface Port {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  /** Listen to incoming messages; returns unsubscribe. */
  onMessage(listener: (data: unknown) => void): () => void;
  /** Listen to transport errors (worker `error`, `messageerror`, simulated crash). */
  onError(listener: (error: SfError) => void): () => void;
  /** Called once when the port closes (locally, by the peer where detectable, or on crash). */
  onClose(listener: () => void): () => void;
  /** Stop listening and release the port. Does not terminate a worker (see SpawnedWorker). */
  close(): void;
}

interface Listeners {
  readonly message: Set<(data: unknown) => void>;
  readonly error: Set<(error: SfError) => void>;
  readonly close: Set<() => void>;
}

function createListeners(): Listeners {
  return { message: new Set(), error: new Set(), close: new Set() };
}

function emitAll<T>(set: Set<(value: T) => void>, value: T): void {
  for (const listener of [...set]) listener(value);
}

/** Minimal EventTarget-with-postMessage shape shared by Worker, MessagePort and worker globals. */
export interface MessageTargetLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

function fromTarget(target: MessageTargetLike, extra: { start?: () => void; close?: () => void; errorTarget?: MessageTargetLike }): Port {
  const listeners = createListeners();
  let closed = false;
  const onMessage = (event: Event): void => {
    emitAll(listeners.message, (event as MessageEvent).data);
  };
  const onError = (event: Event): void => {
    const cause = (event as ErrorEvent).error ?? (event as ErrorEvent).message ?? event.type;
    emitAll(listeners.error, toSfError(cause instanceof Error ? cause : new Error(String(cause))));
  };
  const onMessageError = (): void => {
    emitAll(listeners.error, toSfError(new Error('messageerror: message could not be deserialized')));
  };
  const onPeerClose = (): void => port.close();
  target.addEventListener('message', onMessage);
  target.addEventListener('messageerror', onMessageError);
  // MessagePort 'close' (newer Chromium) tells us the peer went away.
  target.addEventListener('close', onPeerClose);
  (extra.errorTarget ?? target).addEventListener('error', onError);
  extra.start?.();
  const port: Port = {
    postMessage(message, transfer = []) {
      if (closed) return;
      target.postMessage(message, [...transfer]);
    },
    onMessage(listener) {
      listeners.message.add(listener);
      return () => listeners.message.delete(listener);
    },
    onError(listener) {
      listeners.error.add(listener);
      return () => listeners.error.delete(listener);
    },
    onClose(listener) {
      listeners.close.add(listener);
      return () => listeners.close.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      target.removeEventListener('message', onMessage);
      target.removeEventListener('messageerror', onMessageError);
      target.removeEventListener('close', onPeerClose);
      (extra.errorTarget ?? target).removeEventListener('error', onError);
      const closeListeners = [...listeners.close];
      listeners.message.clear();
      listeners.error.clear();
      listeners.close.clear();
      extra.close?.();
      for (const listener of closeListeners) listener();
    },
  };
  return port;
}

/** Adapter for a MessagePort (MessageChannel ends, SharedWorker.port, connect-event ports). */
export function fromMessagePort(port: MessagePort): Port {
  return fromTarget(port as unknown as MessageTargetLike, { start: () => port.start(), close: () => port.close() });
}

/** Adapter for a dedicated Worker (main-thread side). `close()` does not terminate it. */
export function fromWorker(worker: Worker): Port {
  return fromTarget(worker as unknown as MessageTargetLike, {});
}

/** Adapter for a SharedWorker (main-thread side): talks over `worker.port`, errors from the worker. */
export function fromSharedWorker(worker: SharedWorker): Port {
  const port = worker.port;
  return fromTarget(port as unknown as MessageTargetLike, {
    start: () => port.start(),
    close: () => port.close(),
    errorTarget: worker as unknown as MessageTargetLike,
  });
}

/** Adapter for code running inside a dedicated worker (`self`). */
export function fromWorkerScope(scope: MessageTargetLike): Port {
  return fromTarget(scope, {});
}

/** A real MessageChannel as two Ports (feature-detected). */
export function createMessageChannelPorts(): { readonly a: Port; readonly b: Port } | undefined {
  if (typeof MessageChannel === 'undefined') return undefined;
  const channel = new MessageChannel();
  return { a: fromMessagePort(channel.port1), b: fromMessagePort(channel.port2) };
}

// ---------------------------------------------------------------- in-memory pair

export interface MemoryPort extends Port {
  readonly closed: boolean;
  /** Stop delivering incoming messages (simulates a frozen tab / hung worker). Messages queue. */
  freeze(): void;
  /** Resume delivery; queued messages are delivered in order. */
  thaw(): void;
  readonly frozen: boolean;
  /** Messages posted by this side. */
  readonly sent: number;
}

export interface PortPair {
  /** Conventionally the main-thread (supervisor/owner) side. */
  readonly a: MemoryPort;
  /** Conventionally the worker side. */
  readonly b: MemoryPort;
  /** Simulate a worker crash: emits an error on `a`, then closes both sides. */
  crash(error?: unknown): void;
  /** Close both sides. */
  close(): void;
}

export interface PortPairOptions {
  /** Structured-clone messages like the platform does. Default true (when `structuredClone` exists). */
  readonly clone?: boolean;
  /** Delivery scheduler. Default `queueMicrotask` (asynchronous, ordered). */
  readonly deliver?: (fn: () => void) => void;
}

/** In-memory MessagePort pair for tests and in-thread fallbacks. */
export function createPortPair(options: PortPairOptions = {}): PortPair {
  const clone =
    (options.clone ?? true) && typeof structuredClone === 'function'
      ? (value: unknown) => structuredClone(value)
      : (value: unknown) => value;
  const deliver = options.deliver ?? ((fn: () => void) => queueMicrotask(fn));
  let closed = false;

  interface InternalSide extends MemoryPort {
    peer: InternalSide | undefined;
    receive(data: unknown): void;
    emitError(error: SfError): void;
    emitClose(): void;
  }
  const makeSide = (): InternalSide => {
    const listeners = createListeners();
    const queue: unknown[] = [];
    let frozen = false;
    let sent = 0;
    const drain = (): void => {
      while (!frozen && !closed && queue.length > 0) emitAll(listeners.message, queue.shift());
    };
    const side: InternalSide = {
      peer: undefined,
      get closed() {
        return closed;
      },
      get frozen() {
        return frozen;
      },
      get sent() {
        return sent;
      },
      postMessage(message: unknown) {
        if (closed) return;
        sent += 1;
        const copy = clone(message);
        const peer = side.peer;
        deliver(() => peer?.receive(copy));
      },
      receive(data: unknown) {
        if (closed) return;
        queue.push(data);
        drain();
      },
      emitError(error: SfError) {
        emitAll(listeners.error, error);
      },
      emitClose() {
        const closeListeners = [...listeners.close];
        listeners.close.clear();
        for (const listener of closeListeners) listener();
      },
      onClose(listener: () => void) {
        if (closed) {
          listener();
          return () => undefined;
        }
        listeners.close.add(listener);
        return () => listeners.close.delete(listener);
      },
      onMessage(listener: (data: unknown) => void) {
        listeners.message.add(listener);
        return () => listeners.message.delete(listener);
      },
      onError(listener: (error: SfError) => void) {
        listeners.error.add(listener);
        return () => listeners.error.delete(listener);
      },
      close() {
        pair.close();
      },
      freeze() {
        frozen = true;
      },
      thaw() {
        frozen = false;
        drain();
      },
    };
    return side;
  };

  const a = makeSide();
  const b = makeSide();
  a.peer = b;
  b.peer = a;
  const pair: PortPair = {
    a,
    b,
    crash(error = new Error('worker crashed')) {
      if (closed) return;
      a.emitError(toSfError(error));
      pair.close();
    },
    close() {
      if (closed) return;
      closed = true;
      a.emitClose();
      b.emitClose();
    },
  };
  return pair;
}
