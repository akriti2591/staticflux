/** DI tokens of @staticflux/handoff (no implementation imports). */
import { token } from '@staticflux/core';
import type { AnyHandoffSlot } from './slot.js';
import type { HandoffStorages } from './storage.js';
import type { HandoffStore } from './store.js';

export const HandoffStoragesToken = /* @__PURE__ */ token('handoff/storages').type<HandoffStorages>();
export const HandoffSlotsToken = /* @__PURE__ */ token('handoff/slots').multi<AnyHandoffSlot>();
export const HandoffStoreToken = /* @__PURE__ */ token('handoff/store').type<HandoffStore>();
