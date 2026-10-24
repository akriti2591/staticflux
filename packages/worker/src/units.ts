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
import { DuplicateContextError } from './errors.js';

export const ContextHubToken = token('worker/context-hub').type<ContextHub>();
export const TokenBrokerToken = token('worker/token-broker').type<TokenBroker>();
/**
 * Core-context entries for the hub, one contribution per context (R11.1). Each
 * contribution declares its own deps, so sources are injected services:
 *
 * @example
 * const sessionContextUnit = contribution({
 *   id: 'app/session-context',
 *   provides: CoreContextsToken,
 *   scope: 'app',
 *   deps: { required: { session: SessionToken } },
 *   create: ({ session }) => provideContext(CoreContexts.session, reactiveSource(() => ({ status: session.state }))),
 * });
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CoreContextsToken = token('worker/core-contexts').multi<ContextEntry<any>>();

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

export interface ContextHubUnitOptions {
  /** Default `worker/context-hub-unit`. */
  readonly id?: TokenId;
  /** Extra entries built from the unit context (in addition to `CoreContextsToken` contributions). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly entries?: (context: UnitContext) => readonly ContextEntry<any>[];
}

export type ContextHubUnit = UnitDefinition<
  ContextHub,
  { readonly required: { readonly contributed: typeof CoreContextsToken } },
  'worker/context-hub'
>;

/**
 * A unit providing the core-context hub. Entries are every `CoreContextsToken`
 * contribution (each with its own deps) plus `options.entries(context)`. A key
 * contributed twice fails creation with SF-WK-031.
 */
export function contextHubUnit(options: ContextHubUnitOptions = {}): ContextHubUnit {
  return unit({
    id: options.id ?? 'worker/context-hub-unit',
    provides: ContextHubToken,
    scope: 'app',
    deps: { required: { contributed: CoreContextsToken } },
    create: ({ contributed }, context) => {
      const entries = [...contributed, ...(options.entries?.(context) ?? [])];
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.key.id)) throw DuplicateContextError({ details: { context: entry.key.id } });
        seen.add(entry.key.id);
      }
      const hub = createContextHub({ entries, telemetry: context.telemetry });
      context.scope.defer(() => hub.dispose());
      return hub;
    },
    description: 'Core-context hub over CoreContextsToken contributions (R11.1).',
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
