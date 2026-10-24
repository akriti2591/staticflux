# StaticFlux — Requirements

> Status: **draft for review**. Captured from the design conversation of 2026-10-24.
> Mark up anything wrong; nothing in `packages/` gets built until this is agreed.
> Prior-art grounding: [`research/prior-art.md`](./research/prior-art.md). Architecture: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## 0. What StaticFlux is

- **A client-side-only TypeScript framework** for large single-page web applications, spanning many teams, packages and possibly many repos.
- **"Static" core, "flux" implementations.** A small, stable, versioned core of contracts and primitives. Everything else plugs in.
- **An ecosystem of building blocks.** Each package is usable on its own; they work best together. Opting in should be one line and immediately give value (e.g. observability for free).
- **Built on Lit** (web components) for UI and **MobX** (v7) for in-thread reactivity.
- **Inversion of control everywhere.** Plugin patterns are the primary API shape — for the framework's own packages *and* for feature teams. Units register capabilities; the core never knows about features.
- **Composition over inheritance.** No base-class hierarchies beyond what Lit itself requires.
- **Performance first** in every decision: fast boot, fast render, lazy everything, bounded memory.
- **Agent-first codebase.** Explicit, verbose, declarative, shallow abstractions, no magic strings, rules enforced by tooling — so both humans and AI agents know everything without assuming.

### Non-goals
- No server-side runtime (no SSR server, no API server). Backend contracts are defined; backends are mocked.
- Client-side gating is **not** a security boundary (see §6).
- No in-house CRDT algorithm (use a library behind an interface).

## 1. Cross-cutting principles (apply to every package)

| ID | Principle |
|---|---|
| P1 | **Type-safe end to end.** Misconfiguration is a compile-time or CI error, not a runtime surprise. No magic strings; tokens, flags, routes, capabilities are typed values. Declaration merging is the cross-package extension mechanism. |
| P2 | **Declare, don't wire.** Every logical unit declares what it *requires* and what it *provides*. Manifests are data, checked by types and by tooling. |
| P3 | **Granular units.** No god objects. A unit does one thing; fan-in/fan-out are measured and budgeted. |
| P4 | **Composition, not inheritance; plugins, not branches.** Experiments and variants are alternate bindings, never `if/else` in feature code. |
| P5 | **Everything observable.** Every unit, transition, resolution, request and decision emits telemetry through one vendor-neutral fabric. Devtools are a consumer of that fabric. |
| P6 | **Everything cancellable and disposable.** Every async operation takes an `AbortSignal`; every resource registers in a lifecycle-owned disposal scope. |
| P7 | **Budgets enforced from day one.** Bundle size, chunk size, boot time, activation time, memory, dependency fan-out — declared in manifests, enforced in CI, surfaced in devtools. |
| P8 | **Shallow abstractions.** At most one layer between a contract and its implementation. Inheritance depth ≤ 1. |
| P9 | **One version per app.** Every framework package is a singleton per app; no duplicate versions (including across federated modules). |
| P10 | **Accessible, localizable, testable by default.** These are base requirements, not add-ons (§14–16). |

## 2. Dependency injection (the core fabric)

- **R2.1** DI is the first thing bootstrapping starts; the lifecycle supervisor, observability and everything else are resolved through it.
- **R2.2** Units declare `requires` and `provides` using typed tokens. Applies to services, stores, clients, utilities **and UI components**.
- **R2.3** Units may declare themselves **critical to startup**; the app lifecycle knows exactly what "core ready" waits for.
- **R2.4** Every resolution is timed and traced (factory start, async init, waits, ready). Devtools show a **boot waterfall**; boot-time budgets name the offending unit.
- **R2.5** Compile-time guarantees: token→type correctness; composition fails to type-check if a required token has no provider; components can only use what they declared.
- **R2.6** Build-time guarantees (graph tool in CI): no cycles; scope rules respected; no undeclared/unused deps; monolith guards (fan-in, fan-out, provides-count, god-unit detection, layer violations).
- **R2.7** **Scopes:** app → session → workspace → route → feature → component. Shorter-lived units cannot be held by longer-lived ones (types + runtime check). Logging out disposes the session scope.
- **R2.8** **Component self-injection.** Each component injects its own dependencies; no prop-drilling of dependencies through parents. Resolution walks up the DOM to the nearest scope (Lit Context Protocol carries the injector handle).
- **R2.9** **Three kinds of component dependency:**
  - `render` — blocks render; placeholder until resolved; reactive.
  - `lazy` — non-blocking; arrives any time; reactive.
  - `functional` — behaviour (handlers, commands); non-reactive; resolved on first use, so its code loads on interaction.
