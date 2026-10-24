/**
 * The transport contract (R9.1). Fetch, SSE, WebSocket, host bridge, worker
 * port and mocks all implement `Transport`. Transports are dumb pipes:
 *
 * - They never retry (retries live in exactly one layer: the data client, R9.4).
 * - They map failures to typed `SfError`s (`errorForStatus`, `NetworkError`, aborts).
 * - They honour the `AbortSignal` and forward `traceparent` (R10.3, W3C Trace Context).
 *
 * Endpoints are typed values (`defineEndpoint`), never ad-hoc strings at call sites.
 */
import type { RetryPolicy, Result, TokenId } from '@staticflux/core';
import type { PausePolicy } from './pause.js';
import type { Schema } from './schema.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A typed name for a transport binding (e.g. the agent WebSocket). */
export interface TransportSlot<Id extends TokenId = TokenId> {
  readonly kind: 'transport-slot';
  readonly id: Id;
}

export function transportSlot<const Id extends TokenId>(id: Id): TransportSlot<Id> {
  return Object.freeze({ kind: 'transport-slot', id });
}

/** The slot endpoints use unless they name another. */
export const DefaultTransport = transportSlot('data/default');

export type QueryValue = string | number | boolean | undefined;

/** What a transport receives. Everything is already resolved from the endpoint + input. */
export interface TransportRequest {
  readonly endpoint: TokenId;
  readonly method: HttpMethod;
  /** Path relative to the transport's base (e.g. `/docs/42`). */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** Request body (JSON-serializable) or undefined. */
  readonly body: unknown;
  /** The raw typed input (for mock / message-based transports). */
  readonly input: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly idempotent: boolean;
  /** W3C `traceparent` of the `data/request` span (also present in `headers`). */
  readonly traceparent: string | undefined;
  /** App epoch the request started in. */
  readonly epoch: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly data: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export interface Transport {
  /** For telemetry/devtools, e.g. `fetch`, `sse`, `ws`, `mock`. */
  readonly id: string;
  /** Request/response. Non-2xx must be returned as `err(errorForStatus(...))`. */
  request?(request: TransportRequest, signal: AbortSignal): Promise<Result<TransportResponse>>;
  /**
   * Streaming and subscriptions: call `onChunk` for every message; resolve
   * `ok()` when the stream completes, `err(...)` when it fails or is aborted.
   * Subscriptions simply never complete until aborted.
   */
  stream?(request: TransportRequest, onChunk: (chunk: unknown) => void, signal: AbortSignal): Promise<Result<void>>;
  /** Release connections (WebSocket, EventSource). */
  close?(): void;
}

export interface BreakerConfig {
  readonly failureThreshold: number;
  readonly resetAfterMs: number;
}

interface EndpointCommon<I> {
  /** Namespaced id, e.g. `docs/list`. Used for telemetry, breakers, mock routing. */
  readonly id: TokenId;
  readonly method: HttpMethod;
  readonly path: (input: I) => string;
  readonly query: ((input: I) => Readonly<Record<string, QueryValue>>) | undefined;
  readonly body: ((input: I) => unknown) | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
  /** Safe to send twice. Governs retries and pause queueing (R4.6). */
  readonly idempotent: boolean;
  readonly pause: PausePolicy | undefined;
  readonly transport: TransportSlot;
  /** Per-attempt timeout. */
  readonly timeoutMs: number | undefined;
  /** Per-endpoint circuit breaker; `false` disables. Default: client default. */
  readonly breaker: BreakerConfig | false | undefined;
}

export interface Endpoint<I, O> extends EndpointCommon<I> {
  readonly kind: 'endpoint';
  readonly response: Schema<O> | undefined;
  /** Retry policy (core `retry`, full jitter). `false` disables. Default: client default for idempotent endpoints, none otherwise. */
  readonly retry: Omit<RetryPolicy, 'random'> | false | undefined;
}

export interface StreamEndpoint<I, C> extends EndpointCommon<I> {
  readonly kind: 'stream-endpoint';
  readonly chunk: Schema<C> | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEndpoint = Endpoint<any, any> | StreamEndpoint<any, any>;

export interface EndpointInit<I> {
  readonly id: TokenId;
  readonly method?: HttpMethod;
  readonly path: (input: I) => string;
  readonly query?: (input: I) => Readonly<Record<string, QueryValue>>;
  readonly body?: (input: I) => unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Default: `true` for GET, `false` otherwise. */
  readonly idempotent?: boolean;
  readonly pause?: PausePolicy;
  readonly transport?: TransportSlot;
  readonly timeoutMs?: number;
  readonly breaker?: BreakerConfig | false;
}

function common<I>(init: EndpointInit<I>): EndpointCommon<I> {
  const method = init.method ?? 'GET';
  return {
    id: init.id,
    method,
    path: init.path,
    query: init.query,
    body: init.body,
    headers: init.headers,
    idempotent: init.idempotent ?? method === 'GET',
    pause: init.pause,
    transport: init.transport ?? DefaultTransport,
    timeoutMs: init.timeoutMs,
    breaker: init.breaker,
  };
}

/**
 * Declare a request/response endpoint.
 *
 * @example
 * export const DocGet = defineEndpoint({
 *   id: 'docs/get', path: (i: { id: string }) => `/docs/${i.id}`, response: DocSchema,
 * });
 */
export function defineEndpoint<I, O>(
  init: EndpointInit<I> & { readonly response?: Schema<O>; readonly retry?: Omit<RetryPolicy, 'random'> | false },
): Endpoint<I, O> {
  return Object.freeze({ kind: 'endpoint', ...common(init), response: init.response, retry: init.retry });
}

/** Declare a streamed endpoint (SSE, NDJSON, WebSocket stream, subscription). */
export function defineStreamEndpoint<I, C>(init: EndpointInit<I> & { readonly chunk?: Schema<C> }): StreamEndpoint<I, C> {
  return Object.freeze({ kind: 'stream-endpoint', ...common(init), chunk: init.chunk });
}

/** Build the transport request for an endpoint call (used by the client and tests). */
export function buildRequest<I>(
  endpoint: Endpoint<I, unknown> | StreamEndpoint<I, unknown>,
  input: I,
  extra: { readonly traceparent: string | undefined; readonly epoch: number; readonly headers?: Readonly<Record<string, string>> },
): TransportRequest {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(endpoint.query?.(input) ?? {})) {
    if (v !== undefined) query[k] = String(v);
  }
  const headers: Record<string, string> = { ...endpoint.headers, ...extra.headers };
  if (extra.traceparent !== undefined) headers.traceparent = extra.traceparent;
  return {
    endpoint: endpoint.id,
    method: endpoint.method,
    path: endpoint.path(input),
    query,
    body: endpoint.body?.(input),
    input,
    headers,
    idempotent: endpoint.idempotent,
    traceparent: extra.traceparent,
    epoch: extra.epoch,
  };
}

/** Parse a `Retry-After` header (seconds or HTTP date) into ms. */
export function parseRetryAfter(value: string | null | undefined, now: () => number = Date.now): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}
