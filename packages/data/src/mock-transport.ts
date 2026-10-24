/**
 * In-memory mock transport (R9.7): the example app's backends and every test
 * use it. Same contract as the real transports: typed routes per endpoint,
 * abortable latency, failure injection (next-N failures, failure rate,
 * offline), and a call log with `traceparent` + epoch for assertions.
 */
import { AbortedError, err, ok, type Result, type SfError, sleep, toSfError } from '@staticflux/core';
import { errorForStatus, NetworkError, NoRouteError } from './errors.js';
import type { Endpoint, StreamEndpoint, Transport, TransportRequest, TransportResponse } from './transport.js';

/** Returned by a handler to answer with a non-2xx status. */
export interface MockStatus {
  readonly kind: 'mock-status';
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export function mockStatus(status: number, body?: unknown, headers: Readonly<Record<string, string>> = {}): MockStatus {
  return { kind: 'mock-status', status, body, headers };
}

export type MockFailure = { readonly status: number } | { readonly error: SfError } | 'network';

export interface MockContext {
  readonly request: TransportRequest;
  readonly signal: AbortSignal;
  /** 1-based count of calls to this endpoint so far (including this one). */
  readonly call: number;
  /** Abortable sleep for handlers that simulate work between chunks. */
  sleep(ms: number): Promise<Result<void>>;
}

export interface MockRouteOptions {
  readonly latencyMs?: number;
}

export interface MockCall {
  readonly endpoint: string;
  readonly input: unknown;
  readonly traceparent: string | undefined;
  readonly epoch: number;
  readonly kind: 'request' | 'stream';
}

export interface MockTransportOptions {
  /** Default latency per call. Default 0 (still async). */
  readonly latencyMs?: number;
  /** Delay between streamed chunks. Default 0. */
  readonly chunkDelayMs?: number;
  /** Injectable randomness for `failureRate`. */
  readonly random?: () => number;
}

export interface MockTransport extends Transport {
  route<I, O>(
    endpoint: Endpoint<I, O>,
    handler: (input: I, context: MockContext) => O | MockStatus | Promise<O | MockStatus>,
    options?: MockRouteOptions,
  ): MockTransport;
  routeStream<I, C>(
    endpoint: StreamEndpoint<I, C>,
    handler: (input: I, context: MockContext) => Iterable<C> | AsyncIterable<C>,
    options?: MockRouteOptions,
  ): MockTransport;
  stream: NonNullable<Transport['stream']>;
  /** Fail the next `times` calls of `endpoint`. */
  failNext(endpoint: { readonly id: string }, failure: MockFailure, times?: number): void;
  /** Fail a fraction of calls with 503 (uses the injected random). */
  failureRate(endpoint: { readonly id: string }, rate: number): void;
  /** Every call fails with a network error while offline. */
  setOffline(offline: boolean): void;
  readonly calls: readonly MockCall[];
  callsTo(endpoint: { readonly id: string }): readonly MockCall[];
  reset(): void;
}

interface RequestRoute {
  readonly handler: (input: unknown, context: MockContext) => unknown;
  readonly latencyMs: number | undefined;
}
interface StreamRoute {
  readonly handler: (input: unknown, context: MockContext) => Iterable<unknown> | AsyncIterable<unknown>;
  readonly latencyMs: number | undefined;
}

function isMockStatus(value: unknown): value is MockStatus {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'mock-status';
}

function failureError(failure: MockFailure, endpoint: string): SfError {
  if (failure === 'network') return NetworkError({ details: { endpoint, injected: true } });
  if ('error' in failure) return failure.error;
  return errorForStatus({ status: failure.status, endpoint });
}

export function createMockTransport(options: MockTransportOptions = {}): MockTransport {
  const requestRoutes = new Map<string, RequestRoute>();
  const streamRoutes = new Map<string, StreamRoute>();
  const failNext = new Map<string, { failure: MockFailure; remaining: number }>();
  const failureRates = new Map<string, number>();
  const counts = new Map<string, number>();
  const random = options.random ?? Math.random;
  const calls: MockCall[] = [];
  let offline = false;

  const begin = async (
    request: TransportRequest,
    kind: MockCall['kind'],
    latencyMs: number | undefined,
    signal: AbortSignal,
  ): Promise<Result<number>> => {
    calls.push({ endpoint: request.endpoint, input: request.input, traceparent: request.traceparent, epoch: request.epoch, kind });
    const call = (counts.get(request.endpoint) ?? 0) + 1;
    counts.set(request.endpoint, call);
    const slept = await sleep(latencyMs ?? options.latencyMs ?? 0, signal);
    if (!slept.ok) return slept;
    if (offline) return err(NetworkError({ details: { endpoint: request.endpoint, offline: true } }));
    const injected = failNext.get(request.endpoint);
    if (injected !== undefined && injected.remaining > 0) {
      injected.remaining -= 1;
      return err(failureError(injected.failure, request.endpoint));
    }
    const rate = failureRates.get(request.endpoint) ?? 0;
    if (rate > 0 && random() < rate) return err(errorForStatus({ status: 503, endpoint: request.endpoint }));
    return ok(call);
  };

  const context = (request: TransportRequest, signal: AbortSignal, call: number): MockContext => ({
    request,
    signal,
    call,
    sleep: (ms) => sleep(ms, signal),
  });

  const streamRequest: NonNullable<Transport['stream']> = async (request, onChunk, signal) => {
    const route = streamRoutes.get(request.endpoint);
    if (route === undefined) return err(NoRouteError({ details: { endpoint: request.endpoint } }));
    const started = await begin(request, 'stream', route.latencyMs, signal);
    if (!started.ok) return started;
    try {
      for await (const chunk of route.handler(request.input, context(request, signal, started.value))) {
        if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
        onChunk(chunk);
        if ((options.chunkDelayMs ?? 0) > 0) {
          const slept = await sleep(options.chunkDelayMs ?? 0, signal);
          if (!slept.ok) return slept;
        }
      }
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      return ok();
    } catch (error) {
      if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
      return err(toSfError(error));
    }
  };

  const transport: MockTransport = {
    id: 'mock',
    async request(request, signal): Promise<Result<TransportResponse>> {
      const route = requestRoutes.get(request.endpoint);
      if (route === undefined) return err(NoRouteError({ details: { endpoint: request.endpoint } }));
      const started = await begin(request, 'request', route.latencyMs, signal);
      if (!started.ok) return started;
      try {
        const value = await route.handler(request.input, context(request, signal, started.value));
        if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
        if (isMockStatus(value)) {
          if (value.status >= 200 && value.status < 300) return ok({ status: value.status, data: value.body, headers: value.headers });
          return err(errorForStatus({ status: value.status, endpoint: request.endpoint, body: value.body }));
        }
        return ok({ status: 200, data: value, headers: {} });
      } catch (error) {
        if (signal.aborted) return err(AbortedError({ cause: signal.reason }));
        return err(toSfError(error));
      }
    },
    stream: streamRequest,
    route(endpoint, handler, routeOptions = {}) {
      requestRoutes.set(endpoint.id, { handler: handler as RequestRoute['handler'], latencyMs: routeOptions.latencyMs });
      return transport;
    },
    routeStream(endpoint, handler, routeOptions = {}) {
      streamRoutes.set(endpoint.id, { handler: handler as StreamRoute['handler'], latencyMs: routeOptions.latencyMs });
      return transport;
    },
    failNext(endpoint, failure, times = 1) {
      failNext.set(endpoint.id, { failure, remaining: times });
    },
    failureRate(endpoint, rate) {
      failureRates.set(endpoint.id, rate);
    },
    setOffline(value) {
      offline = value;
    },
    get calls() {
      return calls;
    },
    callsTo(endpoint) {
      return calls.filter((c) => c.endpoint === endpoint.id);
    },
    reset() {
      calls.length = 0;
      counts.clear();
      failNext.clear();
      failureRates.clear();
      offline = false;
    },
  };
  return transport;
}