- **R2.10** Async factories allowed; only `critical` units may block boot.
- **R2.11** Multi-providers (contribution lists) with explicit ordering.
- **R2.12** Override precedence: experiment > workspace > app > package default; every override visible in devtools.
- **R2.13** The dependency graph informs topological boot order, chunk boundaries (teams declare, graph validates and suggests), critical path and warmup tiers.
- **R2.14** No `reflect-metadata`, no legacy decorators.

## 3. Plugins & capabilities

- **R3.1** Every package and feature contributes through typed **contribution points** (routes, commands, menu items, shell slots, settings, flags, policies, telemetry sinks, agent tools…).
- **R3.2** Capabilities are registered declaratively in manifests; activation can be inferred from contributions (lazy until needed).
- **R3.3** Capabilities are machine-readable (name, input/output schema, policy), so the same registry serves the UI, the command palette and **AI agents** (§6.6).
- **R3.4** Untrusted third-party plugins (if ever) run only across an isolation boundary (iframe/worker). First-party feature modules run in-process.

## 4. Application lifecycle

- **R4.1** The app is a **supervisor** of subsystems (DI, renderer, workers, transports, stores, session, observability, shell). Each subsystem has its own state machine; app state is derived.
- **R4.2** App states: `starting → core-ready → running ⇄ degraded`, `paused`, `reinitializing`, `shutting-down → terminated`.
- **R4.3** App-wide commands: **pause, resume, abort, refresh, reinitialize, shutdown**, propagating to every subsystem and every worker.
  - pause: stores freeze, transports queue, schedulers stop, workers idle.
  - abort: one root signal cancels everything in flight.
  - refresh: epoch bump → stale old data, refetch active resources, drop late responses — **no page reload** (e.g. token changed).
  - reinitialize: tear down to core and re-boot without reload.
- **R4.4** Subsystem failure → `degraded` with restart policy (backoff, max intensity, then give up); dependents are notified they are impaired; each worker declares its fallback.
- **R4.5** Features may *request* app-wide commands; the shell decides via a policy plugin.
- **R4.6** Paused requests: per-request policy (queue/replay, reject); mutations never auto-replay unless declared idempotent.
- **R4.7** Refresh shows stale data by default (SWR), overridable per store.
- **R4.8** Full reload remains the escape hatch (e.g. framework version mismatch after deploy) and is an explicit lifecycle decision.

## 5. Feature lifecycle

- **R5.1** States: `declared → loaded → activated (logic) → mounted (UI) ⇄ hidden → unmounted → deactivated → evicted`. Logic and UI have independent lifetimes.
- **R5.2** `hidden` keeps DOM and state but freezes rendering and effects (own mechanism; browser freeze is Chromium-only).
- **R5.3** **Weight classes:** `cheap` (recreate), `warm` (keep logic alive), `heavy` (archive: snapshot to IndexedDB/OPFS, evict, rehydrate fast).
- **R5.4** Features declare a retention policy; a **resource manager** enforces budgets (LRU, memory pressure, device tier, active count). **Framework budgets win** over feature preferences.
- **R5.5** Disposal scopes (`DisposableStack`, polyfilled) own every subscription, timer, listener, port and request; deactivation disposes automatically.
- **R5.6** Features may depend on other features' published capabilities/stores; lifecycle is **ref-counted** (a dependency can't deactivate while a dependent is mounted).
- **R5.7** **Headless features** (no UI): background sync, notifications, agent-invocable capabilities.
- **R5.8** Features declare budgets (chunk size, activation time, memory) checked in CI and devtools.
- **R5.9** Features are not routes. A feature may be bound to zero, one or many routes, or to none (e.g. an agentic chat that edits documents owned by an editor feature).

## 6. Authentication, authorization & gating

