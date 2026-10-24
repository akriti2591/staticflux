# StaticFlux: Prior Art Survey

Status: research input, not a decision record. Compiled 2026-10-24.
Versions were checked against the npm registry (`registry.npmjs.org`, dist-tag `latest`) on 2026-10-24 unless noted. Browser support was checked against MDN/caniuse/vendor posts found through web search. **UNVERIFIED** marks claims I could not confirm from a primary source.

## 0. Findings that change current assumptions

| Assumption | Finding | Impact |
|---|---|---|
| "MobX 6 with 2022.3 decorators" | **MobX 7.0.0 shipped 2026-07-30; latest is 7.1.0 (2026-10-20).** MobX 7 drops legacy decorators and the non-Proxy fallback. Namespaced annotations become named exports (`observable.ref` becomes `observableRef`, and so on). `toJS` now includes `@observable accessor` fields (fixed in 7.1.0). | Target MobX 7. This fits the "no legacy decorators" rule. `mobx-utils` 6.1.1 still declares a peer of `mobx ^6`, so do not depend on its `deepObserve` for patches. |
| `@adobe/lit-mobx` as the Lit binding | Last release was 2.2.2 on 2024-01-02, and it is mixin-based. | Write a ~40 LOC `MobxController` (a ReactiveController around `Reaction`). Use lit-mobx only as a reference. |
| Signals as a future option | TC39 Signals is **still Stage 1**. `@lit-labs/signals` is 0.3.0 and depends on `signal-polyfill` 0.2.2, which has had no release since 2025-01. | MobX stays the right choice. Keep a thin reactivity port so signals can be added later. |
| Effect-TS as a reference | **Effect 4.0.0 went stable 2026-10-01** (now 4.0.6). It has zero dependencies and a rewritten core. | Effect 3 API docs and blog posts are now outdated. If we borrow Layer/Context ideas, borrow the v4 shapes. |
| TS toolchain | **TypeScript 7.0 (the Go-native compiler) is stable** (7.0.2, 2026-07-08). 6.0 deprecations are now hard errors, and the programmatic Compiler API is deferred to 7.1 (secondary source). | Custom TS transformers and compiler-API lint rules that need the JS API must pin `@typescript/typescript6` or wait for 7.1. Whether TS 7 still supports `experimentalDecorators`/`emitDecoratorMetadata` is UNVERIFIED. Our no-legacy-decorators rule avoids the question. |
| "Embed-host token" auth provider | In the OpenAI Apps SDK / MCP Apps model, **the host (ChatGPT) is the OAuth client and the MCP server is the resource server.** The widget iframe does not receive the access token. It calls tools through the host bridge (`tools/call` over postMessage, or `window.openai`). | The embed provider should be a *transport adapter* (calls go through the host bridge), not a token source. Passing tokens through tool metadata is a known anti-pattern because the token goes stale. |
| OAuth browser-apps BCP is "a draft" | It is now **RFC 10017 / BCP 212 (Aug 2026)**. | Cite the RFC. It ranks BFF > token-mediating backend > browser-only client. |
| Page Lifecycle freeze/resume as a cross-browser primitive | `freeze`/`resume` are **Chromium-only**. | The "hidden(frozen)" feature state must be our own app-level concept. Treat browser freeze as one optional signal among several. |
| `scheduler.yield` / `postTask` for the boot scheduler | `scheduler.yield` works in Chrome 129+ and Firefox 142+. **Safari has no support** and no announced timeline. | Ship a scheduler shim with a fallback (MessageChannel/setTimeout). |
| Speculation Rules for warmup | **Chromium-only.** Safari has a flag-only implementation, and Firefox has none. | Speculative tier is a progressive enhancement only. The SW-precache and `modulepreload` tiers must stand on their own. |
| SharedWorker on mobile | Chrome for Android re-enabled SharedWorker (around 148 beta, April 2026). MDN marks it **Baseline 2026** (May 2026). | SharedWorker can now host the multi-tab coordinator (for example the Notion pattern). Keep a BroadcastChannel + Web Locks fallback for older clients. |
| `using` / `Symbol.dispose` at runtime | **Not Baseline.** Safari support is partial at best (desktop 26.4 reportedly, iOS not; UNVERIFIED). | Transpile `using` down and polyfill `Symbol.dispose`/`DisposableStack`. Never rely on native support. |
| Yjs as the CRDT | Yjs stable is **13.6.33**. v14 is still a release candidate (rc.29, 2026-10-15). Automerge is **3.5.0** (2026-09-16), and its 3.x line cut memory use sharply. | Keep the CRDT interface. Yjs 13 now, with a planned v14 migration. Automerge 3 is a credible alternative. |

---

## 1. Dependency injection

### Angular hierarchical injectors
- **Idea:** Injectors form a tree: environment injectors (root/platform, lazy-route injectors) and element/node injectors. `inject()` resolves up the tree. Tokens are `InjectionToken<T>`, and providers use `useClass/useValue/useFactory/useExisting` plus `multi: true` for plugin-style collections. Route-level `providers` create a scope tied to a lazily loaded route.
- **Status:** Mature. `@angular/core` 22.2.3. The functional `inject()` style is now idiomatic, and constructor decorators are optional.
- **Adopt:** Typed `InjectionToken<T>`. Multi-providers for contribution collections. Route-scoped environment injectors as the model for our route/feature scopes. The resolution modifiers `optional`/`self`/`skipSelf`/`host`.
- **Avoid:** Two parallel hierarchies (element vs environment), whose resolution order is notoriously hard to explain. Also avoid implicit `providedIn: 'root'` tree-shaking magic. Agents and humans cannot tell where something is bound.
- **Sources:** https://angular.dev/guide/di/hierarchical-dependency-injection , https://angular.dev/api/core/InjectionToken

### Effect-TS Context / Layer
- **Idea:** A service is a typed tag (`Context.Tag`/`Context.Service` in v4). A `Layer<ROut, E, RIn>` is a typed, memoized constructor that builds services from other services, with resource acquisition and release scoped. Missing dependencies are **compile-time errors**, because the requirements type parameter must reach `never`.
- **Status:** Effect **4.0 stable 2026-10-01** (npm `effect` 4.0.6). v3 is `prev` 3.22.4. v4 renamed and simplified several Context APIs, so check v4 docs.
- **Adopt:** (a) Track a module's *requirements* in its type and check the full graph at the app-composition site, so a missing binding fails at compile time. (b) Layers as memoized factories with scoped finalizers. This maps directly to `Symbol.asyncDispose`. (c) A graph build that is pure data, so the graph can be printed and inspected.
- **Avoid:** Taking a dependency on the whole Effect runtime as the DI substrate. It brings a large conceptual surface, a fiber runtime, and churn from the v3 to v4 break. Many contributors do not read Effect fluently.
- **Sources:** https://effect.website/docs/requirements-management/layers/ , https://www.npmjs.com/package/effect

### InversifyJS
- **Idea:** A classic container with `bind(id).to(Class).inSingletonScope()`, child containers, and container modules. It is decorator-driven (`@injectable`, `@inject`).
- **Status:** v8.2.3 (2026-07). Split into `@inversifyjs/core`/`container`. The 7.x docs still require `experimentalDecorators` + `emitDecoratorMetadata` (reflect-metadata). Whether v8 dropped that requirement is UNVERIFIED.
- **Adopt:** Container modules with load/unload, which map to our lazy chunk modules. Binding "when" constraints are prior art for variant bindings, but ours should be data, not predicates.
- **Avoid:** Legacy parameter decorators and reflect-metadata, which conflict with our no-legacy-decorators rule. Also avoid string/symbol identifiers without type linkage.
- **Sources:** https://inversify.io/docs/faq/requirements , https://inversify.io/docs/7.x/guides/migrating-from-v6/

### tsyringe
- **Idea:** A minimal Microsoft container: `@injectable`, `container.register`, child containers, `Lifecycle.ContainerScoped`.
- **Status:** 4.10.0 (2025-04). Low activity. Requires reflect-metadata and legacy decorators.
- **Adopt:** The small API surface as a target for "shallow abstraction".
- **Avoid:** All of it as a dependency, because it uses legacy decorators and reflect-metadata.
- **Sources:** https://github.com/microsoft/tsyringe

### Lit Context protocol (`@lit/context`)
- **Idea:** An implementation of the W3C Web Components Community Group **Context Community Protocol**. Consumers dispatch a bubbling `context-request` event with a context key. The nearest provider in the DOM answers with a value, and optionally a subscription. `ContextProvider`/`ContextConsumer` are ReactiveControllers. `@provide`/`@consume` decorators support standard decorators.
- **Status:** `@lit/context` 1.1.6 (2025-07). Stable and low-churn. The protocol is interoperable across web-component libraries.
- **Adopt:** Use it as the **component-scope bridge only**. The DOM tree supplies the component scope, and a context value carries a child-injector handle (`Injector`), not individual services. This gives DOM-shaped scopes for slots and portals without inventing a new mechanism.
- **Avoid:** Using context as the general DI system. It is DOM-bound, synchronous only on attach, and unavailable in workers. Also avoid per-service contexts, which cause a combinatorial number of context keys.
- **Sources:** https://lit.dev/docs/data/context/ , https://github.com/webcomponents-cg/community-protocols/blob/main/proposals/context.md

