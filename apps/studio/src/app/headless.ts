/**
 * Headless environment for `bootStudio`: memory history, shared memory storage
 * (survives "reloads" = a second boot), a fake platform env, a test auth env that
 * records full-page navigations, and the document worker running in-thread over a
 * port pair. Used by the integration tests (happy-dom) and embedded hosts.
 */
import type { AuthEnvironment } from '@staticflux/auth';
import { createTestAuthEnvironment } from '@staticflux/auth';
import { createFakePlatformEnv, type FakePlatformEnv } from '@staticflux/platform';
import { createMemoryHistory, type MemoryHistory } from '@staticflux/router';
import { inMemorySpawner } from '@staticflux/worker';
import { createMockServer, type MockServer } from '../mocks/server.js';
import { createSharedMemoryStorage, type SharedMemoryStorage } from '../mocks/storage.js';
import { startDocumentWorker } from '../worker/document-host.js';
import type { StudioEnvironment } from './compose.js';

export interface HeadlessOptions {
  readonly url?: string;
  readonly server?: MockServer;
  readonly storage?: SharedMemoryStorage;
  readonly width?: number;
  /** Called with the URL of a full-page navigation (login redirect). */
  readonly onNavigate?: (url: string) => void;
}

export interface HeadlessEnvironment extends StudioEnvironment {
  readonly history: MemoryHistory;
  readonly platformEnv: FakePlatformEnv;
  readonly storage: SharedMemoryStorage;
  /** Full-page navigations requested by the app (e.g. the BFF login redirect). */
  readonly navigations: string[];
}

export function createHeadlessEnvironment(options: HeadlessOptions = {}): HeadlessEnvironment {
  const server = options.server ?? createMockServer();
  const storage = options.storage ?? createSharedMemoryStorage();
  const url = options.url ?? '/';
  const navigations: string[] = [];
  const base = createTestAuthEnvironment({ start: Date.now() });
  const authEnv: AuthEnvironment = {
    ...base,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    navigate(target) {
      navigations.push(target);
      options.onNavigate?.(target);
    },
    currentUrl: () => `https://studio.test${url}`,
  };
  const doc = (globalThis as { document?: Document }).document;
  const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
  return {
    server,
    storage,
    navigations,
    history: createMemoryHistory({ initial: url }),
    storeFactories: storage.factories,
    platformEnv: createFakePlatformEnv({ width: options.width ?? 1280, height: 800, search, media: ['(pointer: fine)', '(hover: hover)'] }),
    authEnv,
    spawnWorker: inMemorySpawner((port) => startDocumentWorker(port)),
    document: doc,
    a11yEnv: { document: doc, matchMedia: undefined, timers: { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, isMac: false },
    search,
    requestedLocales: ['en'],
  };
}
