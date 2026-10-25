# @staticflux/surface — AGENTS.md

**Layer:** ui (depends on `@staticflux/core`, `@staticflux/worker`; the `raster` entry also on `@staticflux/platform`
for GPU adapter facts and on `@staticflux/runtime` for types only; no rendering engine dependency).
**Budget:** loaded with the feature that shows a rich surface (~9.6 KB brotli for the whole package); the render
worker needs only `render-worker.ts` (+ engine, frame-loop, metrics, input). `@staticflux/surface/raster` ≤ 9.5 KB
brotli (measured 9.1 KB), render and export workers only.

## Purpose
Rich surfaces as projections of the document (R11.20–R11.25): one `Surface` contract over DOM, Canvas2D, WebGL,
WebGPU and HTML-in-Canvas; render-worker hosting via transferred `OffscreenCanvas`; engine-agnostic `RenderEngine`;
timestamped compact input forwarding → intents; HTML-in-Canvas adapter with DOM-overlay fallback; accessible DOM
layer for pure-canvas content; per-surface frame metrics with budgets; CORS-clean image loading (R11.16b).

**Tiled GPU rendering (`@staticflux/surface/raster`, Instaflow M1 A6, R11.43–R11.46):** the `RasterBackend` port,
the GPU device lifecycle (SF-Δ23), the tiled renderer with the S1 lessons built in, the headless surface (SF-Δ24
headless part) and the GPU tile cache on the memory ledger (SF-Δ29).

**Why here (not in a new package, not in the app):** the port, the device lifecycle and the headless surface are
generic surface concerns (any WebGPU engine: Vello, a Three.js scene, a video compositor) and sit next to
`RenderEngine`, the render-worker host and frame metrics; the tile/LRU/budget policy has no Instaflow meaning. The
Vello implementation, its Rust crate and the scene IR are Instaflow's (`apps/instaflow/src/render`,
`apps/instaflow/engine/crates/render`): framework packages never import the app, and the backend is chosen by the app.
A separate entry keeps it out of every main-thread bundle.

## Public API (by file)
- `surface.ts` — `Surface` (`attach(host, { size, autoStart, signal })`, `resize(css?, dpr?)`, `start`, `pause`,
  `detach`, `dispose`, `metrics()`, `state`, `machine`), `SurfaceLifecycle`, `createSurfaceShell(hooks)`,
  `createCanvasSurface({ id, kind, engine, state, input: { mapper, onIntents }, budget })` (main thread),
  `createDomSurface({ id, mount, update?, unmount? })`, `sizeCanvas`.
- `render-worker.ts` — `createWorkerSurface({ id, kind, engine: engineId, link })` (main side),
  `hostRenderSurfaces({ link, engines, state, mapper, onIntents })` (worker side), `createRenderSurface` (worker if
  OffscreenCanvas + link, else main thread — same engine), `SurfaceChannels` (`sf/surface/*`).
- `engine.ts` — `RenderEngine<State, Kind>` (`init(ctx)`, `frame(state, dt, info)`, `resize`, `input?`, `dispose`),
  `RenderContext`, `SURFACE_KINDS`, `acquireContext` (WebGL2 → WebGL), `supportsOffscreenCanvas`, `supportsWebGpu`,
  `backingSize`.
- `frame-loop.ts` — `createFrameLoop({ scheduler, now, onFrame, metrics })`, `FrameLoopLifecycle`.
- `input.ts` — `createInputForwarder({ target, env, sink | sinks, coalescedEvents })` (pointer/wheel/key →
  `CompactInputEvent`, absolute `ts = timeOrigin + timeStamp`, microtask batches with a monotonic `inputSeq`).
  **Fidelity (SF-Δ22):** every `getCoalescedEvents()` sample (flag `coalesced`), pen `pr/tp/tx/ty/tw/w/h`, `isPrimary`,
  flagged predicted samples (`getPredictedEvents()`, only for sinks with `predicted: true`); several `InputSink`s with
  `coalesce` chosen per sink (`sink` keeps the old coalesced default). `coalesceInput`, `InputCode`, `InputModifier`,
  `PointerKind`, `InputFlag`, `mapInputToIntents`, `oldestTimestamp`.