### VS Code instantiation service
- **Idea:** `createDecorator<IFoo>('foo')` returns a value that is both the type token and a parameter decorator. `ServiceCollection` holds descriptors (`SyncDescriptor`), which give lazy instantiation. `createChild()` creates scopes. Cycles are detected and reported with the graph. `InstantiationType.Delayed` creates a proxy until first use.
- **Status:** Mature and internal to VS Code. Not published as a supported library.
- **Adopt:** Token = identifier + type in one value. Lazy/delayed instantiation by default. Cycle detection with an explicit printed path. "Services are interfaces; implementations are registered by contributions" (`registerSingleton`).
- **Avoid:** Constructor *parameter decorators*. They are legacy-only, and Stage 3 decorators have no parameter decorators. Also avoid the global `registerSingleton` side-effect registry, which is order-dependent and invisible in manifests.
- **Sources:** https://github.com/microsoft/vscode/blob/main/src/vs/platform/instantiation/common/instantiation.ts , https://github.com/microsoft/vscode/wiki/Source-Code-Organization

**DI synthesis:** Typed tokens (`token<T>('id')`). Factory-function providers declared in manifests: `{ provide, deps: [tokA, tokB], factory }`, no decorators. Scope tree app > session > route > feature > component. The component scope is bridged by `@lit/context`. Lazy providers are bound to logical chunk IDs. Experiments are `variants: { [variantKey]: provider }` resolved against flag state at scope creation. A requirements type is checked at composition, Effect-style, and cycles are detected VS Code-style.

---

## 2. Plugins

### VS Code contribution points & activation events
- **Idea:** `package.json` holds a declarative `contributes` block (commands, menus, views, configuration, keybindings, and more). The host renders these **without loading extension code**. `activationEvents` (`onCommand`, `onView`, `onLanguage`, `workspaceContains`, `onStartupFinished`) decide when code loads. Since VS Code 1.74, activation events are inferred from contributions. Extensions run in an extension-host process.
- **Status:** Mature. The canonical prior art.
- **Adopt:** **The manifest is the primary artifact.** Shell, router, and gates read typed manifests to render menus, routes, and slots before feature code loads. Activation triggers come from contributions (route match, slot visible, command invoked, capability requested). Add `onStartupFinished`-style idle activation for the "likely" warmup tier. Keep a JSON schema per contribution point, and validate it in CI.
- **Avoid:** `*` (eager) activation; forbid it with a lint/budget. Avoid untyped `when`-clause string expressions. Use a typed expression AST instead, so the authorization compiler can analyze it.
- **Sources:** https://code.visualstudio.com/api/references/contribution-points , https://code.visualstudio.com/api/references/activation-events

### Backstage plugin system (new frontend system)
- **Idea:** Plugins are `createFrontendPlugin({ pluginId, extensions })`. **Everything is an extension** (pages, nav items, APIs, themes). An extension declares an `attachTo` point and typed inputs/outputs ("extension data refs"). The app is a tree of extensions configured in `app-config.yaml`, where extensions can be enabled, disabled, or reconfigured **without code**. APIs (DI) are themselves extensions.
- **Status:** `@backstage/frontend-plugin-api` 0.18.2 (pre-1.0). Backstage 1.49 is the "release candidate for 1.0 of the New Frontend System" and the default for new apps. Final 1.0 is UNVERIFIED.
- **Adopt:** A typed attach-point graph (`attachTo: { id, input }`). Typed extension data refs for inputs/outputs. Config-driven enable/disable/override of any extension, which is the basis for workspaces like "expert mode". Experiments can also target this configuration. Treat DI services as just another extension kind.
- **Avoid:** React coupling, and the long dual-system migration. Plan for one plugin model from day one. Also avoid YAML as the only override channel. Keep overrides typed TS, optionally generated from data.
- **Sources:** https://backstage.io/docs/frontend-system/ , https://backstage.io/docs/frontend-system/building-plugins/index , https://backstage.io/docs/releases/v1.49.0/

### Figma plugin sandbox
- **Idea:** Plugin logic runs in a **QuickJS-compiled-to-WASM sandbox** on the main thread. It has the document API but no DOM and no network. UI runs in a separate iframe with browser APIs but no document access. The two halves talk over `postMessage`. Figma moved to QuickJS after Realms-shim escapes (secondary source).
- **Status:** Production. `@figma/plugin-typings` 1.142.0.
- **Adopt:** For third-party or untrusted plugins, use capability-scoped APIs across a message boundary. Treat messages from the UI side as untrusted input, and validate them with a schema. Use the same discipline for host-embed messages.
- **Avoid:** In-realm JS sandboxing (Realms/SES shims) as a security boundary for untrusted code. Only process/iframe/WASM isolation is credible. First-party feature teams do not need sandboxing. Do not pay that cost for them.
- **Sources:** https://www.figma.com/plugin-docs/how-plugins-run/ , https://www.figma.com/blog/how-we-built-the-figma-plugin-system/ , https://macwright.com/2024/03/29/figma-plugins

---

## 3. Lifecycle

### Erlang/OTP supervision
- **Idea:** Supervisors own child specs `{id, start, restart: permanent|transient|temporary, shutdown, type}` and a strategy (`one_for_one`, `one_for_all`, `rest_for_one`). They apply **restart intensity** limits (`intensity`/`period`) and escalate to the parent when exceeded. Shutdown is ordered in reverse start order, with timeouts. "Let it crash" plus clean restart beats defensive recovery.
- **Status:** A decades-mature design pattern.
- **Adopt:** Declarative child specs per subsystem. Restart strategies and intensity windows, with escalation from a subsystem to the app's degraded state and then to a full refresh. Reverse-order shutdown with per-child timeouts (AbortSignal.timeout). `rest_for_one` for dependency chains (transport > stores > session). Map OTP restart to our `reinitializing` state and the epoch bump.
- **Avoid:** Restarting with stale state. Each restart must start a fresh disposal scope and epoch. Avoid unbounded restart loops.
- **Sources:** https://www.erlang.org/doc/system/sup_princ.html , https://www.erlang.org/doc/apps/stdlib/supervisor.html

### XState v5 actors
- **Idea:** Everything is an actor (`createActor`). Machines use `setup({ types, actions, guards, actors })` for strong typing, `fromPromise`/`fromCallback`/`fromObservable` for side-actors, and spawn/invoke with a system registry. `getPersistedSnapshot()` persists and restores a machine **including its child actors**. The inspection API powers visual devtools.
- **Status:** `xstate` 5.33.3 (2026-10-17). v6 is in alpha (6.0.0-alpha.70, 2026-10-19), so expect API movement in 2027.
- **Adopt:** Model the app supervisor and feature lifecycle as explicit statecharts with typed events. The states (declared, loaded, activated, mounted, hidden, unmounted, deactivated, evicted) are a natural machine. Use persisted snapshots for "handoff" and the inspection protocol for devtools. Consider XState for the *supervisor* only.
- **Avoid:** XState as the general store or reactivity layer, which would duplicate MobX. Avoid deep v5 API coupling given v6. Wrap it behind our own lifecycle interfaces, or hand-roll small typed machines.
- **Sources:** https://stately.ai/docs/actor-model , https://stately.ai/docs/persistence , https://www.npmjs.com/package/xstate

### Page Lifecycle API
- **Idea:** States: active, passive, hidden, frozen, discarded. `freeze`/`resume` events, and `document.wasDiscarded`. Frozen pages stop freezable task queues (timers, fetch callbacks). The bfcache adds `pageshow`/`pagehide` with `persisted`.
- **Status:** `freeze`/`resume`/`wasDiscarded` are **Chromium-only** (Chrome 68+). `visibilitychange` and `pagehide`/`pageshow` are universal.
- **Adopt:** Feed `visibilitychange`, `pagehide`/`pageshow(persisted)`, `freeze`/`resume` (where present), and `wasDiscarded` into the supervisor as **inputs** to app-wide pause/resume. Flush observability and persist handoff state on `visibilitychange: hidden`, not on `unload`. Make the app bfcache-eligible: no `unload` handlers, and close BroadcastChannel/WebSocket on `pagehide`.
- **Avoid:** `unload`/`beforeunload` for state saving, which is unreliable and blocks the bfcache. Do not assume a freeze event will arrive.
- **Sources:** https://developer.chrome.com/docs/web-platform/page-lifecycle-api , https://web.dev/articles/bfcache

