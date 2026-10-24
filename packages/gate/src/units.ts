/**
 * DI tokens and units for @staticflux/gate.
 *
 *   createInjector({ units: [...gateUnits, studioPoliciesUnit, sessionFactsUnit] })
 *
 * Packages contribute policy sets (PolicySetsToken), fact sources (FactSourcesToken)
 * and meter definitions (MeterDefinitionsToken). Bind a real MeterBackend to replace
 * `localMeterBackendUnit` (app precedence wins over the default).
 *
 * Client gating is UX, not security (R6.16).
 */
import { contribution, token, unit } from '@staticflux/core';
import { type Gate, GateMetrics, createGate } from './engine.js';
import { type FactSource, type GateClock, systemGateClock } from './facts.js';
import { type MeterBackend, type MeterDef, MeterMetrics, type MeterRegistry, createMeterRegistry, localMeterBackend } from './meters.js';
import type { PolicySet } from './policy.js';

export const PolicySetsToken = token('gate/policy-sets').multi<PolicySet>();
export const FactSourcesToken = token('gate/fact-sources').multi<FactSource>();
export const MeterDefinitionsToken = token('gate/meter-definitions').multi<MeterDef>();
export const MeterBackendToken = token('gate/meter-backend').type<MeterBackend>();
export const GateClockToken = token('gate/clock').type<GateClock>();
export const MeterRegistryToken = token('gate/meters').type<MeterRegistry>();
export const GateToken = token('gate/engine').type<Gate>();

export const systemGateClockUnit = unit({
  id: 'gate/system-clock-unit',
  provides: GateClockToken,
  scope: 'app',
  create: () => systemGateClock,
});

export const localMeterBackendUnit = unit({
  id: 'gate/local-meter-backend-unit',
  provides: MeterBackendToken,
  scope: 'app',
  create: () => localMeterBackend(),
  description: 'Client-only meter backend (no server). Replace with the credit-model plugin.',
});

export const meterRegistryUnit = unit({
  id: 'gate/meter-registry-unit',
  provides: MeterRegistryToken,
  scope: 'app',
  deps: { required: { definitions: MeterDefinitionsToken, backend: MeterBackendToken, clock: GateClockToken } },
  informs: Object.values(MeterMetrics),
  create: ({ definitions, backend, clock }, ctx) => {
    const registry = createMeterRegistry({ definitions, backend, clock, telemetry: ctx.telemetry });
    ctx.scope.defer(() => registry.dispose());
    return registry;
  },
});

export function createGateUnit(config: { readonly unmatched?: 'allow' | 'deny' } = {}) {
  return unit({
    id: 'gate/engine-unit',
    provides: GateToken,
    scope: 'app',
    deps: { required: { policySets: PolicySetsToken, sources: FactSourcesToken, meters: MeterRegistryToken } },
    informs: Object.values(GateMetrics),
    create: ({ policySets, sources, meters }, ctx) => {
      const gate = createGate({ ...config, policySets, sources, meters, telemetry: ctx.telemetry });
      ctx.scope.defer(() => gate.dispose());
      return gate;
    },
    description: 'Compiled, reactive, explainable decisions. UX only — the server re-checks everything (R6.16).',
  });
}

export const gateUnit = createGateUnit();

/**
 * One-line opt-in: clock + default (local) meter backend + meter registry + gate.
 * Override the backend/clock by registering your unit after these, or with
 * `bind(unit, { precedence: 'app' })`.
 */
export const gateUnits = [systemGateClockUnit, localMeterBackendUnit, meterRegistryUnit, gateUnit] as const;

/** Contribute a policy set (multi token). */
export function policySetUnit(id: `${string}/${string}`, set: PolicySet) {
  return contribution({ id, provides: PolicySetsToken, scope: 'app', create: () => set });
}

/** Contribute a fact source (multi token). */
export function factSourceUnit(id: `${string}/${string}`, create: () => FactSource) {
  return contribution({ id, provides: FactSourcesToken, scope: 'app', create: () => create() });
}

/** Contribute a meter definition (multi token). */
export function meterDefinitionUnit(id: `${string}/${string}`, meter: MeterDef) {
  return contribution({ id, provides: MeterDefinitionsToken, scope: 'app', create: () => meter });
}
