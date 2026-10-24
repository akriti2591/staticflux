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

## Pattern: capture deps in `create`, use them in `init`
`create(deps, ctx)` is the only place a unit receives its dependencies; `init(instance, ctx)` gets the
**instance** (plus `signal`, `epoch`, telemetry) and never the deps. This is by design (LIFECYCLES §4:
resolution → `created` → `initializing` → `ready`), not a gap — do not ask for deps in `init`. When async
readiness work needs a dependency, close over it in `create` and expose a method (or keep it on the instance)
that `init` calls:

```ts
export const docRuntimeUnit = unit({
  id: 'app/doc-runtime-unit',
  provides: DocRuntimeToken,
  scope: 'app',
  deps: { required: { client: DataClientToken, supervisor: SupervisorToken } },
  // Capture deps in create …
  create: ({ client, supervisor }, ctx): DocRuntimeHolder => {
    const holder: DocRuntimeHolder = {
      current: undefined,
      async load(signal) {
        const chunk = await import('./doc-runtime.js'); // heavy code stays off the boot path
        if (signal.aborted) return err(toSfError(signal.reason));
        holder.current = chunk.createRuntime({ client, telemetry: ctx.telemetry, scope: ctx.scope });
        return supervisor.register(holder.current.subsystem);
      },
    };
    return holder;
  },
  // … use them in init (through the instance). `init` makes the unit ready (or fails it).
  init: (holder, ctx) => holder.load(ctx.signal),
});
```
Keep `create` synchronous and cheap (no I/O); put awaited work in `init` so readiness, retries
(`retry`) and the `di.resolve` span cover it. Never stash deps in module-level variables.

## Rules
- Do not import from other `@staticflux/*` packages.
- Every new error goes through `defineError` with a code `SF-<AREA>-NNN` and a concrete `fix`.
- Every lifecycle is a `defineMachine` table mirrored in `docs/LIFECYCLES.md`.
- Keep the boot surface under budget; tooling-only code goes in a subpath export.

## Test
`pnpm vitest run packages/core`
