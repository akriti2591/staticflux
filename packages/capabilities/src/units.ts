/**
 * DI tokens and units for @staticflux/capabilities.
 *
 *   createInjector({ units: [...capabilityUnits, insertImageDeclarationUnit] })
 *
 * Ports default to standalone behaviour (allow all, fail-closed confirm, no
 * metering, always active). Plug the real ones in by registering a unit for the
 * port token after these (or with `bind(unit, { precedence: 'app' })`):
 *
 *   unit({ id: 'app/capability-decide', provides: CapabilityDecidePortToken, scope: 'app',
 *          deps: { required: { gate: GateToken } },
 *          create: ({ gate }) => decidePort(({ capability, subject }) => gateToCapabilityDecision(
 *            gate.decide('capability', capability.policy.resource, …, { subject }))) })
 *
 * Feature-scoped implementations register at activation:
 *
 *   unit({ id: 'studio/capabilities', scope: 'feature', provides: StudioCapabilitiesToken,
 *          deps: { required: { registry: CapabilityRegistryToken, doc: DocumentStoreToken } },
 *          create: ({ registry, doc }, ctx) => provideCapabilities(registry, [insertImage(doc)], ctx.scope) })
 */
import { contribution, type Result, type Scope, token, unit } from '@staticflux/core';
import type {
  AnyCapability,
  AnyCapabilityImplementation,
  CapabilityConfirmPort,
  CapabilityDecidePort,
  CapabilityMeterPort,
  FeatureActivationPort,
} from './capability.js';
import { allowAllDecidePort, alwaysActivePort, failClosedConfirmPort, unmeteredPort } from './ports.js';
import { CapabilityMetrics, type CapabilityRegistry, createCapabilityRegistry } from './registry.js';

export const CapabilityDeclarationsToken = token('capabilities/declarations').multi<AnyCapability>();
export const CapabilityImplementationsToken = token('capabilities/implementations').multi<AnyCapabilityImplementation>();
export const CapabilityDecidePortToken = token('capabilities/decide-port').type<CapabilityDecidePort>();
export const CapabilityConfirmPortToken = token('capabilities/confirm-port').type<CapabilityConfirmPort>();
export const CapabilityMeterPortToken = token('capabilities/meter-port').type<CapabilityMeterPort>();
export const FeatureActivationPortToken = token('capabilities/activation-port').type<FeatureActivationPort>();
export const CapabilityRegistryToken = token('capabilities/registry').type<CapabilityRegistry>();

export const allowAllDecidePortUnit = unit({
  id: 'capabilities/allow-all-decide-unit',
  provides: CapabilityDecidePortToken,
  scope: 'app',
  create: () => allowAllDecidePort,
  description: 'Default: no gate bound. Replace with a gate adapter. Client gating is UX, not security.',
});

export const failClosedConfirmPortUnit = unit({
  id: 'capabilities/fail-closed-confirm-unit',
  provides: CapabilityConfirmPortToken,
  scope: 'app',
  create: () => failClosedConfirmPort,
  description: 'Default: refuses every confirmation (SF-CAP-005). Replace with a messaging confirm dialog.',
});

export const unmeteredPortUnit = unit({
  id: 'capabilities/unmetered-unit',
  provides: CapabilityMeterPortToken,
  scope: 'app',
  create: () => unmeteredPort,
  description: 'Default: no metering. Replace with a gate meter adapter.',
});

export const alwaysActivePortUnit = unit({
  id: 'capabilities/always-active-unit',
  provides: FeatureActivationPortToken,
  scope: 'app',
  create: () => alwaysActivePort,
  description: 'Default: no feature host. Replace with a runtime feature-host adapter.',
});

export const capabilityRegistryUnit = unit({
  id: 'capabilities/registry-unit',
  provides: CapabilityRegistryToken,
  scope: 'app',
  deps: {
    required: {
      decide: CapabilityDecidePortToken,
      confirm: CapabilityConfirmPortToken,
      meter: CapabilityMeterPortToken,
      activation: FeatureActivationPortToken,
      declarations: CapabilityDeclarationsToken,
      implementations: CapabilityImplementationsToken,
    },
  },
  informs: Object.values(CapabilityMetrics),
  create: (deps, ctx) => {
    const registry = createCapabilityRegistry({ ...deps, telemetry: ctx.telemetry });
    ctx.scope.defer(() => registry.dispose());
    return registry;
  },
  description: 'Capability registry + the single invoke pipeline (UI, palette, agents, WebMCP).',
});

/** One-line opt-in: default ports + registry. */
export const capabilityUnits = [
  allowAllDecidePortUnit,
  failClosedConfirmPortUnit,
  unmeteredPortUnit,
  alwaysActivePortUnit,
  capabilityRegistryUnit,
] as const;

/** Contribute a declaration (manifest data; no implementation code needed). */
export function capabilityDeclarationUnit(capability: AnyCapability, order?: number) {
  return contribution({
    id: `${capability.id}#declaration`,
    provides: CapabilityDeclarationsToken,
    scope: 'app',
    ...(order === undefined ? {} : { order }),
    create: () => capability,
  });
}

/** Contribute an app-lifetime implementation without dependencies. Use `contribution()` directly when it needs deps. */
export function capabilityImplementationUnit(implementation: AnyCapabilityImplementation) {
  return contribution({
    id: `${implementation.capability.id}#implementation`,
    provides: CapabilityImplementationsToken,
    scope: 'app',
    create: () => implementation,
  });
}

export interface ProvidedCapabilities {
  readonly ids: readonly string[];
}

/**
 * Register implementations for the lifetime of `scope` (feature activation scope).
 * Fails as a whole on the first conflict (already registered ones are rolled back).
 */
export function provideCapabilities(
  registry: CapabilityRegistry,
  implementations: readonly AnyCapabilityImplementation[],
  scope: Scope,
): Result<ProvidedCapabilities> {
  const undo: (() => void)[] = [];
  for (const implementation of implementations) {
    const provided = registry.provide(implementation);
    if (!provided.ok) {
      for (const fn of undo.reverse()) fn();
      return provided;
    }
    undo.push(provided.value);
  }
  for (const fn of undo) scope.defer(fn);
  return { ok: true, value: { ids: implementations.map((i) => i.capability.id) } };
}