### React Activity (formerly Offscreen)
- **Idea:** `<Activity mode="visible|hidden">` keeps a subtree's state and DOM while it is hidden. **Effects are cleaned up on hide** and re-run on show. Hidden work runs at lowest priority, which enables pre-rendering of likely-next screens.
- **Status:** Stable in React 19.2 (Oct 2025).
- **Adopt:** The precise semantics for our `hidden(frozen)` state. Keep the DOM and state. Dispose *subscriptions/effects* (MobX reactions, timers, sockets) via the component's disposal scope on hide, and re-create them on show. Pre-render "likely next" features in hidden mode at idle priority.
- **Avoid:** Keeping reactions live while hidden, which wastes CPU and leaks memory. Avoid unbounded hidden caches. Use LRU plus weight classes, and evict heavy features to IndexedDB.
- **Sources:** https://react.dev/reference/react/Activity , https://react.dev/blog/2025/10/01/react-19-2

---

## 4. Router

### Ember router transitions
- **Idea:** A `Transition` object is a first-class, abortable, retryable, promise-like value. Route hooks run in order: `beforeModel` > `model` > `afterModel` > `redirect` > `setupController`. On exit, `willTransition` runs. The process can be stopped with `transition.abort()`, saved, and replayed later with `transition.retry()`, which is the canonical login-redirect pattern. Loading and error substates are resolved hierarchically.
- **Status:** Mature. `ember-source` 7.3.1.
- **Adopt:** **A transition is a first-class, serializable value that can be retried.** Store an aborted transition as a "pending intent" across a login redirect or reload (handoff), then `retry()` it. Hierarchical loading/error substates map to layout slots.
- **Avoid:** Implicit, run-loop-coupled hook ordering, and controller singletons that keep state across routes.
- **Sources:** https://guides.emberjs.com/release/routing/preventing-and-retrying-transitions/ , https://api.emberjs.com/ember/release/classes/Transition

### Angular guards / resolvers
- **Idea:** Functional guards: `canMatch` (decides whether the route config applies at all, which **prevents lazy chunk loading**), `canActivate`, `canActivateChild`, `canDeactivate`, and `resolve`. Guards return `boolean | UrlTree | RedirectCommand` (a typed redirect) and run inside the route's injection context.
- **Status:** Mature (Angular 22).
- **Adopt:** `canMatch` semantics for **gating before chunk load**, which matches our "gating controls chunk loading". Guards return typed results (`allow | redirect(target, {transient}) | deny(reason)`) rather than throwing. Guards resolve via the route's DI scope.
- **Avoid:** Guard ordering that runs in parallel and then resolves by priority, which is subtle and hard to trace. Use named sequential stages with explicit parallelism inside a stage.
- **Sources:** https://angular.dev/guide/routing/route-guards , https://angular.dev/api/router/CanMatchFn , https://angular.dev/api/router/RedirectCommand

### TanStack Router
- **Idea:** Fully type-safe route tree, search params validated by schema, and route context inherited down the tree. `beforeLoad` runs **serially** top-down (auth checks, context injection, `throw redirect()`), and `loader`s then run **in parallel**. It has built-in SWR caching of loader data (`staleTime`, `gcTime`), preloading on intent (hover/viewport), and `pendingMs`/`pendingMinMs` to avoid flashes.
- **Status:** `@tanstack/router-core` 1.171.x. Very active.
- **Adopt:** A serial-guard / parallel-load split. Search params typed as validated state; sub-route view-state lives in typed search/hash params so features need no reactivation. Preload-on-intent tied to our warmup tiers. Pending-UI timing thresholds. Route context derived from parent context (DI scope).
- **Avoid:** `throw redirect()` control flow. Return Results instead. Avoid code-generated route trees that tie routes to the file system; our routes come from manifests. Avoid React-bound APIs.
- **Sources:** https://tanstack.com/router/latest/docs/framework/react/guide/data-loading , https://tanstack.com/router/latest/docs/framework/react/guide/authenticated-routes , https://tanstack.com/router/latest/docs/framework/react/guide/preloading

### Navigation API
- **Idea:** `navigation.addEventListener('navigate', e => e.intercept({ handler, precommitHandler }))` gives one interception point for links, forms, back/forward, and `navigation.navigate()`. It also provides `navigation.entries()`, per-entry `getState()`, `e.signal` for abort, `navigation.transition`, and `navigatesuccess`/`navigateerror`.
- **Status:** **Baseline Newly available since January 2026** (Chrome 102+, Firefox 147+, Safari 26.2+). Caveat: Safari reportedly lacked `precommitHandler` as of May 2026 (InfoQ). Current status UNVERIFIED.
- **Adopt:** Build the router on the Navigation API, with a small History API fallback for older browsers. Use `e.signal` as the pipeline's AbortSignal. Pre-commit stages (resolve, guards, auth, lazy load) map to `precommitHandler` where available, and post-commit stages (enter, render) map to `handler`. Per-entry state is the place for view-state handoff.
- **Avoid:** Depending on `precommitHandler` without feature detection. Avoid using `navigation.entries()` state as durable storage, since it does not survive session loss.
- **Sources:** https://developer.mozilla.org/docs/Web/API/Navigation_API , https://web.dev/blog/web-platform-01-2026 , https://www.infoq.com/news/2026/05/navigation-api-browser/

---

## 5. Data

### TanStack Query
- **Idea:** Key-addressed cache with SWR (`staleTime`, `gcTime`). Request dedup. Retries with exponential backoff. Refetch on focus/reconnect. `AbortSignal` passed to the query function. Infinite queries. Optimistic mutations with rollback. Structural sharing. A framework-agnostic `query-core`.
- **Status:** `@tanstack/query-core` 5.104.x. Mature and very widely used.
- **Adopt:** Semantics and vocabulary: query keys, staleTime/gcTime, the `fetching` vs `pending` distinction, structural sharing, focus/online managers. Consider using `query-core` directly as the cache engine under our resource abstraction, with a MobX adapter (an observer driven by a `QueryObserver`).
- **Avoid:** Arrays of strings as keys with no typing. Use typed key factories. Avoid the implicit global QueryClient; inject it per scope. Its error model is exception-based, so wrap it into Result.
- **Sources:** https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults , https://tanstack.com/query/latest/docs/reference/QueryCache

### DataLoader
- **Idea:** Batch every `load(key)` within a tick into one `batchLoadFn(keys)` call that returns values in the same order. Includes a per-request memoization cache.
- **Status:** 2.2.3 (2024-12). Stable and feature-complete.
- **Adopt:** The batched resource kind: a configurable batch window (microtask, frame, or ms), `maxBatchSize`, and per-key results returned as a `Result[]` so one failure does not fail the whole batch.
- **Avoid:** A long-lived DataLoader cache. It is request-scoped by design; let the SWR layer own caching.
- **Sources:** https://github.com/graphql/dataloader

### Replicache / Zero
- **Idea:** Replicache: client-side mutators run optimistically against a local KV store. The server is authoritative. **Pull returns patches plus a cookie, and pending local mutations are rebased** on the confirmed state. Zero is its successor: query-driven sync of a Postgres subset (ZQL), incremental view maintenance on the client, and permissions evaluated on the server.
- **Status:** **Zero 1.0 (mid-2026), now 1.11.x.** Replicache 15.3.0 (2025-07) is **in maintenance mode** with no new features.
- **Adopt:** Our store replication protocol should follow the Replicache model: **versioned snapshot + patch log + cookie/version, plus named mutators replayed and rebased**. A single owner per store is analogous to the server being authoritative. Workers send mutation *intents* to the owner instead of writing directly.
- **Avoid:** Replicache itself (maintenance mode). Avoid Zero as a dependency unless the backend is Postgres and we accept its server component. Our scope is client-only.
- **Sources:** https://doc.replicache.dev/concepts/how-it-works , https://zero.rocicorp.dev/docs/release-notes/1.0 , https://www.infoq.com/news/2026/06/zero-version-1/

### Linear sync engine
- **Idea:** Based on a public reverse-engineering study that Linear's CTO reportedly endorsed. Models are declared with decorators, metadata goes in a ModelRegistry, and objects are **MobX-observable** in an in-memory object pool. The client bootstraps from IndexedDB, hydrates lazily, and syncs via monotonically increasing `lastSyncId` **delta packets**. Optimistic transactions are applied in memory, and IndexedDB is updated only on server confirmation. Conflicts use last-writer-wins with rebase, not CRDTs.
- **Status:** Proprietary. All details come from secondary/reverse-engineered sources.
- **Adopt:** Strong validation that **MobX + a model registry + versioned deltas + IndexedDB** scales to a large production client. Use a model registry with explicit schemas (needed for patch serialization). Use lazy hydration of heavy collections. Use a monotonically increasing sync ID per store as the patch version.
- **Avoid:** Legacy-decorator-based model metadata. Use Stage 3 decorators with `context.metadata`, or explicit schema objects. Avoid CRDTs for non-document stores; LWW + rebase is simpler and enough.
- **Sources:** https://github.com/wzhudev/reverse-linear-sync-engine , https://linear.app/now/scaling-the-linear-sync-engine (talk/blog; UNVERIFIED URL)

---

## 6. Workers

