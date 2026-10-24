/**
 * Adapter: @staticflux/gate → @staticflux/ui `DecidePort` (surfaces, workspaces,
 * slots, commands). Decisions are synchronous table lookups (R6.9). UX only (R6.16).
 */
import { unit } from '@staticflux/core';
import { type GateLevel, GATE_LEVELS, GateToken } from '@staticflux/gate';
import { type DecidePort, DecideToken, type GateVerdict } from '@staticflux/ui';

const isGateLevel = (level: string): level is GateLevel => (GATE_LEVELS as readonly string[]).includes(level);

export const gateDecidePortUnit = unit({
  id: 'studio/gate-decide-port-unit',
  provides: DecideToken,
  scope: 'app',
  deps: { required: { gate: GateToken } },
  create: ({ gate }): DecidePort => ({
    decide(resource): GateVerdict {
      if (!isGateLevel(resource.level)) return { effect: 'deny', reason: 'unavailable', code: 'SF-GATE-001' };
      const decision = gate.decide(resource.level, resource.id);
      return decision.effect === 'allow' ? { effect: 'allow' } : { effect: 'deny', reason: decision.reason };
    },
  }),
  description: 'UI gating (surfaces/slots/workspaces) through the gate engine.',
});
