/**
 * Adapter: @staticflux/gate meters ⇄ @staticflux/data endpoints.
 *
 * - `MeterBackend` over the billing endpoints: reserve → commit(actual) | release.
 *   The server balance is authoritative; the registry keeps the optimistic view.
 * - After sign-in (and every epoch) the credit balance is read from the backend and
 *   pushed with `meter.setServerState`, so `covers(credits, n)` can be decided.
 */
import { contribution, err, ok, unit, watch } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { DataClientToken } from '@staticflux/data';
import { type MeterBackend, MeterBackendToken, MeterRegistryToken } from '@staticflux/gate';
import { defineSubsystem, SubsystemsToken } from '@staticflux/runtime';
import { CreditsMeter } from '../app/contracts.js';
import { BillingBalanceEndpoint, MeterCommitEndpoint, MeterReleaseEndpoint, MeterReserveEndpoint } from '../app/endpoints.js';

export const dataMeterBackendUnit = unit({
  id: 'studio/data-meter-backend-unit',
  provides: MeterBackendToken,
  scope: 'app',
  deps: { required: { client: DataClientToken } },
  create: ({ client }): MeterBackend => ({
    async reserve(meter, amount, signal) {
      const result = await client.call(MeterReserveEndpoint, { meter: meter.id, amount }, { signal });
      return result.ok ? ok({ reservationId: result.value.reservationId, balance: result.value.balance }) : err(result.error);
    },
    async commit(_meter, reservationId, actual, signal) {
      const result = await client.call(MeterCommitEndpoint, { reservationId, actual }, { signal });
      return result.ok ? ok({ balance: result.value.balance }) : err(result.error);
    },
    async release(_meter, reservationId, signal) {
      const result = await client.call(MeterReleaseEndpoint, { reservationId }, { signal });
      return result.ok ? ok({ balance: result.value.balance }) : err(result.error);
    },
  }),
  description: 'Credit reservations go to the (mock) billing backend.',
});

export const meterSyncSubsystemUnit = contribution({
  id: 'studio/meter-sync-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { client: DataClientToken, meters: MeterRegistryToken, session: SessionToken } },
  create: ({ client, meters, session }) => {
    const sync = async (signal: AbortSignal): Promise<void> => {
      if (!session.isAuthenticated) return;
      const meter = meters.get(CreditsMeter);
      const balance = await client.call(BillingBalanceEndpoint, undefined, { signal });
      if (meter.ok && balance.ok) meter.value.setServerState({ balance: balance.value.credits });
    };
    return defineSubsystem({
      id: 'billing/meter-sync',
      critical: false,
      start: async (ctx) => {
        watch(
          () => session.isAuthenticated,
          () => void sync(ctx.signal),
          { scope: ctx.scope },
        );
        await sync(ctx.signal);
      },
      refresh: async (_epoch, ctx) => {
        await sync(ctx.signal);
      },
      description: 'Keeps the credits meter in sync with the billing backend.',
    });
  },
});
