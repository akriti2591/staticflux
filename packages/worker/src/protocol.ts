/**
 * Typed message protocols. A protocol is data: an id (also its channel), a
 * version, request definitions (args → result, idempotency, timeout) and
 * event definitions (payload). Schemas validate messages in dev.
 *
 * @example
 * export const DocProtocol = defineProtocol({
 *   id: 'studio/document',
 *   version: 1,
 *   requests: {
 *     apply: request<{ op: Op }, { version: number }>({ idempotent: false }),
 *     snapshot: request<void, DocArchive>({ idempotent: true }),
 *   },
 *   events: { archived: event<DocArchive>() },
 * });
 */
import { err, ok, type Result } from '@staticflux/core';
import type { ChannelId } from './envelope.js';
import { InvalidEnvelopeError } from './errors.js';

declare const schemaType: unique symbol;

/** A runtime check that also carries its static type. */
export interface Schema<T> {
  readonly name: string;
  check(value: unknown): Result<T>;
  /** Phantom type carrier; never present at runtime. */
  readonly [schemaType]?: T;
}

/**
 * Create a schema from a guard. Without a guard the schema is static-only
 * (accepts any value) — use it for trusted, same-bundle protocols.
 */
export function schema<T>(name: string, guard?: (value: unknown) => boolean): Schema<T> {
  return {
    name,
    check(value) {
      if (guard === undefined || guard(value)) return ok(value as T);
      return err(
        InvalidEnvelopeError({
          message: `Message payload does not match schema "${name}".`,
          details: { schema: name },
        }),
      );
    },
  };
}

/** Schema that accepts anything (static type only). */
export function anySchema<T>(): Schema<T> {
  return schema<T>('any');
}

export interface RequestDefinition<A, R> {
  readonly kind: 'request';
  readonly args: Schema<A>;
  readonly result: Schema<R>;
  /** Safe to retry after a worker respawn. Default false. */
  readonly idempotent: boolean;
  readonly timeoutMs: number | undefined;
}

export interface EventDefinition<P> {
  readonly kind: 'event';
  readonly payload: Schema<P>;
}

export interface RequestOptionsInit<A, R> {
  readonly args?: Schema<A>;
  readonly result?: Schema<R>;
  readonly idempotent?: boolean;
  readonly timeoutMs?: number;
}

export function request<A, R>(options: RequestOptionsInit<A, R> = {}): RequestDefinition<A, R> {
  return Object.freeze({
    kind: 'request',
    args: options.args ?? anySchema<A>(),
    result: options.result ?? anySchema<R>(),
    idempotent: options.idempotent ?? false,
    timeoutMs: options.timeoutMs,
  });
}

export function event<P>(options: { readonly payload?: Schema<P> } = {}): EventDefinition<P> {
  return Object.freeze({ kind: 'event', payload: options.payload ?? anySchema<P>() });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRequestDefinition = RequestDefinition<any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEventDefinition = EventDefinition<any>;

export interface ProtocolDefinition<
  Id extends ChannelId = ChannelId,
  Rq extends Readonly<Record<string, AnyRequestDefinition>> = Readonly<Record<string, AnyRequestDefinition>>,
  Ev extends Readonly<Record<string, AnyEventDefinition>> = Readonly<Record<string, AnyEventDefinition>>,
> {
  readonly kind: 'protocol';
  readonly id: Id;
  readonly version: number;
  readonly requests: Rq;
  readonly events: Ev;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProtocol = ProtocolDefinition<ChannelId, any, any>;

/* @__NO_SIDE_EFFECTS__ */
export function defineProtocol<
  const Id extends ChannelId,
  const Rq extends Readonly<Record<string, AnyRequestDefinition>> = Record<never, never>,
  const Ev extends Readonly<Record<string, AnyEventDefinition>> = Record<never, never>,
>(definition: {
  readonly id: Id;
  readonly version: number;
  readonly requests?: Rq;
  readonly events?: Ev;
}): ProtocolDefinition<Id, Rq, Ev> {
  return Object.freeze({
    kind: 'protocol',
    id: definition.id,
    version: definition.version,
    requests: (definition.requests ?? {}) as Rq,
    events: (definition.events ?? {}) as Ev,
  });
}

export type RequestName<P extends AnyProtocol> = keyof P['requests'] & string;
export type EventName<P extends AnyProtocol> = keyof P['events'] & string;
export type ArgsOf<P extends AnyProtocol, K extends RequestName<P>> =
  P['requests'][K] extends RequestDefinition<infer A, unknown> ? A : never;
export type ResultOf<P extends AnyProtocol, K extends RequestName<P>> =
  P['requests'][K] extends RequestDefinition<unknown, infer R> ? R : never;
export type EventPayload<P extends AnyProtocol, K extends EventName<P>> =
  P['events'][K] extends EventDefinition<infer E> ? E : never;

/** Wire payload of a protocol request. */
export interface ProtocolRequestPayload {
  readonly name: string;
  readonly args: unknown;
}

/** Wire payload of a protocol event. */
export interface ProtocolEventPayload {
  readonly name: string;
  readonly payload: unknown;
}

export function isProtocolMessage(value: unknown, field: 'args' | 'payload'): value is { name: string } {
  return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string' && field in value;
}
