/**
 * DI units. Register one storages unit (browser-detected or memory-only for
 * embedded hosts) plus `handoffStoreUnit`; packages contribute their slot
 * declarations to `HandoffSlotsToken` so collisions are caught at boot and
 * logout/sweep cover them.
 */
import { ok, token, unit, type UnitDefinition } from '@staticflux/core';
import type { AnyHandoffSlot } from './slot.js';
import { detectHandoffStorages, type HandoffStorages, memoryHandoffStorages } from './storage.js';
import { createHandoffStore, type HandoffStore } from './store.js';

export const HandoffStoragesToken = token('handoff/storages').type<HandoffStorages>();
export const HandoffSlotsToken = token('handoff/slots').multi<AnyHandoffSlot>();
export const HandoffStoreToken = token('handoff/store').type<HandoffStore>();

type NoDeps = Record<never, never>;

export const browserHandoffStoragesUnit = unit({
  id: 'handoff/browser-storages-unit',
  provides: HandoffStoragesToken,
  scope: 'app',
  create: () => detectHandoffStorages(),
  description: 'sessionStorage/localStorage when usable, memory otherwise.',
});

export const memoryHandoffStoragesUnit = unit({
  id: 'handoff/memory-storages-unit',
  provides: HandoffStoragesToken,
  scope: 'app',
  create: () => memoryHandoffStorages(),
  description: 'Memory-only storages (embedded hosts without storage, tests).',
});

/** Contribute a slot declaration. */
export function handoffSlotUnit(slot: AnyHandoffSlot): UnitDefinition<readonly AnyHandoffSlot[], NoDeps, 'handoff/slots'> {
  return unit({ id: `handoff/slot:${slot.key}`, provides: HandoffSlotsToken, scope: 'app', create: () => slot as never });
}

export const handoffStoreUnit = unit({
  id: 'handoff/store-unit',
  provides: HandoffStoreToken,
  scope: 'app',
  deps: { required: { storages: HandoffStoragesToken, slots: HandoffSlotsToken } },
  create: ({ storages, slots }, ctx) => createHandoffStore({ storages, slots, telemetry: ctx.telemetry }),
  /** Drop expired entries left by earlier visits. Never fails the unit. */
  async init(store) {
    await store.sweep();
    return ok();
  },
  description: 'Typed handoff entries with lifetimes over the storage port.',
});
