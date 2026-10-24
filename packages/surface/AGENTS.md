# @staticflux/surface — AGENTS.md

**Layer:** ui (depends on `@staticflux/core`, `@staticflux/worker`; no rendering engine dependency).
**Budget:** loaded with the feature that shows a rich surface (~9.6 KB brotli for the whole package); the render
worker needs only `render-worker.ts` (+ engine, frame-loop, metrics, input).

## Purpose
Rich surfaces as projections of the document (R11.20–R11.25): one `Surface` contract over DOM, Canvas2D, WebGL,
WebGPU and HTML-in-Canvas; render-worker hosting via transferred `OffscreenCanvas`; engine-agnostic `RenderEngine`;
timestamped compact input forwarding → intents; HTML-in-Canvas adapter with DOM-overlay fallback; accessible DOM
layer for pure-canvas content; per-surface frame metrics with budgets; CORS-clean image loading (R11.16b).

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
- `input.ts` — `createInputForwarder({ target, env, sink })` (pointer/wheel/key → `CompactInputEvent`, absolute
  `ts = timeOrigin + timeStamp`, move coalescing, microtask batches), `InputCode`, `InputModifier`, `PointerKind`,
  `mapInputToIntents`, `oldestTimestamp`.
- `html-in-canvas.ts` — `detectHtmlInCanvas()` (`layoutsubtree` | `content="drawable"`, `drawElementImage` |
  `drawElement`, `texElementImage2D`, `drawElementImageToTexture` | `copyElementImageToTexture`),
  `createHtmlInCanvas({ canvas, document })` → adapter (`add`, `draw`, `drawToTexture`, `place`, `onPaint`,
  `requestPaint`); overlay fallback; main thread only.
- `a11y-layer.ts` — `createAccessibleLayer({ host, document, onAction })` → `update(nodes)` (keyed by id), `focus(id)`.
- `metrics.ts` — `SurfaceMetrics` (`surface/frame-time`, `surface/frame-time-max`, `surface/dropped-frames`,
  `surface/input-latency`), `createSurfaceMetrics({ budget, targetFrameMs, window })`.
- `images.ts` — `SurfaceImagePolicy` port, `anonymousImagePolicy`, `imageCredentials`, `createSurfaceImageLoader`
  (cors mode, single-flight, opaque → SF-SURF-005), `defaultImageLoaderPorts`.
- `env.ts` — `SurfaceEnvironment` (now, timeOrigin, DPR, scheduler, document, ResizeObserver), `rafScheduler`,
  `timerScheduler`, `defaultSurfaceEnvironment`, `absoluteNow`.
- `units.ts` — `SurfaceEnvironmentToken`, `SurfaceImagePolicyToken`, `SurfaceImageLoaderToken`,
  `HtmlInCanvasSupportToken` (+ units), `surfaceUnit({ id, provides, create })` (disposed with its scope).
- `errors.ts` — `SF-SURF-001` … `SF-SURF-009`.

## Lifecycles
- `surface/lifecycle`: `created → attaching → attached ⇄ running`; `attaching → failed`; `attaching|attached|running
  → detached`; `detached|failed → attaching`; `* → disposed`.
- `surface/frame-loop`: `idle → running ⇄ paused → stopped` (a resume is not counted as dropped frames).

## Rules
- Engines never touch the DOM or globals: everything comes through `RenderContext` (the same engine must run on the
  main thread and in the render worker).
- HTML-in-Canvas and the accessible layer are main-thread only (SF-SURF-004). Pure-canvas content must get an
  accessible layer unless the HTML-in-Canvas adapter provides the DOM.
- Input is forwarded, never interpreted on the main thread for worker surfaces; intents are derived where the state
  lives (worker mapper → owner via `replica.intent`).
- Images for canvases always go through the image loader (CORS, policy credentials); never draw no-cors images.
- Metrics are reported per window (default 120 frames), not per frame; budget overruns emit `surface.budget-exceeded`.
- All browser APIs are injected (`SurfaceEnvironment`, ports) so tests run under happy-dom.

## Test
`pnpm vitest run packages/surface` (manual frame scheduler, fake ResizeObserver, fake OffscreenCanvas over an
in-memory port pair with `clone: false`).
