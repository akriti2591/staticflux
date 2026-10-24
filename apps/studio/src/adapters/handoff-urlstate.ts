/**
 * Adapter: @staticflux/handoff ⇄ @staticflux/urlstate — URL intents survive the
 * login redirect (R7.13, R19.1).
 *
 * - `IntentHoldPort` = a tab-scoped handoff slot (`createSlotHold`).
 * - `LoginReturnPort` (consumed by the auth-boundary plugin): persist held intents,
 *   strip them from `returnTo`, drop them from memory so the login page does not
 *   deliver them.
 * - The first navigation of an app restores held intents before `authorize`.
 */
import { contribution, unit } from '@staticflux/core';
import { createSlotHold, defineHandoff, HandoffSlotsToken, HandoffStoreToken } from '@staticflux/handoff';
import { proceed, stagePlugin, StagePluginsToken } from '@staticflux/router';
import { type HeldIntent, IntentHoldPortsToken, IntentServiceToken } from '@staticflux/urlstate';
import { type LoginReturnPort, LoginReturnPortToken } from './auth-router.js';

const isHeldIntents = (value: unknown): value is readonly HeldIntent[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string');

export const HeldIntentsSlot = defineHandoff<readonly HeldIntent[]>({
  key: 'studio/held-intents',
  version: 1,
  lifetime: { ttlMs: 15 * 60_000 },
  scope: 'tab',
  schema: isHeldIntents,
});

export const heldIntentsSlotUnit = contribution({
  id: 'studio/held-intents-slot-unit',
  provides: HandoffSlotsToken,
  scope: 'app',
  create: () => HeldIntentsSlot,
});

export const intentHoldUnit = contribution({
  id: 'studio/intent-hold-unit',
  provides: IntentHoldPortsToken,
  scope: 'app',
  deps: { required: { store: HandoffStoreToken } },
  create: ({ store }) => createSlotHold(store, HeldIntentsSlot),
  description: 'Held URL intents live in a tab-scoped handoff slot across the login redirect.',
});

export const loginReturnPortUnit = unit({
  id: 'studio/login-return-port-unit',
  provides: LoginReturnPortToken,
  scope: 'app',
  deps: { required: { intents: IntentServiceToken } },
  create: ({ intents }): LoginReturnPort => ({
    async prepare(href) {
      const returnTo = intents.strip(href);
      await intents.persist();
      intents.discard(); // keep them out of the login page; restored after sign-in
      return returnTo;
    },
  }),
});

export const intentRestorePluginUnit = contribution({
  id: 'studio/intent-restore-plugin-unit',
  provides: StagePluginsToken,
  scope: 'app',
  deps: { required: { intents: IntentServiceToken } },
  create: ({ intents }) => {
    let restored = false;
    return stagePlugin({
      id: 'studio/intent-restore',
      stage: 'resolve',
      order: -400,
      applies: () => !restored,
      run: async () => {
        restored = true;
        await intents.restore();
        return proceed();
      },
      description: 'After a login redirect, held intents come back before authorize.',
    });
  },
});
