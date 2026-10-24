# StaticFlux

**Static core, flux implementations.** StaticFlux is a client-side TypeScript framework for large
single-page web applications — the kind that span many teams, many packages and possibly many repos.
It is a small, stable core of contracts and primitives, plus an ecosystem of building blocks that plug
into it. Every package is usable on its own; they work best together.

Built on [Lit](https://lit.dev) (web components) and [MobX 7](https://mobx.js.org) (in-thread reactivity).
Client-only: there is no server runtime — backend contracts are typed, and the example app runs against mocks.

**Documentation site:** https://akriti2591.github.io/staticflux/

```ts
import { token, unit } from '@staticflux/core';
import { bootApp, runtimeUnits } from '@staticflux/runtime';

export interface Greeter { greet(name: string): string }
export const GreeterToken = token('hello/greeter').type<Greeter>();

export const greeterUnit = unit({
  id: 'hello/greeter-unit',
  provides: GreeterToken,       // what it offers
  scope: 'app',                 // how long it lives
  create: (): Greeter => ({ greet: (name) => `Hello, ${name}!` }),
});

const booted = await bootApp({ units: [...runtimeUnits, greeterUnit] });   // Result<App>, never throws
if (booted.ok) {
  const greeter = await booted.value.injector.get(GreeterToken);              // Result<Greeter>
}
```

## The philosophy, in short

- **Inversion of control everywhere.** Units *declare* what they require and provide; the injector hands
  dependencies in. The core never knows about features — features and framework packages contribute through
  the same typed contribution points.
- **Declarations, not magic strings.** Tokens, flags, metrics, routes, capabilities and errors are typed
  values. Misconfiguration is a compile-time or CI error.
- **Scopes and lifecycles.** Every lifecycle is a typed state machine; every resource lives in a disposal
  scope with an `AbortSignal`. Leaving a state cleans up.
- **Plugins, not branches.** Experiments and modes are alternate bindings and separate features — never
  `if/else` in feature code. Composition over inheritance (one level: Lit's base element).
- **One telemetry fabric.** DI, navigation stages, chunks, requests, gate decisions, workers and renders all
  emit OpenTelemetry-shaped spans; journeys, budgets and devtools are consumers.
- **Performance first.** Everything lazy by default, budgets enforced in CI that only ratchet tighter.
- **Agent-first codebase.** Explicit and shallow, every package documented in an `AGENTS.md`, every error a
  stable code with a fix, rules enforced by tooling.
- **Client gating is UX, not security.** The server re-checks every request.

Read more: [Philosophy](https://akriti2591.github.io/staticflux/philosophy/) ·
[Before / After](https://akriti2591.github.io/staticflux/before-after/) ·
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)

## Packages

A package may import only lower layers — `core < runtime < vertical < ui < shell < (feature) < app` —
through its declared dependencies, checked by `pnpm lint:boundaries`. Each links to its `AGENTS.md` (purpose, public API by file, rules, budgets).

**Core**

| Package | |
|---|---|
| [`@staticflux/core`](packages/core/AGENTS.md) | Tokens, units, the readiness-aware injector, scopes, `Result`, Tasks, state machines, telemetry, reactivity port (≤ 7.5 KB boot surface) |

**Runtime**

| Package | |
|---|---|
| [`@staticflux/runtime`](packages/runtime/AGENTS.md) | App supervisor, app & feature lifecycles, resource manager, frame scheduler |
| [`@staticflux/storage`](packages/storage/AGENTS.md) | One async key-value interface over any backend, with composable middleware |

**Verticals**

| Package | |
|---|---|
| [`@staticflux/platform`](packages/platform/AGENTS.md) | Capability-based platform facts, host modes, form factors, app profile, isolation policy |
| [`@staticflux/config`](packages/config/AGENTS.md) | Typed flags, layered resolution, OpenFeature-compatible providers, variant bindings |
| [`@staticflux/auth`](packages/auth/AGENTS.md) | Identity providers, session lifecycle, multi-tab sync, single-flight refresh, token broker |
| [`@staticflux/gate`](packages/gate/AGENTS.md) | Facts → policies → compiled decision tables; explainable decisions; meters (credits, quotas) |
| [`@staticflux/data`](packages/data/AGENTS.md) | Transports, resources with SWR and epochs, the single retry layer, schema-first stores, user-data slices |
| [`@staticflux/router`](packages/router/AGENTS.md) | Async 13-stage navigation pipeline, typed routes, exit guards, view sub-routes, routable dialogs |
| [`@staticflux/urlstate`](packages/urlstate/AGENTS.md) | URL-state kinds and owners, declared bindings, URL ⇄ store sync, consume-once intents |
| [`@staticflux/handoff`](packages/handoff/AGENTS.md) | State that survives reloads, redirects, tabs and embeds, with declared lifetimes |
| [`@staticflux/loader`](packages/loader/AGENTS.md) | Logical chunk ids, the `sf-manifest` runtime, warmup tiers, speculation, boot plans |
| [`@staticflux/perf`](packages/perf/AGENTS.md) | Journey traces, framework-measured feature marks, detectors, budgets, conformance stream |
| [`@staticflux/i18n`](packages/i18n/AGENTS.md) | Typed ICU catalogs, lazy locales, runtime locale switch, RTL |
| [`@staticflux/a11y`](packages/a11y/AGENTS.md) | Focus management, live-region announcer, shortcut registry, preference facts |
| [`@staticflux/worker`](packages/worker/AGENTS.md) | Typed envelopes and protocols, supervised workers, store replication, multi-tab coordinator |
| [`@staticflux/document`](packages/document/AGENTS.md) | ECS document model over a `DocumentCRDT` (Yjs), projections, presence, collaboration contract |
| [`@staticflux/wasm`](packages/wasm/AGENTS.md) | Wasm modules as worker-scoped units and chunks; feature facts; memory views |
| [`@staticflux/hydrate`](packages/hydrate/AGENTS.md) | Islands over prerendered HTML with event replay; store-snapshot rehydration |
| [`@staticflux/pwa`](packages/pwa/AGENTS.md) | Service worker from the chunk manifest, update flow without reload, launch intents |
| [`@staticflux/capabilities`](packages/capabilities/AGENTS.md) | Typed, schema-described actions for UI, palette and agents through one gated, metered pipeline |
| [`@staticflux/webmcp`](packages/webmcp/AGENTS.md) | Publishes capabilities as WebMCP tools (gated as subject `agent`) |
| [`@staticflux/ai`](packages/ai/AGENTS.md) | One model-provider port over built-in, on-device, decision and remote models |
| [`@staticflux/advisors`](packages/advisors/AGENTS.md) | Decision points and pluggable advisors — performance only, never authorization |
| [`@staticflux/sandbox`](packages/sandbox/AGENTS.md) | Untrusted plugins in sandboxed iframes / workers, limited to granted capabilities |

**UI and shell**

| Package | |
|---|---|
| [`@staticflux/ui`](packages/ui/AGENTS.md) | Lit components that self-inject `render` / `lazy` / `functional` deps; one render pass per frame |
| [`@staticflux/messaging`](packages/messaging/AGENTS.md) | One surface manager: dialogs, sheets, popovers, toasts, banners, coach marks — scope-bound, arbitrated |
| [`@staticflux/surface`](packages/surface/AGENTS.md) | DOM / Canvas2D / WebGL / WebGPU / HTML-in-Canvas surfaces, render workers, input forwarding |
| [`@staticflux/shell`](packages/shell/AGENTS.md) | Slots, design-token themes, workspaces, command palette, skip links, error boundaries |
| [`@staticflux/devtools`](packages/devtools/AGENTS.md) | Devtools on the telemetry fabric: boot waterfall, journeys, DI graph, decisions, violations (dev only) |

**Tooling** (build and test time only)

| Package | |
|---|---|
| [`@staticflux/testkit`](packages/testkit/AGENTS.md) | Test injector with overrides, fake time, fake session, `bootTestApp`, shared contract suites |
| [`@staticflux/sf`](tooling/sf/AGENTS.md) | CLI: graph check, lint rules, error catalog, budget ratchets, AGENTS.md sync, route and manifest checks |
| [`@staticflux/vite-plugin`](tooling/vite-plugin/AGENTS.md) | Vite 8 (default bundler): logical chunks, `sf-manifest.json`, preloads, precache list, budgets |
| [`@staticflux/rspack-plugin`](tooling/rspack-plugin/AGENTS.md) | Rspack / Module Federation 2.0: the same manifest, remotes as logical chunks, singleton checks |

**Apps:** [`apps/studio`](apps/studio/README.md) — the example app (below) · [`site`](site) — the documentation site, itself built with StaticFlux.

## Quick start

Requirements: **Node ≥ 22** and **pnpm 10** (`corepack enable` picks up the pinned version).

```sh
git clone https://github.com/akriti2591/staticflux.git
cd staticflux
pnpm install
pnpm build          # tsc -b: every package → dist/
pnpm test           # vitest + happy-dom; tests import packages from source
pnpm check          # the full CI gate: build, typecheck, test, boundaries, sf lint, error catalog, size budgets
```

### Run the Studio example

Studio is an AI-assisted mixed-media document editor that composes every vertical against mock services:
agentic chat, a document worker with co-editing, free vs premium gating with credits, guest vs signed-in,
an expert workspace and per-mode editor variants.

```sh
cd apps/studio
npx vite                                # dev server; packages resolve from source (no build needed)
npx vite build                          # production build + sf-manifest.json, sf-build-report.json
cd ../.. && npx vitest run apps/studio  # headless integration tests
```

Try `/studio/doc/1?panel=chat&prompt=Add%20an%20image`, `/onboarding/step/1`, `/settings`, `?sf-mode=web:compact`
and `?sf-debug`. See [`apps/studio/README.md`](apps/studio/README.md) for the architecture map and its 38 adapters.

### Run the documentation site

```sh
pnpm build                              # the site's build-time renderer reads packages' dist
pnpm --filter @staticflux/site dev      # http://localhost:5173/staticflux/
pnpm --filter @staticflux/site build    # → site/dist
```

## Documentation

| | |
|---|---|
| [Documentation site](https://akriti2591.github.io/staticflux/) | Philosophy, before/after examples, getting started, guides per area, package reference |
| [`AGENTS.md`](AGENTS.md) | The rules, for humans and AI agents (each package has its own) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Dev setup, repo layout, rules explained, adding packages and features, the `pnpm check` gate |
| [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) | What the framework must do (requirement IDs like R7.14) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, packages, contracts |
| [`docs/LIFECYCLES.md`](docs/LIFECYCLES.md) | Every state machine, valid transitions, invariants and error codes |
| [`docs/FEATURE-NEEDS.md`](docs/FEATURE-NEEDS.md) | The example app's needs every API traces to |
| [`docs/errors.json`](docs/errors.json) | Machine-readable error catalog (`pnpm errors`) |
| [`docs/research/prior-art.md`](docs/research/prior-art.md) | Prior-art survey behind the design |

### Publishing the site (repository owner)

The site deploys from `.github/workflows/pages.yml` on every push to `main` (and on manual dispatch).
**One-time setup:** in the repository settings, open *Pages → Build and deployment → Source* and select
**GitHub Actions**. The site is served at `https://akriti2591.github.io/staticflux/` (the Vite `base` is
`/staticflux/`; change it in `site/src/build/site.ts` if the repository is renamed or a custom domain is used).
