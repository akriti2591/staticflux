# Instaflow render module (TypeScript side) — AGENTS.md

**Area:** app (`apps/instaflow/src/render`, export `@instaflow/app/render`). M1 work package A6.
**Budget:** ≤ 3.8 KB brotli for this folder's JS (measured 3.74 KB with scene IR v2, B1: raised from 3.5 KB for fill/stroke stacks, effects and masks; `.size-limit.json`), plus the render Wasm
(≤ 300 KB brotli, measured 185.7 KB; see `../../engine/AGENTS.md`). Render and export workers only.
**Allowed deps:** `@staticflux/core`, `@staticflux/platform`, `@staticflux/surface/raster` (framework, lower
layers). Tests may use `@staticflux/testkit` and `@staticflux/runtime/memory`.

## Purpose
IF-7.4 / 7.5 / 7.11: the Vello GPU implementation of the framework's `RasterBackend` port. The framework
(`@staticflux/surface/raster`) owns the policy — tiles per √2 zoom level, idle-lane tile prep, the previous level while
sharpening, lifted layers, warm-up and the cached first frame, the GPU device lifecycle, headless tiling and the GPU
memory budget. This folder only adapts the Wasm engine (`engine/crates/render`) to that port and encodes scenes.

## Public API
- `vello-backend.ts` — `createVelloRasterBackend({ wasm, canvas?, width, height, id })` → `RasterBackend<Uint8Array>`
  (scene batches are scene IR bytes). `attach` makes a fresh wgpu device and installs it into the long-lived engine
  (scene and images retained → re-attach after a loss rebuilds without the document); facts come from the raw
  `GPUDevice`. Readbacks are serialized and cancellable. Engine throws → SF-SURF-014, device creation → SF-SURF-010,
  readback → SF-SURF-015. `takeRenderErrors(wasm)`.
- `render-module.ts` — `RenderWasm` / `RenderEngineWasm` / `RenderGpuWasm` (the Wasm exports, ABI 2),
  `RENDER_ABI_VERSION`, `loadRenderModule({ manifestUrl, signal })` (reads `sf-wasm-manifest/1`, imports the hashed
  glue, instantiates, checks the ABI).
- `scene-ir.ts` — `createSceneWriter()` → `clear`, `upsert(node, index)`, `remove`, `image`, `dropImage`, `finish()`;
  `SceneNode` (transform, opacity, blend, visibility, clip, geometry: group/rect/rrect/ellipse/path/image/glyphs,
  `fill`/`stroke` or the `fills`/`strokes` stacks, `evenOdd`, `mask`, `effects`), `BLEND_MODES`, `PATH_VERBS`,
  `IMAGE_FITS`, `MASK_MODES`, `SCENE_IR_VERSION` (2 since B1). Byte-identical with the Rust `IrWriter` (`shapes`,
  `elements`, `appearance` fixtures).

## Wiring (A7 does it in the render worker)
```ts
const wasm = await loadRenderModule({ manifestUrl });                       // engine/dist/sf-wasm-manifest.json
const backend = createVelloRasterBackend({ wasm, canvas: offscreen, width, height });
const device = createGpuDevice({ id: 'canvas', provider: { acquire: (o) => backend.attach(o) } });
const memory = createMemoryBudgets({ pressure });                           // @staticflux/runtime/memory
const renderer = createTiledRenderer({ backend, memory, lane: workerSchedulerLane(scheduler), requestFrame });
device.onRecovered(() => renderer.deviceRestored());
await device.attach();
renderer.showSnapshot(lastSessionSnapshot);                                 // cached first frame
await renderer.warmUp(signal);                                              // in parallel with document load
renderer.apply(createSceneWriter()....finish());                            // from the delta stream (A7)
```

## Rules
- Policy never lives here: no tile choice, budgets or retries in this folder (they belong to the framework port).
- The scene IR is a wire format: change `ir.rs` and `scene-ir.ts` together, bump `SCENE_IR_VERSION`/`ir::VERSION`,
  regenerate the fixtures and keep `scene-ir.test.ts` byte-identical.
- Never hard-code a hashed Wasm name; read the manifest.
- Client-side checks are UX only (repo rule 9); nothing here gates anything.

## Test
- `pnpm vitest run apps/instaflow/src/render` — encoder vs the Rust fixture bytes; the backend against a fake Wasm
  module whose devices come from testkit's GPU fake (facts, loss, re-attach through `createGpuDevice`, composite
  packing, readback order, abort, error mapping); the loader.
- `pnpm build && NODE_PATH=/opt/node-tools/node_modules pnpm test:gpu` — `render.gpu.test.ts` drives `gpu-page/`
  in Chromium (SwiftShader + ANGLE; `SF_GPU=real` on a GPU): the `RasterBackend` contract on Vello, GPU vs
  `vello_cpu` on four fixtures (gpuVsCpu thresholds), tiles vs direct render at zoom 1 and 2 and a lifted layer
  (sameBackend: no seams), the tiled renderer on a canvas (sharp frame, 20 px drag through the lifted layer without
  re-rasterizing tiles, device destroyed → recovered → same pixels), two small goldens. Timings are printed, not
  asserted. Update goldens: `SF_GPU=1 pnpm goldens:update render.gpu`.
- SwiftShader run (2026-10-25, cloud, 4 shared cores): whole page ≈ 14 s; warm-up 871 ms (the cold-pipeline cost S1
  saw, now paid during boot), first sharp frame after warm-up 28 ms, 10 drag frames 6 ms, device-loss recovery 16 ms.
