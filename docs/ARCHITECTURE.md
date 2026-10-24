# StaticFlux — Architecture

> Status: **draft for review**. Implements [`REQUIREMENTS.md`](./REQUIREMENTS.md); grounded in [`research/prior-art.md`](./research/prior-art.md).
> API sketches below are illustrative — they fix *shapes and boundaries*, not final names.

## 1. Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ apps/            example app, devtools app                            │
├──────────────────────────────────────────────────────────────────────┤
│ features/        feature packages (only in apps / example)           │
├──────────────────────────────────────────────────────────────────────┤
│ shell            layout slots · theming · workspaces · overlays       │
│ ui               Lit integration · MobxController · inject() · deps   │
├──────────────────────────────────────────────────────────────────────┤
│ router · auth · gate · config · data · worker · document · handoff ·  │
│ i18n · a11y · loader · perf                       (verticals)         │
├──────────────────────────────────────────────────────────────────────┤
│ runtime          supervisor · app lifecycle · feature lifecycle ·     │
│                  resource manager · scheduler                         │
├──────────────────────────────────────────────────────────────────────┤
│ core             tokens · injector · scopes · manifests · Result ·    │
│                  async primitives · disposal · reactivity port ·      │
│                  telemetry API · platform facts                       │
└──────────────────────────────────────────────────────────────────────┘
tooling/  sf CLI (graph, budgets, manifests) · eslint-plugin · build plugin · testkit
```

**Dependency rule:** a package may depend only on packages in lower layers, and on *contract* entry points (`@staticflux/x/contract`) of same-layer packages. Enforced by dependency-cruiser tags (`layer:core|runtime|vertical|ui|shell|feature|app`).

## 2. Package map

| Package | Responsibility | Key contracts |
|---|---|---|
| `@staticflux/core` | Tokens, injector, scopes, unit manifests, `Result`, async primitives, `DisposableStack` polyfill, reactivity port, telemetry API, typed registry (declaration merging) | `Token<T>`, `Unit`, `Injector`, `Scope`, `Result`, `Telemetry` |
| `@staticflux/runtime` | Supervisor, app lifecycle machine, feature lifecycle machine, resource manager, boot scheduler | `Subsystem`, `AppLifecycle`, `FeatureHost`, `RetentionPolicy` |
| `@staticflux/platform` | Capability detection → reactive platform facts | `PlatformFacts` |
| `@staticflux/config` | Typed flag/config declarations, layered resolution, OpenFeature-compatible provider port | `defineFlag`, `ConfigProvider` |
| `@staticflux/auth` | Identity providers, session machine, multi-tab sync, single-flight refresh, token broker | `IdentityProvider`, `Session` |
| `@staticflux/gate` | Facts, policy IR, compiler → decision tables, explainable decisions | `FactSource`, `Policy`, `Decision` |
| `@staticflux/data` | Transports, resource kinds, cache/SWR, batching, retries, breakers, schema-first stores + patches | `Transport`, `Resource`, `defineStore` |
| `@staticflux/worker` | Typed envelopes, supervised workers, store replication, SharedWorker coordinator, leader election | `WorkerSpec`, `Envelope`, `Replica` |
| `@staticflux/document` | ECS document model, `DocumentCRDT` interface, Yjs adapter, projections | `DocumentEngine`, `Projection` |
| `@staticflux/router` | Navigation pipeline, stages, typed routes, view-state sub-routes | `RouteDef`, `Stage`, `Navigation` |
| `@staticflux/loader` | Logical chunk IDs, manifest runtime, warmup tiers, speculation engine, federation/import-map strategies | `ChunkId`, `LoadStrategy` |
| `@staticflux/handoff` | Boundary-surviving state with lifetimes; shared snapshot format | `HandoffSlot` |
| `@staticflux/i18n` | Typed catalogs, ICU formatting, lazy locales, RTL | `defineMessages`, `Locale` |
| `@staticflux/a11y` | Focus manager, announcer, shortcut registry, preference facts | `Announcer`, `FocusScope` |
| `@staticflux/perf` | Web Vitals, LoAF→chunk mapping, boot waterfall, budgets at runtime | `PerfMonitor` |
| `@staticflux/ui` | Lit bindings: `MobxController`, `inject()` with render/lazy/functional, scope elements | `component()`, `deps` |
| `@staticflux/shell` | Slots, theming tokens, workspaces, command palette, error boundaries | `Workspace`, `SlotContribution` |
| `@staticflux/messaging` | Surface manager: dialogs, sheets, popovers, tooltips, toasts, banners, coach marks; scope-bound lifetimes; attention arbitration; routable dialogs | `SurfaceDef`, `Surfaces` |
| `@staticflux/urlstate` | URL-state kinds (view/intent/sticky/dialog), declared bindings, URL ⇄ store sync | `urlBinding`, `intent` |
| `@staticflux/testkit` | Test injector, fakes (clock, transport, session, platform, worker bridge), contract suites | — |
| `@staticflux/devtools` | Telemetry-fabric consumer UI | — |
| `tooling/sf` | CLI: graph check, budgets, manifest/chunk extraction | — |
| `tooling/eslint-plugin` | Custom rules (R20.5) | — |

## 3. Core shapes

### 3.1 Tokens and units

```ts
// A token is a typed value. The string id is for devtools/serialization only and is type-checked.
export const SessionToken = token<Session>('auth/session');