- `input-ring.ts` (entry `@staticflux/surface/input-ring`, for workers) — the binary input ring: `InputRecordLayout`
  (80 B, `defineLayout`, Rust/C mirrors), `defineInputRing({ id, capacity, readers })` (a worker record ring),
  `inputRingSink(ring)` (lossless forwarder sink), `drainInputRing(reader, { coalesce, predicted, max })` (coalescing
  per consumer), `encodeInputRecord`/`decodeInputRecord`, `INPUT_KEY_CODES`/`INPUT_KEY_NAMES` (append-only wire tables).
- `html-in-canvas.ts` — `detectHtmlInCanvas()` (`layoutsubtree` | `content="drawable"`, `drawElementImage` |
  `drawElement`, `texElementImage2D`, `drawElementImageToTexture` | `copyElementImageToTexture`),
  `createHtmlInCanvas({ canvas, document })` → adapter (`add`, `draw`, `drawToTexture`, `place`, `onPaint`,
  `requestPaint`); overlay fallback; main thread only.
- `a11y-layer.ts` — `createAccessibleLayer({ host, document, onAction, label, activateKeys, focusRing, focusRingOffset })` →
  `update(nodes)` (keyed by id; `roleDescription`, `level`, roving `tabIndex` 0 | -1, R11.60–R11.62), `focus(id)`.
- `metrics.ts` — `SurfaceMetrics` (`surface/frame-time`, `surface/frame-time-max`, `surface/dropped-frames`,
  `surface/input-latency`), `createSurfaceMetrics({ budget, targetFrameMs, window })`.
- `images.ts` — `SurfaceImagePolicy` port, `anonymousImagePolicy`, `imageCredentials`, `createSurfaceImageLoader`
  (cors mode, single-flight, opaque → SF-SURF-005), `defaultImageLoaderPorts`.
- `env.ts` — `SurfaceEnvironment` (now, timeOrigin, DPR, scheduler, document, ResizeObserver), `rafScheduler`,
  `timerScheduler`, `defaultSurfaceEnvironment`, `absoluteNow`.
- `units.ts` — `SurfaceEnvironmentToken`, `SurfaceImagePolicyToken`, `SurfaceImageLoaderToken`,
  `HtmlInCanvasSupportToken` (+ units), `surfaceUnit({ id, provides, create })` (disposed with its scope).
- `errors.ts` — `SF-SURF-001` … `SF-SURF-009`, `SF-SURF-017` (TextInput implementation unavailable).

`@staticflux/surface/text-input` (entry `text-input.ts`; main thread, loaded with text editing; Instaflow M1b B2, SF-Δ27,
R11.56–R11.59):
- `text-input.ts` — the **`TextInput` port** (`focus`, `blur`, `composing`, `setState`, `setControlBounds`,
  `setSelectionBounds`, `setCharacterBounds`, `onIntent`, `onBoundsRequest`, `dispose`), `TextIntent` (insert, delete with
  direction + unit, compose-start/update/commit/cancel, selection, key, format), `TextInputState`, `ClientRect`;
  implementations `createEditContextTextInput({ host, EditContext? })` and `createHiddenTextareaTextInput({ host })`;
  `TextInputFactoryToken`, `textInputBindings({ editContext })` (variant binding on the platform fact),
  `editContextTextInputUnit`, `hiddenTextareaTextInputUnit`, factories; helpers `applyTextIntent` (plain-text reference
  model), `codePointBoundary`, `keyIntent`; `TEXT_KEYS`, `DELETE_UNITS`, `UNDERLINE_STYLES`. Errors: `SF-SURF-017`.