### 6.1 Authentication
- **R6.1** Pluggable **identity providers**, all producing one session model: `bff-cookie` (recommended), `oidc/oauth-pkce`, `custom` (hand-rolled), `passkey`, `embed-host`, `guest`.
- **R6.2** Session states: `guest → authenticating → authenticated ⇄ refreshing → expired | revoked`; `embedded` is an authenticated flavour.
- **R6.3** **Logged-out (guest) and logged-in apps are the same app.** Boot never waits on auth unless the route requires it.
- **R6.4** Guest → logged-in upgrade carries guest state across via handoff.
- **R6.5** Multi-tab sync of session; single-flight refresh; token change triggers app-wide refresh (R4.3).
- **R6.6** **Embedding** (e.g. ChatGPT / MCP Apps): the host owns OAuth; the widget never holds a token; calls route through the host bridge. Embedded mode gets its own workspace preset and degraded platform profile (no SW/storage/popups as applicable).
- **R6.7** Any token validation in the browser is advisory only; the backend validates and exchanges.

### 6.2 Authorization & gating
- **R6.8** **Facts → declarative policies → compiled decision tables.** Facts from plugins: session, roles, plan, entitlements, cohorts/segments, flags, platform, region, host.
- **R6.9** **Fast:** decisions are synchronous O(1) lookups on the hot path; recompute only affected decisions on fact change; decisions are reactive.
- **R6.10** **Gate levels:** app, workspace, route, feature, capability (incl. agent tools), UI slot. Gate any of them for any set of users.
- **R6.11** Typed, **explainable** decisions: `allow | deny{ reason: login | upgrade | forbidden | unavailable, … }` with a trace; devtools show "why".
- **R6.12** Denied features' chunks are never fetched.
- **R6.13** Policies: code defaults per package + remote overrides (no deploy needed to gate a cohort).
- **R6.14** Revocation via refresh, server push, or 403 — all feed the same fact update.
- **R6.15** Offline: previously granted entitlements honoured until a grace expiry; new grants fail closed.
- **R6.16** **Client gating is UX, not security.** Server re-checks everything. Documented in every relevant AGENTS.md.
- **R6.17** **Agents** are distinct policy subjects with narrower delegated permissions; destructive agent actions require user confirmation policy.
- **R6.18** **Metered entitlements** (credits, tokens, requests, price): meters with unit, window, balance (server-authoritative, optimistic client view). Policies may reference meters; decisions may be `allow` with a cost. **Reserve → commit | release** for actions of unknown cost (AI calls). Denial reasons `quota | rate`. Low-balance and exhaustion surface through messaging. Credit models are plugins; only the primitives are in the framework.

## 7. Router & navigation

- **R7.1** **Async, cancellable navigation pipeline** with named stages: `resolve → exit → availability → transient → pre-auth → auth-boundary → post-auth → authorize → load → prefetch → enter → render → commit`.
- **R7.2** Exit guards can block on async work (e.g. saving to cloud); guards may mark themselves uninterruptible.
- **R7.3** Concurrent navigation: newest cancels older, except uninterruptible stages.
- **R7.4** Browser back/forward run through the same pipeline (Navigation API; History fallback).
- **R7.5** Nested routes; per-segment guards and chunks.
- **R7.6** Fixed named stages; plugins attach to stages; custom stages via `before:/after:` ordering.
- **R7.7** **Sub-route view state** (tabs/pills changing the UI inside one feature) runs a light pipeline without reactivating the feature.
- **R7.8** Code for a route loads only after auth/authorize stages pass.
- **R7.9** Typed paths and typed search params.

### 7.1 URL-state model
- **R7.10** Every URL part has a declared **kind** and **owner**:
  | Kind | Example | Owner | Behaviour |
  |---|---|---|---|
  | path | `/studio/doc/42` | router | full pipeline |
  | view | `?tab=comments` | feature store | light sub-route transition only |
  | dialog | `…/d/share` | messaging layer | open/close routable dialog |
  | intent (consume-once) | `?panel=chat&prompt=…` | declaring feature | digested at resolve, handed to owning store after authorize, stripped via `replace` |
  | sticky | `?workspace=…&lang=…&sf-debug` | declaring package | carried across navigations |
  | hidden | scroll, drafts, selection | store / handoff | never in URL; survives via handoff |
