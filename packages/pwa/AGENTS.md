# @staticflux/pwa — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core`, `@staticflux/loader`, `@staticflux/storage`).
**Budget:** none of this is on the boot path. The page-side updater (`update` + `page-env` + `sw-client` + `protocol` + `errors`)
is ≈ 6.3 KB gzip of unminified tsc output; register it after core-ready. The SW bundle (`@staticflux/pwa/sw`: runtime +
caches + strategies + protocol) is ≈ 10.8 KB gzip unminified; optional plugins add 1–2 KB each. No size-limit entry yet.

## Purpose
R18.11 (manifest, SW from warmup tiers, update flow → reinitialize without reload, OS link capture, file/share handlers),
R12.3 critical tier (SW precache from `sf-manifest`), R11.16a (optional COOP/COEP-injecting SW), the SW warm-cache bridge
for `likely`/`speculative` warmups, Wasm / locale / lazy-asset cache rules, and optional background-sync (R4.6) and push plugins.

## Two entry points
- `@staticflux/pwa/sw` (`src/sw.ts`) — runs **inside the service worker**. Never import page code from the SW bundle.
- `@staticflux/pwa` (`src/index.ts`) — everything (page side + SW side + fakes + DI units).

## Public API (by file)
SW side (all globals via the injected `SwEnv`; `browserSwEnv()` for the real SW):
- `sw-env.ts` — `SwEnv`, `SwGlobalLike`, `CacheStorageLike`, `CacheLike`, `RequestLike`, `ResponseLike`, `FetchLike`, event shapes (`install|activate|fetch|message|sync|push|notificationclick`), `browserSwEnv`, `urlOf`, `headersToRecord`.
- `sw-cache.ts` — `cacheNames(version, prefix='sf')` (`sf-precache-<v>`, `sf-warm`, `sf-rt-<rule>`), `installPrecache` (atomic: all files or the cache is deleted → `SF-PWA-003`; hashed files copied from older precaches), `cleanupCaches` (only owned caches), `prunePrecache`, `createWarmCache` (LRU by entries + bytes, index rebuilt on SW start), `isCacheable`.
- `sw-strategies.ts` — `cacheFirst`, `networkFirst` (timeout; late responses still cached), `staleWhileRevalidate`, `networkOnly`, `STRATEGIES`; rules `ResourceRule { id, match, strategy, maxEntries, timeoutMs, warmCache, crossOrigin }`, `wasmRules()`, `localeCatalogRule(prefix)`, `lazyAssetRule(id, match)`, `isHashedUrl`, `HASHED_FILE`.
- `sw-runtime.ts` — `createServiceWorkerRuntime({ env, config, telemetry })` → `attach(scope)`, `install`, `activate`, `handleFetch`, `respond`, `handleMessage`, `warm`, `warmCache`, machine `pwa/sw-lifecycle`; `ServiceWorkerConfig` (version, frameworkMajor, precache, navigation `{ fallbackUrl, offlineUrl, timeoutMs, denylist }`, resources, navigationPreload, warm, clientsClaim, routeHashed, plugins); `SwPlugin` (transformResponse, fetch, message, listeners, activate, keepCaches).
- `sw-config.ts` — `serviceWorkerConfigFromManifest(manifest, { frameworkMajor, profile, extraUrls, … })` (critical closure + precached navigation fallbacks).
- `sw-coep.ts` — `coepHeadersPlugin({ coep, corp, destinations })`, `withIsolationHeaders`, `createCoepServiceWorker` (standalone, no caching).
- `sw-background-sync.ts` (optional) — `backgroundSyncPlugin({ store, tag, maxAttempts, maxAgeMs })`, `queueKey`, `DEFAULT_SYNC_TAG`.
- `sw-push.ts` (optional) — `pushPlugin({ fallbackTitle, defaultIcon, parse })`, `parsePushPayload`, `safeClickUrl`.
- `sw-share-target.ts` (optional) — `shareTargetPlugin({ action, params, store })` (POST multipart → store → 303 `?sf-share=<id>`), `SHARE_ID_PARAM`.
- `protocol.ts` — `PWA_MESSAGE` (`sf-pwa/*`), `PageToSwMessage`, `SwToPageMessage`, `VersionInfo`, `QueuedMutation`, `isPwaMessage`, `isMessageOf`, `nextMessageId`.