`@staticflux/surface/raster` (entry `raster.ts`; render and export workers):
- `raster-backend.ts` — the `RasterBackend<Delta>` port (`attach`, `warmUp`, `apply` → dirty `WorldRect`s, `bounds`,
  `resize`, `renderTile(slot, key, background)`, `releaseTile`, `setLayer`/`renderLayer`/`releaseLayer`,
  `uploadSnapshot`, `composite(frame)`, `readFrame`, `renderRegion`, `stats`, `dispose`), `WorldRect`, `TileKey`,
  `RasterCamera`, `RasterImage`, `CompositeQuad`/`CompositeSource` (`tile | layer | snapshot | external` — external
  reserved for M3 video), `LayerRaster`, `RasterRegion`; helpers `unionRect`, `intersects`, `cameraWorldRect`.
- `raster-tiling.ts` — `DEFAULT_TILE_SIZE` (512), `levelForZoom` (one level per √2), `levelScale`, `tileWorldRect`,
  `tileId`, `visibleTiles(camera, level, { ring, bounds })` (Manhattan order from the centre), `worldToDevice`,
  `containsRect`, `planChunks`.
- `raster-tile-cache.ts` — `createTileCache({ release, tileSize, maxTiles, memory, id, priority })` → slots, LRU,
  stale-while-revalidate (`invalidate` marks stale; padded by `AA_PAD_PX`), `pin` (frame tiles never evicted),
  `forget` (device lost), bytes registered with the memory ledger (kind `gpu`).
- `raster-lane.ts` — `TilePrepLane` port, `workerSchedulerLane(scheduler)` (idle priority, sliced),
  `manualTilePrepLane()` (tests).
- `tiled-renderer.ts` — `createTiledRenderer({ backend, lane, requestFrame, memory, maxTiles, inFrameBudgetMs = 2,
  ring = 1, background, camera, now, telemetry })` → `setCamera`, `resize`, `apply`, `warmUp`, `showSnapshot`,
  `captureSnapshot`, `lift`/`drag`/`drop`, `frame()` → `FrameReport`, `deviceRestored()`, `dispose`; phases
  `cold → warming → ready`; `RenderMetrics` (`render/first-frame`, `render/first-sharp-frame`, `render/time-to-sharp`,
  `render/tiles-rendered`, `render/in-frame-raster`, `render/warm-up`).
- `headless.ts` — `createHeadlessSurface({ backend, chunkSize, maxPixels, telemetry })` → `render({ world, width,
  height, background, signal, onProgress })`: chunks ≤ `maxRegionSize`, exact stitching, cancellable; `HeadlessMetrics`.
- `gpu-device.ts` — `GpuDeviceLifecycle` (`surface/gpu-device`), `createGpuDevice({ id, provider, restore, recovery:
  { budgetMs = 1000, maxAttempts = 3, backoffMs }, now, sleep, telemetry })` → `attach`, `whenRunning`, `onLost`,
  `onRecovered`, `recoveries`, `handle`, `facts`, `dispose`; `GpuDeviceProvider` port, `webGpuDeviceProvider({ gpu,
  powerPreference, requiredFeatures, optionalFeatures, requiredLimits: 'adapter' | {…} })`, `GpuDeviceFacts`,
  `readGpuLimits`, `GpuDeviceMetrics` (`surface/gpu-recovery`, `surface/gpu-device-lost`).
- `memory-raster-backend.ts` — `createMemoryRasterBackend({ tileSize, maxRegionSize, width, height })`: the CPU
  reference backend (axis-aligned boxes, exact pixels) with test hooks `lose()`, `failNextAttach()`, `failNextTile()`,
  `log`; `MemoryRasterDelta`.
- `raster-errors.ts` — `SF-SURF-010` GPU unavailable · `011` device lost for good · `012` recovery over budget ·
  `013` headless request invalid · `014` backend call failed · `015` readback failed.

`@staticflux/surface/image` (entry `image.ts`; any worker or Node, no canvas; Instaflow M1b B4, R11.54–R11.55):
- `image.ts` — `scaleImage(image, width, height)` (area average in premultiplied space), `fitWithin(w, h, max)`,
  `encodePng(image, { signal })` (8-bit RGBA, no filters: the same pixels always give the same bytes), `crc32`, `PNG_MIME`.
