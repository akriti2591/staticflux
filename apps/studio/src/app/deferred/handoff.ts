/**
 * Deferred chunk: the handoff store (+ its storages over the storage registry). Loaded when
 * something is carried across the login redirect (held intents, guest draft) or restored after
 * it (signed-in boots prewarm it); slot declarations stay in the boot units (data only).
 */
import type { Registration } from '@staticflux/core';
import { handoffStoreUnit, registryHandoffStoragesUnit } from '@staticflux/handoff';

export const handoffUnits: readonly Registration[] = [registryHandoffStoragesUnit, handoffStoreUnit];
