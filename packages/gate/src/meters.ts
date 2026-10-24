/**
 * Meters (R6.18): metered entitlements — credits, tokens, requests, price.
 *
 * - The SERVER balance is authoritative; the client keeps an optimistic view
 *   (`available = balance − held reservations`).
 * - Actions of unknown cost (AI calls): `reserve(estimate) → commit(actual) | release()`,
 *   with expiry. Reservation lifecycle: docs/LIFECYCLES.md §11.
 * - Denials: `quota` (balance meters) / `rate` (rate meters, per window).
 * - Each meter publishes its available balance as a fact (`meter:<id>`), so policies
 *   can reference meters (`covers(meter, amount)`, or a policy `cost`).
 * - Low balance / exhaustion is exposed as reactive `status` for messaging surfaces.
 *
 * Credit models (pricing, top-ups) are plugins behind `MeterBackend`; only primitives live here.
 * Client-side metering is UX: the server must enforce balances (R6.16).
 */
import {
  type Machine,
  type Result,
  type Telemetry,
  box,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  metric,
  ok,
} from '@staticflux/core';
import { QuotaExceededError, RateLimitedError, ReservationStateError, UnknownMeterError } from './errors.js';
import { type FactDef, type FactSink, type FactSource, type GateClock, defineFact, systemGateClock } from './facts.js';
import { type MeterId, meterFactId } from './policy.js';

export interface MeterDef<Id extends MeterId = MeterId> {
  readonly kind: 'meter';
  readonly id: Id;
  /** e.g. `credits`, `tokens`, `requests`, `usd`. */
  readonly unit: string;
  /** `balance`: spendable balance (quota). `rate`: allowance per window (rate). */
  readonly mode: 'balance' | 'rate';
  /** Rate window (rate meters) or accounting period (balance meters). */
  readonly window: { readonly ms: number } | undefined;
  /** Rate meters: allowance restored at each window boundary when the server has not reported yet. */
  readonly limit: number | undefined;
  /** `status` becomes `low` at or below this available amount. */
  readonly lowThreshold: number | undefined;
  /** Default reservation lifetime. */
  readonly reservationTtlMs: number;
}

export function defineMeter<const Id extends MeterId>(
  id: Id,
  options: {
    readonly unit: string;
    readonly mode?: 'balance' | 'rate';
    readonly window?: { readonly ms: number };
    readonly limit?: number;
    readonly lowThreshold?: number;
    readonly reservationTtlMs?: number;
  },
): MeterDef<Id> {
  return Object.freeze({
    kind: 'meter',
    id,
    unit: options.unit,
    mode: options.mode ?? 'balance',
    window: options.window,
    limit: options.limit,
    lowThreshold: options.lowThreshold,
    reservationTtlMs: options.reservationTtlMs ?? 120_000,
  });
}

/** The fact a meter publishes (available balance). */
export function meterFact(meter: MeterDef): FactDef<number> {
  return defineFact(meterFactId(meter.id)).type<number>();
}

export const MeterMetrics = {
  reservations: metric.counter('gate/meter.reservations'),
  denials: metric.counter('gate/meter.denials'),
  committed: metric.counter('gate/meter.committed', { description: 'Sum of committed amounts.' }),
} as const;

// ---------------------------------------------------------------- reservation lifecycle

/**
 *   estimating → reserved → committed | released | expired
 *   estimating → denied (quota | rate)
 *   estimating → released (cancelled before the server answered; extension of §11)
 */
export const reservationMachine = defineMachine({
  id: 'gate/meter-reservation',
  initial: 'estimating',
  states: ['estimating', 'reserved', 'committed', 'released', 'expired', 'denied'],
  transitions: {
    estimating: { reserve: 'reserved', deny: 'denied', cancel: 'released' },
    reserved: { commit: 'committed', release: 'released', expire: 'expired' },
  },
  terminal: ['committed', 'released', 'expired', 'denied'],
});

