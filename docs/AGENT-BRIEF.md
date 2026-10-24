# Brief for package-building agents

You are building one or more packages of StaticFlux, a client-side TypeScript framework
(monorepo at /home/user/staticflux). The design is fixed by these docs — read them first:

- `AGENTS.md` (root rules — mandatory)
- `docs/REQUIREMENTS.md` (requirement IDs; implement the ones for your package)
- `docs/ARCHITECTURE.md`, `docs/LIFECYCLES.md` (state machines, invariants, error codes)
- `docs/FEATURE-NEEDS.md` (what the example "Studio" app needs from your package — design the API to serve it)
- `docs/research/prior-art.md` (the relevant section for your area)
- `packages/core/AGENTS.md` and `packages/core/src/*.ts` — the core API you build on. Use it idiomatically:
  `token('pkg/name').type<T>()`, `unit({...})`, `createInjector`, `Scope`, `Result`/`ok`/`err`,
  `defineError('SF-<AREA>-NNN', kind, summary, fix)`, `defineMachine`/`createMachine` for every lifecycle,
  `Task` combinators (`retry`, `timeout`, `createSingleFlight`, …), telemetry spans with a namespaced
  subsystem (e.g. `auth/session`) and `metric.*` declarations, the reactivity port (`box`, `derived`, `effect`, `watch`, `batch`).
  Read the core tests (`packages/core/src/*.test.ts`) for usage examples.

## Ground rules
- Work ONLY inside your assigned package directories. Package skeletons already exist
  (package.json, tsconfig.json, `src/index.ts`). Do not edit root files, other packages, or lockfiles.
- Do NOT run `pnpm install` / `npm install` and do NOT add dependencies. If you truly need one, say so in your report.
  Allowed deps are exactly those in your package.json (plus `@staticflux/core`, which is built).
- Do NOT `git commit`, `git push`, or touch git state. The coordinator commits your work.
- TypeScript strict (see tsconfig.base.json: exactOptionalPropertyTypes, noUncheckedIndexedAccess, verbatimModuleSyntax — use `import type`, `.js` extensions in relative imports).
- Composition over inheritance, no magic strings, everything cancellable (AbortSignal) and disposable (Scope),
  errors as `Result` with `defineError` codes, every lifecycle a typed machine, telemetry on everything meaningful.
- Expose DI units for your services (so apps register them), not only free functions.
- Browser APIs: feature-detect and degrade (Safari gaps!). Tests run in Vitest + happy-dom; inject clocks/random/storage/etc. to keep tests deterministic.
- Keep the boot-path code small (budgets in REQUIREMENTS R12.7). Verbose and explicit is fine; deep abstraction is not.
- Write thorough unit tests (`src/*.test.ts`) — every exported behaviour, lifecycle transitions, error paths.
- Write `AGENTS.md` in each package (purpose, layer, public API by file, rules, budgets, test command) — follow `packages/core/AGENTS.md` format.
- Export the public API from `src/index.ts`.

## Verify before reporting (must pass)
- `cd /home/user/staticflux && npx tsc -p packages/<name> --noEmit`
- `npx vitest run packages/<name>`
(Tests import `@staticflux/*` from source via vitest aliases; tsc resolves via built `dist` of dependencies.)

## Report (final message, ≤ 400 words)
Packages done; public API summary; requirement IDs covered and any NOT covered; deviations from the docs and why;
test count; anything the coordinator must do (root config, deps, cross-package follow-ups).
