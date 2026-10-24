/**
 * The data client: the single layer that executes endpoint calls (R9.4).
 *
 * Per call, in order:
 *   1. `data/request` span; `traceparent` injected into the transport request.
 *   2. Per-endpoint circuit breaker (outermost, so an open circuit is never retried).
 *   3. Retry with full-jitter backoff (core `retry`) — the ONLY retry layer.
 *      Default: idempotent endpoints only.
 *   4. Per attempt: pause gate (queue | reject, R4.6) → timeout → transport → decode (schema).
 *   5. Epoch check: a response whose start epoch is older than the current one is
 *      discarded with `SF-DATA-001` (I-10).
 *
 * Breaker state is reactive (`breakerState`, `breakers`) so the supervisor and UI banners can observe it.
 */
import {
  AbortedError,
  box,
  type CircuitBreaker,
  type CircuitState,
  createCircuitBreaker,
  createNoopTelemetry,
  err,
  formatTraceparent,
  ok,
  type Result,
  retry,
  type RetryPolicy,
  SfError,
  type Span,
  type SpanContext,
  type Task,
  type Telemetry,
  timeout,
  type TokenId,
  untracked,
} from '@staticflux/core';
import { FIXED_EPOCH, type EpochSource } from './epoch.js';
import { NoTransportError, StaleEpochError, TransportPausedError, UnsupportedOperationError, DecodeError } from './errors.js';
import { DATA_SUBSYSTEMS, DataMetrics } from './metrics.js';
import { createPauseControl, effectivePausePolicy, type PauseControl } from './pause.js';
import {
  type AnyEndpoint,
  type BreakerConfig,
  buildRequest,
  DefaultTransport,
  type Endpoint,
  type StreamEndpoint,
  type Transport,
  type TransportSlot,
} from './transport.js';

export interface DataClientOptions {
  /** Transport for `DefaultTransport`. */
  readonly transport?: Transport;
  /** Additional slot bindings. */
  readonly transports?: readonly (readonly [TransportSlot, Transport])[];
  readonly epoch?: EpochSource;
  readonly pause?: PauseControl;
  readonly telemetry?: Telemetry;
  /** Injectable randomness (retry jitter). */
  readonly random?: () => number;
  readonly now?: () => number;
  /** Default retry for idempotent endpoints. */
  readonly defaultRetry?: Omit<RetryPolicy, 'random'> | false;
  /** Default per-endpoint breaker. */
  readonly defaultBreaker?: BreakerConfig | false;
  /** Default per-attempt timeout. */
  readonly defaultTimeoutMs?: number;
  /** Headers added to every request. */
  readonly headers?: () => Readonly<Record<string, string>>;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Parent span/context (e.g. the navigation or feature span). */
  readonly parent?: Span | SpanContext;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BreakerInfo {
  readonly endpoint: TokenId;
  readonly state: CircuitState;
}

export interface DataClient {
  call<I, O>(endpoint: Endpoint<I, O>, input: I, options?: CallOptions): Promise<Result<O>>;
  /** Streams/subscriptions. Not retried (partial delivery is not idempotent); breaker + pause + epoch apply. */
  stream<I, C>(endpoint: StreamEndpoint<I, C>, input: I, onChunk: (chunk: C) => void, options?: CallOptions): Promise<Result<void>>;
  /** Reactive breaker state of one endpoint (`closed` until it has a breaker). */
  breakerState(endpoint: AnyEndpoint): CircuitState;
  /** Reactive list of all endpoint breakers. */
  breakers(): readonly BreakerInfo[];
  onBreakerChange(listener: (info: BreakerInfo) => void): () => void;
  resetBreaker(endpoint: AnyEndpoint): void;
  readonly epoch: EpochSource;
  readonly pause: PauseControl;
  readonly telemetry: Telemetry;
  dispose(): void;
}

export const DEFAULT_RETRY: Omit<RetryPolicy, 'random'> = { attempts: 3, baseDelayMs: 200, maxDelayMs: 5_000, jitter: 'full' };
export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 5, resetAfterMs: 30_000 };
export const DEFAULT_TIMEOUT_MS = 30_000;