- `image-errors.ts` — `SF-SURF-016` bad size or pixel buffer, or the compression stream failed (also exported from `raster`).

## Lifecycles
- `surface/lifecycle`: `created → attaching → attached ⇄ running`; `attaching → failed`; `attaching|attached|running
  → detached`; `detached|failed → attaching`; `* → disposed`.
- `surface/frame-loop`: `idle → running ⇄ paused → stopped` (a resume is not counted as dropped frames).
- `surface/gpu-device`, renderer phase, tile entries and lifted layers: docs/LIFECYCLES.md §28 (invariants G-1…G-7).

## Rules
- Engines never touch the DOM or globals: everything comes through `RenderContext` (the same engine must run on the
  main thread and in the render worker).
- HTML-in-Canvas and the accessible layer are main-thread only (SF-SURF-004). Pure-canvas content must get an
  accessible layer unless the HTML-in-Canvas adapter provides the DOM.
- Input is forwarded, never interpreted on the main thread for worker surfaces; intents are derived where the state
  lives (worker mapper → owner via `replica.intent`).
- The input ring is lossless: never coalesce before the ring; each reader decides (`drainInputRing({ coalesce })`).
  Predicted samples may be drawn but never committed. Key tables are wire format: append only.
- Images for canvases always go through the image loader (CORS, policy credentials); never draw no-cors images.
- Metrics are reported per window (default 120 frames), not per frame; budget overruns emit `surface.budget-exceeded`.
- All browser APIs are injected (`SurfaceEnvironment`, ports) so tests run under happy-dom.
- Raster: the framework decides **which** tiles and **when**; backends only draw. Never rasterize in a frame beyond
  `inFrameBudgetMs` (S1: a 512 px tile is ≈ 6.7 ms CPU) and never before `warmUp` (cold pipelines ≈ 1 s): the idle lane
  and the snapshot exist for that. Never draw holes: stale tiles, other levels and the snapshot fill in.
- A lost device is never reused: recovery requests a new adapter and rebuilds from the backend's retained CPU-side
  scene, never from the document. Backends must survive `attach` after a loss with their scene intact.
- Every GPU cache reports its bytes to the memory ledger (`@staticflux/runtime/memory`); the frame pins what it draws.
- Every `RasterBackend` passes `runRasterBackendContract` (testkit): the CPU reference in Node, Vello in Chromium.
- Text input: offsets are UTF-16; the editor owns the text (apply intents, push `setState`); never read composition
  text from the hidden textarea; which implementation runs is `textInputBindings`' business, never a browser check.
  Both implementations pass `runTextInputContract` (testkit).

## Test
`pnpm vitest run packages/surface` (manual frame scheduler, fake ResizeObserver, fake OffscreenCanvas over an
in-memory port pair with `clone: false`; the GPU device lifecycle against testkit's `createFakeGpu`, the tiled
renderer and headless surface against `createMemoryRasterBackend` with exact pixel checks). Bench (not a test):
`pnpm vitest bench --run packages/surface/src/raster.bench.ts`.

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/surface (full) | 10.5 KB | packages/surface/dist/index.js |
| @staticflux/surface/input-ring | 1.75 KB | packages/surface/dist/input-ring.js |
| @staticflux/surface/raster (render and export workers: tiled renderer, GPU device lifecycle, headless) | 9.5 KB | packages/surface/dist/raster.js |
| @staticflux/surface/image (area scaling + deterministic PNG encoder; renditions and export workers) | 1.6 KB | packages/surface/dist/image.js |
| @staticflux/surface/text-input (TextInput port: EditContext + hidden textarea, variant binding; main thread, with text editing) | 3.75 KB | packages/surface/dist/text-input.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** ui

- Internal: `@staticflux/core`, `@staticflux/platform`, `@staticflux/runtime`, `@staticflux/worker`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
