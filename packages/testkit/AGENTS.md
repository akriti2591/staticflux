# @staticflux/testkit — AGENTS.md

**Layer:** tooling (test-only). Depends on `@staticflux/core`, `runtime`, `auth`, `data`, `platform`, `storage`,
`worker`, `router`, `urlstate`, `document` (v2 entry); `fast-check` drives property suites; `vitest` is a **peer** and is never imported at runtime (contract suites take

`worker`, `router`, `urlstate`, `blob`; `vitest` is a **peer** and is never imported at runtime (contract suites take

`worker`, `router`, `urlstate`, `ui` (theme contract); `vitest` is a **peer** and is never imported at runtime (contract suites take
`describe`/`it` as parameters). Never import testkit from app or package source — only from `*.test.ts`.
**Budget:** none (not shipped to browsers).

## Purpose
REQUIREMENTS §16 (R16.2–R16.4): a test injector with top-precedence overrides and recorded telemetry,
deterministic time for every injectable timing port, a fake session over the real auth session store,
shared contract suites, a `bootTestApp` helper, and one import point for the fakes other packages ship.
§16.1 (R16.20–R16.25, SF-Δ31 M1 part): render, GPU and media testing — a recording WebGPU fake, SSIM image
comparison, golden render snapshots, a real-GPU runner (Chromium on SwiftShader or a real GPU) and
`VideoFrame`/`AudioData` fakes with close accounting.

**Entry points:** `@staticflux/testkit` (environment-free: Node, workers, browsers) and `@staticflux/testkit/node`
(Node only: `node:fs`, `node:zlib`, `node:http`; PNG codec, goldens on disk, the GPU runner). Bin: `sf-gpu-run`.

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
- `document-store-contract.ts` — `runDocumentStoreContract(name, factory(), runner, { skip })`, `documentStoreContractCases`
  (document `DocumentStore` port: head CAS on `generation`, content-addressed blobs, log seqs/truncation, abort).
- `document-repo-contract.ts` — `runDocumentRepoContract(name, { store, repo(store, { undoHorizon }), liveHandles? }, runner, { skip })`,
  `documentRepoContractCases` (lazy parts, replay, one record per cross-part commit, compaction + undo horizon, concurrent
  compaction, two-tab convergence, eviction, close).
- `document-crdt-contract.ts` — `runDocumentCrdtContract(name, engine, runner, { numRuns, seed, maxPeers, maxSteps, skip })`,
  `documentCrdtContractCases`: deterministic cases plus the **N-peer convergence property** (fast-check: move, reorder,
  text, marks, set, create, delete under random partitions and heals → identical canonical bytes, valid tree, handles released).
  Reproduce a failure with the printed `seed`.
- `undo-service-contract.ts` (Instaflow M1 A8) — `runUndoServiceContract(name, { store, repo(store), service(doc) }, runner,
  { numRuns, maxSteps, seed, skip })`, `undoServiceContractCases` (stage `UndoService`: one step per commit / gesture /
  invocation, per-actor stacks, 200-step default, flagged undo over a later overwrite and its resolutions, persistence
  across reload and compaction, peers converging) plus two **fast-check properties** with two humans and an agent on
  three peers: an exact model under immediate delivery, and own-edits-only plus convergence under random partitions.
  `contractHumanA`, `contractHumanB`, `contractAgent` actors.

- `blob-store-contract.ts` — `runBlobStoreContract(name, factory() → { store, corrupt?, cleanup? }, runner, { skip })`,
  `blobStoreContractCases` (`@staticflux/blob` `BlobStore`: digests, dedupe, chunking above 8 MiB, ranges, encoding,
  quarantine, abort, `putEncoded`, dispose). Runs in Vitest (memory; directory over the memory FS, both write modes)
  and in Chromium over real OPFS (`blob-store-contract.browser.ts`: main thread + dedicated worker; `pnpm test:browser`).

- `theme-contract.ts` — `runThemeContract(name, factory, runner, { skip })`, `themeContractCases`: a theme over `themeTokens`
  is complete and compiles; WCAG 2.2 AA text (4.5:1) and non-text (3:1) pairs in light, dark and both contrast-more
  variants; spacing on the 4 px grid in every density; control heights Focus ≥ Standard ≥ Pro ≥ 24 px; motion 120–200 ms, 0 reduced.
- `a11y.ts` (subpath `@staticflux/testkit/a11y`) — `auditA11y(root, { rules })` / `expectNoA11yIssues(root)`: composed-tree
  (shadow roots + slots) checks `name`, `aria-ref` (ids never cross a shadow boundary), `required-attr`, `required-parent`,
  `valid-role`, `positive-tabindex`, `hidden-focusable`, `nested-interactive`; helpers `accessibleName`, `roleOf`, `flatText`,
  `composedParent`, `allElements`, `deepFocused`, `press(target, key, { shift, ctrl, alt, meta, type })`.
- `app.ts` — `bootTestApp({ units, overrides, subsystems, routes, router, initialUrl, session, time, telemetryLevel })` →
  `{ app, injector, router?, history?, session?, time?, get, shutdown, …TestTelemetry }` (boot failure throws SF-TEST-001);
  `fakeFrameSchedulerUnit(time)`.
- `fakes.ts` — re-exports (do NOT duplicate): data `createMockTransport`/`mockStatus`/`mockTransportUnit`/`createMockRemoteSync`/
  `createMemoryBackend`; platform `createFakePlatformEnv`/`SAMPLE_USER_AGENTS`; storage `createMemoryStore`/`createFakeIndexedDb`/
  `createFakeCookieDocument`/`createFakeOpfsRoot`/`createBroadcastHub`/`createMockRemoteTransport`/`runStoreContract`/`storeContractCases`;
  worker `createPortPair`/`inMemorySpawner`; router `createRouterMemoryHistory`; urlstate `createUrlMemoryHistory`/`createManualScheduler`;
  auth `createTestAuthEnvironment`/`createMemoryChannelHub`/`memoryStorage`.
- `errors.ts` — `SF-TEST-001` boot failed · `002` resolve failed · `003` unexpected violations · `004` runaway timers · `005` span assertion ·
  `006` invalid/mismatched image · `007` PNG decode · `008` golden missing · `009` golden mismatch · `010` golden rejected (name/size) ·
  `011` GPU runner unavailable · `012` GPU page failed · `013` GPU page timeout · `014` GPU readback · `015` media handles leaked · `016` `sf-gpu-run` usage.

Render, GPU and media (`@staticflux/testkit`):
- `image.ts` — `RgbaImage { width, height, data }` (8-bit straight RGBA, no row padding); `validateImage`, `validatePair`, `createImage`,
  `mapPixels`, `shiftImage`, `boxBlur(image, radius)`, `channelPlane(image, 'luma' | 0 | 1 | 2, background)`, `LUMA_WEIGHTS` (Rec. 601),
  `syntheticImage('gradient' | 'checker' | 'rings' | 'noise', w, h, { seed, cell })` (documented integer formulas), `mulberry32(seed)`.
- `ssim.ts` — `ssim(a, b, { channels: 'luma' | 'rgb', background, window: { size, sigma }, k1, k2, dynamicRange })` →
  `Result<{ mssim, worst: { value, x, y }, perChannel, map, mapWidth, mapHeight }>`; `gaussianKernel(size, sigma)`; `SSIM_DEFAULTS`.
- `compare.ts` — `diffImages(a, b, { tolerance })` → `{ maxChannelDelta, maxDeltaAt, differingPixels, differingFraction, meanAbsDelta }`;
  `compareImages(actual, expected, thresholds, ssimOptions)` → `{ pass, failures[], ssim, worstWindow, blurredSsim, diff }`;
  `RENDER_THRESHOLDS.{ sameBackend, gpuVsCpu, crossRasterizer }` (from the S1/S7 measurements); `diffHeatmap(actual, expected, { amplify })`.
- `gpu-fake.ts` — `createFakeGpu({ adapter: { info, features, limits } | false, preferredCanvasFormat, queue: 'auto' | 'manual', compile })` →
  `{ gpu (navigator.gpu), calls, callsTo(method, kind?), clearCalls, adapters, devices, uncapturedErrors, setAdapter, failNextRequestDevice,
  loseDevice(device?, reason, message), injectError(device, error), createCanvas({ width, height }) → { canvas, context, present, presentedFrames,
  lastPresented }, flushQueue, globals }`; `GPU_DEFAULT_LIMITS`, `FAKE_ADAPTER_INFO`, `FakeGpuValidationError` / `OutOfMemory` / `Internal`.
- `gpu-readback.ts` — `readbackTexture(device, texture, { signal })` → `Result<RgbaImage>` (256-byte row alignment, BGRA swizzle, validation
  error scope); `alignedBytesPerRow`; `GPU_CONSTANTS` (usage/map-mode flags); page protocol `GPU_RESULT_GLOBAL` (`__sfGpuResult`),
  `GpuPagePayload`, `publishGpuResult`, `encodePageImage` / `decodePageImage`.
- `media-fake.ts` — `createMediaFakes()` → `{ VideoFrame, AudioData (constructors), open(), stats(), expectAllClosed() (SF-TEST-015),
  label(handle, text), isClosed(handle) }`; `videoPlanes(format, w, h)`.

Node only (`@staticflux/testkit/node`):
- `png.ts` — `encodePng(image)` (deterministic RGBA8, adaptive filters, no metadata), `decodePng(bytes)` → `Result<RgbaImage>`, `crc32`.
- `golden.ts` — `createGoldenStore({ dir, update, thresholds, ssim, maxPixels, maxBytes, failureDir })` → `{ check, assert, read, path }`;
  `goldenUpdateRequested(env)`, `UPDATE_GOLDENS_ENV` (`SF_UPDATE_GOLDENS`), `GOLDEN_LIMITS` (65,536 px, 32 KiB).
- `gpu-runner.ts` — `runGpuPage({ target: { root, page, query } | { url }, mode: 'swiftshader' | 'real-gpu', headed, timeoutMs, signal,
  launcher, extraArgs })` → `Result<GpuRunReport { mode, url, args, adapter, data, images, console, pageErrors }>`; `SWIFTSHADER_FLAGS`,
  `REAL_GPU_FLAGS`, `chromiumArgs`, `gpuModeFromEnv` (`SF_GPU`), `serveIsolated(root)` (COOP/COEP), `loadPlaywrightChromium`, `toReport`;
  ports `BrowserLauncher` / `BrowserLike` / `PageLike` (the slice of Playwright used).
- `gpu-cli.ts` — `sf-gpu-run` / `pnpm gpu:run`: `parseGpuCliArgs`, `gpuCliMain(argv, io)`.

### Pipeline contract suites (SF-Δ17–Δ19, Instaflow M1 A5)
One file per port; each suite runs the same cases on every pipe medium (`local` colocated, `shared` SharedArrayBuffer,
`message` postMessage) or link transport (in-process pair, MessageChannel). `pipeline-contracts.test.ts` runs them all.
Cross-thread concurrency (torn reads, real respawn) is tested in `packages/worker` with `worker_threads`.
- `pipe-contract-support.ts` — `PipeContractMedium`, `PIPE_CONTRACT_MEDIA`, `availablePipeMedia()`, `mediumOptions`,
  `LinkContractTransport`, `inProcessLinks`, `messageChannelLinks`, `availableLinkTransports()`, `settle`, `eventually`.
- `seqlock-cell-contract.ts` — `runSeqlockCellContract(medium, runner)`, `seqlockCellContractCases`.
- `clock-cell-contract.ts` — `runClockCellContract(medium, runner)`, `clockCellContractCases`.
- `record-ring-contract.ts` — `runRecordRingContract(medium, runner)`, `recordRingContractCases` (lossless SPMC, back-pressure, release).
- `delta-stream-contract.ts` — `runDeltaStreamContract(medium, runner)`, `deltaStreamContractCases` (oracle: ordered apply,
  `upTo`, gap → resnapshot, overflow healing, blob refs, respawned reader).
- `blob-side-channel-contract.ts` — `runBlobSideChannelContract(transport, runner)`, `blobSideChannelContractCases`.
- `handle-channel-contract.ts` — `runHandleChannelContract(transport, runner, { makeHandle })`, `handleChannelContractCases`,
  `createFakeHandle(kind)` (duck-typed ownership fakes; pass real handles via `makeHandle` in a browser).
- `peer-channel-contract.ts` — `runPeerChannelContract(factory, runner)`, `peerChannelContractCases`, `colocatedPeerSetup`,
  `brokeredPeerSetup(transport)` (re-wire on respawn: generations, surviving listeners, `onConnect` cleanups).
- `windowed-replica-contract.ts` — `runWindowedReplicaContract(transport, driver, runner)`, `windowedReplicaContractCases`,
  `memoryWindowedDriver` (a store's own `WindowedSource` plugs in through `WindowedSourceDriver`).

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
Accessibility (R15.4): end every component test with `expectNoA11yIssues(element)` from `@staticflux/testkit/a11y` and drive
keyboard patterns with `press(…)` (layout-dependent checks — rendered contrast, target size — belong to the theme contract and e2e).

## Contract suites (R16.4)
Every implementation of a contract runs the shared suite; a new adapter is not done until it passes.
```ts
import { describe, it } from 'vitest';
runTransportContract('fetch', (fixture) => createFetchTransport({ baseUrl: '/api', fetch: fakeFetch(fixture) }), { describe, it });
runHistoryContract('router memory', (url) => createRouterMemoryHistory({ initial: url }), { describe, it }, { level: 'adapter' });
runStoreContract('memory', () => createMemoryStore(), { describe, it });
runBlobStoreContract('memory', () => ({ store: createMemoryBlobStore() }), { describe, it });

runThemeContract('default theme', () => defaultTheme, { describe, it });
```
The transport fixture is addressed by path (`/echo`, `/query`, `/status/<n>`, `/hang`, `/stream`, `/stream-hang`, `/stream-fail`);
the factory adapts it to its wire (see `contracts.test.ts` for a fake `fetch` speaking JSON + NDJSON). Suites use real timers
for their settle timeouts — do not run them under `vi.useFakeTimers()`.

## How to test rendering and GPU code
Three levels, cheapest first:

1. **Unit, fake GPU (Node, every run).** Recovery, readback, budgets and call order against `createFakeGpu()`.
   ```ts
   const fake = createFakeGpu({ adapter: { info: { architecture: 'swiftshader', isFallbackAdapter: true } } });
   const renderer = await createRenderer({ gpu: fake.gpu as unknown as GPU });   // your port's type
   fake.loseDevice();                                                            // device.lost resolves ('unknown')
   await renderer.whenReady();                                                   // must request a NEW adapter: the old one is consumed
   expect(fake.devices).toHaveLength(2);
   expect(fake.callsTo('createRenderPipeline', 'device')).toHaveLength(2);       // pipelines rebuilt from retained state
   expect(fake.uncapturedErrors).toEqual([]);                                    // no validation errors on the way
   ```
   Copies, clears (`loadOp: 'clear'`), `writeBuffer/writeTexture` and maps execute, so `readbackTexture` works end to end. Draws are
   recorded, not rasterized: assert pixels in the browser (level 3), not here. `queue: 'manual'` + `flushQueue()` orders map/loss races.
2. **Images (Node, every run).** `compareImages(actual, expected, RENDER_THRESHOLDS.gpuVsCpu)` for two renders you hold (e.g. tiled vs
   full, GPU vs `vello_cpu`). Goldens for "this must not change": `createGoldenStore({ dir: new URL('./__goldens__', import.meta.url) })
   .assert('name', image)`. Goldens are small (≤ 256×256, ≤ 32 KiB) and few — crop to the feature under test.
3. **Real browser (`pnpm test:gpu`, CI job and owner GPU).** A page that renders and publishes `{ ok, data, images }` on
   `globalThis.__sfGpuResult` (bundle `readbackTexture` + `publishGpuResult` into it), driven by `runGpuPage` in a `*.gpu.test.ts`
   file guarded by `describe.skipIf(gpuModeFromEnv() === undefined)`. See `src/gpu-smoke.gpu.test.ts` + `fixtures/gpu-smoke/`.
   ```sh
   NODE_PATH=/opt/node-tools/node_modules pnpm test:gpu        # SwiftShader + ANGLE (correct pixels, CPU timings)
   SF_GPU=real pnpm test:gpu                                    # real GPU, on a machine that has one
   pnpm build && pnpm gpu:run <dir> [page.html] [--query=…] [--real-gpu] [--headed] [--out=<dir>]   # ad-hoc: JSON + PNGs
   SF_GPU=1 pnpm goldens:update gpu-smoke                       # rewrite GPU goldens after an intended change
   ```
   SwiftShader needs **both** `--use-angle=swiftshader --enable-unsafe-swiftshader` besides the WebGPU/Vulkan flags: without them the
   first canvas present destroys the device (S1 spike; the smoke test fails with SF-TEST-012 if a flag is dropped).

**SSIM** (`ssim.ts` header has the formula): Wang et al. 2004 — 11×11 Gaussian window, σ = 1.5, K1 = 0.01, K2 = 0.03, L = 255, valid
windows only, population variances, mean over windows; default on Rec. 601 luma after compositing over white. Pinned in `ssim.test.ts`
against an independent NumPy implementation (agreement < 1e-14). SSIM ignores alpha and shrugs off one-channel color shifts; that is why
every comparison also bounds the max channel delta.

**Goldens update only through `pnpm goldens:update <filter>`** (`SF_UPDATE_GOLDENS=1`). Outside it a missing golden fails (SF-TEST-008), so
CI never creates one. Update mode leaves matching goldens untouched. Mismatch artifacts land in `__goldens__/__failures__/` (gitignored).

**Media:** `const media = createMediaFakes()`; give `media.VideoFrame` / `media.AudioData` to the code under test (or `vi.stubGlobal`), then
`media.expectAllClosed()` in `afterEach`. Clones are separate handles. M3 adds decoder/encoder fakes, `AudioContext` and a media clock here.

## Rules
- Re-export other packages' fakes; never re-implement them here. A missing fake belongs in its package.
- `src/index.ts` stays environment-free (no `node:*` imports); Node-only helpers go through `src/node.ts`.
- GPU tests that need a browser live in `*.gpu.test.ts` and skip unless `SF_GPU` is set; `pnpm test` / `pnpm check` never launch Chromium.
- Thresholds come from `RENDER_THRESHOLDS` or a measured number with a comment; never loosen one to make a golden pass.
- Nothing patches globals. Code that calls global `setTimeout` directly (core `sleep`, mock-transport latency) needs
  `vi.useFakeTimers()`; everything with an injectable port should get a testkit fake instead.
- Assert span *structure* and attributes, never durations. Seeded randomness keeps span ids stable.
- Helpers throw `SfError`s with `SF-TEST-*` codes (tests fail loudly); everything else stays `Result`-based.

## Test
`npx vitest run packages/testkit` · `npx tsc -p packages/testkit --noEmit` · `NODE_PATH=/opt/node-tools/node_modules pnpm test:gpu` (real Chromium)

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

No size budget declared in `.size-limit.json` for this package.

## Allowed dependencies

**Layer:** tooling

- Internal: `@staticflux/auth`, `@staticflux/blob`, `@staticflux/core`, `@staticflux/data`, `@staticflux/document`, `@staticflux/platform`, `@staticflux/router`, `@staticflux/runtime`, `@staticflux/stage`, `@staticflux/storage`, `@staticflux/ui`, `@staticflux/urlstate`, `@staticflux/worker`
- External: `fast-check` (4.10.2)

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
