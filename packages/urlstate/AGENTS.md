# @staticflux/urlstate — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`).
**Budget:** full surface ≤ 7.5 KB brotli (measured 7.0 KB minified, core external); history port + sync are boot-path (router), intents/dialogs/marketing tree-shake separately.

## Purpose
The URL-state model (REQUIREMENTS §7.1 R7.10–R7.15, URL-level parts of §7.2
R7.16/R7.18/R7.20, invariant I-13): declared URL parts with kinds and owners,
typed keys with collision detection, a URL ⇄ store sync service batched per frame
that never invokes the router, consume-once intents (prefill-only by default),
sticky params, marketing-param capture, routable dialog paths, and an injectable
`HistoryPort`.

## URL part kinds
| kind | example | owner | handled by |
|---|---|---|---|
| path | `/studio/doc/42` | router | router (not here) |
| view | `?tab=comments` | feature store | `createUrlSync` |
| dialog | `…/d/share` | messaging | `parseDialogPath` / `createDialogUrl` |
| intent | `?panel=chat&prompt=…` | declaring feature | `createIntentService` |
| sticky | `?workspace=…&lang=…&sf-debug` | declaring package | `createUrlSync` (+ `decorate`) |
| hidden | selection, drafts | store / handoff | stripped from URLs if present |

## Public API (by file)
- `binding.ts` — `defineUrlBinding({ key, kind: 'view'|'sticky'|'hidden', codec, owner, history?, default? })` with keys/types from `Registry['urlParams']`;
  `defineIntent({ id, owner, params: { key: codec }, required?, safe? })`; `reserveParams`; `checkUrlDeclarations` (CI); `createUrlDeclarationRegistry` (runtime, `SF-URL-002`).
- `codec.ts` — `codec.string|enum|int|number|boolean|flag|list|custom`, `codecEquals`; parse failures are `SF-URL-003`.
- `sync.ts` — `createUrlSync({ history, scheduler, registry?, telemetry? })` → `bind(binding, store, scope?)`, `flush`, `pending`, `decorate(href)`, `inspect`, `dispose`; `boxAdapter`, `URLSTATE_SOURCE`; `SF-URL-005`.
- `intents.ts` — `createIntentService({ history, intents, hold?, now?, telemetry? })` → `capture`, `persist`, `restore`, `authorize(owner?)`, `consume(intent, handler, scope?)`, `discard`, `strip`, `inspect`;
  `IntentDelivery.execute()` refuses unless `safe` (`SF-URL-001`, I-13); `IntentHoldPort`, `HeldIntent`; machine `IntentMachine` (`urlstate/intent`); `IntentMetrics`.
- `marketing.ts` — `extractMarketingParams`, `createMarketingCapture({ history, keys?, strip? })` (once, telemetry, strip via replace), `DEFAULT_MARKETING_PARAMS`, `MarketingParams` (reserved declaration).
- `dialog.ts` — `parseDialogPath`, `formatDialogPath` (one routable dialog max, `SF-URL-004`), `createDialogUrl({ history })` → `open`, `dismiss` (back if opened in-app, else replace to parent), `DialogKey` (typed via `Registry['dialogs']`).
- `history.ts` — `HistoryPort`, `createNavigationHistory`, `createBrowserHistory`, `createMemoryHistory`, `detectHistory`.
- `scheduler.ts` — `FrameScheduler`, `createRafScheduler`, `createManualScheduler` (tests).
- `url.ts` — `parseUrl`, `formatUrl`, `getParam`, `hasParam`, `withParam`, `withoutParams`.
- `units.ts` — tokens `HistoryPortToken`, `FrameSchedulerToken`, `UrlDeclarationsToken`/`IntentDefinitionsToken`/`IntentHoldPortsToken` (multi), `UrlDeclarationRegistryToken`, `UrlSyncToken`, `IntentServiceToken`, `MarketingCaptureToken`, `DialogUrlToken`;
  units `browserHistoryUnit`, `memoryHistoryUnit(initial)`, `rafSchedulerUnit`, `urlDeclarationUnit(decl)`, `intentUnit(intent)`, `intentHoldUnit(port)`, `urlDeclarationRegistryUnit`, `urlSyncUnit`, `intentServiceUnit`, `marketingCaptureUnit`, `dialogUrlUnit`.

## Rules
- Declare every query key once (contracts file + `Registry['urlParams']` merge). Same-key/different-type merges fail to compile; same-type duplicates are caught by `checkUrlDeclarations` (CI) and the registry unit (boot).
- Stores never read the URL; the router is never invoked for view/intent/sticky changes. All writes go through `HistoryPort` with `source: 'urlstate'`.
- Intents are prefill-only unless `safe: true` (side-effect-free only). Intent values never go to telemetry. Intents captured before login go through `persist()`/`restore()` (handoff `createSlotHold`) and `strip()` keeps them out of `returnTo`.
- Navigation API writes use `history.pushState/replaceState` (a same-document `navigation.navigate()` without interception would reload).
- Lifecycle machines above must stay mirrored in `docs/LIFECYCLES.md`.

## Test
`pnpm vitest run packages/urlstate`
