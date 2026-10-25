# Studio — StaticFlux example app

An AI-assisted mixed-media document editor that composes **every StaticFlux vertical**
into one app, against **mock services only**: a mock data transport, a mock BFF session
endpoint, a mock collaboration network (in the document worker), a mock AI provider and
memory/IndexedDB storage. It is the integration proof described in `docs/FEATURE-NEEDS.md`.

## Run

```sh
cd apps/studio
npx vite                    # dev server (packages resolve from source; no package build)
npx vite build              # production build → dist/ (+ sf-manifest.json, sf-precache.json, sf-build-report.json)
cd ../.. && npx vitest run apps/studio      # headless integration tests (happy-dom)
npx tsc -p apps/studio                      # typecheck (needs packages' dist: `npx tsc -b tsconfig.build.json`)
cd apps/studio && NODE_PATH=$(npm root -g) npx playwright test -c e2e/playwright.config.cjs   # e2e smoke (Chromium)
# same smoke against the production build: start `npx vite preview --port 5199` first (the config reuses it)
```

Try it: `/` (guest welcome) → `/studio/doc/1?panel=chat&prompt=Add%20an%20image` (redirects to
`/login`; pick *Ada (free)* or *Grace (pro)*; the mock BFF "redirects" back with a real page
load and the chat prompt is prefilled) · `/onboarding/step/1` · `/settings` (theme, language
incl. Arabic/RTL, expert workspace) · `?sf-mode=web:compact` (mobile editor variant) ·
`?sf-flag=studio/ai-suggestions:false` · `?sf-debug` (console telemetry sink) · `Ctrl/⌘+K` (capability palette) ·
`/settings` density Focus / Standard / Pro (kit + theme contract, see `@staticflux/kit`).
Devtools: `globalThis.__STUDIO__` (injector, supervisor, telemetry records, violations, journeys).

## Architecture map

```
index.html → src/main.ts        inline mode detector (@staticflux/platform/detect-mode), then
           → src/boot-browser.ts createBrowserEnvironment → bootStudio → mountStudioUi
src/app/
  compose.ts     THE composition: every unit of every package + adapters (studioUnits, bootStudio)
  contracts.ts   shared declarations: tokens, capabilities, intents, URL bindings, slices, flags, meters, chunk ids
  routes.ts      typed routes / routable dialogs      policies.ts   gate policies (route, capability, ui-slot, workspace)
  endpoints.ts   typed endpoints + resources          surfaces.ts   messaging surfaces (confirm, upsell, share, banner, coach mark)
  features.ts    feature manifests + static chunk map chunks.ts     logical chunk declarations (also read by vite.config.ts)
  document.ts    lazy document runtime units          late.ts       post-boot units chunk (AI, WebMCP, warmup/advisors)
  deferred.ts   deferred unit groups (core `deferredUnits`): surfaces, keyboard, capabilities, resources,
                user-data, handoff, resource-cache — placeholders at boot, chunks in deferred/*.ts
  shell.ts       slots, workspaces, outlets, panel controller, UI root (applies the theme appearance to <html>)
  home.ts        observed docs.list (session-scoped cache)
  telemetry.ts   telemetry + memory/console sinks + journey tracker + violation collector (attached before boot)
  environment.ts / headless.ts   browser vs headless StudioEnvironment
src/adapters/    one file per package pair (see below)
src/features/    studio-desktop · studio-mobile · agent-chat · onboarding · settings · billing (one chunk each)
src/lib/         studio-logic.ts — logic shared by the two editor variants (not a feature)
src/ui/          app views (header, main, panel, inspector), block list, feature mount helper, controls.ts (kit
                 controls the app views lazy-load after boot)
src/worker/      document worker: protocol, worker-side host (engine + presence + mock co-editor), spawners
                 (spawn-browser.ts is a lazy shim; the real spawner is the spawn-worker.ts chunk)
src/mocks/       mock server (BFF session, docs, credits, flags), data routes, BFF endpoints, shared memory storage
src/test/        headless harness (boot, simulated BFF login round trip) and fixtures
e2e/             Playwright smoke (boot → navigate → open chat)
build/           boot-chunk.ts: Rolldown helper merging the boot closure into one chunk (vite.config.ts)
```

Boot: `bootApp` → critical units (platform facts, app profile, flag resolver and what they need:
session store, data client, storage registry, handoff) → core-ready → subsystems (router first
navigation, meter sync, workspace restore, locale ⇄ `?lang`, perf marks, post-boot) → running.
Off the boot path: feature chunks, the document runtime (+ worker), the late units chunk and the
deferred unit groups (`app/deferred.ts`), which load on first resolution of one of their tokens.

## Bundle budget

R12.7: total boot JS ≤ 150 KB gzip. Boot set = the entry chunk (`main.ts`, inline mode detector) +
the static closure of `boot-browser.ts` (`bootEntries`), as computed by the build report
(`dist/sf-build-report.json`, `boot[*].bootKb`, sum of per-file gzip).

