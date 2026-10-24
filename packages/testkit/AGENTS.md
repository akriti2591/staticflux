# @staticflux/testkit — AGENTS.md

**Layer:** tooling (test-only). Depends on `@staticflux/core`, `runtime`, `auth`, `data`, `platform`, `storage`,
`worker`, `router`, `urlstate`; `vitest` is a **peer** and is never imported at runtime (contract suites take
`describe`/`it` as parameters). Never import testkit from app or package source — only from `*.test.ts`.
**Budget:** none (not shipped to browsers).

## Purpose
REQUIREMENTS §16 (R16.2–R16.4): a test injector with top-precedence overrides and recorded telemetry,
deterministic time for every injectable timing port, a fake session over the real auth session store,
shared contract suites, a `bootTestApp` helper, and one import point for the fakes other packages ship.

## Public API (by file)
- `injector.ts` — `createTestInjector({ units, overrides, level, name, telemetryLevel, telemetryLevels, now, idle })` →
  `{ injector, get(token) (throws SF-TEST-002), dispose(), …TestTelemetry }`; `asOverrides(entries)` (re-bind at
  `experiment` precedence, keeps `when`); `provideValue(token, value, scope?)`; `OVERRIDE_SOURCE`.
- `telemetry.ts` — `createTestTelemetry({ level = 'debug', levels, now, random })` → `telemetry`, `sink`, `records`,
  `spans(query)`, `openSpans(query)`, `events(query)`, `metrics(def?)`, `violations()`, `expectNoViolations()` (SF-TEST-003),
  `spanTree(query?)`, `formatSpanTree()`, `expectChildSpan(parent, child, { deep })` (SF-TEST-005), `clear`, `dispose`.
  `RecordQuery { name: string|RegExp, subsystem, status, attrs }` (a string = name). `createSeededRandom(seed)`.
  `VIOLATION_EVENT` (`violation`, the R17.22 conformance event — mirrored, no perf dependency).
- `time.ts` — `createFakeClock({ start })` (`now`, `setTimeout/clearTimeout/setInterval/clearInterval`, `setTimer → cancel`,
  `sleep(ms, signal)` (core `Sleep`), `advance`, `advanceAsync`, `next`, `runAll` (SF-TEST-004 on runaway), `runAllAsync`, `setNow`);
  `createFakeFrames({ clock, frameMs })` (`raf`, `cancelRaf`, `flushFrame`, `flushFrames`); `createFakeIdle({ clock, budgetMs })`
  (`requestIdleCallback` with clock-driven `timeout`, `cancelIdleCallback`, `flushIdle`); `createFakeTime()` bundling them with
  `tasks` (macrotask queue), `schedulerEnv` (runtime `createFrameScheduler` env), `urlScheduler` (urlstate port), `injectorIdle`,
  `flush()` (until quiet, time frozen), `advance(ms)`; `flushMicrotasks(turns)`.
- `session.ts` — `createFakeSession({ initial: 'guest' | user | { user, roles, plan, entitlements }, clock, channels, expiresInMs, refresh })`
  → `{ provider, env, units, store, snapshot, ready, login, logout, expire, switchAccount, revoke }`;
  `createFakeIdentityProvider` (`setIdentity`, `emit`, `failNext(op, error)`, `calls`); `toPrincipal` (plan/entitlements → `claims`).
- `contract-runner.ts` — `ContractRunner`, assertion helpers (`assertEqual`, `okValue`, `errOf`, `within`).
- `transport-contract.ts` — `runTransportContract(name, factory(fixture), runner, { stream, timeoutMs, skip })`,
  `transportContractCases`, `createTransportFixture`, `ContractEndpoints`, `mockTransportFromFixture`.
- `history-contract.ts` — `runHistoryContract(name, factory(initialUrl), runner, { level: 'port' | 'adapter', timeoutMs, skip })`,
  `historyContractCases` (urlstate `HistoryPort`), `historyAdapterContractCases` (router `HistoryAdapter` extras).
- `app.ts` — `bootTestApp({ units, overrides, subsystems, routes, router, initialUrl, session, time, telemetryLevel })` →
  `{ app, injector, router?, history?, session?, time?, get, shutdown, …TestTelemetry }` (boot failure throws SF-TEST-001);
  `fakeFrameSchedulerUnit(time)`.
- `fakes.ts` — re-exports (do NOT duplicate): data `createMockTransport`/`mockStatus`/`mockTransportUnit`/`createMockRemoteSync`/
  `createMemoryBackend`; platform `createFakePlatformEnv`/`SAMPLE_USER_AGENTS`; storage `createMemoryStore`/`createFakeIndexedDb`/
  `createFakeCookieDocument`/`createFakeOpfsRoot`/`createBroadcastHub`/`createMockRemoteTransport`/`runStoreContract`/`storeContractCases`;
  worker `createPortPair`/`inMemorySpawner`; router `createRouterMemoryHistory`; urlstate `createUrlMemoryHistory`/`createManualScheduler`;
  auth `createTestAuthEnvironment`/`createMemoryChannelHub`/`memoryStorage`.
