# @staticflux/sf — AGENTS.md

**Layer:** tooling (Node only; never imported by app or framework runtime code).
**Budget:** none (not shipped to browsers).

## Purpose
The StaticFlux CLI (R20.6). CI and agents use it to check the DI graph (R2.6, R17.21),
emit the machine-readable error catalog `docs/errors.json` (§13 error format), enforce
the StaticFlux lint rules (R20.5), report size budgets and propose ratchets (R12.8), and
keep the generated sections of every package `AGENTS.md` in sync with the config CI
enforces (R20.2), check route × profile completeness (R18.7) and validate build manifests (R12.2). Every command is a plain function (unit-tested) behind a thin argv layer.

## Commands
| Command | What it does | Exit codes |
|---|---|---|
| `sf graph <entry> [--json\|--dot] [--max-fan-out N] [--max-fan-in N] [--external a/b,…]` | Imports a module exporting `units` (+ optional `external` tokens/ids) or `module` (a `defineModule` result); runs `analyzeGraph`; adds `SF-GRAPH-DUP-PROVIDER` (warning) and `SF-GRAPH-UNUSED` (info). Text report: issues by severity, boot order, critical set, fan-in/out table. | 1 if any error issue |
| `sf errors [modules…] [--out FILE] [--check] [--strict] [--json]` | Imports modules (default `packages/*/dist/index.js`), merges core's `listErrorDefinitions()` with `ErrorDefinition`s found in the exports, writes `docs/errors.json` (`{ version, description, errors: [{ code, kind, summary, fix }] }`, sorted, deterministic). | 1 on code conflicts, stale file (`--check`), or import failures with `--strict` |
| `sf lint [paths…] [--json] [--rules a,b] [--flag-names a,b] [--include-tests]` | Runs the rules below over files/dirs/globs (default `packages/*/src`; `*.test.ts`, `*.spec.ts`, `__tests__/`, `.d.ts`, `dist`, `node_modules` excluded). Output `file:line:col rule message`. | 1 on violations |
| `sf budgets --results FILE [--config .size-limit.json] [--threshold 0.1] [--headroom 0.05] [--write] [--json]` | Table of limit vs. actual (`size-limit --json` output). Proposes tightening when actual < limit by more than the threshold: new limit = actual + headroom, rounded up to 0.1 of the limit's unit. `--write` applies only tightenings; nothing ever loosens. | 1 if any budget exceeded |
| `sf routes <entry> [--json]` | Imports a module exporting `routes` (router `defineRoute`s; capability bindings via `bindCapability`), `features` (runtime `defineFeature` manifests with `modes`) and `profiles` (`'web:expanded'`, `{ key, hostMode, formFactor }`, `{ key, modes }`) or `hostModes` + `formFactors`. For each capability-bound route × profile, selects the first candidate whose modes (candidate `modes` ?? manifest `modes`; none = all) share a mode with `[hostMode, formFactor]` (router `modesPredicate`). Errors: `SF-ROUTES-NO-FEATURE` (route/profile with no feature), `SF-ROUTES-UNKNOWN-FEATURE`, `SF-ROUTES-NO-CANDIDATES`; warning `SF-ROUTES-SHADOWED-CANDIDATE` (never selected); info `SF-ROUTES-UNROUTED-FEATURE` (non-headless). Text output: issues + route × profile → feature matrix (`MISSING`). | 1 if any error |
| `sf manifest <file> [--max-eager-kb N] [--max-boot-kb N] [--report FILE \| --no-report] [--json]` | Validates an `sf-manifest.json` (`sf-manifest/1`) structurally, collecting all issues: `SF-MANIFEST-FORMAT`, `-SHAPE` (ids, files, css, deps, tier, load, sizes, profiles, integrity), `-ID-MISMATCH`, `-REMOTE`, `-EAGER-REASON`, `-DANGLING-DEP`, `-OVER-BUDGET`, `-EAGER-BUDGET` (with `--max-eager-kb`), `-BOOT-BUDGET` (with `--max-boot-kb`), `-REPORT` (malformed report) — errors; `-CYCLE` warning; `-UNMEASURED` info (budget without size). Budgets use the build report (`sf-build-report/1`, default `<manifest dir>/sf-build-report.json`, as the Vite/Rspack plugins emit it): a chunk is over budget when its `incrementalKb` (bytes beyond the boot set) exceeds `budgetKb`; per-profile `bootKb` is checked against `--max-boot-kb`. Without a report the manifest's `sizeKb` (full closure, shared/boot code included) over budget is only a warning. Prints a chunk table (size, added, budget). | 1 if any error |
| `sf agents [--packages glob,…] [--size-limit FILE] [--check]` | Regenerates "Budgets" and "Allowed dependencies" between `<!-- sf:generated:start -->` / `<!-- sf:generated:end -->` in each `packages/*/AGENTS.md` from `package.json` (`dependencies`, `staticflux.layer`) and `.size-limit.json` (checks whose `path` is inside the package dir). Appends the markers if absent; creates the file if missing. | 1 if stale with `--check` |

