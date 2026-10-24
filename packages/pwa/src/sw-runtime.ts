/**
 * Service-worker runtime (R18.11, R12.3). Runs inside the SW; every global comes
 * from the injected `SwEnv`, so the whole lifecycle is unit-testable.
 *
 * ```ts
 * // sw.ts (bundled as the service worker entry)
 * import { browserSwEnv, createServiceWorkerRuntime, wasmRules, localeCatalogRule } from '@staticflux/pwa/sw';
 * import config from 'virtual:sf-sw-config'; // serviceWorkerConfigFromManifest(manifest, …) at build time
 * createServiceWorkerRuntime({ env: browserSwEnv(), config: { ...config, resources: [...wasmRules(), localeCatalogRule()] } }).attach();
 * ```
 *
 * Lifecycle (`pwa/sw-lifecycle`): idle → installing → installed → activating → activated;
 * installing → failed → installing (browser retries on the next update check).
 *
 * The runtime never calls `skipWaiting()` on its own: the page's update flow asks for it
 * (`sf-pwa/skip-waiting`) once the app is ready to reinitialize, so chunk versions never mix.
 */
import {
  createLimiter,
  createMachine,
  createNoopTelemetry,
  createSingleFlight,
  defineMachine,
  err,
  type Machine,
  ok,
  type Result,
  type Scope,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import type { PrecacheEntry } from '@staticflux/loader';
import { isMessageOf, PWA_MESSAGE, type SwToPageMessage, type VersionInfo, type WarmSkipReason } from './protocol.js';
import {
  cacheNames,
  type CacheNames,
  cleanupCaches,
  createWarmCache,
  installPrecache,
  type PrecacheInstallReport,
  prunePrecache,
  type WarmCache,
} from './sw-cache.js';
import type {
  ClientLike,
  ExtendableEventLike,
  FetchEventLike,
  MessageEventLike,
  RequestLike,
  ResponseLike,
  SwEnv,
  SwEventMap,
  SwEventType,
} from './sw-env.js';
import {
  isHashedUrl,
  matchesUrl,
  type ResourceRule,
  type ResponseStore,
  STRATEGIES,
  type StrategyName,
  type StrategyOutcome,
  type UrlMatcher,
} from './sw-strategies.js';
import { pwaMetrics, PWA_SUBSYSTEMS } from './telemetry.js';

export const swLifecycleMachine = defineMachine({
  id: 'pwa/sw-lifecycle',
  initial: 'idle',
  states: ['idle', 'installing', 'installed', 'failed', 'activating', 'activated'],
  transitions: {
    idle: { install: 'installing', activate: 'activating' },
    installing: { installed: 'installed', fail: 'failed' },
    failed: { install: 'installing' },
    installed: { activate: 'activating', install: 'installing' },
    activating: { activated: 'activated' },
    activated: { install: 'installing' },
  },
});

export type SwLifecycleState = (typeof swLifecycleMachine.states)[number];

export interface NavigationConfig {
  /** Precached app shell served when a navigation fails offline (SPA), e.g. `/index.html`. */
  readonly fallbackUrl?: string;
  /** Precached offline page used when there is no app shell. */
  readonly offlineUrl?: string;
  /** Give up on the network after this long (default 4000 ms). */
  readonly timeoutMs?: number;
  /** Navigations never handled (e.g. `/api/`, `/auth/callback`). */
  readonly denylist?: readonly UrlMatcher[];
}

export interface WarmConfig {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  /** Parallel warm fetches (default 2: low priority). */
  readonly concurrency?: number;
}

export interface ServiceWorkerConfig {
  /** Build id (sf-manifest `buildId`); versions the precache. */
  readonly version: string;
  readonly frameworkMajor: number;
  /** Critical tier: `precacheList(manifest)` from @staticflux/loader. */
  readonly precache: readonly PrecacheEntry[];
  readonly cachePrefix?: string;
  /** `false` = do not handle navigations. */
  readonly navigation?: NavigationConfig | false;
  /** Declared runtime rules (Wasm, locale catalogs, lazy assets), evaluated in order. */
  readonly resources?: readonly ResourceRule[];
  readonly isHashed?: (url: string) => boolean;
  /** Serve same-origin content-hashed files cache-first (default true). */
  readonly routeHashed?: boolean;
  /** Enable navigation preload where supported (default true). */
  readonly navigationPreload?: boolean;
  /** Warm cache for likely/speculative chunks (`false` disables the warm bridge). */
  readonly warm?: WarmConfig | false;
  /** Take control of uncontrolled clients on activation (default true). */
  readonly clientsClaim?: boolean;
  readonly plugins?: readonly SwPlugin[];
}

export interface SwPluginContext {
  readonly env: SwEnv;
  readonly names: CacheNames;
  readonly config: ServiceWorkerConfig;
  readonly telemetry: Telemetry;
  /** Post a message to every window client. */
  broadcast(message: SwToPageMessage): Promise<void>;
}

/**
 * Optional SW behaviour (COOP/COEP headers, background sync, push, share target).
 * Plugins are separate modules; nothing is active unless listed in `config.plugins`.
 */
export interface SwPlugin {
  readonly id: string;
  /** Rewrite every response the runtime returns (and pass-through GETs). */
  transformResponse?(response: ResponseLike, request: RequestLike, context: SwPluginContext): ResponseLike;
  /** Claim a fetch before the built-in routes (e.g. a POST share target). */
  fetch?(event: FetchEventLike, context: SwPluginContext): Promise<ResponseLike> | undefined;
  /** Handle a page message; return true when handled. */
  message?(data: unknown, event: MessageEventLike, context: SwPluginContext): boolean;
  /** Extra SW events (sync, push, notificationclick). */
  readonly listeners?: { readonly [K in SwEventType]?: (event: SwEventMap[K], context: SwPluginContext) => void };
  activate?(context: SwPluginContext): Promise<void>;
  /** Cache names this plugin owns (kept at activation). */
  readonly keepCaches?: (names: CacheNames) => readonly string[];
}

export interface WarmOptions {
  readonly saveData?: boolean;
  readonly offline?: boolean;
}

export interface WarmReport {
  readonly warmed: readonly string[];
  /** Already in the precache or warm cache. */
  readonly cached: readonly string[];
  readonly skipped: readonly { readonly url: string; readonly reason: WarmSkipReason }[];
  readonly failed: readonly string[];
}

export interface ServiceWorkerRuntime {
  readonly state: SwLifecycleState;
  readonly machine: Machine<SwLifecycleState, string>;
  readonly names: CacheNames;
  readonly versionInfo: VersionInfo;
  /** Register install/activate/fetch/message (+ plugin) listeners; removed when `scope` is disposed. */
  attach(scope?: Scope): () => void;
  install(): Promise<Result<PrecacheInstallReport>>;
  activate(): Promise<Result<{ readonly deleted: readonly string[] }>>;
  /** Fetch event entry; returns true when the runtime responded. */
  handleFetch(event: FetchEventLike): boolean;
  /** Resolve a request like the fetch handler would (undefined = not handled). */
  respond(request: RequestLike, event?: Partial<Pick<FetchEventLike, 'preloadResponse' | 'waitUntil'>>): Promise<ResponseLike> | undefined;
  handleMessage(event: MessageEventLike): boolean;
  warm(urls: readonly string[], options?: WarmOptions): Promise<WarmReport>;
  /** Warm cache (undefined when disabled). */
  readonly warmCache: WarmCache | undefined;
}

export interface ServiceWorkerRuntimeOptions {
  readonly env: SwEnv;
  readonly config: ServiceWorkerConfig;
  readonly telemetry?: Telemetry;
}

interface Route {
  readonly id: string;
  readonly strategy: StrategyName;
  readonly store: ResponseStore;
  readonly timeoutMs?: number;
  readonly navigation: boolean;
}

export function createServiceWorkerRuntime(options: ServiceWorkerRuntimeOptions): ServiceWorkerRuntime {
  const { env, config } = options;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const names = cacheNames(config.version, config.cachePrefix);
  const origin = env.self.location.origin;
  const resolve = (url: string): string => new URL(url, origin).href;
  const precacheUrls = new Set(config.precache.map((e) => resolve(e.url)));
  const isHashed = config.isHashed ?? isHashedUrl;
  const plugins = config.plugins ?? [];
  const transformers = plugins.filter((p) => p.transformResponse !== undefined);
  const machine = createMachine(swLifecycleMachine, {
    onInvalid: (state, event) =>
      telemetry.event('pwa.sw.invalid-transition', { subsystem: PWA_SUBSYSTEMS.sw, level: 'critical', attrs: { state, event } }),
  });
  machine.onTransition((r) =>
    telemetry.event(`lifecycle.${r.machine}.${r.from}→${r.to}`, { subsystem: PWA_SUBSYSTEMS.sw, level: 'verbose' }),
  );
  const versionInfo: VersionInfo = { version: config.version, frameworkMajor: config.frameworkMajor };

  const precacheStore: ResponseStore = {
    match: async (url) => (await env.caches.open(names.precache)).match(url),
    put: () => Promise.resolve(),
  };
  const warmConfig = config.warm === false ? undefined : (config.warm ?? {});
  const warmCache =
    warmConfig === undefined
      ? undefined
      : createWarmCache({
          caches: env.caches,
          name: names.warm,
          now: env.now,
          telemetry,
          ...(warmConfig.maxEntries === undefined ? {} : { maxEntries: warmConfig.maxEntries }),
          ...(warmConfig.maxBytes === undefined ? {} : { maxBytes: warmConfig.maxBytes }),
        });
  // Without a warm cache, hashed files fall back to an unbounded-by-bytes rule cache.
  const hashedStore: ResponseStore =
    warmCache ?? createWarmCache({ caches: env.caches, name: names.runtime('chunks'), now: env.now, maxEntries: 100 });
  const ruleStores = new Map<string, ResponseStore>();
  const storeForRule = (rule: ResourceRule): ResponseStore => {
    if (rule.warmCache === true) return hashedStore;
    let found = ruleStores.get(rule.id);
    if (found === undefined) {
      found = createWarmCache({ caches: env.caches, name: names.runtime(rule.id), now: env.now, maxEntries: rule.maxEntries ?? 60 });
      ruleStores.set(rule.id, found);
    }
    return found;
  };
  const navigation = config.navigation === false ? undefined : (config.navigation ?? {});
  const pagesStore = createWarmCache({ caches: env.caches, name: names.runtime('pages'), now: env.now, maxEntries: 20 });

  const clients = (): Promise<readonly ClientLike[]> =>
    env.self.clients.matchAll({ type: 'window', includeUncontrolled: true }).catch(() => []);
  const context: SwPluginContext = {
    env,
    names,
    config,
    telemetry,
    async broadcast(message) {
      for (const client of await clients()) client.postMessage(message);
    },
  };

  const transform = (response: ResponseLike, request: RequestLike): ResponseLike =>
    transformers.reduce((current, plugin) => plugin.transformResponse?.(current, request, context) ?? current, response);

  const pickRoute = (request: RequestLike, url: URL): Route | undefined => {
    const href = url.href;
    if (request.mode === 'navigate') {
      if (navigation === undefined) return undefined;
      if ((navigation.denylist ?? []).some((m) => matchesUrl(m, url, request, origin))) return undefined;
      return { id: 'navigation', strategy: 'network-first', store: pagesStore, timeoutMs: navigation.timeoutMs ?? 4000, navigation: true };
    }
    if (precacheUrls.has(href)) return { id: 'precache', strategy: 'cache-first', store: precacheStore, navigation: false };
    for (const rule of config.resources ?? []) {
      if (url.origin !== origin && rule.crossOrigin !== true) continue;
      if (!matchesUrl(rule.match, url, request, origin)) continue;
      return {
        id: rule.id,
        strategy: rule.strategy ?? 'stale-while-revalidate',
        store: storeForRule(rule),
        ...(rule.timeoutMs === undefined ? {} : { timeoutMs: rule.timeoutMs }),
        navigation: false,
      };
    }
    if (config.routeHashed !== false && url.origin === origin && isHashed(href)) return { id: 'hashed', strategy: 'cache-first', store: hashedStore, navigation: false };
    return undefined;
  };

  const navigationFallback = async (): Promise<ResponseLike | undefined> => {
    if (navigation === undefined) return undefined;
    for (const candidate of [navigation.fallbackUrl, navigation.offlineUrl]) {
      if (candidate === undefined) continue;
      const hit = await precacheStore.match(resolve(candidate)).catch(() => undefined);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const respond: ServiceWorkerRuntime['respond'] = (request, event = {}) => {
    if (request.method !== 'GET') return undefined;
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return undefined;
    }
    const route = pickRoute(request, url);
    const waitUntil = (promise: Promise<unknown>): void => {
      if (event.waitUntil !== undefined) event.waitUntil(promise);
      else void promise.catch(() => undefined);
    };
    if (route === undefined) {
      if (transformers.length === 0) return undefined;
      return env.fetch(request).then((response) => transform(response, request));
    }
    const run = async (): Promise<ResponseLike> => {
      const strategy = STRATEGIES[route.strategy];
      let outcome: StrategyOutcome | undefined = await strategy({
        url: url.href,
        request,
        fetch: env.fetch,
        store: route.store,
        waitUntil,
        ...(route.timeoutMs === undefined ? {} : { timeoutMs: route.timeoutMs }),
        ...(route.navigation && config.navigationPreload !== false ? { preload: event.preloadResponse } : {}),
      });
      if (route.navigation && (outcome === undefined || outcome.response.status >= 500)) {
        const fallback = await navigationFallback();
        if (fallback !== undefined) outcome = { response: fallback, source: 'fallback' };
      }
      if (outcome === undefined) {
        telemetry.record(pwaMetrics.swResponse, 1, { route: route.id, strategy: route.strategy, source: 'none' });
        if (route.navigation) return env.createResponse('Offline', { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'text/plain' } });
        throw new TypeError(`sf-pwa: network error for ${url.href}`);
      }
      telemetry.record(pwaMetrics.swResponse, 1, { route: route.id, strategy: route.strategy, source: outcome.source });
      return transform(outcome.response, request);
    };
    return run();
  };

  // ------------------------------------------------------------ warm bridge

  const warmFlights = createSingleFlight<string, 'warmed' | 'cached' | 'over-budget'>();
  const warmLimiter = createLimiter(warmConfig?.concurrency ?? 2);
  const warm = async (urls: readonly string[], warmOptions: WarmOptions = {}): Promise<WarmReport> => {
    const report = { warmed: [] as string[], cached: [] as string[], skipped: [] as { url: string; reason: WarmSkipReason }[], failed: [] as string[] };
    const unique = [...new Set(urls.map((u) => resolve(u)))];
    const signal = new AbortController().signal;
    await Promise.all(
      unique.map(async (url) => {
        const skip = (reason: WarmSkipReason): void => {
          report.skipped.push({ url, reason });
          telemetry.record(pwaMetrics.warm, 1, { outcome: 'skipped', reason });
        };
        if (warmCache === undefined) return skip('disabled');
        if (new URL(url).origin !== origin) return skip('cross-origin');
        if (precacheUrls.has(url) || (await warmCache.has(url))) {
          report.cached.push(url);
          telemetry.record(pwaMetrics.warm, 1, { outcome: 'cached' });
          return;
        }
        if (warmOptions.offline === true) return skip('offline');
        if (warmOptions.saveData === true) return skip('save-data');
        const result = await warmFlights.run(
          url,
          (s) =>
            warmLimiter.run(async () => {
              try {
                const response = await env.fetch(url, { credentials: 'same-origin', priority: 'low', signal: s });
                if (!response.ok) return err(toSfError(new Error(`status ${response.status}`)));
                return ok((await warmCache.put(url, response)) ? ('warmed' as const) : ('over-budget' as const));
              } catch (cause) {
                return err(toSfError(cause));
              }
            }, s),
          signal,
        );
        if (!result.ok) {
          report.failed.push(url);
          telemetry.record(pwaMetrics.warm, 1, { outcome: 'failed' });
        } else if (result.value === 'over-budget') {
          skip('over-budget');
        } else {
          report.warmed.push(url);
          telemetry.record(pwaMetrics.warm, 1, { outcome: 'warmed' });
        }
      }),
    );
    return report;
  };

  // ------------------------------------------------------------ lifecycle

  const install = async (): Promise<Result<PrecacheInstallReport>> => {
    const sent = machine.send('install');
    if (!sent.ok) return err(sent.error);
    const result = await installPrecache({
      caches: env.caches,
      fetch: env.fetch,
      names,
      entries: config.precache,
      resolve,
      telemetry,
      now: env.now,
    });
    if (!result.ok) {
      machine.send('fail');
      return result;
    }
    await prunePrecache(await env.caches.open(names.precache), precacheUrls);
    machine.send('installed');
    return result;
  };

  const activate = async (): Promise<Result<{ readonly deleted: readonly string[] }>> => {
    const sent = machine.send('activate');
    if (!sent.ok) return err(sent.error);
    const span = telemetry.span('pwa.sw.activate', { subsystem: PWA_SUBSYSTEMS.sw, attrs: { version: config.version } });
    if (config.navigationPreload !== false && navigation !== undefined) {
      await env.self.registration.navigationPreload?.enable().catch(() => undefined);
    }
    const keep = [
      names.precache,
      names.warm,
      names.runtime('pages'),
      names.runtime('chunks'),
      ...(config.resources ?? []).map((r) => names.runtime(r.id)),
      ...plugins.flatMap((p) => p.keepCaches?.(names) ?? []),
    ];
    const deleted = await cleanupCaches(env.caches, names, keep).catch(() => [] as string[]);
    for (const plugin of plugins) await plugin.activate?.(context).catch(() => undefined);
    if (config.clientsClaim !== false) await env.self.clients.claim().catch(() => undefined);
    machine.send('activated');
    await context.broadcast({ type: PWA_MESSAGE.activated, ...versionInfo });
    span.set('deleted', deleted.length);
    span.end('ok');
    return ok({ deleted });
  };

  const handleFetch = (event: FetchEventLike): boolean => {
    for (const plugin of plugins) {
      const claimed = plugin.fetch?.(event, context);
      if (claimed !== undefined) {
        event.respondWith(claimed.then((response) => transform(response, event.request)));
        return true;
      }
    }
    const response = respond(event.request, event);
    if (response === undefined) return false;
    event.respondWith(response);
    return true;
  };

  const reply = (event: MessageEventLike, message: SwToPageMessage): void => {
    event.source?.postMessage(message);
  };

  const handleMessage = (event: MessageEventLike): boolean => {
    const data = event.data;
    if (isMessageOf(data, PWA_MESSAGE.getVersion)) {
      reply(event, { type: PWA_MESSAGE.version, id: data.id, ...versionInfo });
      return true;
    }
    if (isMessageOf(data, PWA_MESSAGE.skipWaiting)) {
      event.waitUntil(env.self.skipWaiting());
      return true;
    }
    if (isMessageOf(data, PWA_MESSAGE.warm)) {
      const urls = Array.isArray(data.urls) ? data.urls.filter((u): u is string => typeof u === 'string') : [];
      event.waitUntil(
        warm(urls, { saveData: data.saveData === true, offline: data.offline === true }).then((report) =>
          reply(event, { type: PWA_MESSAGE.warmed, id: data.id, ...report }),
        ),
      );
      return true;
    }
    if (isMessageOf(data, PWA_MESSAGE.warmQuery)) {
      event.waitUntil(
        (async () => {
          const held = new Set([...(await warmCache?.urls() ?? []), ...precacheUrls]);
          const asked = data.urls === undefined ? [...held] : data.urls.map(resolve).filter((u) => held.has(u));
          reply(event, { type: PWA_MESSAGE.warmState, id: data.id, warm: asked });
        })(),
      );
      return true;
    }
    for (const plugin of plugins) if (plugin.message?.(data, event, context) === true) return true;
    return false;
  };

  const attach = (scope?: Scope): (() => void) => {
    const removers: (() => void)[] = [];
    const on = <K extends SwEventType>(type: K, listener: (event: SwEventMap[K]) => void): void => {
      env.self.addEventListener(type, listener);
      removers.push(() => env.self.removeEventListener(type, listener));
    };
    on('install', (event: ExtendableEventLike) =>
      event.waitUntil(
        install().then((r) => {
          // Rejecting waitUntil fails the install: the previous SW stays in control.
          if (!r.ok) throw r.error;
        }),
      ),
    );
    on('activate', (event: ExtendableEventLike) => event.waitUntil(activate()));
    on('fetch', (event) => {
      handleFetch(event);
    });
    on('message', (event) => {
      handleMessage(event);
    });
    for (const plugin of plugins) {
      for (const [type, listener] of Object.entries(plugin.listeners ?? {}) as [SwEventType, (event: never, c: SwPluginContext) => void][]) {
        on(type, (event) => listener(event as never, context));
      }
    }
    const detach = (): void => {
      for (const remove of removers.splice(0)) remove();
    };
    scope?.defer(detach);
    return detach;
  };

  return {
    get state() {
      return machine.state;
    },
    machine: machine as Machine<SwLifecycleState, string>,
    names,
    versionInfo,
    attach,
    install,
    activate,
    handleFetch,
    respond,
    handleMessage,
    warm,
    warmCache,
  };
}
