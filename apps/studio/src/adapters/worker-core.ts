/**
 * Adapter: core contexts (auth session, config flags, gate decisions, platform facts,
 * observability) → @staticflux/worker context hub (R11.1). Every worker receives them
 * in the handshake, before its feature code runs, and gets pushes on change. Tokens
 * never cross: the hub strips secret-looking keys (SF-WK-012).
 *
 * Loaded lazily with the document runtime (the worker package is not on the boot path).
 * PACKAGE GAP (reported): worker's `contextHubUnit` builds entries from the unit
 * context only (no `deps`), so the sources cannot be injected; this is the same thing
 * as a plain factory over the injected services.
 */
import { formatTraceparent, type Scope, type Span, type Telemetry } from '@staticflux/core';
import type { SessionStore } from '@staticflux/auth';
import type { FlagResolver } from '@staticflux/config';
import type { Gate } from '@staticflux/gate';
import type { PlatformFactsSource } from '@staticflux/platform';
import { type ContextHub, CoreContexts, createContextHub, provideContext, reactiveSource, staticSource } from '@staticflux/worker';

export interface CoreContextSources {
  readonly session: SessionStore;
  readonly flags: FlagResolver;
  readonly gate: Gate;
  readonly platform: PlatformFactsSource;
  readonly telemetry: Telemetry;
  readonly span: Span;
  readonly scope: Scope;
}

export function createCoreContextHub({ session, flags, gate, platform, telemetry, span, scope }: CoreContextSources): ContextHub {
  {
    const parent = span.context;
    const hub = createContextHub({
      telemetry,
      entries: [
        provideContext(CoreContexts.session, reactiveSource(() => ({ status: session.state, ...(session.principal === undefined ? {} : { userId: session.principal.id }) }))),
        provideContext(CoreContexts.user, reactiveSource(() => (session.principal === undefined ? null : { id: session.principal.id, name: session.principal.displayName ?? '' }))),
        provideContext(
          CoreContexts.flags,
          reactiveSource(() => {
            const values: Record<string, unknown> = {};
            for (const flag of flags.flags()) values[flag.key] = flags.value(flag);
            return values;
          }),
        ),
        provideContext(
          CoreContexts.decisions,
          reactiveSource(() => {
            const version = gate.version; // tracked: recompiles push a fresh table
            const snapshot = gate.snapshot();
            return { version, facts: snapshot.facts.map(([id, value]) => [id, value]), decisions: snapshot.decisions.map(([key, d]) => [key, d.effect]) };
          }),
        ),
        provideContext(CoreContexts.platform, reactiveSource(() => JSON.parse(JSON.stringify(platform.current)) as Record<string, unknown>)),
        provideContext(CoreContexts.observability, staticSource({ defaultLevel: 'standard' as const, ...(parent === undefined ? {} : { traceparent: formatTraceparent(parent) }) })),
      ],
    });
    scope.defer(() => hub.dispose());
    return hub;
  }
}
