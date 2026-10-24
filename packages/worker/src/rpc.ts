/**
 * Protocol clients and servers: typed request/response and events for a
 * `defineProtocol()` definition over a Link. The protocol id is the channel.
 * Args, results and event payloads are validated against their schemas when
 * `validate` is on (default: on — production builds may pass false).
 */
import { err, ok, type Result, type SfError, toSfError } from '@staticflux/core';
import { NoHandlerError, InvalidEnvelopeError } from './errors.js';
import type { Link, LinkRequestOptions, MessageContext, SendOptions } from './link.js';
import {
  type AnyProtocol,
  type ArgsOf,
  type EventName,
  type EventPayload,
  isProtocolMessage,
  type ProtocolEventPayload,
  type ProtocolRequestPayload,
  type RequestName,
  type ResultOf,
} from './protocol.js';

export interface ProtocolOptions {
  /** Validate messages against schemas. Default true (dev). */
  readonly validate?: boolean;
}

export type ProtocolRequestOptions = LinkRequestOptions;

export interface ProtocolClient<P extends AnyProtocol> {
  readonly protocol: P;
  request<K extends RequestName<P>>(
    name: K,
    args: ArgsOf<P, K>,
    options?: ProtocolRequestOptions,
  ): Promise<Result<ResultOf<P, K>>>;
  on<K extends EventName<P>>(name: K, listener: (payload: EventPayload<P, K>, context: MessageContext) => void): () => void;
}

export type ProtocolHandler<P extends AnyProtocol, K extends RequestName<P>> = (
  args: ArgsOf<P, K>,
  context: MessageContext,
) => Result<ResultOf<P, K>> | Promise<Result<ResultOf<P, K>>>;

export type ProtocolHandlers<P extends AnyProtocol> = { readonly [K in RequestName<P>]: ProtocolHandler<P, K> };

export interface ProtocolServer<P extends AnyProtocol> {
  readonly protocol: P;
  handle<K extends RequestName<P>>(name: K, handler: ProtocolHandler<P, K>): () => void;
  emit<K extends EventName<P>>(name: K, payload: EventPayload<P, K>, options?: SendOptions): Result<void>;
  dispose(): void;
}

function validationError(protocolId: string, name: string, cause: SfError): SfError {
  return InvalidEnvelopeError({
    message: `Protocol "${protocolId}" message "${name}" failed validation.`,
    cause,
    details: { protocol: protocolId, message: name },
  });
}

export function createProtocolClient<P extends AnyProtocol>(link: Link, protocol: P, options: ProtocolOptions = {}): ProtocolClient<P> {
  const validate = options.validate ?? true;
  return {
    protocol,
    async request(name, args, requestOptions = {}) {
      const definition = protocol.requests[name];
      if (definition === undefined) return err(NoHandlerError({ details: { protocol: protocol.id, message: name } }));
      if (validate) {
        const checked = definition.args.check(args);
        if (!checked.ok) return err(validationError(protocol.id, name, checked.error));
      }
      const payload: ProtocolRequestPayload = { name, args };
      const result = await link.request(protocol.id, payload, {
        ...requestOptions,
        timeoutMs: requestOptions.timeoutMs ?? definition.timeoutMs,
      });
      if (!result.ok || !validate) return result as Result<ResultOf<P, typeof name>>;
      const checked = definition.result.check(result.value);
      return checked.ok ? (checked as Result<ResultOf<P, typeof name>>) : err(validationError(protocol.id, name, checked.error));
    },
    on(name, listener) {
      const definition = protocol.events[name];
      return link.on(protocol.id, (raw, context) => {
        if (!isProtocolMessage(raw, 'payload') || raw.name !== name) return;
        const payload = (raw as unknown as ProtocolEventPayload).payload;
        if (validate && definition !== undefined && !definition.payload.check(payload).ok) return;
        listener(payload as EventPayload<P, typeof name>, context);
      });
    },
  };
}

export function createProtocolServer<P extends AnyProtocol>(
  link: Link,
  protocol: P,
  handlers: Partial<ProtocolHandlers<P>> = {},
  options: ProtocolOptions = {},
): ProtocolServer<P> {
  const validate = options.validate ?? true;
  const table = new Map<string, (args: unknown, context: MessageContext) => Result<unknown> | Promise<Result<unknown>>>();
  for (const [name, handler] of Object.entries(handlers)) {
    if (handler !== undefined) table.set(name, handler as never);
  }
  const unhandle = link.handle(protocol.id, async (raw, context) => {
    if (!isProtocolMessage(raw, 'args')) {
      return err(InvalidEnvelopeError({ message: 'Malformed protocol request.', details: { protocol: protocol.id } }));
    }
    const { name, args } = raw as unknown as ProtocolRequestPayload;
    const handler = table.get(name);
    const definition = protocol.requests[name];
    if (handler === undefined || definition === undefined) {
      return err(NoHandlerError({ message: `No handler for "${protocol.id}" request "${name}".`, details: { protocol: protocol.id, message: name } }));
    }
    if (validate) {
      const checked = definition.args.check(args);
      if (!checked.ok) return err(validationError(protocol.id, name, checked.error));
    }
    try {
      return await handler(args, context);
    } catch (error) {
      return err(toSfError(error));
    }
  });
  return {
    protocol,
    handle(name, handler) {
      table.set(name, handler as never);
      return () => {
        if (table.get(name) === (handler as never)) table.delete(name);
      };
    },
    emit(name, payload, sendOptions) {
      const definition = protocol.events[name];
      if (definition === undefined) return err(NoHandlerError({ details: { protocol: protocol.id, event: name } }));
      if (validate) {
        const checked = definition.payload.check(payload);
        if (!checked.ok) return err(validationError(protocol.id, name, checked.error));
      }
      const wire: ProtocolEventPayload = { name, payload };
      link.send(protocol.id, wire, sendOptions);
      return ok();
    },
    dispose() {
      unhandle();
      table.clear();
    },
  };
}