| | before | after |
|---|---:|---:|
| boot JS, gzip (build report) | 197.8 KB | 145.8 KB → **149.1 KB** with the theme contract (A10) |
| boot JS, brotli | 173.6 KB | 123.4 KB |
| boot files | 17 | 3 (`index` 2.3 · `boot-browser` 0.4 · `boot` 143.0) |
| rendered (pre-minify) module code | 1002 KB | 797 KB |

Where the boot bytes are, per package (sum of per-module gzip from the bundle's rendered
modules — an attribution, not additive to the file total; measured with a throwaway Rolldown
`generateBundle` plugin that dumps `chunk.modules[id].code`):

| module group | before | after | Δ | what moved |
|---|---:|---:|---:|---|
| app (studio src) | 36.9 | 34.8 | −2.1 | capability/dialog wiring → deferred chunks |
| @staticflux/data | 23.9 | 12.1 | −11.8 | resource cache, user data → deferred; unused defs tree-shaken |
| @staticflux/runtime | 23.6 | 20.9 | −2.7 | resource manager → `studio/resources` |
| @staticflux/router | 21.5 | 20.5 | −1.0 | pure annotations |
| mobx | 16.5 | 16.5 | 0 | does not tree-shake (≈11.5 KB minified alone) |
| @staticflux/shell | 15.3 | 11.1 | −4.2 | command registry + palette → `studio/keyboard` |
| @staticflux/core | 14.2 | 14.8 | +0.6 | + `deferredUnits` support in the injector |
| @staticflux/loader | 14.3 | 7.6 | −6.7 | warmup/speculation/advisor no longer leak via `units.ts` |
| @staticflux/perf | 14.2 | 9.5 | −4.6 | unused detectors/metrics tree-shaken |
| @staticflux/gate | 13.1 | 13.3 | +0.2 | (meters stay: the engine needs them) |
| @staticflux/auth | 12.8 | 10.6 | −2.2 | pure annotations |
| @staticflux/messaging | 12.7 | 1.4 | −11.3 | surface manager, host, routable dialogs → `studio/surfaces` |
| @staticflux/ui | 12.1 | 12.1 | 0 | |
| @staticflux/storage | 11.8 | 11.8 | 0 | |
| @staticflux/platform | 11.6 | 11.2 | −0.4 | |
| lit (+ @lit/context) | 11.4 | 11.5 | 0 | |
| @staticflux/urlstate | 11.2 | 8.1 | −3.1 | pure annotations |
| @staticflux/a11y | 9.8 | 6.2 | −3.6 | shortcut registry → `studio/keyboard` |
| @staticflux/config | 9.7 | 9.7 | 0 | |
| @staticflux/i18n | 9.3 | 9.4 | 0 | (non-active catalogs were already lazy) |
| @staticflux/capabilities | 8.4 | 3.6 | −4.7 | registry → `studio/capabilities` (schema/defs stay: contracts) |
| @staticflux/handoff | 7.3 | 0.8 | −6.4 | handoff store → `studio/handoff` |
| @staticflux/worker | 3.3 | 0 | −3.3 | browser spawner → `spawn-worker` chunk |

What changed (deferring, not deleting — every vertical is still composed):

1. **Tree-shaking (framework).** `sideEffects: false` was truthful, but top-level `defineError` /
   `token(...).type()` / `unit(...)` / `defineMachine` / `metric.*` calls are side effects to a bundler.
   Factories now carry `/* @__NO_SIDE_EFFECTS__ */` and token/metric call sites `/* @__PURE__ */`
   (packages/core/AGENTS.md "Tree-shaking"): unused declarations drop out (≈ −11 KB).
2. **Token-only modules (framework).** Rolldown places whole modules: a boot module naming
   `SurfaceManagerToken` pulled every unit of `messaging/units.ts` (and their implementations) into
   boot. Tokens moved to `tokens.ts` (a11y, capabilities, data, handoff, messaging, shell), deferrable
   units to their own modules (`a11y/shortcuts-unit`, `shell/keyboard-units`, `runtime/resource-units`,
   `loader/warmup-units` + `loader/defaults`, `data/resources-unit` + `user-data-unit`). Public APIs unchanged.
3. **Deferred unit groups (framework + app).** Core `deferredUnits({ id, provides, load })` registers
   placeholders; the first resolution of a token imports the group's chunk, registers its units and
   resolves the real provider. Studio defers: surfaces (post-boot idle / first surface), keyboard
   (`<sf-shell>` idle), capabilities (first editor/assistant), resource manager, user data (first slice
   use; a logout before it loaded still wipes), handoff (login redirect carry; signed-in boots prewarm it),
   the session resource cache. Boot consumers use lazy/functional deps (reconnecting banner, intent hold,
   guest-draft hook, home docs).