### Comlink
- **Idea:** ES6 Proxy-based RPC over `postMessage`. `Comlink.wrap(worker)` makes a remote object look local and async. `Comlink.transfer()` handles transferables, `Comlink.proxy()` handles callbacks, and transfer handlers are pluggable.
- **Status:** 4.4.2 (2024-11). Stable but slow-moving.
- **Adopt:** Transfer handlers for custom serialization. Use the RPC style for *commands* to document workers.
- **Avoid:** Comlink as the store replication mechanism. Proxy RPC hides message boundaries, cost, and ordering, which goes against "explicit abstractions". Use explicit typed message channels with schemas, versions, and trace context. Comlink is fine for leaf RPC.
- **Sources:** https://github.com/GoogleChromeLabs/comlink

### Figma multiplayer
- **Idea:** A server-authoritative, CRDT-*inspired* design, explicitly not a full CRDT. The document is a map of objects to properties with **last-writer-wins per property** decided by the server. Fractional indexing orders children, and reparenting is validated server-side to prevent cycles. Clients apply changes optimistically and discard their own unacknowledged changes when conflicting server updates arrive.
- **Status:** Production (2019 post, still the reference).
- **Adopt:** For ECS document workers, use **per-component-property LWW** plus fractional indexing for ordering. This is simpler than a general CRDT if a server is authoritative. Keep the CRDT interface but allow an LWW implementation.
- **Avoid:** A text-CRDT for structured, non-text data when LWW is enough.
- **Sources:** https://www.figma.com/blog/how-figmas-multiplayer-technology-works/ , https://www.figma.com/blog/realtime-editing-of-ordered-sequences/

### Yjs vs Automerge
- **Idea:** Yjs is a YATA-based CRDT with shared types (Map/Array/Text/XmlFragment), very fast binary updates, `y-protocols` (sync/awareness), and providers (y-websocket, y-indexeddb, y-webrtc). Automerge is a JSON-like CRDT with full history, a Rust core compiled to WASM, and `automerge-repo` for networking and storage.
- **Status:** **Yjs 13.6.33 stable. v14 is still RC (14.0.0-rc.29, 2026-10-15)**, so plan a migration. **Automerge 3.5.0** (2026-09-16). Automerge 3 cut memory use dramatically (a reported ~700 MB to ~1.3 MB on a large text doc, secondary source). 3.5 adds per-change author strings.
- **Adopt:** **Yjs behind a `DocumentCRDT` interface** for text, rich text, and editor bindings (ecosystem: ProseMirror/TipTap/Lexical/CodeMirror bindings), plus awareness. Automerge is the alternative where full history or time travel is a product requirement.
- **Avoid:** Leaking `Y.*` types into feature code. Avoid building on Yjs v14 RC APIs before a stable release. Avoid storing UI state in the CRDT.
- **Sources:** https://github.com/yjs/yjs/releases , https://github.com/automerge/automerge/releases , https://automerge.org/blog/automerge-3/ (UNVERIFIED URL)

### Notion: SQLite WASM + OPFS
- **Idea:** Official SQLite WASM persists through OPFS (sync access handles, **workers only**). One dedicated worker per tab. A **SharedWorker elects the "active" tab** that owns the DB connection, and other tabs route queries through it. **Web Locks** detect tab closure and trigger re-election. Notion reported ~20% faster navigation.
- **Status:** Production at Notion. `@sqlite.org/sqlite-wasm` 3.54.1-build1 (2026-10).
- **Adopt:** This exact topology for the multi-tab store owner and heavy-feature archive: SharedWorker as router, Web Locks for leadership and liveness, a single writer. SharedWorker is now Baseline 2026, including Chrome Android.
- **Avoid:** Assuming OPFS sync handles are available on the main thread. Avoid multiple writers. Notion reported early corruption issues before the single-writer design.
- **Sources:** https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite , https://sqlite.org/wasm/doc/trunk/persistence.md

### ECS libraries
- **Idea:** bitECS uses data-oriented SoA TypedArray components, which serialize cheaply and can be transferred or shared via SharedArrayBuffer. Koota (pmndrs) is a traits/queries ECS with a better DX. Miniplex is object-based and simple, but stale.
- **Status:** bitECS 0.4.0 (2025-12, major API rewrite from 0.3). Koota 0.6.6 (2026-04). Miniplex 2.0.0 (2023), effectively unmaintained.
- **Adopt:** bitECS-style SoA storage for large, numeric-heavy documents (canvas/diagram) inside document workers. Component tables map to snapshot/patch columns. Koota is worth a spike for ergonomics.
- **Avoid:** Using an ECS for app/UI state. Avoid SharedArrayBuffer unless we commit to COOP/COEP cross-origin isolation, which constrains embeds such as the ChatGPT iframe.
- **Sources:** https://github.com/NateTheGreatt/bitECS , https://github.com/pmndrs/koota

### SharedWorker support
- **Status:** **Baseline 2026** per MDN. Chrome for Android re-enabled it around Chrome 148 (2026), and an `extendedLifetime` option appears in recent Chromium. Exact first stable Android version is UNVERIFIED (caniuse rows disagree: 151 vs 154).
- **Adopt:** SharedWorker as the cross-tab coordinator with feature detection. Fall back to leader election via Web Locks + BroadcastChannel.
- **Sources:** https://developer.mozilla.org/docs/Web/API/SharedWorker , https://caniuse.com/mdn-api_sharedworker

---

## 7. Async & errors

### Effect-TS (as an error/async model)
- **Idea:** `Effect<A, E, R>` gives typed errors, structured concurrency (fibers, interruption), `Schedule` combinators for retry/backoff/jitter, `Scope` for resources, and built-in tracing spans.
- **Status:** 4.0 stable (2026-10-01).
- **Adopt:** Ideas only. Typed error channel. Interruption = AbortSignal. Retry policies as composable values (`Schedule.exponential` + jitter + `recurs`). Spans attached to every operation.
- **Avoid:** Mandating Effect across all packages. It is a full paradigm, and agent and contributor fluency is uneven. Allow it *inside* a package if a team wants it.
- **Sources:** https://effect.website/docs/error-management/retrying/ , https://effect.website/docs/scheduling/built-in-schedules/

### neverthrow
- **Idea:** `Result<T, E>` / `ResultAsync<T, E>` with `map`, `andThen`, `match`, and `safeTry` generators. `eslint-plugin-neverthrow` enforces that results are consumed.
- **Status:** 8.2.0 (2025-02). Stable, low churn.
- **Adopt:** A Result type for all fallible framework APIs. **Ship our own ~150 LOC `Result`** in `@staticflux/core` with the same shape, so no third-party type leaks into public APIs. Add a lint rule for unconsumed Results.
- **Avoid:** Mixing thrown errors and Results at the same layer. Throw only for programmer errors/invariants.
- **Sources:** https://github.com/supermacro/neverthrow

### AbortSignal.any / AbortSignal.timeout
- **Status:** Both **Baseline 2024**. `any()`: Chrome 116, Firefox 124, Safari 17.4. `timeout()`: Baseline 2024. Its timer counts active time and pauses in bfcache and suspended workers. Both are available in workers.
- **Adopt:** Every async API takes `signal`. Compose scope signal + navigation signal + timeout via `AbortSignal.any`. A disposal scope owns an `AbortController` and aborts it in `[Symbol.dispose]`.
- **Avoid:** Custom cancellation tokens.
- **Sources:** https://developer.mozilla.org/docs/Web/API/AbortSignal/any_static , https://developer.mozilla.org/docs/Web/API/AbortSignal/timeout_static

### Backoff with jitter (AWS)
- **Idea:** Exponential backoff without jitter creates synchronized retry storms. "Full jitter" (`sleep = random(0, min(cap, base*2^n))`) and "decorrelated jitter" minimize total work and contention. AWS also recommends retry *budgets*/token buckets and retrying at only one layer.
- **Status:** Canonical guidance.
- **Adopt:** Full jitter as the default. Honor `Retry-After`. Use a per-scope retry budget. Retry only idempotent operations by default. Retry at one layer (the resource layer), not in both transport and resource.
- **Sources:** https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ , https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/

### Circuit breakers
- **Idea:** States closed > open > half-open. The breaker opens on a failure-rate or consecutive-failure threshold and probes after a cooldown. Cockatiel (TS) composes retry, circuit breaker, timeout, bulkhead, and fallback policies, with AbortSignal support.
- **Status:** Cockatiel 4.0.0 (2026-05).
- **Adopt:** A breaker per *endpoint/transport* whose state feeds the supervisor (transport degraded > app degraded, with UI banners via slots). Cockatiel's policy-composition API is a good reference, or a dependency for the transport package.
- **Avoid:** Breakers per call site, which fragment state. Avoid breakers in front of user-initiated writes without clear UX.
- **Sources:** https://martinfowler.com/bliki/CircuitBreaker.html , https://github.com/connor4312/cockatiel

---

## 8. Auth