const STATE_GAUGE: Record<CircuitState, number> = { closed: 0, 'half-open': 1, open: 2 };

/** Re-create an error with the request's trace id attached (R10.3). */
function withTrace(error: SfError, traceId: string | undefined): SfError {
  if (traceId === undefined || error.traceId !== undefined) return error;
  return new SfError({
    code: error.code,
    kind: error.kind,
    message: error.message,
    ...(error.fix === undefined ? {} : { fix: error.fix }),
    units: error.units,
    ...(error.scope === undefined ? {} : { scope: error.scope }),
    traceId,
    details: error.details,
    cause: error.cause ?? error,
  });
}

export function createDataClient(options: DataClientOptions = {}): DataClient {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const epoch = options.epoch ?? FIXED_EPOCH;
  const pause = options.pause ?? createPauseControl();
  const now = options.now ?? Date.now;
  const slots = new Map<string, Transport>();
  if (options.transport !== undefined) slots.set(DefaultTransport.id, options.transport);
  for (const [slot, transport] of options.transports ?? []) slots.set(slot.id, transport);

  const breakers = new Map<string, CircuitBreaker>();
  const breakerStates = box<Readonly<Record<string, CircuitState>>>({});
  const breakerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const breakerListeners = new Set<(info: BreakerInfo) => void>();

  const breakerConfig = (endpoint: AnyEndpoint): BreakerConfig | false => {
    if (endpoint.breaker !== undefined) return endpoint.breaker;
    return options.defaultBreaker ?? DEFAULT_BREAKER;
  };

  const onBreakerState = (endpoint: TokenId, state: CircuitState, config: BreakerConfig): void => {
    breakerStates.set({ ...breakerStates.get(), [endpoint]: state });
    telemetry.record(DataMetrics.breakerState, STATE_GAUGE[state], { endpoint });
    telemetry.event('breaker.state', { subsystem: DATA_SUBSYSTEMS.transport, level: state === 'open' ? 'critical' : 'standard', attrs: { endpoint, state } });
    for (const listener of breakerListeners) listener({ endpoint, state });
    const timer = breakerTimers.get(endpoint);
    if (timer !== undefined) clearTimeout(timer);
    breakerTimers.delete(endpoint);
    if (state === 'open') {
      // Make the open → half-open transition observable without polling.
      breakerTimers.set(
        endpoint,
        setTimeout(() => {
          breakerTimers.delete(endpoint);
          void breakers.get(endpoint)?.state;
        }, config.resetAfterMs),
      );
    }
  };

  const breakerFor = (endpoint: AnyEndpoint): CircuitBreaker | undefined => {
    const config = breakerConfig(endpoint);
    if (config === false) return undefined;
    let breaker = breakers.get(endpoint.id);
    if (breaker === undefined) {
      breaker = createCircuitBreaker({
        failureThreshold: config.failureThreshold,
        resetAfterMs: config.resetAfterMs,
        now,
        onStateChange: (state) => onBreakerState(endpoint.id, state, config),
      });
      breakers.set(endpoint.id, breaker);
    }
    return breaker;
  };

  const retryPolicyFor = (endpoint: Endpoint<unknown, unknown>): Omit<RetryPolicy, 'random'> | undefined => {
    if (endpoint.retry === false) return undefined;
    if (endpoint.retry !== undefined) return endpoint.retry;
    if (!endpoint.idempotent) return undefined;
    const fallback = options.defaultRetry ?? DEFAULT_RETRY;
    return fallback === false ? undefined : fallback;
  };

  const transportFor = (endpoint: AnyEndpoint): Result<Transport> => {
    const transport = slots.get(endpoint.transport.id);
    if (transport === undefined) return err(NoTransportError({ details: { endpoint: endpoint.id, slot: endpoint.transport.id } }));
    return ok(transport);
  };

  const pauseGate = async (endpoint: AnyEndpoint, signal: AbortSignal): Promise<Result<void>> => {
    if (!untracked(() => pause.paused)) return ok();
    const policy = effectivePausePolicy(endpoint.pause, endpoint.idempotent);
    if (policy === 'reject') return err(TransportPausedError({ details: { endpoint: endpoint.id, idempotent: endpoint.idempotent } }));
    return pause.whenResumed(signal);
  };

  interface Started {
    readonly span: Span;
    readonly traceparent: string | undefined;
    readonly traceId: string | undefined;
    readonly epochAtStart: number;
    readonly startedAt: number;
    readonly signal: AbortSignal;
  }

  const start = (endpoint: AnyEndpoint, callOptions: CallOptions): Started => {
    const epochAtStart = untracked(() => epoch.current);
    const span = telemetry.span('data/request', {
      subsystem: DATA_SUBSYSTEMS.request,
      parent: callOptions.parent,
      attrs: { endpoint: endpoint.id, method: endpoint.method, epoch: epochAtStart, kind: endpoint.kind },
    });
    const parentContext: SpanContext | undefined =
      callOptions.parent === undefined ? undefined : 'traceId' in callOptions.parent ? callOptions.parent : callOptions.parent.context;
    const context = span.context ?? parentContext;
    return {
      span,
      traceparent: context === undefined ? undefined : formatTraceparent(context),
      traceId: context?.traceId,
      epochAtStart,
      startedAt: telemetry.now(),
      signal: callOptions.signal ?? new AbortController().signal,
    };
  };

  const finish = <T>(endpoint: AnyEndpoint, started: Started, result: Result<T>): Result<T> => {
    const { span } = started;
    const attrs = { endpoint: endpoint.id };
    telemetry.record(DataMetrics.requestDuration, telemetry.now() - started.startedAt, attrs, span);
    if (untracked(() => epoch.current) !== started.epochAtStart) {
      telemetry.record(DataMetrics.staleEpochDiscarded, 1, attrs, span);
      const stale = withTrace(
        StaleEpochError({ details: { endpoint: endpoint.id, epoch: started.epochAtStart, current: untracked(() => epoch.current) } }),
        started.traceId,
      );
      span.set('discarded', 'stale-epoch');
      span.end('cancelled', stale);
      return err(stale);
    }
    if (result.ok) {
      span.end('ok');
      return result;
    }
    const error = withTrace(result.error, started.traceId);
    telemetry.record(DataMetrics.requestFailure, 1, { ...attrs, kind: error.kind }, span);
    span.set('error.kind', error.kind);
    span.end(error.kind === 'aborted' ? 'cancelled' : 'error', error);
    return err(error);
  };

  const client: DataClient = {
    epoch,
    pause,
    telemetry,
    async call<I, O>(endpoint: Endpoint<I, O>, input: I, callOptions: CallOptions = {}): Promise<Result<O>> {
      const started = start(endpoint, callOptions);
      const transportResult = transportFor(endpoint);
      if (!transportResult.ok) return finish(endpoint, started, transportResult);
      const transport = transportResult.value;
      const request = transport.request?.bind(transport);
      if (request === undefined) {
        return finish(endpoint, started, err(UnsupportedOperationError({ details: { endpoint: endpoint.id, transport: transport.id, op: 'request' } })));
      }
      let attempts = 0;
      const attempt: Task<O> = async (signal) => {
        const gate = await pauseGate(endpoint, signal);
        if (!gate.ok) return gate;
        attempts += 1;
        started.span.set('attempts', attempts);
        const transportRequest = buildRequest(endpoint, input, {
          traceparent: started.traceparent,
          epoch: started.epochAtStart,
          headers: { ...options.headers?.(), ...callOptions.headers },
        });
        const response = await request(transportRequest, signal);
        if (!response.ok) return response;
        started.span.set('status', response.value.status);
        if (endpoint.response === undefined) return ok(response.value.data as O);
        const decoded = endpoint.response.validate(response.value.data);
        return decoded.ok ? decoded : err(DecodeError({ cause: decoded.error, details: { endpoint: endpoint.id, ...decoded.error.details } }));
      };
      const timed = timeout(attempt, endpoint.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
      const policy = retryPolicyFor(endpoint as Endpoint<unknown, unknown>);
      const retried: Task<O> =
        policy === undefined
          ? timed
          : retry(timed, {
              ...policy,
              ...(options.random === undefined ? {} : { random: options.random }),
              onRetry: (error, n, delayMs) => {
                started.span.event('retry', { attempt: n, delayMs, kind: error.kind });
                policy.onRetry?.(error, n, delayMs);
              },
            });
      const breaker = breakerFor(endpoint);
      const result = breaker === undefined ? await retried(started.signal) : await breaker.run(retried, started.signal);
      return finish(endpoint, started, result);
    },

    async stream<I, C>(endpoint: StreamEndpoint<I, C>, input: I, onChunk: (chunk: C) => void, callOptions: CallOptions = {}): Promise<Result<void>> {
      const started = start(endpoint, callOptions);
      const transportResult = transportFor(endpoint);
      if (!transportResult.ok) return finish(endpoint, started, transportResult);
      const transport = transportResult.value;
      const stream = transport.stream?.bind(transport);
      if (stream === undefined) {
        return finish(endpoint, started, err(UnsupportedOperationError({ details: { endpoint: endpoint.id, transport: transport.id, op: 'stream' } })));
      }
      const run: Task<void> = async (signal) => {
        const gate = await pauseGate(endpoint, signal);
        if (!gate.ok) return gate;
        const inner = new AbortController();
        const onOuterAbort = (): void => inner.abort(signal.reason);
        signal.addEventListener('abort', onOuterAbort, { once: true });
        let failure: SfError | undefined;
        let chunks = 0;
        const transportRequest = buildRequest(endpoint, input, {
          traceparent: started.traceparent,
          epoch: started.epochAtStart,
          headers: { ...options.headers?.(), ...callOptions.headers },
        });
        const result = await stream(
          transportRequest,
          (raw) => {
            if (failure !== undefined || inner.signal.aborted) return;
            if (untracked(() => epoch.current) !== started.epochAtStart) {
              failure = StaleEpochError({ details: { endpoint: endpoint.id } });
              inner.abort(failure);
              return;
            }
            let chunk = raw as C;
            if (endpoint.chunk !== undefined) {
              const decoded = endpoint.chunk.validate(raw);
              if (!decoded.ok) {
                failure = DecodeError({ cause: decoded.error, details: { endpoint: endpoint.id, ...decoded.error.details } });
                inner.abort(failure);
                return;
              }
              chunk = decoded.value;
            }
            chunks += 1;
            onChunk(chunk);
          },
          inner.signal,
        );
        signal.removeEventListener('abort', onOuterAbort);
        started.span.set('chunks', chunks);
        if (failure !== undefined) return err(failure);
        if (signal.aborted && result.ok) return err(AbortedError({ cause: signal.reason }));
        return result;
      };
      const breaker = breakerFor(endpoint);
      const result = breaker === undefined ? await run(started.signal) : await breaker.run(run, started.signal);
      return finish(endpoint, started, result);
    },

    breakerState(endpoint) {
      return breakerStates.get()[endpoint.id] ?? 'closed';
    },
    breakers() {
      return Object.entries(breakerStates.get()).map(([endpoint, state]) => ({ endpoint: endpoint as TokenId, state }));
    },
    onBreakerChange(listener) {
      breakerListeners.add(listener);
      return () => {
        breakerListeners.delete(listener);
      };
    },
    resetBreaker(endpoint) {
      breakers.get(endpoint.id)?.reset();
    },
    dispose() {
      for (const timer of breakerTimers.values()) clearTimeout(timer);
      breakerTimers.clear();
      breakerListeners.clear();
      for (const transport of new Set(slots.values())) transport.close?.();
    },
  };
  return client;
}