4. **One boot chunk (build).** The vite-plugin emits feature chunks as entries, so Rolldown split every
   module shared with boot into ~15 common chunks (each gzipped alone). `build/boot-chunk.ts` computes,
   per binding, what boot uses and puts it in one `codeSplitting` group (≈ −6 KB, 17 → 3 files).
5. **Lazy worker spawner.** `spawn-browser.ts` imports the real spawner on the first spawn.

Theme contract (Instaflow M1 A10): `@staticflux/ui/theme` (contract, appearance) + the default theme cost ≈ 3.3 KB net — the
shell theme controller they replace left boot, kit controls on the app views load right after boot (`ui/controls.ts`),
and the kit surface layer stays in the deferred surfaces chunk.

Remaining 149.1 KB is what the first interactive frame runs: the framework runtime (core, runtime, DI,
router, auth, gate, config, data client, platform, urlstate, i18n, storage ≈ 120 KB attributed), Lit + MobX
(≈ 28 KB), shell/ui elements and the app composition + mock backend. Next candidates if the budget tightens:
gate meters (needs a lazy meter source in `@staticflux/gate`), perf conformance detectors (need a replay
of marks recorded before they load), error definitions (the packages' `errors.ts` modules — summaries + `fix` texts — are ≈ 17 KB of the attributed
boot gzip; a lazily loaded fix catalog would need a core API change).
The build fails in CI on a regression (`budgets.onViolation: 'error'` when `CI` is set).

## Adapters (which package pair each one bridges)

| File | Bridges | What |
|---|---|---|
| a11y-router | a11y ⇄ router | route-change focus + announcement |
| advisors-loader | advisors → loader | Markov next-chunk advisor ranks warmup candidates |
| auth-config | auth (+platform) → config | evaluation context (targeting key, mode) |
| auth-data | auth → data | user-data identity follows the session; logout wipes (loads the deferred user-data chunk if needed) |
| auth-gate | auth → gate | session + BFF claims (plan, entitlements) as facts |
| auth-router | auth → router | `auth-boundary` stage: guests → `/login` with `returnTo` |
| auth-runtime | auth ⇄ runtime | session change → `supervisor.refresh()` (epoch); per-principal session scope |
| capabilities-gate | gate → capabilities | decide port (agent subject distinct) + meter port (reserve/commit) |
| capabilities-messaging | messaging → capabilities | confirm port (stacked dialog) |
| capabilities-router | capabilities → router | `upgrade` denial opens `/d/upgrade` |
| capabilities-runtime | runtime → capabilities | activation port (`ensureActive`) |
| config-gate | config → gate | flags as facts |
| data-config | data → config | remote flag layer over the data client |
| document-worker | document ⇄ worker (+data) | supervised worker, replicas, projection, DocumentStore (lazy chunk) |
| gate-data | gate ⇄ data | meter backend over billing endpoints; balance sync |
| gate-loader | gate → loader | chunk gate (denied chunks never fetched, I-8) |
| gate-router | gate → router | `authorize` stage for `requires.gate` |
| gate-ui | gate → ui | `DecidePort` (slots, workspaces, surfaces) |
| handoff-auth | handoff → auth | guest draft carried through login (upgrade hook) |
| handoff-urlstate | handoff ⇄ urlstate | intent hold slot (lazy handoff store), login return port, intent restore stage (signed in) |
| i18n-urlstate | i18n ⇄ urlstate | sticky `?lang=`; `<html lang dir>` |
| loader-perf | loader → perf | LoAF script URL → chunk attribution |
| loader-router | router → loader | observe feature transitions; warm likely chunks after navigation |
| loader-runtime | loader ⇄ runtime | dev manifest, static-import strategy, feature host loading via chunk loader |
| messaging-router | messaging → router | `DialogSurfacePort` over the routable dialog bridge |
| perf-runtime | perf ⇄ runtime | mount → mark session; `ReadinessToken` reports marks to both |
| platform-gate | platform → gate | form factor / host / capabilities as facts |
| platform-loader | platform → loader | warmup facts + loader profile |
| platform-perf | platform → perf | device tier for budgets |
| platform-router | platform → router | per-mode variant predicate; profile change → `router.refresh()` |
| runtime-data | runtime → data | epoch source = app epoch; pause → transport pause |
| runtime-messaging | runtime → messaging | "Reconnecting…" while paused (functional surface manager) |
| runtime-router | runtime → router | feature driver mounting into the main outlet |
| runtime-urlstate | runtime → urlstate | URL sync in the frame scheduler |
| storage-shell | storage → shell/messaging | workspace/seen preference stores |
| storage-ui | storage → ui | appearance preference store (device: scheme, contrast, density, motion) |
| urlstate-router | urlstate ⇄ router | one shared history; intent capture/authorize plugins; flush hook |
| urlstate-runtime | urlstate → runtime | authorized intent activates its owner (chat opens the panel) |
| worker-core | auth/config/gate/platform → worker | core-context hub (lazy chunk) |
