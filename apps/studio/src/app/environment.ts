/**
 * The browser environment for `bootStudio`: real history (Navigation API → History
 * API), IndexedDB-backed storage registry, a Web Worker for documents, and the mock
 * backend persisted in localStorage (so the BFF login redirect survives the reload).
 * The headless twin lives in `headless.ts` (kept out of the browser bundle).
 */
import { browserA11yEnvironment } from '@staticflux/a11y';
import { type AuthEnvironment, browserAuthEnvironment } from '@staticflux/auth';
import { browserEnv, type DetectedMode } from '@staticflux/platform';
import { createBrowserHistory } from '@staticflux/router';
import { indexedDbStoreFactory, memoryStoreFactory, STORE_SCOPES, type StoreFactory, webStorageStoreFactory } from '@staticflux/storage';
import type { Spawner } from '@staticflux/worker';
import { isMockLoginUrl } from '../mocks/auth-endpoints.js';
import { createMockServer, localStoragePersist } from '../mocks/server.js';
import type { StudioEnvironment } from './compose.js';

/** Browser factories: IndexedDB → Web Storage → memory per scope (degradation reported by the registry). */
export function browserStoreFactories(): readonly StoreFactory[] {
  const hasIdb = typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
  return [
    ...(hasIdb ? (['device', 'user', 'workspace'] as const).map((scope) => ({ ...indexedDbStoreFactory(scope, { dbName: 'studio' }), priority: 20 })) : []),
    ...STORE_SCOPES.map((scope) => ({ ...webStorageStoreFactory(scope), priority: 10 })),
    ...STORE_SCOPES.map((scope) => memoryStoreFactory(scope)),
  ];
}

function flagStorage(): { readonly flagStorage?: Storage } {
  try {
    return { flagStorage: localStorage };
  } catch {
    return {}; // blocked storage (Safari private mode, sandboxed iframes): overrides stay in memory
  }
}

export function createBrowserEnvironment(options: { readonly spawnWorker: Spawner; readonly detected?: DetectedMode }): StudioEnvironment {
  const persist = localStoragePersist();
  const server = createMockServer(persist === undefined ? {} : { persist });
  const base = browserAuthEnvironment();
  const authEnv: AuthEnvironment = {
    ...base,
    navigate(url) {
      // The mock BFF "login page": authenticate, then redirect back (a real full-page load).
      if (isMockLoginUrl(url)) location.assign(server.completeBffLogin(url));
      else base.navigate(url);
    },
  };
  const search = location.search;
  return {
    server,
    history: createBrowserHistory({ window: window as never }),
    storeFactories: browserStoreFactories(),
    platformEnv: browserEnv(),
    ...(options.detected === undefined ? {} : { detected: options.detected }),
    authEnv,
    spawnWorker: options.spawnWorker,
    document,
    a11yEnv: browserA11yEnvironment(),
    search,
    requestedLocales: [...new URLSearchParams(search).getAll('lang'), ...navigator.languages],
    ...flagStorage(),
    mockLatencyMs: 80,
    debug: new URLSearchParams(search).has('sf-debug'),
  };
}

