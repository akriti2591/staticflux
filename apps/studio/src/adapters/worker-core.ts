/**
 * Adapter: core contexts (auth session, config flags, gate decisions, platform facts,
 * observability) → @staticflux/worker context hub (R11.1). Every worker receives them
 * in the handshake, before its feature code runs, and gets pushes on change. Tokens
 * never cross: the hub strips secret-looking keys (SF-WK-012).
 *
 * Each context is a `CoreContextsToken` contribution declaring its own deps; the
 * stock `contextHubUnit` collects them. Loaded lazily with the document runtime (the
 * worker package is not on the boot path): `coreContextUnits` are registered into the
 * app injector when the document runtime chunk loads.
 */
import { contribution, formatTraceparent, type Injector, type Registration, type Result } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { FlagResolverToken } from '@staticflux/config';
import { GateToken } from '@staticflux/gate';
import { PlatformFactsToken } from '@staticflux/platform';
import { type ContextHub, ContextHubToken, contextHubUnit, CoreContexts, CoreContextsToken, provideContext, reactiveSource, staticSource } from '@staticflux/worker';

export const sessionContextUnit = contribution({
  id: 'studio/session-context-unit',
  provides: CoreContextsToken,
  scope: 'app',
  deps: { required: { session: SessionToken } },
  create: ({ session }) =>
    provideContext(CoreContexts.session, reactiveSource(() => ({ status: session.state, ...(session.principal === undefined ? {} : { userId: session.principal.id }) }))),
});

export const userContextUnit = contribution({
  id: 'studio/user-context-unit',
  provides: CoreContextsToken,
  scope: 'app',
  deps: { required: { session: SessionToken } },
  create: ({ session }) =>
    provideContext(CoreContexts.user, reactiveSource(() => (session.principal === undefined ? null : { id: session.principal.id, name: session.principal.displayName ?? '' }))),
});

export const flagsContextUnit = contribution({
  id: 'studio/flags-context-unit',
  provides: CoreContextsToken,
  scope: 'app',
  deps: { required: { flags: FlagResolverToken } },
  create: ({ flags }) =>
    provideContext(
      CoreContexts.flags,
      reactiveSource(() => {
        const values: Record<string, unknown> = {};
        for (const flag of flags.flags()) values[flag.key] = flags.value(flag);
        return values;
      }),
    ),
});

export const decisionsContextUnit = contribution({
  id: 'studio/decisions-context-unit',
  provides: CoreContextsToken,
  scope: 'app',
  deps: { required: { gate: GateToken } },
  create: ({ gate }) =>
    provideContext(
      CoreContexts.decisions,
      reactiveSource(() => {
        const version = gate.version; // tracked: recompiles push a fresh table
        const snapshot = gate.snapshot();
        return { version, facts: snapshot.facts.map(([id, value]) => [id, value]), decisions: snapshot.decisions.map(([key, d]) => [key, d.effect]) };
      }),
    ),
});

export const platformContextUnit = contribution({
  id: 'studio/platform-context-unit',
  provides: CoreContextsToken,
  scope: 'app',
  deps: { required: { platform: PlatformFactsToken } },
  create: ({ platform }) => provideContext(CoreContexts.platform, reactiveSource(() => JSON.parse(JSON.stringify(platform.current)) as Record<string, unknown>)),
});

export const observabilityContextUnit = contribution({
  id: 'studio/observability-context-unit',
  provides: CoreContextsToken,
  scope: 'app',
  create: (_deps, ctx) => {
    const parent = ctx.span.context;
    return provideContext(CoreContexts.observability, staticSource({ defaultLevel: 'standard' as const, ...(parent === undefined ? {} : { traceparent: formatTraceparent(parent) }) }));
  },
});

/** The hub and every core context (registered when the document runtime chunk loads). */
export const coreContextUnits: readonly Registration[] = [
  sessionContextUnit,
  userContextUnit,
  flagsContextUnit,
  decisionsContextUnit,
  platformContextUnit,
  observabilityContextUnit,
  contextHubUnit({ id: 'studio/context-hub-unit' }),
];

/** Register the core contexts + hub into `injector` (once) and resolve the hub. */
export async function resolveCoreContextHub(injector: Injector, signal?: AbortSignal): Promise<Result<ContextHub>> {
  if (injector.stateOf(ContextHubToken) === 'unresolved') {
    const registered = injector.register(...coreContextUnits);
    if (!registered.ok) return registered;
  }
  return injector.get(ContextHubToken, signal);
}
