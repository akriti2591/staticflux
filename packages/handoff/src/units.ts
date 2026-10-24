/**
 * DI units. Register one storages unit (browser-detected or memory-only for
 * embedded hosts) plus `handoffStoreUnit`; packages contribute their slot
 * declarations to `HandoffSlotsToken` so collisions are caught at boot and
 * logout/sweep cover them. Tokens are in `tokens.ts` (apps can name them at boot while the
 * store loads later).
 */
import { ok, unit, type UnitDefinition } from '@staticflux/core';
import { StoreRegistryToken } from '@staticflux/storage';
import { handoffStoragesFromStores } from './async-store.js';
import type { AnyHandoffSlot } from './slot.js';
import { detectHandoffStorages, memoryHandoffStorages } from './storage.js';
import { createHandoffStore } from './store.js';
import { HandoffSlotsToken, HandoffStoragesToken, HandoffStoreToken } from './tokens.js';


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

/**
 * Storages from the `@staticflux/storage` registry (R9.0d): `tab` = session-scope
 * store, `origin` = device-scope store, both namespace `handoff`. Scopes the
 * registry had to back with memory are reported as degraded.
 */
export const registryHandoffStoragesUnit = unit({
  id: 'handoff/registry-storages-unit',
  provides: HandoffStoragesToken,
  scope: 'app',
  deps: { required: { registry: StoreRegistryToken } },
  create: ({ registry }) => {
    const tab = registry.open('session', 'handoff');
    const origin = registry.open('device', 'handoff');
    const report = registry.report();
    const degraded = (scope: 'session' | 'device'): boolean => report.some((r) => r.scope === scope && r.namespace === 'handoff' && r.degraded);
    return handoffStoragesFromStores({
      tab,
      origin,
      degraded: [...(degraded('session') ? (['tab'] as const) : []), ...(degraded('device') ? (['origin'] as const) : [])],
    });
  },
  description: 'Handoff storages over the storage registry (session → tab, device → origin).',
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
