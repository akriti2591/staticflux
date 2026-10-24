/**
 * DI units: apps register these instead of wiring workers by hand.
 *
 * @example
 * export const DocWorkerToken = token('studio/document-worker').type<SupervisedWorker<typeof DocProtocol>>();
 * const docWorkerUnit = supervisedWorkerUnit({
 *   id: 'studio/document-worker-unit',
 *   provides: DocWorkerToken,
 *   spec: () => ({ id: 'studio/document-worker', protocol: DocProtocol, spawn, fallback }),
 * });
 */
import {
  type ScopeLevel,
  type Token,
  type TokenId,
  token,
  unit,
  type UnitContext,
  type UnitDefinition,
} from '@staticflux/core';
import { type ContextEntry, type ContextHub, createContextHub } from './context.js';
import type { AnyProtocol } from './protocol.js';
import { createSupervisedWorker, type SupervisedWorker, type WorkerSpec } from './supervisor.js';
import { createTokenBroker, type TokenBroker, type TokenBrokerOptions } from './broker.js';

export const ContextHubToken = token('worker/context-hub').type<ContextHub>();
export const TokenBrokerToken = token('worker/token-broker').type<TokenBroker>();

export interface SupervisedWorkerUnitOptions<P extends AnyProtocol, Id extends TokenId> {
  readonly id: TokenId;
  readonly provides: Token<SupervisedWorker<P>, Id>;
  /** Default `app`. */
  readonly scope?: ScopeLevel;
  readonly critical?: boolean;
  readonly description?: string;
  /** Build the spec; the unit's telemetry is used unless the spec sets one. */
  readonly spec: (context: UnitContext) => WorkerSpec<P>;
}

/**
 * A unit providing a supervised worker. `init` starts it (ready = handshake +
 * replica sync done); the unit's scope stops it (drain → terminated).
 * A worker that gives up fails `init` with SF-WK-005 after activating its fallback.
 */
export function supervisedWorkerUnit<P extends AnyProtocol, const Id extends TokenId>(
  options: SupervisedWorkerUnitOptions<P, Id>,
): UnitDefinition<SupervisedWorker<P>, Record<never, never>, Id> {
  return unit<SupervisedWorker<P>, Record<never, never>, Id>({
    id: options.id,
    provides: options.provides,
    scope: options.scope ?? 'app',
    ...(options.critical === undefined ? {} : { critical: options.critical }),
    ...(options.description === undefined ? {} : { description: options.description }),
    create: (_deps, context) => {
      const spec = options.spec(context);
      const worker = createSupervisedWorker({ telemetry: context.telemetry, ...spec });
      context.scope.defer(async () => {
        await worker.stop('scope disposed');
      });
      return worker;
    },
    init: (worker, context) => worker.start({ signal: context.signal, epoch: context.epoch }),
  });
}

/** A unit providing the core-context hub (entries built from the unit context). */
export function contextHubUnit(options: {
  readonly id: TokenId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly entries: (context: UnitContext) => readonly ContextEntry<any>[];
}): UnitDefinition<ContextHub, Record<never, never>, 'worker/context-hub'> {
  return unit<ContextHub, Record<never, never>, 'worker/context-hub'>({
    id: options.id,
    provides: ContextHubToken,
    scope: 'app',
    create: (_deps, context) => {
      const hub = createContextHub({ entries: options.entries(context), telemetry: context.telemetry });
      context.scope.defer(() => hub.dispose());
      return hub;
    },
  });
}

/** A unit providing the token broker (session-scoped by default: credentials live there). */
export function tokenBrokerUnit(options: {
  readonly id: TokenId;
  readonly scope?: ScopeLevel;
  readonly broker: (context: UnitContext) => TokenBrokerOptions;
}): UnitDefinition<TokenBroker, Record<never, never>, 'worker/token-broker'> {
  return unit<TokenBroker, Record<never, never>, 'worker/token-broker'>({
    id: options.id,
    provides: TokenBrokerToken,
    scope: options.scope ?? 'session',
    create: (_deps, context) => createTokenBroker(options.broker(context)),
  });
}