### OAuth 2.0 for Browser-Based Applications
- **Idea:** Three architectures in decreasing security: **(1) BFF** (tokens held server-side, cookie session to the SPA); **(2) token-mediating backend** (the backend obtains tokens and the SPA holds the access token only); **(3) browser-based OAuth client** (authorization code + PKCE in the browser, with DPoP/refresh rotation recommended). It states plainly that a malicious JS payload in the origin can obtain tokens in model (3).
- **Status:** **RFC 10017 / BCP 212, August 2026.**
- **Adopt:** Provider interface with BFF-cookie as the recommended production mode. Browser-only PKCE (use `oauth4webapi` 3.8.x, a standards-focused library with no dependencies) for cases with no backend. Hold refresh tokens in a worker or SharedWorker closure, never in `localStorage`. Single-flight refresh behind a Web Lock. Use BroadcastChannel for multi-tab session events. Use DPoP if the AS supports it.
- **Avoid:** Implicit flow. Avoid tokens in `localStorage`/`sessionStorage`. Avoid silent renew via hidden iframes, which third-party cookie blocking breaks.
- **Sources:** https://www.rfc-editor.org/rfc/rfc10017 , https://github.com/panva/oauth4webapi

### BFF / token-handler pattern
- **Idea:** A thin backend (or an edge "token handler" such as Curity's OAuth Agent + API proxy) performs the OAuth code flow, stores tokens, and issues an HttpOnly SameSite cookie. The SPA calls APIs through a proxy that swaps the cookie for a token. This preserves static-SPA hosting.
- **Status:** Mainstream. Endorsed as the top option in RFC 10017.
- **Adopt:** "Client-side only" framework, but our auth provider contract must treat **"session cookie + CSRF header"** as a first-class mode. In that mode the client never sees tokens; it only sees a session-state endpoint. This also fits "tokens brokered, not replicated" to workers.
- **Avoid:** Forcing every app to run a BFF. Keep PKCE-in-browser as a supported, documented-risk mode.
- **Sources:** https://curity.io/resources/learn/the-token-handler-pattern/ , https://www.rfc-editor.org/rfc/rfc10017#name-backend-for-frontend-bff

### WebAuthn / passkeys
- **Idea:** Public-key credentials bound to an origin. Includes conditional mediation (autofill UI), `PublicKeyCredential.getClientCapabilities()`, JSON helpers (`parseCreationOptionsFromJSON`), and the Signals API (`signalUnknownCredential` and related) to keep passkey providers in sync.
- **Status:** Level 3 features are broadly shipped. `@simplewebauthn/browser` 14.0.0 (2026-09). Exact cross-browser status of the Signals API is UNVERIFIED.
- **Adopt:** A passkey provider built on native JSON helpers with a SimpleWebAuthn fallback. Conditional UI on the login route. Feature detection via `getClientCapabilities`.
- **Avoid:** Passkeys inside the embed iframe. WebAuthn in cross-origin iframes needs `publickey-credentials-get` permission policy from the host, which ChatGPT-like hosts likely will not grant (UNVERIFIED).
- **Sources:** https://www.w3.org/TR/webauthn-3/ , https://simplewebauthn.dev/ , https://passkeys.dev/

### OpenAI Apps SDK / MCP authorization for embedded apps
- **Idea:** UI is a `ui://` HTML resource rendered by the host in a **sandboxed iframe** (MCP Apps extension, SEP-1865, standardized early 2026). It talks JSON-RPC to the host over postMessage. ChatGPT implements MCP Apps, and `window.openai` covers extras. **Auth sits between host and MCP server**: the MCP server is an OAuth 2.1 protected resource that publishes RFC 9728 metadata. The host is the client, using CIMD (Client ID Metadata Documents, now the default; DCR is deprecated) and PKCE, with RFC 8707 `resource` indicators. The widget does not get the token.
- **Status:** MCP spec latest revision **2026-07-28**. `@modelcontextprotocol/ext-apps` 2.0.3. `@modelcontextprotocol/sdk` 1.32.2.
- **Adopt:** An `EmbedHostProvider` that (a) reports identity and session from host-provided context, (b) routes data calls through **host tool calls** (a transport adapter in our data layer), and (c) maps 401 / `WWW-Authenticate` to a host-driven re-auth request. Validate `event.source` + `event.origin` on every message. Detect the host (`window.openai` vs MCP Apps bridge) behind one interface.
- **Avoid:** Extracting tokens into the widget through tool `_meta` or "echo token" tools. Tokens go stale and are exposed. Avoid assuming storage, cookies, popups, or service workers are available in the sandboxed iframe (sandbox attributes per host; UNVERIFIED for ChatGPT specifics).
- **Sources:** https://developers.openai.com/apps-sdk/build/auth , https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization , https://github.com/modelcontextprotocol/ext-apps , https://community.openai.com/t/how-to-get-apps-sdk-auth-token-for-authenticated-calls-to-a-backend/1361566

---

## 9. Authorization (client-side fast decisions)

General principle: **the client is never the security boundary.** Client authz exists for UX, chunk gating, and avoiding wasted requests. The server must re-check. Every system below is evaluated on whether it can produce a *compiled, synchronous, explainable* client artifact.

### Zanzibar / OpenFGA
- **Idea:** Relationship tuples (`user:anne#member@group:eng`) plus a typed model with rewrite rules (union, intersection, exclusion, tuple-to-userset). `Check`, `ListObjects`, and `ListUsers` queries. Consistency via zookies (Zanzibar) and consistency preferences (OpenFGA).
- **Status:** OpenFGA is a CNCF incubating project. `@openfga/sdk` 0.9.7 is a server API client and does not include a local evaluator.
- **Adopt:** Relationship-based *facts* as an input type. **The server precomputes `ListObjects`/batch-check results** for the current workspace and sends them as facts. The client compiles them into decision tables. Keep the `object#relation@user` vocabulary for explainability.
- **Avoid:** Running a graph-walking Zanzibar evaluator in the browser. That requires the tuple graph client-side, which is a data-exposure and size risk.
- **Sources:** https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/ , https://openfga.dev/docs/concepts

### Cedar
- **Idea:** A policy language with `permit`/`forbid` over principal/action/resource/context. It is schema-validated, designed for **formal analysis** (SMT-backed `cedar-policy-symcc`), and supports **partial evaluation** (residual policies for unknowns). Deny-overrides semantics. Every decision returns the determining policy IDs.
- **Status:** `@cedar-policy/cedar-wasm` **4.14.0 (2026-10-19)**, official WASM/JS bindings. Partial evaluation was experimental in earlier 4.x releases; its current stability is UNVERIFIED.
- **Adopt:** Strongest fit for "declarative policies, explainable traces". Use Cedar-like semantics (schema, permit/forbid, deny-overrides, *determining policies* as the explanation) and **partial evaluation as the compile step**. Fix principal and context per session, leave resource/action open, and emit a residual table keyed by (action, resource type, gate). Run the compile step in a worker or at build time. The WASM bundle stays off the main-thread critical path.
- **Avoid:** Shipping `cedar-wasm` on the critical path. Bundle size is UNVERIFIED but likely several hundred KB+. Avoid per-decision WASM calls in render paths; use the compiled O(1) tables.
- **Sources:** https://www.cedarpolicy.com/ , https://docs.cedarpolicy.com/ , https://github.com/cedar-policy/cedar , https://www.npmjs.com/package/@cedar-policy/cedar-wasm

### OPA (Rego)
- **Idea:** A general policy engine with the Rego datalog-ish language. Supports compiling to WASM (`opa build -t wasm`) and partial evaluation (`compile` API) that produces residual queries. Decision logs.
- **Status:** CNCF graduated, mature. JS WASM SDK `@open-policy-agent/opa-wasm` (version UNVERIFIED).
- **Adopt:** Decision-log format as prior art for our explainable decision traces. Use partial evaluation to compile policy into residuals.
- **Avoid:** Rego as the authoring language for feature teams. It is hard to read and hard for agents to write correctly, and its WASM bundles are large for the client.
- **Sources:** https://www.openpolicyagent.org/docs/latest/wasm/ , https://www.openpolicyagent.org/docs/latest/philosophy/#the-opa-document-model

### CASL
- **Idea:** An isomorphic JS ability library. `can(action, subject, conditions)` rules use Mongo-like conditions, and rules are serializable JSON (`packRules`/`unpackRules`). `ability.relevantRuleFor()` gives explainability.
- **Status:** `@casl/ability` **7.0.2 (2026-10-15)**. Active.
- **Adopt:** A client-side rule shape (serializable rules shipped from the server, `packRules` compression). `relevantRuleFor` as a minimal "why" trace. CASL is a pragmatic fallback runtime if we do not build our own compiler.
- **Avoid:** Evaluating condition objects in render loops. Precompile into lookup tables. Avoid the global ability singleton; inject it per session scope.
- **Sources:** https://casl.js.org/v6/en/guide/intro , https://casl.js.org/v6/en/api/casl-ability-extra

**Authorization synthesis:** Facts (entitlements, roles, relationships precomputed server-side, plan, flags) go into a Cedar-like policy IR (typed TS builder, schema-validated). A compiler (build time for static parts, worker at session start for the facts-dependent part, partial-evaluation style) emits a **decision table** `Map<gateKey, {decision, determiningPolicies[]}>`, where gateKey = `level:action:resourceType[:id]`. Decision tables replicate to workers as a core store. The router, slot renderer, and lazy loader query them synchronously.

---

## 10. Feature flags: OpenFeature web SDK
- **Idea:** A vendor-neutral flag API. **Static-context paradigm** on the client: evaluation context is set globally (`OpenFeature.setContext`), and providers implement `onContextChange(old, new)`. Evaluations are **synchronous**, against a provider-held cache. Provider events (`READY`, `STALE`, `ERROR`, `CONFIGURATION_CHANGED`, `RECONCILING`, `CONTEXT_CHANGED`). Hooks (`before`/`after`/`error`/`finally`) for telemetry. Domains (named clients) bind different providers per domain. Typed `getBooleanValue`/`getStringValue`/`getObjectValue` with defaults, plus `getXDetails` returning reason, variant, and error code.
- **Status:** `@openfeature/web-sdk` **1.10.0 (2026-07-28)**. Web SDK v1 since 2024-03. A CNCF project. There is an OTel hook and semantic conventions for feature-flag events.
- **Adopt:** **Implement the flag layer as an OpenFeature-compatible facade.** Package-declared typed flag definitions (`defineFlag<boolean>('pkg.feature.x', { default })`) live in a tiny *flag-keys* package, so other packages can read flags without depending on the owner, compiled to OpenFeature calls. Use domains per package or team. Use hooks to emit OTel spans/events. `RECONCILING` maps to our session/context transitions, and DI variant bindings resolve from `getStringValue` details. Replicate flag *snapshots* (not providers) to workers.
- **Avoid:** Calling OpenFeature directly from feature code (untyped string keys). Avoid dynamic-context evaluation per call on the client. Avoid re-resolving DI variants mid-scope; a variant is fixed for the life of its scope, and changes take effect at the next scope boundary or epoch.
- **Sources:** https://openfeature.dev/docs/reference/concepts/sdk-paradigms , https://openfeature.dev/docs/reference/technologies/client/web , https://openfeature.dev/specification/sections/hooks

---

## 11. Observability

### OpenTelemetry JS (browser)
- **Idea:** API/SDK split. `@opentelemetry/api` 1.10.0 (stable), `sdk-trace-web` 2.12.0, and OTLP/HTTP exporters. The **Browser SIG** (formed late 2025) shipped the first official **`@opentelemetry/browser-sdk`** release in May 2026 (now 0.6.0, pre-1.0, logs-centric: depends on `sdk-logs`/`api-logs` 0.223). Browser semantic conventions (session, page view, web vitals events) are still being developed.
- **Status:** Traces API stable. Browser SDK and browser semconv are **experimental/pre-1.0**. Logs are pre-1.0.
- **Adopt:** **Depend only on `@opentelemetry/api` in framework packages** (stable, tiny, no-op by default). Ship our own span helpers emitted automatically from DI resolution, router stages, resource fetches, gate decisions, and worker messages. Make the SDK/exporter an optional, lazily loaded observability package. Use OTel semantic-convention names where they exist.
- **Avoid:** `context-zone` (Zone.js monkeypatching) for async context. Pass context explicitly, or adopt AsyncContext when it ships (TC39 AsyncContext is Stage 2; current stage UNVERIFIED). Avoid hard-coding the experimental browser-sdk API.
- **Sources:** https://opentelemetry.io/docs/languages/js/ , https://www.npmjs.com/package/@opentelemetry/browser-sdk , https://opensource.datadoghq.com/otel-news/2026/05/

### W3C Trace Context
- **Idea:** `traceparent` (`00-<trace-id>-<parent-id>-<flags>`) and `tracestate` headers.
- **Status:** W3C Recommendation (Level 1). Level 2 adds the random-trace-id flag (status UNVERIFIED).
- **Adopt:** Put `traceparent`/`tracestate` in **every postMessage envelope** (main thread, worker, SharedWorker, host embed) and on fetch. CORS needs `traceparent` allowed by APIs.
- **Avoid:** Proprietary correlation headers.
- **Sources:** https://www.w3.org/TR/trace-context/

### web-vitals library
- **Idea:** `onLCP`, `onINP`, `onCLS`, `onFCP`, `onTTFB` with an attribution build (LoAF-based INP attribution). A soft-navigation build is in experimental tagging.
- **Status:** `web-vitals` **6.2.3 (2026-10-05)**. A `soft-navs` dist-tag exists, and soft navigation heuristics are still a Chromium origin trial/experiment (UNVERIFIED current state).
- **Adopt:** Use the attribution build in the observability package. Report vitals per *route epoch* (the router already knows soft navigations). Include LoAF script attribution.
- **Avoid:** Treating SPA route changes as hard-navigation vitals.
- **Sources:** https://github.com/GoogleChrome/web-vitals

### Long Animation Frames (LoAF)
- **Idea:** `PerformanceObserver({type:'long-animation-frame'})` reports frames >50 ms with `scripts[]` attribution (sourceURL, function, invoker, forcedStyleAndLayoutDuration). It supersedes the Long Tasks API.
- **Status:** **Chromium-only** (Chrome 123+). Firefox and Safari: not supported as of the latest data found.
- **Adopt:** Map `scripts[].sourceURL` back to **logical chunk IDs and features** through our build manifest, which gives per-feature jank attribution. Enforce budgets in lab CI (Chromium).
- **Avoid:** Assuming field coverage on Safari/iOS.
- **Sources:** https://developer.chrome.com/docs/web-platform/long-animation-frames , https://w3c.github.io/long-animation-frames/

---

## 12. Loading & performance

### Workbox precaching
- **Idea:** A build-generated precache manifest (`{url, revision}`), with an install-time cache, cleanup of outdated caches, and runtime routing strategies (StaleWhileRevalidate, NetworkFirst). `workbox-window` manages the update lifecycle.
- **Status:** `workbox-precaching` 7.4.1 (2026-05). Maintained but slow-moving.
- **Adopt:** **Critical tier = SW precache generated from our build manifest** (logical chunk ID to hashed URL). A user-visible "update available" flow via workbox-window, tied to app refresh/epoch. Runtime SWR for the "likely" tier.
- **Avoid:** Precaching everything. Precache only the critical tier, under a CI budget. Avoid `skipWaiting` without coordinating the epoch, which mixes chunk versions.
- **Sources:** https://developer.chrome.com/docs/workbox/modules/workbox-precaching

### Speculation Rules
- **Idea:** JSON `<script type="speculationrules">` with `prefetch`/`prerender`, document rules with `eagerness`, and `Speculation-Rules` header. Mostly aimed at MPA navigations.
- **Status:** **Chromium only.** Safari: flag-only in Technology Preview. Firefox: not supported.
- **Adopt:** Little for an SPA. Use it only for cross-document navigations, such as the login page or a separate app.
- **Avoid:** Building the speculative tier on it. Use the router's preload-on-intent plus `import()` instead.
- **Sources:** https://developer.mozilla.org/docs/Web/API/Speculation_Rules_API , https://caniuse.com/wf-speculation-rules

### modulepreload
- **Idea:** `<link rel="modulepreload">` fetches, parses, and compiles ES modules ahead of time, including the module graph in some engines.
- **Status:** Baseline (Safari 17+, Firefox 115+).
- **Adopt:** Emit modulepreload for the boot chunk graph from the build manifest. Inject modulepreload links on preload-on-intent.
- **Sources:** https://developer.mozilla.org/docs/Web/HTML/Attributes/rel/modulepreload

### Module Federation 2.0
- **Idea:** Runtime-composed remotes with shared dependencies negotiated at runtime. MF 2.0 adds a manifest (`mf-manifest.json`), dynamic TS type hints, a decoupled runtime (`@module-federation/runtime`), and support for Rspack, webpack, Vite, and others.
- **Status:** **MF 2.0 stable April 2026.** `@module-federation/enhanced` 2.9.2. Rspack 2.0 also released April 2026.
- **Adopt:** The *manifest* concept (remote entry + exposed modules + shared versions) as prior art for our build manifest. Use MF only if independently deployed team bundles become a requirement.
- **Avoid:** MF as the default chunking mechanism. Shared-singleton version negotiation is a major source of runtime bugs. A monorepo with a single build plus stable logical chunk IDs is simpler and gives deterministic budgets.
- **Sources:** https://module-federation.io/ , https://rspack.rs/blog/announcing-2-0

### Import maps
- **Idea:** `<script type="importmap">` maps bare specifiers to URLs. Supports `scopes` and `integrity` (SRI for modules). **Multiple import maps** merge deterministically.
- **Status:** Import maps are Baseline Widely available. `integrity`: Chrome 127, Safari 18, Firefox (UNVERIFIED version). Multiple import maps: Chromium, and Firefox 150. Safari not confirmed. An open WebKit bug (2026-10) blocks import-map modules under `Integrity-Policy`.
- **Adopt:** An import map as a *possible* runtime form of the logical-chunk-ID manifest (`"@sf/chunk/feature-x": "/assets/feature-x.3f2a.js"`), with integrity. This gives stable IDs in code and hashed files in deployment, and an epoch refresh can swap maps.
- **Avoid:** Relying on multiple or dynamic import maps cross-browser. Emit a single map at boot, or let the bundler's runtime manifest do the mapping.
- **Sources:** https://developer.mozilla.org/docs/Web/HTML/Element/script/type/importmap , https://bugzilla.mozilla.org/show_bug.cgi?id=1916277 , https://bugs.webkit.org/show_bug.cgi?id=326340

### Qwik resumability
- **Idea:** Serialize app state and listener locations into HTML, so the client *resumes* without hydration and loads event-handler chunks lazily on interaction (`q:` attributes, the Qwik optimizer splits on `$`).
- **Status:** Qwik 1.x (`@builder.io/qwik` 1.20.2) is production. **Qwik 2 is RC** (`@qwik.dev/core` 2.0.0-rc.3, 2026-10-13).
- **Adopt:** The principle (*serialize enough state to resume, load code on interaction*) for our **epoch-based rehydration without reload** and IndexedDB-archived heavy features: snapshot store + view state, then resume lazily.
- **Avoid:** Its SSR dependency and optimizer-driven closure extraction. StaticFlux is client-only.
- **Sources:** https://qwik.dev/docs/concepts/resumable/ , https://qwik.dev/blog/qwik-2-coming-soon/

### scheduler.postTask / scheduler.yield
- **Status:** `postTask`: Chromium and Firefox. `yield`: Chrome 129+, Firefox 142+. **Safari: neither**, and not Baseline.
- **Adopt:** A boot-scheduler abstraction with priorities `user-blocking | user-visible | background` mapped to postTask. Fallbacks: `MessageChannel` for yield, `requestIdleCallback` (Safari has no rIC by default; UNVERIFIED current state), then `setTimeout`. Yield between feature activations.
- **Sources:** https://developer.chrome.com/blog/use-scheduler-yield , https://developer.mozilla.org/docs/Web/API/Scheduler

---

## 13. Reactivity

### MobX (now v7) with standard decorators
- **Facts:** MobX 7.0.0 (2026-07-30) **removed legacy decorators and the non-Proxy mode**. Bundle shrank to ~14 KiB gzip (ESM prod). Namespaced annotations became named exports (`observableRef`, `actionBound`, `compareStructural`, and others). `trace` was removed. Reaction disposers implement `Disposable` (7.0.4), so they work with `using`. A Reaction-`signal` listener leak was fixed (7.0.6). `toJS` includes `@observable accessor` fields (7.1.0). Standard decorators need `accessor` for observable fields (`@observable accessor x = 0`) with TS 5.0+, no `experimentalDecorators`. MobX-State-Tree 9.0.0 (2026-10-23) requires mobx ^7. mobx-keystone 2.4.1 supports 4 through 7.
- **Lit interplay:** Lit 3 standard decorators also use `accessor` (`@property() accessor foo`). With both on the standard model, the old "MobX decorators need `useDefineForClassFields`, which breaks Lit legacy decorators" conflict (seen in Hilla docs) does not apply. Combining Lit `@property` and MobX `@observable` on the *same* field is not supported and should be forbidden. Keep MobX state in stores, not in elements.
- **Lit binding:** `@adobe/lit-mobx` 2.2.2 (2024-01) is a mixin (`MobxLitElement`) that wraps `update()` in a `Reaction`. Recommended: our own **`MobxController implements ReactiveController`**, written by us. In `hostConnected` it creates a `Reaction(() => host.requestUpdate())`. It overrides render tracking by running `reaction.track(() => host.render())`, or more simply by wrapping `update` through a small base-class hook. In `hostDisconnected` it disposes the reaction, and it also disposes on the hidden(frozen) state. Prior art: lit-mobx `MobxReactionUpdate` (UNVERIFIED that a controller-only form can intercept `render` without a base class; a 1-method base-class hook is acceptable).

### @lit-labs/signals and TC39 Signals
- **Facts:** The TC39 Signals proposal is **Stage 1** (README unchanged in stage). Champions estimate "at least 2-3 years" before native availability. `@lit-labs/signals` **0.3.0 (2026-05-14)** depends on `signal-polyfill` 0.2.2 (last release 2025-01). It offers `SignalWatcher` mixin, `watch()` directive, and an `html` tag with auto-watch. It is a Labs package, so not stable.

### Recommendation: MobX vs signals
**Use MobX 7 for in-thread reactivity.** Reasons: (1) Mature, stable major, actively maintained (commits through Oct 2026). (2) Rich object graphs: observable maps/sets/arrays, computeds, `reaction`/`when` with `signal` (AbortSignal) support, `onBecomeObserved` for lazy resource subscription. (3) Production prior art at scale: Linear uses MobX models with delta sync. (4) Interception APIs (`observe`, `intercept`, `spy`) exist for patch generation. Signals are not standardized, and the polyfill is stalled. Hide MobX behind a ~5-function **reactivity port** (`observableBox`, `computed`, `effect`, `batch`, `untracked`) used by framework internals, so a future migration to native Signals is possible. Feature code may use MobX directly.

### How to serialize MobX state to patches for worker replication
Prior art: MST `onPatch`/`applyPatch` (JSON-patch, RFC 6902), mobx-keystone `onPatches`/`applyPatches` + `getSnapshot`/`fromSnapshot`, Immer `produceWithPatches`, Replicache patches.
Recommended design (StaticFlux store model):
1. **Schema-first stores.** `defineStore({ id, version, schema, actions })`. The schema is explicit, so serialization does not depend on reflection over `accessor` fields. That reflection is exactly what broke `toJS` before 7.1.
2. **Owner thread only mutates through named actions.** Wrap each action in a MobX `action` plus a **patch recorder**. Use `observe()`/`deepObserve`-style listeners on the store's observable tree, installed once per node by the schema walker. Do not rely on `mobx-utils` (peer `^6`). Each listener emits ops `{op:'replace'|'add'|'remove', path, value}` into the current transaction buffer.
3. **On action end** (the outermost batch), flush one message: `{storeId, epoch, version: n+1, patches, actionName, traceparent}`. Values are structured-clone-safe (validated by schema in dev).
4. **Handshake:** a replica sends `{storeId, haveVersion?}`. The owner replies with `{snapshot, version}` (from `getSnapshot`-like schema walk), or with the patches since `haveVersion` from a bounded ring buffer. On a gap or epoch mismatch the replica requests a resnapshot.
5. **Replicas** apply patches inside `runInAction` and are read-only otherwise (enforced: replica actions throw). Writes from replicas are sent as *intents* `{action, args}` to the owner (Replicache mutator style).
6. Consider **mobx-keystone** (supports MobX 7, has snapshots, patches, and `applyPatches`) as a build-vs-buy candidate for steps 1-5. MST 9 is heavier and more opinionated. Spike both against a hand-rolled 500-LOC version.
- **Avoid:** Diffing whole snapshots per change, which is O(state). Avoid `toJS` + `structuredClone` per action. Avoid proxies or MobX objects crossing postMessage; they cannot be cloned.
- **Sources:** https://github.com/mobxjs/mobx/blob/main/packages/mobx/CHANGELOG.md , https://mobx.js.org/enabling-decorators.html , https://github.com/adobe/lit-mobx , https://github.com/tc39/proposal-signals , https://www.npmjs.com/package/@lit-labs/signals , https://mobx-keystone.js.org/ , https://mobx-state-tree.js.org/concepts/patches , https://lit.dev/docs/components/decorators/

---

## 14. Agent-friendly repos

### AGENTS.md
- **Idea:** A plain-Markdown file of agent instructions next to README: build/test commands, conventions, boundaries. Nested files in subdirectories apply to their subtree (nearest-file-wins per agents.md site; nested precedence semantics UNVERIFIED across all tools).
- **Status:** Donated by OpenAI to the **Agentic AI Foundation (Linux Foundation)**, founded 2025-12-09 with Anthropic (MCP) and Block (goose). Reportedly used in 60k+ projects. Claude Code reads `CLAUDE.md`; a symlink or include keeps one source.
- **Adopt:** Root AGENTS.md plus **per-package AGENTS.md** (package purpose, public API, allowed deps, budgets, test command). Generate the "allowed deps/budgets" sections from the same config CI enforces, so they cannot drift. Symlink CLAUDE.md to AGENTS.md.
- **Avoid:** Long prose. Keep it short and imperative, and link to docs.
- **Sources:** https://agents.md/ , https://openai.com/index/agentic-ai-foundation/

### dependency-cruiser / Nx module boundaries
- **Idea:** dependency-cruiser enforces rules over the resolved import graph: forbidden paths, no-circular, no-orphans, and `reaches` rules, and can export graphs. Nx `@nx/enforce-module-boundaries` enforces tag-based constraints (`type:feature` may depend only on `type:ui|type:data`, `scope:x` on `scope:x|shared`).
- **Status:** dependency-cruiser 18.7.0 (2026-10). `@nx/eslint-plugin` 24.0.1 (2026-10).
- **Adopt:** **Tags declared in each package manifest** (layer: core|platform|feature|app; team; weight class). Enforce with dependency-cruiser (no Nx lock-in), or with Nx if we adopt Nx as the task runner. Rules: features cannot import features; only `*-keys`/contract packages are shared; no cycles; no deep imports (exports-map only). Add a custom check for "abstraction depth" budgets (max re-export chain, max class inheritance depth = 1).
- **Avoid:** ESLint `import/no-restricted-paths` sprawl. Use one rule source.
- **Sources:** https://github.com/sverweij/dependency-cruiser , https://nx.dev/features/enforce-module-boundaries

### size-limit
- **Idea:** Per-entry size budgets (brotli/gzip, optionally execution time), measured on the real bundler output, with failure in CI and PR comments via the GitHub action.
- **Status:** 14.3.0 (2026-10-22).
- **Adopt:** Per-package and per-logical-chunk budgets declared in manifests, plus a whole-app "critical tier" budget. Feed the same numbers into AGENTS.md.
- **Sources:** https://github.com/ai/size-limit

### TypeScript explicit resource management (`using`)
- **Status:** TS supports `using`/`await using` since **5.2**, and the downlevel emit works with the `esnext.disposable` lib. TS 7.0 (Go) is stable. The proposal is reportedly part of **ES2026** (secondary source; UNVERIFIED in spec text). Runtime: Chromium (134+) and Firefox (134+, UNVERIFIED versions) ship `using`/`DisposableStack`. **Safari: not Baseline** (`Symbol.dispose` reportedly in desktop 26.4, not iOS; UNVERIFIED). Node 24+ supports it (UNVERIFIED exact version).
- **Adopt:** Disposal scopes as `DisposableStack`/`AsyncDisposableStack`, with a polyfill (`core-js` or our own ~60 LOC) and TS downleveling of `using`. Every subscription, reaction (MobX 7 disposers are `Disposable`), worker port, and listener registers into the owning lifecycle scope's stack. Lint: no bare `addEventListener` without a `signal` or scope.
- **Avoid:** Native-only `using` syntax in shipped output until Safari/iOS is Baseline.
- **Sources:** https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html , https://developer.mozilla.org/docs/Web/JavaScript/Reference/Statements/using , https://github.com/tc39/proposal-explicit-resource-management

---

## Recommendations summary

| Layer | Recommended approach | Key prior art |
|---|---|---|
| Reactivity | MobX **7** in-thread, behind a thin reactivity port. Own `MobxController` for Lit. Stores are schema-first. | MobX 7 changelog, Linear, lit-mobx |
| Store replication | Owner-only named actions, patch recorder producing versioned patches. Snapshot handshake + ring buffer + epoch. Replica writes go to the owner as intents. Spike mobx-keystone vs hand-rolled. | Replicache, mobx-keystone/MST patches, Linear deltas |
| UI | Lit 3 (3.3.3) with standard decorators (`accessor`). `@lit/context` only to carry the injector handle. | Lit, Context Community Protocol |
| DI | Typed tokens + factory providers in manifests (no decorators). Scope tree. Requirement types checked at composition. Lazy providers mapped to chunk IDs. Variants keyed by flags and fixed per scope. | Angular injectors, Effect Layers, VS Code instantiation |
| Plugins | Manifest-first contribution points. Activation inferred from contributions. Typed attach-points. Config-driven enable/override (workspaces). Untrusted plugins only across an iframe/WASM boundary. | VS Code, Backstage NFS, Figma |
| App lifecycle | Supervisor with OTP child specs, strategies, restart intensity, reverse-order shutdown, epoch bump on restart. Optional XState for the supervisor machine. | Erlang/OTP, XState v5 |
| Feature lifecycle | Explicit state machine. `hidden` = keep DOM/state, dispose effects (Activity semantics). Browser lifecycle signals are inputs only. | React Activity, Page Lifecycle, bfcache |
| Router | Navigation API core with History fallback. Named sequential stages (`canMatch`-style gating before chunk load). Serial guards, parallel loaders. Retryable transitions persisted for handoff. Typed search params for view state. | Ember Transition, Angular guards, TanStack Router |
| Data | Typed resource kinds over TanStack `query-core` or equivalent. DataLoader batching. Full-jitter retries at one layer. Per-endpoint breakers feed the supervisor. Results everywhere. | TanStack Query, DataLoader, AWS, Cockatiel |
| Errors/async | Own `Result` type. `AbortSignal.any` composition. `DisposableStack` scopes (polyfilled). | neverthrow, Effect, TC39 ERM |
| Workers | Explicit typed message envelopes (traceparent, epoch, version). SharedWorker coordinator + Web Locks leader. SQLite-WASM/OPFS single writer for archive. Comlink only for leaf RPC. | Notion, Comlink |
| Documents | ECS (bitECS-style SoA) in document workers. `DocumentCRDT` interface with Yjs 13 (v14 later) for text; LWW per property for structure. | Figma multiplayer, Yjs, Automerge 3 |
| Auth | Provider contract: BFF-cookie (recommended), browser PKCE via oauth4webapi (refresh token in a worker, single-flight via Web Locks), passkeys, guest, **embed-host transport adapter (no tokens in widget)**. | RFC 10017, token handler, MCP 2026-07-28 auth, MCP Apps |
| Authorization | Facts, Cedar-like policy IR, partial-eval compile (worker/build) into O(1) decision tables with determining-policy traces. Server re-checks. | Cedar, OPA partial eval, OpenFGA ListObjects, CASL |
| Flags | Typed flag-key packages over an OpenFeature-compatible facade (static context, hooks for OTel, domains per package). | OpenFeature web SDK 1.10 |
| Observability | Depend on `@opentelemetry/api` only. Auto spans from DI/router/data/gates/workers. traceparent in every envelope. web-vitals attribution per route epoch. LoAF mapped to chunk IDs. Lazy SDK/exporter. | OTel JS, W3C Trace Context, web-vitals 6, LoAF |
| Loading | Logical chunk IDs and build manifest (optionally emitted as an import map). Tiers: SW precache (critical), modulepreload + idle import (likely), preload-on-intent (speculative), on demand. Scheduler shim with postTask/yield fallbacks. | Workbox, MF 2.0 manifest, Qwik (resume idea) |
| Repo/agents | AGENTS.md per package, generated from CI config. dependency-cruiser tag rules. size-limit budgets. Abstraction-depth lint. | AGENTS.md / AAIF, dependency-cruiser, Nx, size-limit |

## Open risks

1. **Safari gaps** affect several core assumptions: no `scheduler.yield`/`postTask`, no Speculation Rules, no LoAF, no Page Lifecycle freeze, partial `using`/`Symbol.dispose`, Navigation API `precommitHandler` possibly missing, and an import-map + Integrity-Policy bug. Every one needs a shim or degradation path. Safari is likely the weakest client (iOS especially).
2. **Embedded hosts (ChatGPT / MCP Apps):** the sandboxed iframe may lack storage, service workers, SharedWorker, popups, and WebAuthn, and has no token access. "Handoff" and "workers" may need an embed-specific degraded profile. Host sandbox specifics are UNVERIFIED.
3. **MobX patch generation** is not a built-in MobX feature, and `mobx-utils` lags MobX 7. A hand-rolled recorder has edge cases: array splices, Map key ordering, observable class instances, and computed exclusion. mobx-keystone is a dependency risk (single maintainer; UNVERIFIED).
4. **TypeScript 7 toolchain:** the programmatic compiler API is deferred to 7.1 (secondary source), which affects custom lint, codegen, and manifest-extraction tools. Lit/MobX standard-decorator emit under tsgo is UNVERIFIED and needs a spike.
5. **Yjs v14** has been in RC for a long time. The migration (API and binary format changes, UNVERIFIED) could land mid-project.
6. **Client authorization** could be mistaken for security. It needs explicit docs and server re-checks. Compiled decision tables can also leak policy structure to the client.
7. **Cedar-WASM size and partial-evaluation stability** are UNVERIFIED. A custom compiler may be necessary, which means owning policy semantics (formal-analysis benefits lost).
8. **OTel browser SDK is pre-1.0**, and browser semantic conventions are still in development. Expect churn in exporters and attribute names. Coupling to `api` only mitigates this.
9. **SharedWorker lifetime** on mobile (termination when backgrounded) and Android rollout version are UNVERIFIED. Leader election must tolerate worker loss at any time.
10. **Scope of the supervisor/feature state machines:** they could grow into a framework within the framework. Keep them as data (child specs, transition tables) and keep the code paths shallow, per the agent-friendly goal.
11. **Effect 4 / XState 6** major versions are close in time. If either is adopted internally, pin it and wrap it.
12. **Single build vs Module Federation:** if org structure later requires independent deploys, stable logical chunk IDs must be designed so they could be served from MF-style remotes. Decide the manifest format with that in mind.
