/**
 * Adapter: @staticflux/capabilities ports ← @staticflux/gate (decisions + meters).
 *
 * - decide: `gate.decide('capability', policy.resource, action?, { subject })`; the
 *   agent subject stays distinct (R6.17), allow-with-cost carries the policy cost.
 * - meter: `meters.get(meter).reserve(amount)` → commit(actual) | release (R6.18).
 */
import { err, ok, unit } from '@staticflux/core';
import {
  capabilityDecisionFrom,
  type CapabilityDecidePort,
  CapabilityDecidePortToken,
  type CapabilityMeterPort,
  CapabilityMeterPortToken,
} from '@staticflux/capabilities';
import { defineAction, GateToken, MeterRegistryToken } from '@staticflux/gate';
import { CreditsMeter } from '../app/contracts.js';

const METERS = { [CreditsMeter.id]: CreditsMeter } as const;

export const gateCapabilityDecideUnit = unit({
  id: 'studio/gate-capability-decide-unit',
  provides: CapabilityDecidePortToken,
  scope: 'app',
  deps: { required: { gate: GateToken } },
  create: ({ gate }): CapabilityDecidePort => ({
    decide({ capability, subject }) {
      const action = capability.policy.action === undefined ? undefined : defineAction(capability.policy.action as `${string}/${string}`, { destructive: capability.destructive });
      const decision = gate.decide('capability', capability.policy.resource, action, { subject: subject === 'agent' ? 'agent' : 'principal' });
      return capabilityDecisionFrom(decision);
    },
  }),
  description: 'Capability authorization through the gate (agent subject distinct).',
});

export const gateCapabilityMeterUnit = unit({
  id: 'studio/gate-capability-meter-unit',
  provides: CapabilityMeterPortToken,
  scope: 'app',
  deps: { required: { meters: MeterRegistryToken } },
  create: ({ meters }): CapabilityMeterPort => ({
    async reserve(cost, signal) {
      const def = METERS[cost.meter as keyof typeof METERS];
      if (def === undefined) return ok({ commit: () => Promise.resolve(ok()), release: () => Promise.resolve(ok()) });
      const meter = meters.get(def);
      if (!meter.ok) return err(meter.error);
      const reservation = await meter.value.reserve(cost.amount, { signal });
      if (!reservation.ok) return err(reservation.error);
      return ok({
        commit: (actual, s) => reservation.value.commit(actual, s),
        release: (s) => reservation.value.release(s),
      });
    },
  }),
  description: 'Capability metering through gate meter reservations.',
});