- **R7.11** Features **declare URL bindings** (key, schema, kind, owner store, push vs replace). A **URL-sync service** binds URL ⇄ stores bidirectionally (batched per frame). The router is not invoked for view/intent/sticky changes; stores don't know about the URL.
- **R7.12** URL key collisions across packages are a build-time error (typed declarations).
- **R7.13** Intents survive login redirects via handoff.
- **R7.14** **Intents may prefill but never auto-execute** (prompt-injection/phishing guard) unless a policy marks the intent safe.
- **R7.15** Marketing params (utm etc.) captured once into telemetry and stripped (default).

### 7.2 Dialog routing
- **R7.16** Routable dialogs use `/d/<key>` (app-level) or `<feature-path>/d/<key>` (feature-level).
- **R7.17** Opening a routable dialog runs a light pipeline: availability → authorize → lazy-load → enter.
- **R7.18** Dismiss = history back when opened in-app; `replace` to parent path when arrived via deep link.
- **R7.19** Dialogs are scope-bound: leaving the owning feature/route closes them; unsaved state registers an exit guard.
- **R7.20** At most one routable dialog in the URL; stacked dialogs above it are non-routable (default).
- **R7.21** Non-routable surfaces (confirmations, pickers, popovers) are scope-bound only.

## 8. Configuration & feature flags

- **R8.1** Each package declares its flags (key, type, default, owner, pre-auth-safe) in a contracts-only file.
- **R8.2** Any package can observe any flag by importing only the declaration (no runtime dependency on the owner).
- **R8.3** Vendor-neutral provider interface (OpenFeature-compatible).
- **R8.4** Flags are reactive; flag reads in components/business logic are banned by lint outside the binding layer (experiments = variant bindings, P4).
- **R8.5** Config layering: package default < app < workspace < remote < experiment < local dev override.

## 9. Data layer: stores, resources & transports

- **R9.1** **Transport-agnostic.** Fetch, SSE, WebSocket, host bridge, worker port, mocks — all behind one transport contract.
- **R9.2** **Resource kinds:** single-shot, paginated (cursor/offset), streamed, batched (DataLoader-style coalescing), subscriptions.
- **R9.3** Dedup, caching, stale-while-revalidate, optimistic updates, epochs (R4.3).
- **R9.4** Retry (full-jitter backoff, retry-if predicates) at exactly one layer; per-endpoint circuit breakers feed the supervisor.
- **R9.5** **Schema-first stores** (MobX inside), with serializable snapshots and patches (for workers, handoff, archive).
- **R9.6** UI stores are distinct from domain/client services; both are DI units.
- **R9.7** Mock backends in the example app follow the same contracts.

### 9.1 Persistent user data
- **R9.8** A user-data document with **typed per-feature slices** (key, schema, version, migrations, default). Features never collide and never read each other's slices directly.
- **R9.9** Slice scopes: `device | user | workspace | session`. Pluggable backends: memory → IndexedDB → remote sync contract (mocked). Offline-first, batched writes, per-slice conflict policy (LWW default or merge fn).
- **R9.10** Mandatory versioning + migrations on read; failed migration → defaults + report, never a crash.
- **R9.11** Logout flushes and (by default) wipes local `user`-scoped slices; per-app policy override. Guest slices may migrate on login via handoff.
- **R9.12** Per-slice storage budgets.

### 9.2 Unit readiness
- **R9.13** Resolution (instance exists) and readiness (initialized) are distinct states (see `LIFECYCLES.md` §4).
- **R9.14** `init()` runs once per scope instance; promise cached and shared; typed failure with retry policy.
- **R9.15** `refreshOn` declarations + app epoch drive automatic refresh; consumers keep last value during refresh.
- **R9.16** Hooks `onInjected / onReady / onRefresh / onFailed`, scope-bound, for **every unit** (stores, services, utilities, components).
- **R9.17** Generic dependency kinds for all units: `required` (ready before my init; `render` for components), `lazy` (reactive handle), `functional` (init on first call).

## 10. Async & error primitives

- **R10.1** Own `Result<T, E>` type with typed error kinds (`network | timeout | aborted | auth | forbidden | not-found | validation | conflict | unavailable | unknown`).
- **R10.2** Primitives: cancellable task, timeout, retry/backoff/jitter, circuit breaker, concurrency limiter, deferred, `settleAll`, signal composition (`AbortSignal.any` + fallback), single-flight, debounce/throttle (lifecycle-aware).
- **R10.3** Errors are observable and carry trace context.

