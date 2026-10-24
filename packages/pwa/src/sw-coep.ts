/**
 * Optional COOP/COEP-injecting service worker (R11.16a) for static hosts that cannot
 * set response headers (GitHub Pages, some CDNs). The SW adds
 * `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` to document and
 * worker responses so the page becomes `crossOriginIsolated` — after ONE reload on the
 * first visit (the first navigation is never controlled; see `coep-reload.ts`).
 *
 * Caveats (also in AGENTS.md):
 * - Costs one reload on the first visit; a hard reload (Shift+Reload) bypasses the SW,
 *   so that load is not isolated (the page-side coordinator reloads at most once per session).
 * - Does nothing in embedded hosts (iframes cannot isolate unless the embedder does too).
 * - Opaque (no-cors cross-origin) responses cannot be modified: under `require-corp`
 *   they must carry `Cross-Origin-Resource-Policy` from their own server, or be loaded
 *   with `crossorigin` (the platform `IsolationPolicy` adds it). `credentialless` relaxes
 *   this (Chromium 96+, Firefox 119+; NOT Safari — use `require-corp` there).
 * - Real headers always win: if the host already sends COOP/COEP, prefer them and drop this plugin.
 * - The SW only sees requests in its scope; cross-origin iframes need their own COEP/CORP
 *   or the `credentialless` iframe attribute.
 */
import type { CacheNames } from './sw-cache.js';
import { headersToRecord, type RequestLike, type ResponseLike, type SwEnv } from './sw-env.js';
import { createServiceWorkerRuntime, type ServiceWorkerRuntime, type SwPlugin, type SwPluginContext } from './sw-runtime.js';
import type { Telemetry } from '@staticflux/core';

export type CoepValue = 'require-corp' | 'credentialless';
export type CorpValue = 'same-origin' | 'same-site' | 'cross-origin';

export interface CoepPluginOptions {
  /** Default `require-corp` (works in every engine that supports COEP). */
  readonly coep?: CoepValue;
  /** Also add `Cross-Origin-Resource-Policy` to same-origin subresources lacking one (default `same-origin`; `false` disables). */
  readonly corp?: CorpValue | false;
  /** Destinations that receive COOP/COEP (default documents and workers). */
  readonly destinations?: readonly string[];
}

export const COOP_HEADER = 'cross-origin-opener-policy';
export const COEP_HEADER = 'cross-origin-embedder-policy';
export const CORP_HEADER = 'cross-origin-resource-policy';

const DEFAULT_DESTINATIONS = ['document', 'iframe', 'frame', 'worker', 'sharedworker', 'serviceworker'];

/** Response rewrite: returns the same response when nothing needs to change. */
export function withIsolationHeaders(
  response: ResponseLike,
  request: RequestLike,
  createResponse: SwEnv['createResponse'],
  origin: string,
  options: CoepPluginOptions = {},
): ResponseLike {
  // Opaque / network-error responses are immutable (status 0).
  if (response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect' || response.type === 'error') return response;
  const destinations = options.destinations ?? DEFAULT_DESTINATIONS;
  const isDocument = request.mode === 'navigate' || destinations.includes(request.destination ?? '');
  const headers = headersToRecord(response.headers);
  let changed = false;
  if (isDocument) {
    if (headers[COOP_HEADER] === undefined) {
      headers[COOP_HEADER] = 'same-origin';
      changed = true;
    }
    if (headers[COEP_HEADER] === undefined) {
      headers[COEP_HEADER] = options.coep ?? 'require-corp';
      changed = true;
    }
  }
  const corp = options.corp ?? 'same-origin';
  let sameOrigin = false;
  try {
    sameOrigin = new URL(request.url).origin === origin;
  } catch {
    sameOrigin = false;
  }
  if (corp !== false && sameOrigin && !isDocument && headers[CORP_HEADER] === undefined) {
    headers[CORP_HEADER] = corp;
    changed = true;
  }
  if (!changed) return response;
  return createResponse(response.body ?? null, {
    status: response.status,
    ...(response.statusText === undefined ? {} : { statusText: response.statusText }),
    headers,
  });
}

/** Plugin for `createServiceWorkerRuntime({ config: { plugins: [coepHeadersPlugin()] } })`. */
export function coepHeadersPlugin(options: CoepPluginOptions = {}): SwPlugin {
  return {
    id: 'pwa/coep-headers',
    transformResponse: (response: ResponseLike, request: RequestLike, context: SwPluginContext) =>
      withIsolationHeaders(response, request, context.env.createResponse, context.env.self.location.origin, options),
    keepCaches: (_names: CacheNames) => [],
  };
}

/**
 * A standalone COOP/COEP SW (no precache, no routing): every GET passes through the
 * network and gets the headers. Use when the app does not otherwise need a SW; apps with
 * the full runtime add `coepHeadersPlugin()` to its plugins instead.
 */
export function createCoepServiceWorker(options: { readonly env: SwEnv; readonly telemetry?: Telemetry } & CoepPluginOptions): ServiceWorkerRuntime {
  const { env, telemetry, ...plugin } = options;
  return createServiceWorkerRuntime({
    env,
    ...(telemetry === undefined ? {} : { telemetry }),
    config: {
      version: 'coep',
      frameworkMajor: 0,
      precache: [],
      cachePrefix: 'sf-coep',
      navigation: false,
      warm: false,
      routeHashed: false,
      plugins: [coepHeadersPlugin(plugin)],
    },
  });
}
