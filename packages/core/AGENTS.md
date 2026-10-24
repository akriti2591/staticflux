# @staticflux/core — AGENTS.md

**Layer:** core (depends on nothing internal; only `mobx`).
**Budget:** ≤ 7.5 KB brotli for the boot surface (`.size-limit.json`).

## Purpose
The fabric every other package builds on: typed tokens, units, the hierarchical
readiness-aware injector, disposal scopes, `Result`/`SfError`, async Task combinators,
typed state machines, telemetry (spans/events/declared metrics), the reactivity port.
Graph analysis lives at `@staticflux/core/graph` (tooling/devtools; not in the boot path).

## Public API (by file)
- `token.ts` — `token('pkg/name').type<T>()`, `.multi<T>()`, `Registry` (declaration merging).
- `unit.ts` — `unit({ id, provides, scope, deps: { required, lazy, functional }, create, init, refreshOn, retry, critical })`, `DepHandle`, `FunctionalDep`, `ScopeLevel`, `InitTiming`.
- `injector.ts` — `createInjector`, `injector.child(level, name, units)`, `get`, `handle`, `functional`, `refresh(tokens | 'epoch')`, `resolveCritical`, `inspect`, `bind`, `variant`.
- `compose.ts` — `composeUnits([...])`, `defineModule({ units, external })` (compile-time completeness).
- `disposal.ts` — `createScope`, `scope.defer/use/listen/child/dispose`, `scope.signal`.
- `async.ts` — `Task<T>`, `task`, `retry`, `timeout`, `sleep`, `anySignal`, `createSingleFlight`, `createLimiter`, `createCircuitBreaker`, `createDeferred`, `settleAll`.
- `errors.ts` / `result.ts` — `defineError`, `SfError`, `toSfError`, `listErrorDefinitions`; `Result`, `ok`, `err`, `attempt`, `attemptAsync`.
- `machine.ts` — `defineMachine`, `createMachine` (reactive state, invalid transitions → `SF-CORE-010`).
- `telemetry.ts` — `createTelemetry`, levels `off|critical|standard|verbose|debug` per subsystem, `metric.counter|histogram|gauge|mark`, `formatTraceparent`/`parseTraceparent`, `createMemorySink`.
- `reactivity.ts` — `box`, `derived`, `effect`, `watch`, `batch`, `untracked` (MobX 7 behind a port).

## Rules
- Do not import from other `@staticflux/*` packages.
- Every new error goes through `defineError` with a code `SF-<AREA>-NNN` and a concrete `fix`.
- Every lifecycle is a `defineMachine` table mirrored in `docs/LIFECYCLES.md`.
- Keep the boot surface under budget; tooling-only code goes in a subpath export.

## Test
`pnpm vitest run packages/core`