## 11. Workers & shared state

- **R11.1** **Core context replicated to every worker:** session state, user, entitlements/decision tables, config/flags, platform facts, observability context.
- **R11.2** **One owner per store** (main thread by default); replicas are read-only; replica writes are intents sent to the owner.
- **R11.3** Snapshot handshake on spawn; versioned patches batched per frame; gap/epoch mismatch → resnapshot.
- **R11.4** Tolerates throttled/frozen background tabs.
- **R11.5** Lifecycle commands reach workers; workers are supervised subsystems.
- **R11.6** `traceparent` on every envelope; worker telemetry joins one timeline.
- **R11.7** **Raw tokens not replicated by default**; token broker on the owning side.
- **R11.8** Long-lived **document workers**: ECS document model + CRDT (Yjs behind a `DocumentCRDT` interface) for co-editing; main-thread UI and optional OffscreenCanvas renderer are projections.
- **R11.9** SharedWorker coordinator across tabs where available; Web Locks for leader election.
- **R11.10** Collaboration transport: client contract only, mocked.
- **R11.11** **Worker lifecycle** (`LIFECYCLES.md` §3): heartbeat-based health, respawn with backoff and intensity limit, state restoration after respawn, declared fallback on give-up; full visibility in app lifecycle and devtools.

## 11.1 Feature-needs-driven API design
- **R11.12** Before each package is built, the example features' manifests are written against it (`docs/FEATURE-NEEDS.md`); every API must trace to a feature need.
- **R11.13** All lifecycles are typed state machines with explicit valid transitions and cross-lifecycle invariants (`LIFECYCLES.md`); errors carry stable codes, suggested fixes, and live in a machine-readable catalog.

## 12. Performance, boot, loading & hydration

- **R12.1** **Boot scheduler** with priorities (critical → visible → idle → interaction) and fallbacks where `scheduler.postTask/yield` are missing.
- **R12.2** **Stable logical chunk IDs** + build manifest mapping to hashed files; manifests survive deploys.
- **R12.3** **Warmup tiers:** `critical` (SW precache), `likely` (idle background), `speculative` (intent: hover/viewport/prediction, network/device aware), `on-demand`.
- **R12.4** Hydration: partial/islands hydration of static or prerendered HTML **and** state rehydration from snapshots for instant boot.
- **R12.5** Module federation / import maps supported as loading strategies; host owns shared singletons.
- **R12.6** **Performance monitoring primitive:** Web Vitals per route epoch, long tasks / LoAF mapped to chunk IDs, boot waterfall, activation timing, memory sampling.
- **R12.7** Starting budgets (gzip; educated estimates, tuned from example-app measurements):

  | Item | Budget |
  |---|---|
  | `@staticflux/core` alone | ≤ 5 KB |
  | Framework runtime loaded at boot (core, runtime, DI, router, auth, gate, config, data, telemetry API) | ≤ 45 KB |
  | Lit + MobX | ~20 KB |
  | **Total boot JS** (framework + shell + app critical units) | **≤ 150 KB** (~500 KB raw) |
  | Feature initial chunk | ≤ 50 KB |
  | Lazy sub-chunk | ≤ 30 KB |
  | Heavy feature (declared exemption) | ≤ 200 KB, only after authorize |
  | Locale catalog per feature | ≤ 10 KB |

  Timing (mid-tier mobile, 4G-class, lab): core-ready ≤ 300 ms cold / 100 ms warm; app loading state ≤ 1.0 s / 300 ms; `feature.first-render` ≤ 1.8 s / 500 ms; `feature.interactive` ≤ 2.5 s / 700 ms; sub-route transition ≤ 150 ms / 100 ms.
- **R12.8** Budgets **ratchet**: CI proposes tightening when actuals beat them; loosening needs a reviewed change. Exemptions are declared in manifests with a reason.

## 13. Shell

- **R13.1** Layout regions (slots), theming via design tokens (CSS custom properties), light/dark/high-contrast.
- **R13.2** **Workspaces** (e.g. expert mode) are declarative config that rearranges/reconfigures features; may swap features; may be gated.
- **R13.3** Out of the box: notifications/toasts, modals/overlays, command palette, keyboard shortcuts, focus management, per-region error boundaries, skeletons, live-region announcements.