export type ReservationState = (typeof reservationMachine.states)[number];

/**
 * Server port. Credit models implement it (mocked in tests; `localMeterBackend` for offline demos).
 * Every `balance` returned is the SETTLED balance (committed spend deducted, outstanding
 * holds NOT deducted); the registry subtracts its own holds for the optimistic view.
 */
export interface MeterBackend {
  reserve(
    meter: MeterDef,
    amount: number,
    signal: AbortSignal,
  ): Promise<Result<{ readonly reservationId: string; readonly balance?: number; readonly expiresAt?: number }>>;
  commit(meter: MeterDef, reservationId: string, actual: number, signal: AbortSignal): Promise<Result<{ readonly balance?: number }>>;
  release(meter: MeterDef, reservationId: string, signal: AbortSignal): Promise<Result<{ readonly balance?: number }>>;
}

/** Client-only backend: accepts everything, reports no balances (the registry stays optimistic). */
export function localMeterBackend(): MeterBackend {
  let counter = 0;
  return {
    reserve: () => {
      counter += 1;
      return Promise.resolve(ok({ reservationId: `local-${counter}` }));
    },
    commit: () => Promise.resolve(ok({})),
    release: () => Promise.resolve(ok({})),
  };
}

export interface Reservation {
  readonly id: string;
  readonly meter: MeterId;
  readonly amount: number;
  /** Reactive. */
  readonly state: ReservationState;
  readonly expiresAt: number;
  readonly machine: Machine<ReservationState, 'reserve' | 'deny' | 'cancel' | 'commit' | 'release' | 'expire'>;
  /** Settle with the actual cost (may differ from the estimate). */
  commit(actual: number, signal?: AbortSignal): Promise<Result<void>>;
  release(signal?: AbortSignal): Promise<Result<void>>;
}

export type MeterStatus = 'unknown' | 'ok' | 'low' | 'exhausted';

export interface Meter {
  readonly def: MeterDef;
  /** Last server-reported balance (rate meters: remaining in window). Reactive. */
  readonly balance: number | undefined;
  /** Sum held by live reservations. Reactive. */
  readonly held: number;
  /** Optimistic view: balance − held. Undefined until the server reports. Reactive. */
  readonly available: number | undefined;
  readonly status: MeterStatus;
  /** When the current rate window resets (rate meters). */
  readonly resetAt: number | undefined;
  /** Authoritative update from the server (response headers, push, polling). */
  setServerState(state: { readonly balance: number; readonly resetAt?: number }): void;
  reserve(amount: number, options?: { readonly signal?: AbortSignal; readonly ttlMs?: number }): Promise<Result<Reservation>>;
  readonly reservations: readonly Reservation[];
  onStatusChange(listener: (status: MeterStatus, meter: Meter) => void): () => void;
}

export interface MeterRegistry extends FactSource {
  get(meter: MeterDef): Result<Meter>;
  readonly meters: readonly Meter[];
  readonly modes: ReadonlyMap<MeterId, 'balance' | 'rate'>;
  dispose(): void;
}

export interface MeterRegistryOptions {
  readonly definitions: readonly MeterDef[];
  readonly backend?: MeterBackend;
  readonly clock?: GateClock;
  readonly telemetry?: Telemetry;
}

const SUBSYSTEM = 'gate/meters' as const;