// A unit declares what it requires and provides. Factories are plain functions.
export const sessionUnit = unit({
  id: 'auth/session-unit',
  scope: 'app',
  critical: true,
  requires: { transport: TransportToken, telemetry: TelemetryToken },
  provides: SessionToken,
  async create({ transport, telemetry }, ctx) {   // ctx: { signal, scope(disposables), log }
    const session = createSession(transport);
    ctx.scope.defer(() => session.dispose());
    return session;
  },
} satisfies UnitDef);
```

### 3.2 Composition with compile-time completeness

```ts
const app = composeApp({
  units: [sessionUnit, transportUnit, telemetryUnit /* … */],
});
// If any `requires` has no matching `provides`, the type of `app` is an error naming the missing token:
//   Type 'MissingProvider<"data/transport">' is not assignable to ...
```

### 3.3 Cross-package registry (declaration merging)

```ts
declare module '@staticflux/core' {
  interface Registry {
    tokens:   { 'auth/session': Session };
    flags:    { 'editor/ai-panel': boolean };
    commands: { 'editor/insert-image': { src: string } };
  }
}
```

### 3.4 Experiments as variant bindings

```ts
export const searchVariantB = variant({
  of: SearchRankerToken,
  when: flag(SearchRankingExperiment, 'B'),
  unit: rankerBUnit,
});
// Feature code calls inject(SearchRankerToken). It never sees the flag.
```

### 3.5 Components with three dependency kinds

```ts
@component({
  tag: 'sf-doc-toolbar',
  deps: {
    render:     { doc: DocumentStoreToken },          // blocks render → placeholder
    lazy:       { presence: PresenceStoreToken },      // reactive when it arrives
    functional: { exportPdf: ExportPdfCommandToken },  // resolved (and loaded) on first call
  },
  placeholder: () => html`<sf-skeleton lines="1"></sf-skeleton>`,
})
export class DocToolbar extends SfElement {               // single-level base (Lit requirement)
  render() {
    const { doc, presence, exportPdf } = this.deps;
    return html`… @click=${() => exportPdf.invoke({ id: doc.id })} …`;
  }
}
```

## 4. Runtime

### 4.1 Boot sequence

```
1. core injector + telemetry (buffering)          — synchronous, < 1 ms target
2. supervisor starts; registers subsystems
3. critical units resolve in topological order    — traced → boot waterfall
4. app: core-ready  → shell renders frame + placeholders
5. router runs first navigation pipeline
6. scheduler: visible → idle → warmup tiers
```

### 4.2 App lifecycle commands

`pause | resume | abort | refresh | reinitialize | shutdown` are broadcast in dependency order (reverse for teardown) to each `Subsystem`:

```ts
interface Subsystem {
  id: string;
  dependsOn: readonly string[];
  start(ctx): Promise<void>;
  pause?(): void; resume?(): void;
  refresh?(epoch: Epoch): Promise<void>;
  stop(reason): Promise<void>;
  restart: RestartPolicy;     // OTP-style intensity/period, backoff
}
```

### 4.3 Feature host

Feature manifest → state machine → disposal scopes per state (`logicScope`, `uiScope`). The resource manager subscribes to platform facts + LRU and issues demotions; features declare `weight` and `retention`.

## 5. Navigation pipeline

Stages run serially; loaders/prefetch run in parallel inside their stage; each stage returns `continue | redirect | block | cancel` as a `Result`. Every stage is a span. Sub-route (view-state) changes run only `exit(view) → enter(view) → commit`.

## 6. Data flow across threads

```
Main thread (owner)                          Worker (replica)
store.action() ──patch recorder──► Envelope{storeId, epoch, version, patches, traceparent}
                                       ──► apply in runInAction (read-only)
                    ◄── Intent{action,args} ◄── replica write attempt
```
Handshake: `hello{haveVersion}` → `snapshot | patchesSince` (ring buffer); gap/epoch mismatch → resnapshot.

## 7. Build & loading

- Feature/chunk boundaries declared via `chunk('feature:editor')` in manifests; build plugin emits `sf-manifest.json` (logical id → hashed files + deps + tier + budget).
- Loader resolves logical ids at runtime; SW precaches `critical`; `likely` on idle; `speculative` on intent; gates consulted before any fetch.

## 8. Implementation phases

| Phase | Deliverable | Packages |
|---|---|---|
| 0 | Repo scaffold: pnpm, TS refs, Vitest, lint, dependency-cruiser, size-limit, AGENTS.md | root, tooling |
| 1 | **Core**: tokens, injector, scopes, units, Result, async primitives, disposal, telemetry API, reactivity port | core, testkit |
| 2 | **Runtime + platform + config** | runtime, platform, config |
| 3 | **Verticals in parallel**: auth, gate, data, router, loader, i18n, a11y, perf, handoff | (one agent each) |
| 4 | **Threads**: worker replication, document engine | worker, document |
| 5 | **UI + shell** | ui, shell |
| 6 | **Example app + devtools + e2e** | apps/* |
| 7 | **Tooling**: sf CLI graph/budget checks, eslint rules | tooling/* |

Each phase lands as its own commits; every package ships tests, AGENTS.md and budgets before the next phase depends on it.
