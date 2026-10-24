/**
 * Worker-side runtime: `runWorker()` is what code inside a worker calls.
 *
 * 1. Waits for the supervisor's `hello`.
 * 2. Replicates core contexts (and checks required ones) and applies the
 *    observability context to worker telemetry — before any feature code runs.
 * 3. Runs `setup` / builds handlers (feature code), then answers `ready`.
 * 4. Answers heartbeats; applies pause/resume/refresh/drain commands.
 * 5. Forwards worker telemetry to the main thread (R11.6).
 *
 * @example (inside doc.worker.ts)
 * void runWorker({
 *   port: fromWorkerScope(self),
 *   protocol: DocProtocol,
 *   contexts: [CoreContexts.session],
 *   handlers: (runtime) => ({ apply: (args) => engine.apply(args) }),
 * });
 */
import {
  createDeferred,
  createScope,
  createTelemetry,
  err,
  type LevelName,
  ok,
  parseTraceparent,
  type Result,
  type Scope,
  type SpanContext,
  type Subsystem,
  type Telemetry,
} from '@staticflux/core';
import { type BrokerClient, createBrokerClient } from './broker.js';
import { type Clock, systemClock } from './clock.js';
import { type AnyContextKey, CoreContexts, createWorkerContexts, type WorkerContexts } from './context.js';
import { type ControlMessage, type HelloMessage, isControlMessage, type ReadyMessage } from './control.js';
import { Channels } from './envelope.js';
import { InvalidEnvelopeError, NoHandlerError, ProtocolMismatchError } from './errors.js';
import { createLink, type Link, type MessageContext, type SendOptions } from './link.js';
import type { Port } from './port.js';
import type { AnyProtocol, ArgsOf, EventName, EventPayload, RequestName, ResultOf } from './protocol.js';
import {
  type AnyReplicaDefinition,
  createReplica,
  type IntentsOf,
  type Publisher,
  type Replica,
  type ReplicaOptions,
  type StateOf,
} from './replication.js';
import { createProtocolServer, type ProtocolHandlers, type ProtocolServer } from './rpc.js';
import { createForwardingSink } from './telemetry-forward.js';

export interface WorkerRuntime<P extends AnyProtocol> {
  readonly workerId: string;
  readonly attempt: number;
  readonly epoch: number;
  readonly paused: boolean;
  readonly contexts: WorkerContexts;
  /** Payload from the supervisor's `rehydrate()` (e.g. last archive), if any. */
  readonly rehydrate: unknown;
  /** Parent trace from the observability context. */
  readonly parent: SpanContext | undefined;
  readonly link: Link;
  readonly scope: Scope;
  readonly telemetry: Telemetry;
  readonly broker: BrokerClient;
  emit<K extends EventName<P>>(name: K, payload: EventPayload<P, K>, options?: SendOptions): Result<void>;
  /** Serve a worker-owned store to main-thread replicas. */
  publish(publisher: Publisher): void;
  /** Replica of a main-owned store (synced when the promise resolves). */
  replicate<D extends AnyReplicaDefinition>(
    definition: D,
    options?: ReplicaOptions<StateOf<D>>,
  ): Promise<Result<Replica<StateOf<D>, IntentsOf<D>>>>;
}

export interface WorkerHandlerContext<P extends AnyProtocol> extends MessageContext {
  readonly runtime: WorkerRuntime<P>;
}

export type WorkerHandlers<P extends AnyProtocol> = {
  readonly [K in RequestName<P>]: (
    args: ArgsOf<P, K>,
    context: WorkerHandlerContext<P>,
  ) => Result<ResultOf<P, K>> | Promise<Result<ResultOf<P, K>>>;
};

export interface RunWorkerOptions<P extends AnyProtocol> {
  readonly port: Port;
  readonly protocol: P;
  /** Handlers, or a factory run after contexts are replicated (feature code). */
  readonly handlers:
    | WorkerHandlers<P>
    | ((runtime: WorkerRuntime<P>) => WorkerHandlers<P> | Result<WorkerHandlers<P>> | Promise<Result<WorkerHandlers<P>>>);
  /** Core contexts this worker requires; the handshake fails if one is missing. */
  readonly contexts?: readonly AnyContextKey[];
  /** Extra setup after handlers are built and before `ready`. */
  readonly setup?: (runtime: WorkerRuntime<P>) => void | Result<void> | Promise<Result<void>>;
  readonly onPause?: () => void | Promise<void>;
  readonly onResume?: () => void | Promise<void>;
  readonly onRefresh?: (epoch: number) => void | Promise<void>;
  readonly onShutdown?: () => void | Promise<void>;
  /** Worker telemetry. Default: a new telemetry configured from the observability context. */
  readonly telemetry?: Telemetry;
  /** Forward telemetry to the main thread. Default true. */
  readonly forwardTelemetry?: boolean;
  readonly validate?: boolean;
  readonly clock?: Clock;
  readonly drainTimeoutMs?: number;
}

function isHandlerRecord<P extends AnyProtocol>(value: RunWorkerOptions<P>['handlers']): value is WorkerHandlers<P> {
  return typeof value !== 'function';
}

function isResult(value: unknown): value is Result<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean' && ('value' in value || 'error' in value);
}

