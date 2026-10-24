/**
 * Storage backends for headless runs: memory stores shared across app boots
 * (one per scope × namespace), so a second boot sees what the first one wrote —
 * the in-memory equivalent of IndexedDB/sessionStorage surviving a reload.
 */
import { ok } from '@staticflux/core';
import { borrowed, createMemoryStore, type AsyncStore, STORE_SCOPES, type StoreFactory } from '@staticflux/storage';

export interface SharedMemoryStorage {
  readonly factories: readonly StoreFactory[];
  /** Simulate closing the tab: session-scoped stores are dropped. */
  closeTab(): void;
}

export function createSharedMemoryStorage(): SharedMemoryStorage {
  const stores = new Map<string, AsyncStore>();
  const factories = STORE_SCOPES.map(
    (scope): StoreFactory => ({
      scope,
      id: 'shared-memory',
      create: (namespace) => {
        const key = `${scope}/${namespace}`;
        let store = stores.get(key);
        if (store === undefined) {
          store = createMemoryStore({ id: `shared-memory(${key})` });
          stores.set(key, store);
        }
        // The registry disposes what it opened; the shared backend must survive the app.
        return ok(borrowed(store));
      },
    }),
  );
  return {
    factories,
    closeTab() {
      for (const key of [...stores.keys()]) if (key.startsWith('session/')) stores.delete(key);
    },
  };
}