- `errors.ts` — `SF-TEST-001` boot failed · `002` resolve failed · `003` unexpected violations · `004` runaway timers · `005` span assertion.

## How to test a unit
Register the unit under test with its real dependencies or overrides; assert on values *and* on telemetry.
```ts
const t = createTestInjector({
  units: [docsUnit, dataClientUnit, epochSourceUnit, pauseControlUnit],
  overrides: [mockTransportUnit((m) => m.route(DocGet, ({ id }) => ({ id, title: 'Draft' })))],
});
const docs = await t.get(DocsToken);
expect((await docs.load('42')).ok).toBe(true);
expect(t.spans({ name: 'data/request', attrs: { endpoint: 'docs/get' } })).toHaveLength(1); // structure, not timings
t.expectChildSpan({ name: 'di.resolve', attrs: { unit: 'docs/unit' } }, { name: 'di.resolve', attrs: { unit: 'data/client-unit' } });
t.expectNoViolations();
await t.dispose();
```
- Overrides use `experiment` precedence: they beat `bind(…, { precedence: 'app' })` and variants. `provideValue(Token, fake)` for plain values.
- Telemetry defaults to `debug`, so `verbose` DI spans (`di.resolve`) are visible; pass `telemetryLevel` to test level gating.

## How to test a feature (boot path, routing, session)
```ts
const t = await bootTestApp({
  units: [...runtimeUnits, ...studioUnits],
  routes: [home, doc],               // adds router + memory history + routeUnits; omit if units register the router
  initialUrl: '/doc/42',
  session: { initial: { user: 'ada', roles: ['editor'], plan: 'pro' } },
  time: true,                        // fake time: scheduler frames, supervisor back-offs, session expiry
});
expect(t.router?.current?.route).toBe(doc);
await t.session?.switchAccount('bob');  // principalChanged + requiresEpochRefresh (one change)
await t.session?.expire();              // → expired (provider rejects the refresh)
await t.time?.advance(1_000);           // restart back-offs / timers elapse only here
t.expectChildSpan('app.boot', 'boot.critical');
await t.shutdown();
```
- Multi-tab: two `createFakeSession({ channels: hub })` sharing `createMemoryChannelHub()`.
- With fake time, `bootTestApp` drains work that needs no time and returns; starts that sleep wait for `time.advance()`.

## How to test a component
Use `@staticflux/ui/testing` (`mountTestRoot`, `manualVisibility`, `settle`) for the DOM root, and testkit for the rest:
build the injector with `createTestInjector({ units: [...uiUnits, ...], overrides })`, pass `injector: t.injector` to
`mountTestRoot`, drive frames with a `fakeFrameSchedulerUnit(time)` override + `await time.flush()`, and platform
facts with `createFakePlatformEnv()` (`platformEnvUnit(env)` override). Browser-mode tests (R16.1) run the same code in a real browser.

## Contract suites (R16.4)
Every implementation of a contract runs the shared suite; a new adapter is not done until it passes.
```ts
import { describe, it } from 'vitest';
runTransportContract('fetch', (fixture) => createFetchTransport({ baseUrl: '/api', fetch: fakeFetch(fixture) }), { describe, it });
runHistoryContract('router memory', (url) => createRouterMemoryHistory({ initial: url }), { describe, it }, { level: 'adapter' });
runStoreContract('memory', () => createMemoryStore(), { describe, it });
```
The transport fixture is addressed by path (`/echo`, `/query`, `/status/<n>`, `/hang`, `/stream`, `/stream-hang`, `/stream-fail`);
the factory adapts it to its wire (see `contracts.test.ts` for a fake `fetch` speaking JSON + NDJSON). Suites use real timers
for their settle timeouts — do not run them under `vi.useFakeTimers()`.

## Rules
- Re-export other packages' fakes; never re-implement them here. A missing fake belongs in its package.
- Nothing patches globals. Code that calls global `setTimeout` directly (core `sleep`, mock-transport latency) needs
  `vi.useFakeTimers()`; everything with an injectable port should get a testkit fake instead.
- Assert span *structure* and attributes, never durations. Seeded randomness keeps span ids stable.
- Helpers throw `SfError`s with `SF-TEST-*` codes (tests fail loudly); everything else stays `Result`-based.

## Test
`npx vitest run packages/testkit` · `npx tsc -p packages/testkit --noEmit`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

No size budget declared in `.size-limit.json` for this package.

## Allowed dependencies

**Layer:** tooling

- Internal: `@staticflux/auth`, `@staticflux/core`, `@staticflux/data`, `@staticflux/platform`, `@staticflux/router`, `@staticflux/runtime`, `@staticflux/storage`, `@staticflux/urlstate`, `@staticflux/worker`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
