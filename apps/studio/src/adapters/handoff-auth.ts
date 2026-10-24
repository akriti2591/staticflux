/**
 * Adapter: @staticflux/handoff → @staticflux/auth guest-upgrade hook (R6.4, R19.1).
 * A guest's unsaved draft title is written to a tab-scoped handoff slot *before* the
 * login redirect; after sign-in the home view takes it (consume-once) and creates the doc.
 */
import { type Box, box, contribution, ok, token, unit } from '@staticflux/core';
import { type GuestUpgradeHook, GuestUpgradeHooksToken } from '@staticflux/auth';
import { HandoffSlotsToken, HandoffStoreToken } from '@staticflux/handoff';
import { GuestDraftSlot } from '../app/contracts.js';

/** The guest's draft (home view input). */
export const GuestDraftToken = token('studio/guest-draft').type<Box<string>>();

export const guestDraftUnit = unit({ id: 'studio/guest-draft-unit', provides: GuestDraftToken, scope: 'app', create: () => box('') });

export const guestDraftSlotUnit = contribution({
  id: 'studio/guest-draft-slot-unit',
  provides: HandoffSlotsToken,
  scope: 'app',
  create: () => GuestDraftSlot,
});

export const guestDraftUpgradeHookUnit = contribution({
  id: 'studio/guest-draft-upgrade-hook-unit',
  provides: GuestUpgradeHooksToken,
  scope: 'app',
  deps: { required: { store: HandoffStoreToken, draft: GuestDraftToken } },
  create: ({ store, draft }): GuestUpgradeHook => ({
    id: 'studio/guest-draft',
    async beforeUpgrade() {
      const title = draft.get().trim();
      if (title === '') return ok();
      const put = await store.put(GuestDraftSlot, { title });
      return put.ok ? ok() : put;
    },
  }),
  description: 'Carries the guest draft through the login redirect.',
});