export function createMeterRegistry(options: MeterRegistryOptions): MeterRegistry {
  const backend = options.backend ?? localMeterBackend();
  const clock = options.clock ?? systemGateClock;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const sinks = new Set<FactSink>();
  const meters = new Map<MeterId, Meter>();
  const disposers: (() => void)[] = [];

  const create = (def: MeterDef): Meter => {
    const balanceBox = box<number | undefined>(undefined);
    const heldBox = box(0);
    const resetBox = box<number | undefined>(undefined);
    const live = new Set<Reservation>();
    const statusListeners = new Set<(status: MeterStatus, meter: Meter) => void>();
    const factDef = meterFact(def);
    let lastStatus: MeterStatus = 'unknown';
    let cancelWindow: (() => void) | undefined;

    const available = (): number | undefined => {
      const b = balanceBox.get();
      return b === undefined ? undefined : b - heldBox.get();
    };
    const statusOf = (): MeterStatus => {
      const a = available();
      if (a === undefined) return 'unknown';
      if (a <= 0) return 'exhausted';
      if (def.lowThreshold !== undefined && a <= def.lowThreshold) return 'low';
      return 'ok';
    };
    const publish = (): void => {
      const a = available();
      for (const sink of sinks) sink.set(factDef, a);
      const status = statusOf();
      if (status !== lastStatus) {
        lastStatus = status;
        telemetry.event('meter.status', { subsystem: SUBSYSTEM, level: 'standard', attrs: { meter: def.id, status, available: a ?? null } });
        for (const listener of [...statusListeners]) listener(status, meter);
      }
    };
    const scheduleWindow = (resetAt: number | undefined): void => {
      cancelWindow?.();
      cancelWindow = undefined;
      resetBox.set(resetAt);
      if (resetAt === undefined || def.mode !== 'rate') return;
      cancelWindow = clock.setTimer(() => {
        cancelWindow = undefined;
        if (def.limit !== undefined) balanceBox.set(def.limit);
        scheduleWindow(def.window === undefined ? undefined : resetAt + def.window.ms);
        publish();
      }, Math.max(0, resetAt - clock.now()));
    };
    disposers.push(() => cancelWindow?.());

    const meter: Meter = {
      def,
      get balance() {
        return balanceBox.get();
      },
      get held() {
        return heldBox.get();
      },
      get available() {
        return available();
      },
      get status() {
        return statusOf();
      },
      get resetAt() {
        return resetBox.get();
      },
      get reservations() {
        return [...live];
      },
      setServerState(state) {
        balanceBox.set(state.balance);
        if (state.resetAt !== undefined) scheduleWindow(state.resetAt);
        else if (def.mode === 'rate' && resetBox.get() === undefined && def.window !== undefined) scheduleWindow(clock.now() + def.window.ms);
        publish();
      },
      onStatusChange(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      async reserve(amount, reserveOptions = {}) {
        const signal = reserveOptions.signal ?? new AbortController().signal;
        const machine = createMachine(reservationMachine, {
          onInvalid: (state, event) =>
            telemetry.event('lifecycle.meter-reservation.invalid', { subsystem: SUBSYSTEM, level: 'critical', attrs: { state, event } }),
        });
        const span = telemetry.span('meter.reserve', { subsystem: SUBSYSTEM, level: 'standard', attrs: { meter: def.id, amount } });
        const deny = (error: ReturnType<typeof QuotaExceededError>): Result<never> => {
          machine.send('deny');
          telemetry.record(MeterMetrics.denials, 1, { meter: def.id, kind: error.kind });
          span.end('error', error);
          return err(error);
        };
        const denial = (): ReturnType<typeof QuotaExceededError> => {
          const details = { meter: def.id, required: amount, available: available() ?? null, retryAt: resetBox.get() ?? null };
          return def.mode === 'rate' ? RateLimitedError({ details }) : QuotaExceededError({ details });
        };
        // 1. Optimistic fast-deny (no network) when the known balance cannot cover the estimate.
        const known = available();
        if (known !== undefined && known < amount) return deny(denial());
        // 2. Hold optimistically while the server decides.
        heldBox.set(heldBox.get() + amount);
        publish();
        const unhold = (): void => {
          heldBox.set(Math.max(0, heldBox.get() - amount));
        };
        const answer = await backend.reserve(def, amount, signal);
        if (signal.aborted && answer.ok) {
          machine.send('cancel');
          unhold();
          publish();
          void backend.release(def, answer.value.reservationId, new AbortController().signal);
          span.end('cancelled');
          return err(ReservationStateError({ message: 'Reservation cancelled before it was confirmed.', details: { meter: def.id } }));
        }
        if (!answer.ok) {
          unhold();
          publish();
          if (answer.error.kind === 'quota' || answer.error.kind === 'rate') return deny(answer.error);
          if (answer.error.kind === 'aborted') {
            machine.send('cancel');
            span.end('cancelled');
            return answer;
          }
          return deny(answer.error);
        }
        if (answer.value.balance !== undefined) balanceBox.set(answer.value.balance);
        machine.send('reserve');
        const ttl = reserveOptions.ttlMs ?? def.reservationTtlMs;
        const expiresAt = answer.value.expiresAt ?? clock.now() + ttl;
        let cancelExpiry: (() => void) | undefined;
        const settle = (): void => {
          cancelExpiry?.();
          cancelExpiry = undefined;
          live.delete(reservation);
          unhold();
        };
        const reservation: Reservation = {
          id: answer.value.reservationId,
          meter: def.id,
          amount,
          expiresAt,
          machine,
          get state() {
            return machine.state;
          },
          async commit(actual, commitSignal = new AbortController().signal) {
            if (!machine.can('commit')) {
              return err(ReservationStateError({ details: { reservation: reservation.id, state: machine.state, op: 'commit' } }));
            }
            const committed = await backend.commit(def, reservation.id, actual, commitSignal);
            if (!committed.ok) return committed;
            if (!machine.can('commit')) {
              return err(ReservationStateError({ details: { reservation: reservation.id, state: machine.state, op: 'commit' } }));
            }
            machine.send('commit');
            settle();
            const current = balanceBox.get();
            // Server-authoritative when reported; otherwise optimistic deduction.
            if (committed.value.balance !== undefined) balanceBox.set(committed.value.balance);
            else if (current !== undefined) balanceBox.set(current - actual);
            telemetry.record(MeterMetrics.committed, actual, { meter: def.id });
            telemetry.event('meter.committed', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { meter: def.id, estimate: amount, actual } });
            publish();
            return ok();
          },
          async release(releaseSignal = new AbortController().signal) {
            if (!machine.can('release')) {
              return err(ReservationStateError({ details: { reservation: reservation.id, state: machine.state, op: 'release' } }));
            }
            machine.send('release');
            settle();
            publish();
            const released = await backend.release(def, reservation.id, releaseSignal);
            if (released.ok && released.value.balance !== undefined) {
              balanceBox.set(released.value.balance);
              publish();
            }
            return released.ok ? ok() : released;
          },
        };
        cancelExpiry = clock.setTimer(() => {
          cancelExpiry = undefined;
          if (!machine.can('expire')) return;
          machine.send('expire');
          settle();
          publish();
          telemetry.event('meter.reservation-expired', { subsystem: SUBSYSTEM, level: 'standard', attrs: { meter: def.id, reservation: reservation.id } });
          void backend.release(def, reservation.id, new AbortController().signal);
        }, Math.max(0, expiresAt - clock.now()));
        live.add(reservation);
        disposers.push(() => cancelExpiry?.());
        telemetry.record(MeterMetrics.reservations, 1, { meter: def.id });
        span.end('ok');
        return ok(reservation);
      },
    };
    return meter;
  };

  for (const def of options.definitions) meters.set(def.id, create(def));

  return {
    id: 'gate/meters',
    facts: options.definitions.map(meterFact),
    modes: new Map(options.definitions.map((d) => [d.id, d.mode])),
    get meters() {
      return [...meters.values()];
    },
    get(def) {
      const meter = meters.get(def.id);
      return meter === undefined ? err(UnknownMeterError({ details: { meter: def.id } })) : ok(meter);
    },
    connect(sink) {
      sinks.add(sink);
      sink.batch(() => {
        for (const meter of meters.values()) sink.set(meterFact(meter.def), meter.available);
      });
      return () => sinks.delete(sink);
    },
    dispose() {
      for (const d of disposers) d();
      sinks.clear();
    },
  };
}