### 13.1 User messaging (one layer)
- **R13.4** A single **surface manager** owns every user-messaging surface: `dialog`, `sheet/drawer`, `popover`, `tooltip`, `toast`, `banner`, `coach-mark`, `inline-alert`. Features declare surfaces and request them; they never render overlays directly.
- **R13.5** One stacking model, focus/a11y behaviour, theming, motion (incl. reduced motion) for all surfaces.
- **R13.6** **Scope-bound lifetime**: every surface belongs to a scope (app/session/route/feature/view) and is dismissed when the scope ends — a surface can never outlive the page it belongs to.
- **R13.7** **Attention arbitration**: priorities and queues; toast concurrency caps; coach marks suppressed while dialogs/urgent toasts are up or the user is mid-task; banner dedup.
- **R13.8** Coach marks: declared targets, gating, seen-once persistence (per user via mocked contract, local cache), sequencing; wait for target visibility.
- **R13.9** Surfaces are gated (a denied premium dialog resolves to its upsell surface).
- **R13.10** Every surface emits shown/dismissed/dismiss-reason/dwell metrics through the declarative metrics model.

## 14. Localization (base requirement)

- **R14.1** Typed message catalogs per package (keys are typed values, not strings); ICU MessageFormat semantics (plurals, select, gender).
- **R14.2** Locale catalogs are lazy chunks with the same warmup tiers; no locale blocks boot beyond the active one.
- **R14.3** `Intl`-based formatting (dates, numbers, currency, relative time, lists) via a locale service.
- **R14.4** RTL support (logical CSS properties, `dir` handling in shell).
- **R14.5** Runtime locale switch without reload (reactive).
- **R14.6** CI checks: missing keys, unused keys, placeholder mismatches.

## 15. Accessibility (base requirement)

- **R15.1** Target WCAG 2.2 AA.
- **R15.2** Shell provides focus management (route change focus, modal focus trap, restore), skip links, live-region announcer, keyboard shortcut registry with conflict detection.
- **R15.3** Respect platform preferences: reduced motion, contrast, forced colors, color scheme.
- **R15.4** Automated a11y checks (axe) in component tests and CI.
- **R15.5** Placeholders/skeletons expose correct busy states (`aria-busy`).

## 16. Testing (base requirement)

- **R16.1** Every package ships unit tests (Vitest); browser-mode tests for components.
- **R16.2** DI makes everything testable: `createTestInjector()` with overrides; no global singletons.
- **R16.3** Test kits per package (mock transports, fake clock/scheduler, fake session, fake platform, in-memory worker bridge).
- **R16.4** Contract tests: every implementation of a contract runs the same shared suite.
- **R16.5** Example app has end-to-end tests (Playwright) over mock backends.
- **R16.6** CI runs: typecheck, lint, boundary checks, graph checks, size budgets, unit, a11y, e2e.

## 17. Observability & devtools

- **R17.1** Vendor-neutral, OpenTelemetry-shaped API (traces, metrics, logs, events); pluggable sinks; sampling.
- **R17.2** Automatic spans for DI resolution, lifecycle transitions, navigation stages, resource requests, gate decisions, worker messages, renders.
- **R17.3** Devtools panel built on the fabric: boot waterfall, dependency graph, lifecycle states, decision traces, store inspector, overrides, budget violations.
- **R17.4** Zero-config default (console/devtools sink) on opt-in.

### 17.1 Journey tracing (boot → navigation → feature)
- **R17.5** One **journey trace** per navigation, from first input to feature complete, with nested phase spans; parallel work is sibling spans; each phase reports total time **and critical path**.
- **R17.6** Phases: `app.boot` (`boot.core`, `boot.critical` per unit, `boot.shell-frame`) → `nav.pipeline` (one span per stage; chunk loads and prefetches inside) → `feature` (activation, render) → `view` (sub-route transitions).
- **R17.7** Feature marks: `feature.placeholder-shown`, `feature.first-render`, `feature.largest-render`, `feature.interactive`, `feature.complete`. Completeness defaults to: render deps resolved + initial resources settled + layout-stable window; features may supply their own readiness signal.
- **R17.8** Journey classification: start (`cold | warm | soft`), feature activation (`fresh | warm | archived`), code source (`network | http-cache | sw`), data source (`network | cache | snapshot`). Enables warm vs cold comparison per feature.
- **R17.9** Applies uniformly to routes, features, sub-routes and transitions between them.
- **R17.10** Feature paint marks are framework-measured (render commit + next frame, Element Timing where supported, own largest-element heuristic elsewhere) and labelled with their method; never conflated with browser LCP.
- **R17.11** App loading state (shell) and feature loading state (feature skeleton) are distinct layers with distinct timings.
- **R17.12** Journey marks can carry budgets (per feature, per device tier), enforced in e2e lab runs and flagged in devtools.