/** Run worker-side code. Resolves once the handshake completed (or failed). */
export function runWorker<P extends AnyProtocol>(options: RunWorkerOptions<P>): Promise<Result<WorkerRuntime<P>>> {
  const clock = options.clock ?? systemClock;
  const telemetry = options.telemetry ?? createTelemetry({ defaultLevel: 'standard' });
  const scope = createScope('worker-runtime');
  const link = createLink({ port: options.port, name: 'worker', telemetry, clock });
  scope.defer(() => link.close());
  if (options.forwardTelemetry !== false) {
    const sink = createForwardingSink(link);
    scope.defer(telemetry.addSink(sink));
    scope.defer(() => sink.flush());
  }
  const done = createDeferred<Result<WorkerRuntime<P>>>();
  let runtime: WorkerRuntime<P> | undefined;
  let server: ProtocolServer<P> | undefined;
  let paused = false;
  let epoch = 0;
  let inFlight = 0;
  let idle = createDeferred<void>();
  idle.resolve();

  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    if (inFlight === 0) idle = createDeferred<void>();
    inFlight += 1;
    try {
      return await work();
    } finally {
      inFlight -= 1;
      if (inFlight === 0) idle.resolve();
    }
  };

  const applyObservability = (contexts: WorkerContexts): void => {
    const observability = contexts.get(CoreContexts.observability);
    if (observability === undefined || options.telemetry !== undefined) return;
    if (observability.defaultLevel !== undefined) telemetry.setLevel('*', observability.defaultLevel);
    for (const [subsystem, level] of Object.entries(observability.levels ?? {})) {
      telemetry.setLevel(subsystem as Subsystem, level as LevelName);
    }
  };

  const onHello = async (hello: HelloMessage): Promise<Result<ReadyMessage>> => {
    if (runtime !== undefined) return err(InvalidEnvelopeError({ message: 'Duplicate hello.' }));
    if (hello.protocol.id !== options.protocol.id || hello.protocol.version !== options.protocol.version) {
      const mismatch = ProtocolMismatchError({
        details: { expected: `${options.protocol.id}@${options.protocol.version}`, received: `${hello.protocol.id}@${hello.protocol.version}` },
      });
      done.resolve(err(mismatch));
      return err(mismatch);
    }
    epoch = hello.epoch;
    paused = hello.paused;
    link.setEpoch(epoch);
    const contexts = createWorkerContexts(hello.contexts);
    contexts.attach(link, scope);
    const missing = (options.contexts ?? []).filter((key) => !contexts.has(key)).map((key) => key.id);
    if (missing.length > 0) {
      const error = NoHandlerError({ message: `Worker requires core contexts that were not replicated: ${missing.join(', ')}.`, details: { missing: missing.join(',') } });
      done.resolve(err(error));
      return err(error);
    }
    applyObservability(contexts);
    const traceparent = contexts.get(CoreContexts.observability)?.traceparent;
    const created: WorkerRuntime<P> = {
      workerId: hello.workerId,
      attempt: hello.attempt,
      get epoch() {
        return epoch;
      },
      get paused() {
        return paused;
      },
      contexts,
      rehydrate: hello.rehydrate,
      parent: traceparent === undefined ? undefined : parseTraceparent(traceparent),
      link,
      scope,
      telemetry,
      broker: createBrokerClient(link),
      emit(name, payload, sendOptions) {
        if (server === undefined) return err(NoHandlerError({ message: 'Worker is not ready yet.' }));
        return server.emit(name, payload, sendOptions);
      },
      publish(publisher) {
        publisher.attach(link, scope);
      },
      async replicate(definition, replicaOptions) {
        const replica = createReplica(definition, replicaOptions);
        const attached = await replica.attach(link, scope);
        return attached.ok ? ok(replica) : attached;
      },
    };
    runtime = created;

    let handlers: WorkerHandlers<P>;
    if (isHandlerRecord(options.handlers)) handlers = options.handlers;
    else {
      const built = await options.handlers(created);
      if (isResult(built)) {
        if (!built.ok) {
          done.resolve(built);
          return built;
        }
        handlers = built.value as WorkerHandlers<P>;
      } else handlers = built;
    }
    const wrapped: Record<string, (args: unknown, context: MessageContext) => Promise<Result<unknown>>> = {};
    for (const [name, handler] of Object.entries(handlers) as [string, (args: unknown, context: WorkerHandlerContext<P>) => Result<unknown> | Promise<Result<unknown>>][]) {
      wrapped[name] = (args, context) => track(async () => handler(args, { ...context, runtime: created }));
    }
    server = createProtocolServer(link, options.protocol, wrapped as unknown as Partial<ProtocolHandlers<P>>, {
      validate: options.validate ?? true,
    });
    scope.defer(() => server?.dispose());
    if (options.setup !== undefined) {
      const setup = await options.setup(created);
      if (setup !== undefined && !setup.ok) {
        done.resolve(setup);
        return setup;
      }
    }
    done.resolve(ok(created));
    return ok({ type: 'ready', protocol: { id: options.protocol.id, version: options.protocol.version } });
  };

  link.handle(Channels.control, async (payload) => {
    if (!isControlMessage(payload)) return err(InvalidEnvelopeError({ message: 'Malformed control message.' }));
    const message = payload as ControlMessage;
    switch (message.type) {
      case 'hello':
        return onHello(message);
      case 'ping':
        return ok({ type: 'pong' });
      case 'pause':
        paused = true;
        await options.onPause?.();
        return ok();
      case 'resume':
        paused = false;
        await options.onResume?.();
        return ok();
      case 'refresh':
        epoch = message.epoch;
        link.setEpoch(epoch);
        await options.onRefresh?.(epoch);
        return ok();
      case 'drain': {
        let timer: unknown;
        await Promise.race([
          idle.promise,
          new Promise<void>((resolve) => {
            timer = clock.setTimeout(resolve, options.drainTimeoutMs ?? 5_000);
          }),
        ]);
        clock.clearTimeout(timer);
        await options.onShutdown?.();
        // Close after the response has been posted.
        clock.setTimeout(() => void scope.dispose(), 0);
        return ok();
      }
    }
  });

  return done.promise;
}
