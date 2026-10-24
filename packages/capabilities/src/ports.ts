/**
 * Default port implementations. They let the registry work standalone (tests,
 * small apps) and are replaced by real plugins: gate → decide, messaging →
 * confirm, gate meters → meter, runtime feature host → activation.
 */
import { err, ok } from '@staticflux/core';
import type {
  CapabilityConfirmPort,
  CapabilityDecidePort,
  CapabilityDecision,
  CapabilityMeterPort,
  DecisionRequest,
  FeatureActivationPort,
  MeterLease,
} from './capability.js';
import { NoConfirmerError } from './errors.js';

/**
 * Allows every call (no gate bound). Destructive non-user calls still require
 * confirmation through the confirm port, which fails closed by default.
 */
export const allowAllDecidePort: CapabilityDecidePort = {
  decide: (): CapabilityDecision => ({ effect: 'allow' }),
};

/** Build a decide port from a plain function (e.g. an adapter over the gate engine). */
export function decidePort(decide: (request: DecisionRequest) => CapabilityDecision | Promise<CapabilityDecision>): CapabilityDecidePort {
  return { decide };
}

/** Fails closed: anything that needs confirmation is refused until a real confirmer is bound. */
export const failClosedConfirmPort: CapabilityConfirmPort = {
  confirm: (request) =>
    Promise.resolve(err(NoConfirmerError({ details: { capability: request.capability.id, reason: request.reason } }))),
};

const NOOP_LEASE: MeterLease = {
  commit: () => Promise.resolve(ok()),
  release: () => Promise.resolve(ok()),
};

/** No metering: reservations always succeed and cost nothing. */
export const unmeteredPort: CapabilityMeterPort = {
  reserve: () => Promise.resolve(ok(NOOP_LEASE)),
};

/** Features are always active (no feature host bound). */
export const alwaysActivePort: FeatureActivationPort = {
  ensureActive: () => Promise.resolve(ok(undefined)),
};

/** Structural shape of a gate decision (no import of @staticflux/gate — layers stay independent). */
export type GateLikeDecision =
  | {
      readonly effect: 'allow';
      readonly cost?: { readonly meter: string; readonly amount: number } | undefined;
      readonly requiresConfirmation?: boolean;
    }
  | { readonly effect: 'deny'; readonly reason: CapabilityDenyReason; readonly meta?: Readonly<Record<string, unknown>> };

type CapabilityDenyReason = Extract<CapabilityDecision, { effect: 'deny' }>['reason'];

/** Convert a gate `Decision` into a capability decision (for a decide-port adapter). */
export function capabilityDecisionFrom(decision: GateLikeDecision): CapabilityDecision {
  if (decision.effect === 'deny') {
    return decision.meta === undefined
      ? { effect: 'deny', reason: decision.reason }
      : { effect: 'deny', reason: decision.reason, meta: decision.meta };
  }
  return {
    effect: 'allow',
    requiresConfirmation: decision.requiresConfirmation === true,
    ...(decision.cost === undefined ? {} : { cost: { meter: decision.cost.meter, amount: decision.cost.amount } }),
  };
}
