/**
 * DI surface of @staticflux/config. Layers, flag declarations and hooks are
 * multi-token contributions; the evaluation context is a port the app fills
 * (from session + platform facts) without this package importing either.
 */
import { type AnyUnit, token, type TokenId, unit } from '@staticflux/core';
import type { FlagBinder } from './bindings.js';
import { type EvaluationContextSource, staticContext } from './context.js';
import type { AnyFlag } from './flag.js';
import type { FlagHook } from './hooks.js';
import type { FlagLayerProvider } from './layer.js';
import { createFlagResolver, type FlagResolver } from './resolver.js';

export const FlagResolverToken = token('config/flags').type<FlagResolver>();
export const FlagLayersToken = token('config/layers').multi<FlagLayerProvider>();
export const FlagDefinitionsToken = token('config/flag-definitions').multi<AnyFlag>();
export const FlagHooksToken = token('config/hooks').multi<FlagHook>();
export const EvaluationContextToken = token('config/evaluation-context').type<EvaluationContextSource>();
export const FlagBinderToken = token('config/flag-binder').type<FlagBinder>();

export interface FlagResolverUnitOptions {
  readonly initTimeoutMs?: number;
  readonly domain?: string;
}

/** The resolver. Critical: variant bindings and pre-auth flags are read during boot. */
export function flagResolverUnit(options: FlagResolverUnitOptions = {}): AnyUnit {
  const resolverUnit = unit({
    id: 'config/flag-resolver-unit',
    provides: FlagResolverToken,
    scope: 'app',
    critical: true,
    deps: {
      required: {
        layers: FlagLayersToken,
        definitions: FlagDefinitionsToken,
        hooks: FlagHooksToken,
        context: EvaluationContextToken,
      },
    },
    description: 'Layered, reactive flag resolution with per-flag evaluation traces.',
    create: ({ layers, definitions, hooks, context }, ctx) => {
      const resolver = createFlagResolver({
        providers: layers,
        flags: definitions,
        hooks,
        context,
        telemetry: ctx.telemetry,
        ...(options.initTimeoutMs === undefined ? {} : { initTimeoutMs: options.initTimeoutMs }),
        ...(options.domain === undefined ? {} : { domain: options.domain }),
      });
      ctx.scope.defer(() => resolver.dispose());
      return resolver;
    },
    init: (resolver, ctx) => resolver.initialize(ctx.signal),
  });
  return resolverUnit;
}

/** Attaches the resolver to a binder so `binder.variants(…)` bindings can read flags. */
export function flagBinderUnit(binder: FlagBinder): AnyUnit {
  const binderUnit = unit({
    id: 'config/flag-binder-unit',
    provides: FlagBinderToken,
    scope: 'app',
    critical: true,
    deps: { required: { flags: FlagResolverToken } },
    create: ({ flags }, ctx) => {
      ctx.scope.defer(binder.attach(flags));
      return binder;
    },
  });
  return binderUnit;
}

/** Anonymous, unauthenticated context (use until the app provides a session-derived one). */
export function evaluationContextUnit(source: EvaluationContextSource = staticContext()): AnyUnit {
  const contextUnit = unit({
    id: 'config/evaluation-context-unit',
    provides: EvaluationContextToken,
    scope: 'app',
    create: () => source,
  });
  return contextUnit;
}

/** Contribute a layer provider. */
export function layerUnit(provider: FlagLayerProvider): AnyUnit {
  const contribution = unit({
    id: `config/layer:${provider.id}` as TokenId,
    provides: FlagLayersToken,
    scope: 'app',
    // Multi-token contributions return one item; the injector collects the list.
    create: () => provider as never,
  });
  return contribution;
}

/** Contribute a package's flag declarations (for devtools inspect, snapshots, duplicate checks). */
export function flagDefinitionUnits(flags: readonly AnyFlag[]): readonly AnyUnit[] {
  return flags.map((flag) => {
    const contribution = unit({
      id: `config/flag:${flag.key}` as TokenId,
      provides: FlagDefinitionsToken,
      scope: 'app',
      create: () => flag as never,
    });
    return contribution;
  });
}

/** Contribute an OpenFeature-shaped hook (telemetry, OTel, audit). */
export function hookUnit(id: TokenId, hook: FlagHook): AnyUnit {
  const contribution = unit({
    id,
    provides: FlagHooksToken,
    scope: 'app',
    create: () => hook as never,
  });
  return contribution;
}

export interface ConfigUnitsOptions extends FlagResolverUnitOptions {
  readonly layers?: readonly FlagLayerProvider[];
  readonly flags?: readonly AnyFlag[];
  /** Pass the app's binder to enable flag-driven variant bindings. */
  readonly binder?: FlagBinder;
  /** Omit when the app registers its own `EvaluationContextToken` unit. */
  readonly context?: EvaluationContextSource | 'app-provided';
}

/** Resolver + layers + declarations (+ binder, + default context). */
export function configUnits(options: ConfigUnitsOptions = {}): readonly AnyUnit[] {
  const resolverOptions: FlagResolverUnitOptions = {
    ...(options.initTimeoutMs === undefined ? {} : { initTimeoutMs: options.initTimeoutMs }),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
  };
  return [
    flagResolverUnit(resolverOptions),
    ...(options.context === 'app-provided' ? [] : [evaluationContextUnit(options.context)]),
    ...(options.layers ?? []).map(layerUnit),
    ...flagDefinitionUnits(options.flags ?? []),
    ...(options.binder === undefined ? [] : [flagBinderUnit(options.binder)]),
  ];
}