Exit code 2 = usage or input error (printed as `SF-TOOL-NNN: message` + `fix:`).

## Lint rules (syntactic heuristics — no type checker)
- `no-direct-flag-reads` — calls named `flag` / `readFlag` / `getFlag` (configurable: `flagReadNames`, `--flag-names`) outside files ending `.bindings.ts` or under a `bindings/` dir.
- `no-bare-listener` — `addEventListener` whose 3rd argument is not an object literal with `signal` (or an identifier bound in the same file to such a literal). Also accepted: the same function registers `scope.defer(() => x.removeEventListener(<same type>, <same listener>))`. `scope.listen(...)` is the preferred form. Spreads alone do not count.
- `inheritance-depth` — follows `extends` by class *name* across all linted files; the chain ends at an allowed base (`Error`, `LitElement`, `HTMLElement`, `SfElement`) or a class not declared in the linted set. Depth > 1 is a violation. `extends Mixin(Base)` is treated as one level (composition).
- `no-string-tokens` — a string literal first argument to free `inject(…)`, to `.inject(…)` on any receiver, or to `.get/.handle/.functional/.resolve/.has(…)` when the receiver's last identifier matches `/^(injector|inj|container|di|\w*Injector)$/` (so `map.get('k')` / `headers.get('x')` are not flagged).
- `no-default-export` — `export default …`, `export { x as default }`, `export { default } from …`.

Suppress one line: `// sf-lint-disable-next-line <rule>[, rule] -- reason` (no rule list = all rules).

## Public API (by file)
- `cli.ts` — `runCli(argv, io)` → exit code, `parseArgs`, `HELP`; `#!/usr/bin/env node` entry (`bin: sf → dist/cli.js`).
- `graph.ts` — `readGraphExports`, `loadGraphModule`, `checkGraph`, `formatGraphText`, `formatGraphJson`, `formatGraphDot`.
- `error-catalog.ts` — `collectErrorCatalog`, `serializeErrorCatalog`, `writeErrorCatalog`, `isErrorCatalogCurrent`, `DEFAULT_ERROR_MODULES`.
- `lint.ts` — `lintSources`, `lintPaths`, `collectLintFiles`, `formatLintText`, `LINT_RULES`, `DEFAULT_LINT_CONFIG`, `DEFAULT_LINT_PATHS`.
- `budgets.ts` — `analyzeBudgets`, `applyRatchet`, `parseBytes` (size-limit semantics: `KB` = 1000 B, `KiB` = 1024 B), `formatLimitLike`, `formatBudgetTable`, `readBudgetConfig`, `readBudgetResults`, `writeBudgetConfig`.
- `agents.ts` — `updateAgentsFiles`, `renderGeneratedBlock`, `spliceGeneratedBlock`, `budgetsForPackage`, `readPackageInfo`, `GENERATED_START`/`GENERATED_END`.
- `routes.ts` — `readRoutesExports`, `loadRoutesModule`, `checkRoutes`, `formatRoutesText`, `formatRoutesJson`, `ROUTE_ISSUES` (structural `RouteLike`/`FeatureLike`/`RouteProfile`; no router/runtime dependency).
- `manifest-check.ts` — `checkManifest(json, { maxEagerKb, maxBootKb, report })`, `formatManifestText`, `MANIFEST_ISSUES`, `BUILD_REPORT_FORMAT_ID` (structural; no loader dependency).
- `files.ts` — `expandGlob` (`*`, `?`, `**`), `importModule` (injectable `ModuleImporter`), `readJson`/`readText` as `Result`, `formatError`.
- `errors.ts` — `SF-TOOL-001` module load failed · `002` invalid graph module · `003` file read failed · `004` invalid JSON/shape · `005` usage · `006` error-code conflict · `007` invalid routes module.

## Rules
- Node built-ins, `@staticflux/core` (incl. `@staticflux/core/graph`) and `typescript` only; no CLI libraries.
- Commands are functions returning data; formatting and exit codes live in `cli.ts`.
- Generated files are deterministic (no timestamps) so `--check` modes work in CI.
- Tests use temp dirs; modules that tests `import()` must live under the workspace root (`tempDir({ importable: true })` → `node_modules/.sf-test`), because Vitest only loads files there.

## Test
`npx vitest run tooling/sf` · typecheck `npx tsc -p tooling/sf --noEmit`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

No size budget declared in `.size-limit.json` for this package.

## Allowed dependencies

**Layer:** tooling

- Internal: `@staticflux/core`
- External: `typescript` (5.9.3)

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
