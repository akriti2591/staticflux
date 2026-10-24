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
```

Try it: `/` (guest welcome) → `/studio/doc/1?panel=chat&prompt=Add%20an%20image` (redirects to
`/login`; pick *Ada (free)* or *Grace (pro)*; the mock BFF "redirects" back with a real page
load and the chat prompt is prefilled) · `/onboarding/step/1` · `/settings` (theme, language
incl. Arabic/RTL, expert workspace) · `?sf-mode=web:compact` (mobile editor variant) ·
`?sf-flag=studio/ai-suggestions:false` · `?sf-debug` (console telemetry sink).
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
  shell.ts       slots, workspaces, outlets, panel controller, UI root   home.ts  observed docs.list (session-scoped cache)
  telemetry.ts   telemetry + memory/console sinks + journey tracker + violation collector (attached before boot)
  environment.ts / headless.ts   browser vs headless StudioEnvironment
src/adapters/    one file per package pair (see below)
src/features/    studio-desktop · studio-mobile · agent-chat · onboarding · settings · billing (one chunk each)
src/lib/         studio-logic.ts — logic shared by the two editor variants (not a feature)
src/ui/          app views (header, main, panel, inspector), block list, feature mount helper
src/worker/      document worker: protocol, worker-side host (engine + presence + mock co-editor), spawners
src/mocks/       mock server (BFF session, docs, credits, flags), data routes, BFF endpoints, shared memory storage
src/test/        headless harness (boot, simulated BFF login round trip) and fixtures
e2e/             Playwright smoke (boot → navigate → open chat)
```

Boot: `bootApp` → critical units (platform facts, app profile, flag resolver and what they need:
session store, data client, storage registry, handoff) → core-ready → subsystems (router first
navigation, meter sync, workspace restore, locale ⇄ `?lang`, perf marks, post-boot) → running.
Off the boot path: feature chunks, the document runtime (+ worker), the late units chunk.

## Adapters (which package pair each one bridges)

| File | Bridges | What |
|---|---|---|
| a11y-router | a11y ⇄ router | route-change focus + announcement |
| advisors-loader | advisors → loader | Markov next-chunk advisor ranks warmup candidates |
| auth-config | auth (+platform) → config | evaluation context (targeting key, mode) |
| auth-data | auth → data | user-data identity follows the session; logout wipes |
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
| handoff-urlstate | handoff ⇄ urlstate | intent hold slot, login return port, intent restore stage |
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
| runtime-messaging | runtime → messaging | "Reconnecting…" while paused |
| runtime-router | runtime → router | feature driver mounting into the main outlet |
| runtime-urlstate | runtime → urlstate | URL sync in the frame scheduler |
| storage-shell | storage → shell/messaging | theme/workspace/seen preference stores |
| urlstate-router | urlstate ⇄ router | one shared history; intent capture/authorize plugins; flush hook |
| urlstate-runtime | urlstate → runtime | authorized intent activates its owner (chat opens the panel) |
| worker-core | auth/config/gate/platform → worker | core-context hub (lazy chunk) |
