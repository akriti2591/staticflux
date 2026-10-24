/**
 * Adapter: core contexts (auth session, config flags, gate decisions, platform facts,
 * observability) → @staticflux/worker context hub (R11.1). Every worker receives them
 * in the handshake, before its feature code runs, and gets pushes on change. Tokens
 * never cross: the hub strips secret-looking keys (SF-WK-012).
 *
 * PACKAGE GAP (reported): worker's `contextHubUnit` builds entries from the unit
 * context only (no `deps`), so the sources (session, flags, gate, platform) cannot be
 * injected; this unit is the same thing with declared dependencies.
 */
import { formatTraceparent, unit } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { FlagResolverToken } from '@staticflux/config';
import { GateToken } from '@staticflux/gate';
import { PlatformFactsToken } from '@staticflux/platform';
import { ContextHubToken, CoreContexts, createContextHub, provideContext, reactiveSource, staticSource } from '@staticflux/worker';

export const coreContextHubUnit = unit({
  id: 'studio/core-context-hub-unit',
  provides: ContextHubToken,
  scope: 'app',
  deps: { required: { session: SessionToken, flags: FlagResolverToken, gate: GateToken, platform: PlatformFactsToken } },
  create: ({ session, flags, gate, platform }, ctx) => {
    const parent = ctx.span.context;
    const hub = createContextHub({
      telemetry: ctx.telemetry,
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
    ctx.scope.defer(() => hub.dispose());
    return hub;
  },
  description: 'Core contexts replicated to every worker.',
});