Page side:
- `page-env.ts` — `PwaPageEnv` (serviceWorker, embedded, launchQueue, location, reload, window, onLine, saveData, crossOriginIsolated), `browserPwaPageEnv`, container/registration/worker shapes, `listenTo`.
- `update.ts` — `createPwaUpdater({ env, scriptUrl, frameworkMajor, enabled, reinitialize, prompt, … })` → `register`, `check`, `accept`, `dismiss`, `onUpdateAvailable`, `state`, `info`; machine `pwa/update`; ports `ReinitializePort` (runtime supervisor), `UpdatePromptPort` (messaging); `UpdateInfo { version, frameworkMajor, reloadRequired }`.
- `warmup-bridge.ts` — `createSwWarmup({ container, origin, manifest, facts })` → `SwWarmup { available, warm(urls), warmChunks(ids), isWarm(url), refresh() }`.
- `coep-reload.ts` — `coordinateIsolationReload({ env, register, store })` → `isolated | reloading | unsupported` or `SF-PWA-009`.
- `manifest.ts` — `defineWebAppManifest(decl)` → `Result<WebAppManifestJson>` (`SF-PWA-007`, `details.field`), `webAppManifestJson`, `shareTargetParamsOf`, `SAFELISTED_PROTOCOLS`.
- `launch.ts` — `LaunchIntent` (`link | files | share`), `LaunchIntentPort`, `consumeLaunchQueue`, `receiveShareTarget` (GET params or consume-once POST payload, `SF-PWA-011`), `receiveProtocolLaunch`, `receiveNotificationIntents`.
- `mutation-queue.ts` (optional) — `createMutationQueueClient({ container, registration, window, scope })` → `enqueue` (non-idempotent → `SF-PWA-008`), `replay`.
- `sw-client.ts` — `askServiceWorker` (request/response by `id`, timeout `SF-PWA-010`).
- `units.ts` — tokens `PwaPageEnvToken`, `PwaOptionsToken`, `ReinitializePortsToken` (multi), `UpdatePromptsToken` (multi), `LaunchIntentPortToken`, `PwaUpdaterToken`, `SwWarmupToken`, `LaunchQueueToken`, `MutationQueueToken`; units `browserPwaPageEnvUnit`, `pwaPageEnvUnit`, `pwaOptionsUnit`, `reinitializePortUnit`, `updatePromptUnit`, `launchIntentPortUnit`, `pwaUpdaterUnit` (registers in `init`; failures reported, never block), `swWarmupUnit` (needs loader `ChunkManifestToken`), `launchQueueUnit`, `mutationQueueUnit`.
- `fakes.ts` — test utilities: `createFakeSwEnv`, `createFakeSwGlobal`, `FakeCacheStorage`, `createFakeNetwork`, `FakeResponse`, `fakeRequest`, `FakeClient`, `createFakePageEnv`, `FakeContainer`, `FakeRegistration`, `FakeServiceWorker`, `linkWorker` (page ⇄ SW over the real protocol), `FakeLaunchQueue`, `extendable`.
- `errors.ts` — `SF-PWA-001` unsupported · `002` registration · `003` precache install · `004` activation timeout · `005` no waiting update · `006` reinitialize failed (reloaded) · `007` invalid manifest · `008` non-idempotent mutation · `009` isolation reload failed · `010` SW message timeout · `011` share payload missing.
- `telemetry.ts` — `PWA_SUBSYSTEMS` (`pwa/sw|precache|update|warm|launch|isolation|sync|push`), `pwaMetrics`.

## Lifecycles (mirror into docs/LIFECYCLES.md §14)
- `pwa/sw-lifecycle`: idle → installing → installed → activating → activated; installing → failed → installing; installed|activated → installing.
- `pwa/update`: idle → checking → available → activating → activated | failed; checking → idle | failed; idle|activated|failed → available;
  available → available (newer waiting worker); idle|available|activated|failed → activating (`takeover`, another tab); activated|failed → checking.

## Semantics to know
- The SW never calls `skipWaiting()` itself; the page asks (`sf-pwa/skip-waiting`) on accept, so chunk versions never mix (prior-art: Workbox).
- Update apply: same framework major + reinitialize port → `reinitialize({ kind: 'sw-update', version })`; major change, unknown version
  (SW did not answer `get-version`), no port, or reinitialize failure → `env.reload()` (R4.8 escape hatch).
- Precache = critical tier only. `likely`/`speculative` go through `SwWarmup` (SW fetches at `priority: 'low'`, skips on saveData/offline,
  dedupes, LRU cap); demand loads are then served by the SW, so the loader reports code source `sw`. Without a controller, fall back to
  `loader.preload()`.
- Routing order: plugins' `fetch` → navigations (network-first + navigation preload → cached page → app shell `fallbackUrl` → `offlineUrl` → 503)
  → precache (cache-first) → declared rules → same-origin hashed files (cache-first, warm cache) → pass-through (transformed when a
  plugin rewrites responses). Non-GET is never handled except by plugins.
- Launch/share/file/notification data is handed to `LaunchIntentPort` as data only (prefill-only; never executed here; values never in telemetry).
- Background sync replays only `idempotent: true` mutations, in order; stops on retryable failures (network/5xx/408/425/429); drops other 4xx.

## COOP/COEP service worker caveats (R11.16a)
One reload on the first visit (first navigation is never controlled); hard reload bypasses the SW (not isolated for that load; the
coordinator reloads at most once per session, then `SF-PWA-009`); does nothing when embedded; opaque cross-origin responses cannot be
rewritten (need CORP from their server or `crossorigin` via the platform `IsolationPolicy`); `credentialless` is not in Safari (use
`require-corp`); real host headers always win — prefer them.

## Rules
- SW code only touches `SwEnv`; page code only `PwaPageEnv`. Every listener's remover goes on a scope.
- New SW behaviour = a separate `SwPlugin` module, off unless listed in `config.plugins`.
- New errors via `defineError('SF-PWA-NNN', …)` with a concrete `fix`; keep the machines above in sync with docs/LIFECYCLES.md.

## Test
`npx vitest run packages/pwa` · `npx tsc -p packages/pwa --noEmit`
