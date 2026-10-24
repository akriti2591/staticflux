# Contributing to StaticFlux

Thanks for helping. This guide is for humans; [`AGENTS.md`](AGENTS.md) (symlinked as `CLAUDE.md`) is the
short, machine-friendly version of the same rules, and every package has its own `AGENTS.md`. Where this file
and an `AGENTS.md` disagree, the `AGENTS.md` wins — and please open a PR to fix this file.

- [Development setup](#development-setup)
- [Repository layout](#repository-layout)
- [The rules, explained](#the-rules-explained)
- [Adding a package](#adding-a-package)
- [Adding a unit, a feature or a capability](#adding-a-unit-a-feature-or-a-capability)
- [Testing](#testing)
- [The `pnpm check` gate and CI](#the-pnpm-check-gate-and-ci)
- [Commits and pull requests](#commits-and-pull-requests)
- [Working with AI agents](#working-with-ai-agents)

## Development setup

Requirements: **Node ≥ 22**, **pnpm 10** (the exact version is pinned in `package.json` → `packageManager`;
`corepack enable` picks it up).

```sh
pnpm install
pnpm build            # tsc -b tsconfig.build.json — every package and tool → dist/
pnpm test             # vitest run (happy-dom); tests import @staticflux/* from source via aliases
pnpm test:watch
pnpm typecheck        # tsc -p tsconfig.test.json (sources + tests of packages and tooling)
pnpm check            # everything CI runs (see below)
```

Tests never need a build: the root `vitest.config.ts` aliases `@staticflux/<pkg>` to
`packages/<pkg>/src/index.ts`. `tsc` resolves packages through their built `dist`, so run `pnpm build` (or
`npx tsc -b packages/<pkg>`) after changing a package another package depends on.

Useful one-offs:

```sh
npx vitest run packages/router              # one package
npx tsc -p packages/router --noEmit         # typecheck one package
cd apps/studio && npx vite                  # the example app (dev server, source aliases)
pnpm --filter @staticflux/site dev          # the documentation site
```

## Repository layout

```
packages/<name>/        framework packages — src/, AGENTS.md, package.json, tsconfig.json
tooling/sf              the sf CLI (graph, lint, errors, budgets, agents, routes, manifest)
tooling/vite-plugin     Vite 8 integration (default bundler)
tooling/rspack-plugin   Rspack / Module Federation 2.0 integration
apps/studio             the example app: every vertical composed against mock services
site                    the documentation site (GitHub Pages), built with StaticFlux
docs/                   REQUIREMENTS, ARCHITECTURE, LIFECYCLES, FEATURE-NEEDS, errors.json, research/
.size-limit.json        size budgets per package entry point
.dependency-cruiser.cjs boundary rules
tsconfig.base.json      strict compiler settings shared by everything
tsconfig.build.json     project references of every buildable package (tsc -b)
```

**Layers**, low to high: `core < runtime < vertical < ui < shell < feature < app` (plus `tooling`, which ships
nothing to browsers). Each package declares its layer in `package.json` → `"staticflux": { "layer": "…" }`.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the package map and contracts.

## The rules, explained

These are the ten rules of `AGENTS.md`. Most of them are enforced by tooling — please don't work around the
tooling; if a rule is wrong for your case, say so in the PR.

### 1. No magic strings

Tokens, flags, metrics, routes, URL keys, capabilities, chunks and errors are **typed values** created by
`token()`, `defineFlag()`, `metric.*()`, `defineRoute()`, `defineUrlBinding()`, `defineCapability()`,
`chunk()`, `defineError()`. You import the declaration; you never type the id again.

```ts
export const SessionToken = token('auth/session').type<Session>();   // ✓ declared once
injector.get(SessionToken);                                           // ✓
injector.get('auth/session');                                         // ✗ sf lint: no-string-tokens
```

Cross-package typing uses declaration merging (`interface Registry { urlParams: { tab: … } }`), so a key
collision or a type mismatch is a compile error. *Why:* string keys drift silently; typed values fail the build.

### 2. Declare, don't wire

Every unit declares `deps` (`required` / `lazy` / `functional`) and `provides`. No service locators, no
globals, no module-level singletons, no reaching into another package's state. The injector resolves the
graph, in dependency order, lazily. *Why:* a declared graph can be type-checked (`composeUnits`,
`defineModule`), analysed (`sf graph`: cycles, scope leaks, fan-in/out), ordered for boot and split into chunks.

Capture dependencies in `create` (synchronous, cheap, no I/O) and do async readiness work in `init`; see the
pattern in [`packages/core/AGENTS.md`](packages/core/AGENTS.md).

### 3. Composition over inheritance

At most one level of `extends` — and the only base you extend is Lit's (`SfElement`). Features are manifests
plus hook modules, units are plain objects, middleware returns the interface it wraps. Enforced by the
`inheritance-depth` lint rule. No decorators, no `reflect-metadata`.

### 4. No `if/else` on flags or modes in feature code

Experiments are **variant bindings**: one unit per variant, bound by `createFlagBinder().variants(...)` at
`experiment` precedence. Modes (host mode × form factor) are **separate features** that the router's
availability stage picks per profile; shells pick a preset per profile. Feature code injects a token and never
learns which variant it got. Enforced by the `no-direct-flag-reads` lint rule (flag reads are allowed only in
`*.bindings.ts` / `bindings/`).

### 5. Everything cancellable and disposable

Every async API takes an `AbortSignal`. Every listener, timer, subscription, port and request registers in the
scope that owns it — `scope.defer(cleanup)`, `scope.use(disposable)`, `scope.listen(target, type, fn)` — so
leaving a lifecycle state cleans up. Prefer `scope.listen`; a bare `addEventListener` without a `signal` (or a
matching `scope.defer(removeEventListener)`) fails the `no-bare-listener` lint rule.

### 6. Errors are values

Expected failures return `Result<T, SfError>` (`ok` / `err`); they never throw. Every error is declared once:

```ts
export const ScopeViolation = defineError('SF-DI-002', 'invariant',
  'A longer-lived unit requires a shorter-lived unit.',
  'Move the dependency to a lazy dep, or lower the consumer scope.');
```

Codes are stable (`SF-<AREA>-NNN`), unique across the repo, and every one has a concrete `fix`. `pnpm errors`
collects them into [`docs/errors.json`](docs/errors.json); `pnpm errors:check` fails CI if the catalog is stale
or two packages claim the same code. Every lifecycle is a `defineMachine` table mirrored in
[`docs/LIFECYCLES.md`](docs/LIFECYCLES.md).

### 7. Layer boundaries

A package imports only lower layers and only through package entry points — never `…/src/…`. Same-layer
packages talk through ports that the app (or an adapter) wires. Checked by `pnpm lint:boundaries`
(dependency-cruiser: no runtime cycles, no deep imports, core imports nothing internal, features never import
features) and by each package's declared `dependencies` (pnpm only links what you declare). `sf agents` writes
the allowed set into every package's `AGENTS.md`.

### 8. Budgets ratchet

Size budgets live in `.size-limit.json` and run in CI (`pnpm size`). `pnpm budgets` compares actuals with
limits and **proposes tightening** when you beat a budget (`sf budgets --write` applies only tightenings).
Loosening a budget needs a reason in the PR. Feature and chunk budgets live in manifests and the Vite /
Rspack plugins enforce them; eager loading needs a declared `reason`.

### 9. Client gating is UX, not security

`gate`, `auth`, route guards, the capability pipeline, WebMCP and the sandbox decide what to render, load and
attempt. They never authorize anything. The server re-checks every request; never ship data a user may not see
on the assumption that a gate hides it. Advisors are never consulted for access decisions.

### 10. Tests ship with code

Every exported function has unit tests; every implementation of a contract runs that contract's shared suite.
See [Testing](#testing).

### Style

TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` — use
`import type` and `.js` extensions in relative imports), ESM only, explicit return types on exported
functions, no default exports (`no-default-export`). Verbose and explicit beats clever; at most one layer
between a contract and its implementation. Browser APIs go through injectable ports and are feature-detected
(Safari and Firefox gaps are the norm, not the exception).

## Adding a package

1. **Skeleton** — `packages/<name>/` with:
   - `package.json`: `"name": "@staticflux/<name>"`, `"type": "module"`, `"sideEffects": false`, an `exports`
     map (`types` + `import` pointing into `dist/`), `"files": ["dist"]`, `"staticflux": { "layer": "vertical" }`
     (or `core | runtime | ui | shell | tooling`) and `dependencies` with `workspace:*` for internal packages.
     Exact versions for external dependencies; adding one needs a reviewed reason.
   - `tsconfig.json`: extends `../../tsconfig.base.json`, `rootDir: "src"`, `outDir: "dist"`, excludes
     `src/**/*.test.ts`, and lists a `references` entry for each internal dependency.
   - `src/index.ts` exporting the public API (`export * from './x.js'`). Tooling-only code goes in a subpath
     export so it stays off the boot path.
2. **Register it** — add the package to `tsconfig.build.json` `references`, run `pnpm install` (links the
   workspace package and updates the lockfile).
3. **`AGENTS.md`** — follow [`packages/core/AGENTS.md`](packages/core/AGENTS.md): layer, budget, purpose,
   public API **by file**, semantics, rules (including the "client gating is UX" banner if it gates anything),
   lifecycles mirrored into `docs/LIFECYCLES.md`, and the test command. Then run `pnpm agents` to append the
   generated *Budgets* / *Allowed dependencies* sections (`pnpm agents:check` runs in review).
4. **Budget** — add a `.size-limit.json` entry for the entry point (`"path": "packages/<name>/dist/index.js"`,
   `"ignore"` for `mobx` and the `@staticflux/*` packages it builds on, a `"limit"`), optionally a second entry
   with `"import"` for the boot surface.
5. **Errors** — declare every error with `defineError('SF-<AREA>-NNN', kind, summary, fix)` in `errors.ts` and
   export it. Run `pnpm build && pnpm errors` to regenerate `docs/errors.json` and commit it. If the package
   has extra entry points with errors, add their `dist` files to the `errors` / `errors:check` scripts.
6. **Tests** — `src/*.test.ts` for every exported behaviour, lifecycle transition and error path. Inject
   clocks, randomness, storage and browser globals to keep them deterministic.
7. **Trace it** — every API should trace to a need in [`docs/FEATURE-NEEDS.md`](docs/FEATURE-NEEDS.md) and a
   requirement ID in [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md). Expose DI units (and a one-line opt-in
   array like `perfUnits`) so apps register services instead of calling free functions.

## Adding a unit, a feature or a capability

**A unit** — declare the token in the owner's contracts file and the unit next to its implementation:

```ts
export const DocsToken = token('docs/list').type<DocsList>();
export const docsUnit = unit({
  id: 'docs/list-unit',
  provides: DocsToken,
  scope: 'session',                      // the shortest-lived scope that is long enough
  deps: { required: { resources: ResourcesToken }, lazy: { presence: PresenceToken } },
  refreshOn: ['epoch'],                  // re-init after an app-wide refresh (login, token change)
  create: ({ resources, presence }, ctx) => createDocsList(resources, presence, ctx.scope),
});
```

Register it in the composition (in Studio: `apps/studio/src/app/compose.ts`). If a dependency's owner is
another package, bridge the two in an adapter file (`src/adapters/<a>-<b>.ts`), never by importing across
features.

**A feature** — a manifest (`defineFeature({ id, weight, modes, retention, budget, readiness, load })`)
contributed to `FeatureManifestsToken`, plus a module (`defineFeatureModule({ units, activate, mount, hide,
unmount, snapshot, restore })`) in its own chunk (`chunk('feature:<name>', { entry, tier, budget })`). Bind it
to routes through a capability (`bindCapability(...)`), declare its URL bindings, slices and surfaces in the
contracts file, and add it to the route × mode matrix (`sf routes`). Features never import each other.

**A capability** — `defineCapability({ id, title, description, input, output, policy, destructive,
requiresConfirmation, costEstimate })` in contracts, `implementCapability(cap, run)` in the owning feature
(returning a `Result`), provided with `provideCapabilities` / `capabilityImplementationUnit`. Write the gate
policy for each subject (`user`, `agent`) — UI, command palette, agents and WebMCP all call the same pipeline.

## Testing

Use [`@staticflux/testkit`](packages/testkit/AGENTS.md) (only from `*.test.ts`, never from source):

```ts
const t = createTestInjector({ units: [docsUnit, dataClientUnit, epochSourceUnit, pauseControlUnit],
  overrides: [mockTransportUnit((m) => m.route(DocGet, ({ id }) => ({ id, title: 'Draft' })))] });
const docs = await t.get(DocsToken);
expect(t.spans({ name: 'data/request', attrs: { endpoint: 'docs/get' } })).toHaveLength(1);
t.expectNoViolations();
await t.dispose();
```

- `createTestInjector` — overrides at `experiment` precedence, recorded telemetry (`spans`, `events`,
  `metrics`, `expectChildSpan`, `expectNoViolations`). Assert span **structure**, never durations.
- `createFakeTime()` / `createFakeClock()` — deterministic frames, idle callbacks and timers.
- `createFakeSession` — the real session store over a scripted provider (`login`, `expire`, `switchAccount`).
- `bootTestApp` — boot, routing and session in one call, with fake time.
- Contract suites — `runTransportContract`, `runHistoryContract`, `runStoreContract`: a new adapter is not done
  until it passes its contract's suite.
- Components — `@staticflux/ui/testing` (`mountTestRoot`, `manualVisibility`, `settle`).

A missing fake belongs in the package that owns the contract; testkit only re-exports.

## The `pnpm check` gate and CI

`pnpm check` runs, in order — and [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same steps on
pushes to `main` (and `claude/**` branches) and on pull requests:

| Step | Command | Fails when |
|---|---|---|
| Build | `pnpm build` | any package fails `tsc -b` |
| Typecheck | `pnpm typecheck` | sources or tests don't type-check |
| Tests | `pnpm test` | any Vitest test fails |
| Boundaries | `pnpm lint:boundaries` | runtime cycles, deep imports, core importing packages, features importing features |
| StaticFlux lint | `pnpm lint:sf` | string tokens, bare listeners, deep inheritance, flag reads outside bindings, default exports |
| Error catalog | `pnpm errors:check` | `docs/errors.json` is stale or two errors share a code |
| Size | `pnpm size` | an entry point exceeds its `.size-limit.json` budget |

Also useful before review: `pnpm agents:check` (generated `AGENTS.md` sections current), `pnpm budgets`
(ratchet proposals), `pnpm sf graph <module exporting units>` and `pnpm sf routes <module>` for apps.

The documentation site deploys from [`.github/workflows/pages.yml`](.github/workflows/pages.yml) on pushes to
`main`.

## Commits and pull requests

- **Commits** follow Conventional Commits with the package as scope: `feat(router): exit guards can be
  uninterruptible`, `fix(data): discard stale-epoch responses`, `chore: …`, `docs: …`, `test(gate): …`.
  Keep one logical change per commit.
- **Pull requests** say *what* and *why*, list the requirement IDs (`R7.2`) they implement, and call out:
  any budget change (with the reason), new or changed error codes, lifecycle changes (with the
  `docs/LIFECYCLES.md` update), new dependencies, and anything that crosses a layer.
- `pnpm check` passes locally before you ask for review. Don't skip hooks or lint rules; a
  `// sf-lint-disable-next-line <rule> -- reason` needs a real reason.
- Changes to a package update its `AGENTS.md` in the same PR.

## Working with AI agents

The codebase is written to be agent-first: explicit, declarative, shallow, with the rules in machine-readable
form. When you delegate work to an AI agent:

- **Brief it like a new teammate.** [`docs/AGENT-BRIEF.md`](docs/AGENT-BRIEF.md) is the template used to build
  the packages: what to read first (root `AGENTS.md`, `REQUIREMENTS`, `ARCHITECTURE`, `LIFECYCLES`,
  `FEATURE-NEEDS`, the relevant prior-art section, `packages/core/AGENTS.md` and the core tests), how to use the
  core idiomatically, the ground rules, how to verify, and a fixed report format.
- **One agent per package (or per adapter).** Agents work only inside their assigned directories, don't touch
  root files, lockfiles or other packages, don't add dependencies and don't commit — a coordinator reviews
  and commits. Several agents can work in parallel because the boundaries are real.
- **Verify before reporting.** Each agent must pass `npx tsc -p packages/<name> --noEmit` and
  `npx vitest run packages/<name>` and report public API, requirement IDs covered and not covered, deviations
  and follow-ups.
- **Point agents at the error catalog.** `docs/errors.json` has every code with its fix; agents should look
  codes up instead of guessing, and the package `AGENTS.md` files are the API reference.
- Package gaps found while building an app are worked around in that app's adapter with a `PACKAGE GAP` /
  `WORKAROUND` comment and fixed upstream in a separate change.