### 17.2 Verbosity
- **R17.13** Levels: `off` (compiled to no-ops) · `critical` (journey summary) · `standard` (phases, stages, chunks, resources) · `verbose` (DI resolutions, store actions, gate decisions, worker messages) · `debug` (everything).
- **R17.14** Level configurable per subsystem, per feature, and per journey (with sampling); switchable at runtime (devtools, URL/dev flag) without reload.
- **R17.15** Output destination is fully pluggable (OTel-shaped spans/metrics/logs); the framework only guarantees the data is generated.

### 17.3 Declarative metrics (own model, not Web Vitals)
- **R17.16** StaticFlux defines its **own performance model**. Browser Web Vitals may be collected as optional supplementary facts; they are never the source of truth.
- **R17.17** Metrics are **typed declarations** (`metric.counter | histogram | gauge | mark`), like DI tokens. No manual plumbing.
- **R17.18** Units declare `informs: [...]` (producer) and `reads: [...]` (consumer: devtools, budgets, sinks, features). Producers and consumers never import each other — only the declaration.
- **R17.19** Framework primitives inform built-in metrics automatically (DI, stages, chunks, resources, renders, lifecycle, workers). Opting in = full journey trace.
- **R17.20** Features declare readiness signals (`readiness: { firstRender, interactive, complete }`); journey marks are derived.
- **R17.21** Build-time check: read-but-never-informed = error; informed-but-never-read = warning.

## 18. Platform detection

- **R18.1** Capability-based detection: device class, OS, browser, input (touch/pointer/hover), network quality, memory/CPU tier, reduced motion, PWA/webview/embedded host.
- **R18.2** Platform facts feed gating, warmup and resource-manager decisions.

## 19. Handoff

- **R19.1** State that survives boundaries: reload, deep link, login redirect, tab/window, host↔embed; cross-device as a client contract only.
- **R19.2** Each handoff entry declares a lifetime: one-shot, session, TTL.
- **R19.3** Uses the same snapshot format as feature archive (R5.3).
- **R19.4** Sub-route → sub-route handoff of view state within a feature.

## 20. Tooling, repo & enforcement

- **R20.1** pnpm workspace monorepo; TypeScript project references; Vitest; tsup (or equivalent) builds.
- **R20.2** Root + per-package `AGENTS.md` (CLAUDE.md symlinked), with budgets/allowed deps generated from the same config CI enforces.
- **R20.3** Boundary enforcement (dependency-cruiser): features can't import features; only contract packages are shared; no deep imports; no cycles.
- **R20.4** size-limit budgets per package and per logical chunk.
- **R20.5** Custom lint rules: no direct flag reads outside bindings, no bare `addEventListener` without signal/scope, inheritance depth ≤ 1, no string tokens.
- **R20.6** `sf` CLI: graph check, budget report, manifest generation.

## 21. Example app

- **R21.1** A small app in the monorepo exercising every vertical, against mock services.
- **R21.2** Scenario: agentic chat (headless + UI) that edits mixed-media documents in an editor feature backed by a document worker; free vs premium gating; guest vs logged-in; expert workspace; embedded mode.

## 22. Open questions

1. ~~Final budget numbers~~ — starting values set in R12.7; tune from measurements.
2. Collaboration: multi-user over network vs local multi-tab only for v1 (R11.10 assumes contract + mock).
3. Workspaces swapping features vs reconfiguring only (R13.2 assumes both).
4. Worker↔worker direct channels vs via main thread (default: direct MessageChannel, brokered by main).
5. MobX store patching: hand-rolled recorder vs mobx-keystone (spike).
6. TypeScript 7 (tsgo) vs TS 5.x for custom tooling until 7.1 API lands.
