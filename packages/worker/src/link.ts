/**
 * Link: envelopes over a Port. Multiplexes named channels, correlates
 * request/response pairs, propagates cancellation (`cancel` envelopes) and
 * trace context (`traceparent`), and validates every incoming envelope.
 *
 * Everything higher-level (control, protocols, replication, contexts,
 * telemetry forwarding, broker) is a channel on a Link.
 */
import {
  AbortedError,
  createNoopTelemetry,
  err,
  formatTraceparent,
  parseTraceparent,
  type Result,
  type SfError,
  type Span,
  type SpanContext,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import { type Clock, systemClock } from './clock.js';
import {
  type ChannelId,
  createEnvelope,
  type Envelope,
  fromWireResult,
  isEnvelope,
  isWireResult,
  toWireResult,
} from './envelope.js';
import { InvalidEnvelopeError, NoHandlerError, PortClosedError, RequestTimeoutError } from './errors.js';
import type { Port } from './port.js';

export interface SendOptions {
  /** Parent span (or remote context) for trace propagation. */
  readonly parent?: Span | SpanContext | undefined;
  /** Explicit traceparent (wins over `parent`). */
  readonly traceparent?: string | undefined;
  readonly version?: number | undefined;
  readonly transfer?: readonly Transferable[];
}

export interface LinkRequestOptions extends SendOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface MessageContext {
  readonly envelope: Envelope;
  /** Remote span context parsed from the envelope's traceparent. */
  readonly parent: SpanContext | undefined;
  /** Aborted when the requester cancels or the link closes (requests only). */
  readonly signal: AbortSignal;
}

export type LinkRequestHandler = (
  payload: unknown,
  context: MessageContext,
) => Result<unknown> | Promise<Result<unknown>>;

export type LinkEventListener = (payload: unknown, context: MessageContext) => void;

export interface Link {
  readonly name: string;
  readonly closed: boolean;
  /** Epoch stamped on outgoing envelopes. */
  readonly epoch: number;
  setEpoch(epoch: number): void;
  /** Number of outgoing requests awaiting a response. */
  readonly pending: number;
  /** Fire-and-forget event on `channel`. Returns the envelope id. */
  send(channel: ChannelId, payload: unknown, options?: SendOptions): string;
  on(channel: ChannelId, listener: LinkEventListener): () => void;
  request(channel: ChannelId, payload: unknown, options?: LinkRequestOptions): Promise<Result<unknown>>;
  /** One request handler per channel; registering again replaces it. */
  handle(channel: ChannelId, handler: LinkRequestHandler): () => void;
  onClose(listener: (reason: SfError) => void): () => void;
  /** Close the link: pending requests fail with SF-WK-009, incoming handlers are aborted. */
  close(reason?: SfError): void;
}

export interface LinkOptions {
  readonly port: Port;
  readonly name?: string;
  readonly epoch?: number;
  readonly telemetry?: Telemetry;
  /** Default request timeout. Default 30 s. */
  readonly defaultTimeoutMs?: number;
  readonly clock?: Clock;
  /** Called for every invalid incoming message (also reported to telemetry). */
  readonly onInvalid?: (error: SfError) => void;
}

const SUBSYSTEM = 'worker/link';

export function createLink(options: LinkOptions): Link {
  const port = options.port;
  const name = options.name ?? 'link';
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const clock = options.clock ?? systemClock;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  let epoch = options.epoch ?? 0;
  let closed = false;
  let counter = 0;
  const pending = new Map<string, (result: Result<unknown>) => void>();
  const incoming = new Map<string, AbortController>();
  const handlers = new Map<string, LinkRequestHandler>();
  const listeners = new Map<string, Set<LinkEventListener>>();
  const closeListeners = new Set<(reason: SfError) => void>();

  const nextId = (): string => {
    counter += 1;
    return `${name}:${counter}`;
  };

  const traceparentOf = (o: SendOptions | undefined, span?: Span): string | undefined => {
    if (o?.traceparent !== undefined) return o.traceparent;
    const context = span?.context ?? (o?.parent === undefined ? undefined : 'traceId' in o.parent ? o.parent : o.parent.context);
    return context === undefined ? undefined : formatTraceparent(context);
  };

  const post = (envelope: Envelope, transfer?: readonly Transferable[]): void => {
    if (closed) return;
    port.postMessage(envelope, transfer);
  };

  const reportInvalid = (error: SfError): void => {
    telemetry.event('worker.invalid-message', {
      subsystem: SUBSYSTEM,
      level: 'critical',
      attrs: { link: name, code: error.code, message: error.message },
    });
    options.onInvalid?.(error);
  };

  const contextOf = (envelope: Envelope, signal: AbortSignal): MessageContext => ({
    envelope,
    parent: envelope.traceparent === undefined ? undefined : parseTraceparent(envelope.traceparent),
    signal,
  });

  const respond = (request: Envelope, result: Result<unknown>): void => {
    post(
      createEnvelope({
        kind: 'response',
        channel: request.channel,
        id: request.id,
        epoch,
        payload: toWireResult(result),
        traceparent: request.traceparent,
      }),
    );
  };

  const onRequest = (envelope: Envelope): void => {
    const handler = handlers.get(envelope.channel);
    if (handler === undefined) {
      respond(
        envelope,
        err(NoHandlerError({ message: `No handler for channel "${envelope.channel}".`, details: { channel: envelope.channel } })),
      );
      return;
    }
    const controller = new AbortController();
    incoming.set(envelope.id, controller);
    const context = contextOf(envelope, controller.signal);
    let outcome: Promise<Result<unknown>>;
    try {
      outcome = Promise.resolve(handler(envelope.payload, context));
    } catch (error) {
      outcome = Promise.resolve(err(toSfError(error)));
    }
    void outcome
      .catch((error: unknown) => err(toSfError(error)))
      .then((result) => {
        incoming.delete(envelope.id);
        if (controller.signal.aborted) return;
        respond(envelope, result);
      });
  };

  const unsubscribeMessage = port.onMessage((data) => {
    if (closed) return;
    if (!isEnvelope(data)) {
      reportInvalid(InvalidEnvelopeError({ details: { link: name, received: typeof data } }));
      return;
    }
    switch (data.kind) {
      case 'response': {
        const settle = pending.get(data.id);
        if (settle === undefined) return; // late (timed out / cancelled) — ignore
        if (!isWireResult(data.payload)) {
          const error = InvalidEnvelopeError({ message: 'Malformed response payload.', details: { channel: data.channel } });
          reportInvalid(error);
          settle(err(error));
          return;
        }
        settle(fromWireResult(data.payload));
        return;
      }
      case 'event': {
        const set = listeners.get(data.channel);
        if (set === undefined) return;
        const context = contextOf(data, NEVER_ABORTED);
        for (const listener of [...set]) {
          try {
            listener(data.payload, context);
          } catch (error) {
            reportInvalid(toSfError(error));
          }
        }
        return;
      }
      case 'request':
        onRequest(data);
        return;
      case 'cancel':
        incoming.get(data.id)?.abort(new DOMException('cancelled by requester', 'AbortError'));
        incoming.delete(data.id);
        return;
    }
  });

  let unsubscribePortClose: () => void = () => undefined;

  const link: Link = {
    name,
    get closed() {
      return closed;
    },
    get epoch() {
      return epoch;
    },
    setEpoch(next) {
      epoch = next;
    },
    get pending() {
      return pending.size;
    },
    send(channel, payload, sendOptions) {
      const id = nextId();
      post(
        createEnvelope({
          kind: 'event',
          channel,
          id,
          epoch,
          payload,
          version: sendOptions?.version,
          traceparent: traceparentOf(sendOptions),
        }),
        sendOptions?.transfer,
      );
      return id;
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (set === undefined) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    request(channel, payload, requestOptions = {}) {
      if (closed) return Promise.resolve(err(PortClosedError({ details: { channel, link: name } })));
      const signal = requestOptions.signal;
      if (signal?.aborted === true) return Promise.resolve(err(AbortedError({ cause: signal.reason })));
      const id = nextId();
      const span = telemetry.span('worker.request', {
        subsystem: SUBSYSTEM,
        level: 'verbose',
        attrs: { channel, link: name },
        parent: requestOptions.parent,
      });
      const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs;
      return new Promise<Result<unknown>>((resolve) => {
        let timer: unknown;
        // Aborted to detach the abort listener once the request settles.
        const detach = new AbortController();
        const cancel = (): void => {
          post(createEnvelope({ kind: 'cancel', channel, id, epoch, payload: null }));
        };
        const onAbort = (): void => {
          cancel();
          settle(err(AbortedError({ cause: signal?.reason })));
        };
        const settle = (result: Result<unknown>): void => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clock.clearTimeout(timer);
          detach.abort();
          if (result.ok) span.end('ok');
          else span.end(result.error.kind === 'aborted' ? 'cancelled' : 'error', result.error);
          resolve(result);
        };
        pending.set(id, settle);
        timer = clock.setTimeout(() => {
          cancel();
          settle(err(RequestTimeoutError({ details: { channel, timeoutMs, link: name } })));
        }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true, signal: detach.signal });
        post(
          createEnvelope({
            kind: 'request',
            channel,
            id,
            epoch,
            payload,
            version: requestOptions.version,
            traceparent: traceparentOf(requestOptions, span),
          }),
          requestOptions.transfer,
        );
      });
    },
    handle(channel, handler) {
      handlers.set(channel, handler);
      return () => {
        if (handlers.get(channel) === handler) handlers.delete(channel);
      };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close(reason = PortClosedError({ details: { link: name } })) {
      if (closed) return;
      closed = true;
      unsubscribeMessage();
      unsubscribePortClose();
      for (const settle of [...pending.values()]) settle(err(PortClosedError({ cause: reason, details: { link: name } })));
      pending.clear();
      for (const controller of incoming.values()) controller.abort(reason);
      incoming.clear();
      port.close();
      for (const listener of [...closeListeners]) listener(reason);
      closeListeners.clear();
    },
  };
  unsubscribePortClose = port.onClose(() => link.close());
  return link;
}

const NEVER_ABORTED: AbortSignal = new AbortController().signal;
