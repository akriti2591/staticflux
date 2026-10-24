/**
 * DI units for @staticflux/sandbox.
 *
 *   createInjector({ units: [...capabilityUnits, pluginHostUnit({ options: () => ({ realms: { iframe: iframeRealm() } }) })] })
 *
 * Feature-scoped plugins load on activation and unload with the feature:
 *
 *   pluginUnit({ id: 'studio/word-count-plugin', provides: WordCountPluginToken, manifest, slot: () => slotElement })
 */
import { CapabilityRegistryToken } from '@staticflux/capabilities';
import { type ScopeLevel, type Token, type TokenId, token, unit, type UnitContext, type UnitDefinition } from '@staticflux/core';
import { createPluginHost, type LoadOptions, type PluginHost, type PluginHostOptions, type PluginInstance } from './host.js';

export const PluginHostToken = token('sandbox/plugin-host').type<PluginHost>();

export interface PluginHostUnitOptions {
  readonly id?: TokenId;
  /** Everything but the registry (from `CapabilityRegistryToken`) and telemetry (the unit's). */
  readonly options: (context: UnitContext) => Omit<PluginHostOptions, 'registry'>;
}

export function pluginHostUnit(
  options: PluginHostUnitOptions,
): UnitDefinition<PluginHost, { readonly required: { readonly registry: typeof CapabilityRegistryToken } }, 'sandbox/plugin-host'> {
  return unit({
    id: options.id ?? 'sandbox/plugin-host-unit',
    provides: PluginHostToken,
    scope: 'app',
    deps: { required: { registry: CapabilityRegistryToken } },
    description: 'Hosts untrusted plugins in isolated realms; they reach the app only through granted capabilities (R3.4).',
    create: ({ registry }, context) => {
      const host = createPluginHost({ telemetry: context.telemetry, ...options.options(context), registry });
      context.scope.defer(() => host.dispose());
      return host;
    },
  });
}

export interface PluginUnitOptions<Id extends TokenId> {
  readonly id: TokenId;
  readonly provides: Token<PluginInstance, Id>;
  /** The (untrusted) manifest, validated at create. */
  readonly manifest: unknown;
  /** Default `feature`. */
  readonly scope?: ScopeLevel;
  readonly slot?: (context: UnitContext) => Element | undefined;
  readonly grants?: LoadOptions['grants'];
}

/** A plugin instance: registered at create, running after init, stopped with the unit scope. */
export function pluginUnit<const Id extends TokenId>(
  options: PluginUnitOptions<Id>,
): UnitDefinition<PluginInstance, { readonly required: { readonly host: typeof PluginHostToken } }, Id> {
  return unit({
    id: options.id,
    provides: options.provides,
    scope: options.scope ?? 'feature',
    deps: { required: { host: PluginHostToken } },
    create: ({ host }, context) => {
      const slot = options.slot?.(context);
      const registered = host.register(options.manifest, {
        ...(slot === undefined ? {} : { slot }),
        ...(options.grants === undefined ? {} : { grants: options.grants }),
      });
      if (!registered.ok) throw registered.error;
      const instance = registered.value;
      context.scope.defer(() => instance.stop());
      return instance;
    },
    init: (instance, context) => instance.start(context.signal),
  });
}
