/**
 * Spec gating through `@staticflux/gate`: the `DecidePort` the spec runtime asks for every slot, per
 * proposer subject. A spec an agent proposes is gated as the agent (R6.17: principal ∧ agent policies),
 * one a person or a preset applies as the principal. Decisions are synchronous table lookups (R6.9).
 * Client gating is UX, not security (R6.16): the capability pipeline and the server check again.
 */
import { type Gate, GATE_LEVELS, type GateLevel } from '@staticflux/gate';
import type { DecidePort, GateVerdict } from '@staticflux/ui';

export type SpecSubject = 'principal' | 'agent';

const isGateLevel = (level: string): level is GateLevel => (GATE_LEVELS as readonly string[]).includes(level);

/** A `DecidePort` over the gate for one subject. Unknown levels are denied as `unavailable`. */
export function gateSpecDecide(gate: Gate, subject: SpecSubject = 'principal'): DecidePort {
  return {
    decide(resource): GateVerdict {
      if (!isGateLevel(resource.level)) return { effect: 'deny', reason: 'unavailable', code: 'SF-GATE-001' };
      const decision = gate.decide(resource.level, resource.id, undefined, { subject });
      return decision.effect === 'allow' ? { effect: 'allow' } : { effect: 'deny', reason: decision.reason };
    },
  };
}
