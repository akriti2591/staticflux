# S1 (Render) + S7 (Export parity): result

**Verdict: proceed with Vello GPU. The perf criteria need an owner-machine run.** The Vello WebGPU path works end to end: a
`vello_gpu` 0.3.0 + `wgpu` 30.0.1 module runs in a dedicated worker on a transferred OffscreenCanvas, with 512 px tiles per
√2 zoom level, a lifted layer and our own WGSL compositor. It renders pixel-equivalent to `vello_cpu` (SSIM ≥ 0.9995 on
every frame and every corpus scene). The two exports (SVG and PDF via krilla) carry the same content. Real text in the PDF
works. Every timing below comes from **SwiftShader (CPU WebGPU) under contention from other spikes, so it is not a GPU
number.** The CPU-side numbers (Vello strip preparation in Wasm) *are* meaningful, and they drive two of the M1
recommendations. No fallback was needed. CanvasKit plan B is weaker than research/03 assumed (see Surprises).

## What was built (`rust/`, `web/`, `scripts/`)
- **`ir`**: one deterministic scene IR. It holds a 6000×6000 page with **10,000 elements**: rects, rounded rects,
  ellipses, stars, quad-bezier blobs; solid (some translucent), linear and radial gradients; 64² image patterns; strokes; 25%
  rotated. The crate also has a uniform-grid index, a `Painter` trait (every backend draws through the same `draw()`), an
  **SVG writer**, SSIM and diff helpers, and a 200-scene **synthetic corpus** (256², 40 elements, feature focus rotating).
- **`gpu`** (Wasm, wasm-bindgen): it runs `vello_gpu` on wgpu's WebGPU backend. Every frame renders into an `Rgba8Unorm`
  frame texture, which is read back for parity and then blitted to the canvas. The crate has two render paths:
  - **full**: Vello re-rasterizes every visible element on every frame.
  - **tiled**: 512² tile textures per √2 zoom level, rendered in Manhattan order with a per-frame tile budget (default 4)
    plus an interest ring of one tile. Missing tiles fall back to tiles from another zoom level. Tiles live in an LRU cache
    (256 tiles max). Lifting 100 selected elements invalidates only the tiles under them. The lifted layer is either
    rasterized once into a texture and composited at the drag offset (**cached**), or redrawn by Vello `SrcOver` on every
    frame (**reraster**). Dropping the selection invalidates the tiles under the old and new bounds.
- **`cpu`** (Wasm): `vello_cpu` reference renders, the SVG writer, PNG output and SSIM, all exposed to JS. **`pdf`** is
  krilla over the same IR. **`native`** compares resvg and poppler against `vello_cpu` and checks PDF text with
  `pdftotext`.
- **`web/index.html` + `gpu-worker.js`**: a scripted benchmark that then runs the parity checks. It does 30 frames per
  sequence on SwiftShader (120 on a real GPU). The 200-scene corpus is drawn three ways: GPU, CPU, and Chrome rendering our
  SVG.

## Criteria
| Criterion | Result | Number, and how it was measured |
|---|---|---|
| S1 pan/zoom p95 ≤ 8.3 ms | **INCONCLUSIVE (needs real GPU)** | SwiftShader, tiled pan (composite only) p95 **38–71 ms**. Full re-raster pan p95 0.9–4.3 s. *CPU side (meaningful):* tiled pan 0.4–0.6 ms median, p95 ≤ 1 ms (simd build). Full re-raster strip prep is **10.6 ms** at zoom 1 (297 elements) and **46–58 ms** at zoom 0.25 (4.4k elements), so **full re-raster cannot hit 8.3 ms when zoomed out, on any GPU**. Tiles are mandatory, not an optimization. During continuous zoom (4 tiles per frame) CPU is 25 ms median, about **6.7 ms CPU per 512² tile**. |
| S1 drag 100 elements p95 ≤ 8.3 ms | **INCONCLUSIVE (needs real GPU)** | SwiftShader frame p95: cached layer **58 ms**, reraster 324 ms, full 1.2 s. CPU: cached layer **0.4 ms median / 2.6 ms p95**, reraster of 100 elements 5.4 / 10.4 ms (simd). |
| S1 time to sharp ≤ 250 ms | **INCONCLUSIVE (needs real GPU)** | SwiftShader: 1.7–4.6 s per √2 zoom step (8–9 tiles); lift and drop re-sharpen (4 tiles) in 1.0–1.9 s. CPU part ≈ 9 tiles × 6.7 ms ≈ **60 ms**, which leaves about 190 ms for the GPU on a real machine. |
| S1 GPU memory ≤ 512 MiB | **INCONCLUSIVE (no browser API)** | Our allocations only: a peak of 57 tiles × 1 MiB after a 7-level zoom sweep, plus frame color and depth (7 MiB), the lifted layer, and **Vello's default image atlas, 4096² = 64 MiB**, allocated on first image upload. That is about **130 MiB**; the cache cap is 256 MiB. Wasm heap 26 MiB. |
| S1 quality matches resvg/Chrome on a 200-file SVG corpus | **PASS on a synthetic 200-scene corpus. A real-world SVG corpus is INCONCLUSIVE** (it needs a usvg→IR importer, not built) | Vello GPU vs `vello_cpu`: SSIM **min 0.99955**, median 0.99993, max channel diff 4. 10k-page frames at zoom 0.25/0.5/1/2: 0.99992–0.99995, max diff 3. **Tiled vs full is identical (max diff 1, SSIM 1.0)**; the lifted layer vs full has max diff 2. Spread between other rasterizers (same SVG, vs `vello_cpu`): resvg median 0.9964 (min 0.986), Chrome median 0.9944 (min 0.982). |
| S7 SSIM ≥ 0.99 vs `vello_cpu` | **GPU: PASS. SVG and PDF: FAIL on the strict metric.** The differences are anti-aliasing, not content | GPU: see above. **SVG** rendered by Chrome: median 0.9944, 25/200 below 0.99. The same SVG in resvg: median 0.9964, 17/200 below. **PDF** (krilla, rasterized by poppler `pdftoppm`): median 0.9876, min 0.960, 117/200 below. Poppler vs resvg on the same content is about the same (0.990). With a 3×3 blur before SSIM: resvg min **0.992** (0 below), PDF median 0.994 (40 below). Visual inspection shows identical content (`results/native/pdf/*.png`). |
| S7 text stays real text in PDF | **PASS** | krilla `draw_text` with DejaVuSans (subset-embedded). `pdftotext` recovers `Instaflow export parity: real text ✓ ünïcödé` exactly. The PDF is 148 KB with the font subset, from a 760 KB font file. |
| Wasm size (render) | measured | `vello_gpu` + wgpu (WebGPU only) + our compositor + IR, **after wasm-bindgen + wasm-opt**: **173 KB brotli** (opt-z) and **158 KB brotli (opt-z + simd128)**. The JS glue adds 12 KB. The raw cargo output is 292 KB brotli because it still holds wasm-bindgen descriptor sections, which is what research/03's 262 KB measured. glyph `text` feature: +5 KB (unused, so dead-stripped). |
| Init | measured | Wasm fetch + compile + instantiate **15–18 ms**. `create_engine` 38–57 ms (adapter 7–16, device 5–15, Vello `Renderer::new` 5–10, our pipelines 3–11, 10k-element IR + grid 8–12 ms). First frame on SwiftShader **2.0–2.7 s**, which is pipeline compile plus CPU raster and not representative. |

**Wasm sizes** (KB, raw / gzip / brotli, from `results/sizes.json`):

| Module | Raw | gzip | brotli |
|---|---|---|---|
| gpu (opt-z) | 565 | 216 | 173 |
| gpu_simd | 428 | 190 | **158** |
| gpu_o3_simd | 546 | 222 | 178 |
| cpu (vello_cpu + SVG writer + PNG + SSIM; O3 + simd) | 478 | 195 | 161 |
| cpu_z (no simd) | 2023 | 451 | 279 |
| krilla (raster-images) | 1691 | 527 | **389** |
| krilla + simple-text (rustybuzz) | 2241 | 736 | 529 |
| canvaskit 0.42.0 | 7146 | 2891 | 2222 |

## Surprises and findings
1. **The shared harness cannot present WebGPU to any canvas.** With `_harness` flags, the first `getCurrentTexture()` and
   submit **destroys the device**: `lost: destroyed`, "A valid external Instance reference no longer exists". This happens
   on the main thread, in workers, and in plain JS. Adding `--use-angle=swiftshader --enable-unsafe-swiftshader` fixes
   it. Repro: `web/repro-present-*.html`. This spike uses `scripts/serve-and-run-angle.cjs` (the harness plus those two
   flags). **Other WebGPU spikes (S2, S5, S9) are probably affected.**
2. **Build with `+simd128`.** Without it, `fearless_simd` falls back to scalar code. With it, strip prep is **4.6–7× faster**
   (encode at zoom 0.25: 322 → 46–58 ms), and modules get *smaller*. `vello_cpu` drops from 279 to 161 KB brotli, and the
   gpu module from 173 to 158 KB. opt-level 3 adds little over opt-z + simd.
3. **Tiles have no seams.** Sparse-strip coverage is per pixel, so tiled output is bit-near-identical to full raster. Per-tile
   invalidation is therefore safe.
4. **The per-frame raster budget does not fit a whole tile.** One 512² tile costs about 6.7 ms CPU against the ≤ 4 ms budget
   in research/03 §5. Tile strip generation should move off the render worker's frame path, into a helper worker (scene
   encode is CPU-only) or into idle time, or use 256 px tiles. The budget should be in time, not tile count.
5. **`vello_cpu` is a viable fallback and export path.** In Wasm with simd, single thread, it renders the 1280×720 10k-page
   view in **16–20 ms** at zoom 1 and 68–85 ms at zoom 0.25. Native: 14 and 43 ms.
6. **CanvasKit plan B is not free.** npm `canvaskit-wasm@0.42.0` *declares* `MakeGPUDeviceContext` and related functions in
   its `.d.ts`, but none of its builds (`bin`, `full`, `profiling`) contain WebGPU code; only WebGL is present. CanvasKit on
   WebGPU would need our own Skia (Dawn/Graphite) Emscripten build, on top of 2.2 MB brotli.
7. **Vello gotchas.** (a) Staged queue writes mean you must submit after every `Renderer::render`, so each tile is one
   submit. (b) The default image atlas is 4096², so set `AtlasConfig` smaller. (c) `Renderer::new` compiles pipelines
   synchronously.
8. **krilla works on wasm32 unchanged, but it is big.** Image support (the `raster-images` feature) pulls PNG, JPEG, GIF and
   WebP decoders, even when you pass raw RGBA. That alone is 389 KB brotli, at the edge of the 400 KB export-extras budget.

## Recommendations for M1
- Use `vello_gpu` with `wgpu` (WebGPU only) built `opt-level=z` + `-C target-feature=+simd128`, then wasm-bindgen and
  wasm-opt. That is 158 KB brotli, well under the 300 KB budget.
- Keep tiles (512 px, √2 levels, Manhattan order, interest ring) and the **cached lifted layer**. Re-raster the lifted layer
  only when its geometry changes, as in resize; that costs about 5 ms CPU for 100 elements. Make the tile budget time-based,
  and prototype strip generation in a helper worker.
- Make `vello_cpu` the CI golden reference. Gate GPU parity at **SSIM ≥ 0.999**, since the measured minimum is 0.9995. For
  SVG and PDF, change the S7 metric to "SSIM ≥ 0.98, plus SSIM-after-3×3-blur ≥ 0.99, plus no missing primitives".
  Cross-rasterizer anti-aliasing alone fails 0.99. Alternatively, compare SVG→resvg against PDF→hayro or poppler to keep one
  rasterizer per format.
- PDF: use krilla `draw_glyphs` with Parley runs, not `simple-text`/rustybuzz. Evaluate trimming `raster-images` upstream
  (an RGBA-only path), and lazy-load the export worker.
- Fix `_harness` flags (Surprise 1) before trusting any WebGPU presentation result from the other spikes.

## Rerun
```bash
cd apps/instaflow/spikes/s1-s7-render
npm install                        # binaryen (wasm-opt), canvaskit-wasm (size comparison only)
npm run build                      # needs Rust + wasm32-unknown-unknown; installs wasm-bindgen-cli 0.2.129 into .tools/ (~6 builds, ~15 min)
npm run build:pdf                  # krilla wasm size probe (optional)
export NODE_PATH=/opt/node-tools/node_modules   # wherever `playwright` is installed
# cloud / SwiftShader (uses the harness + ANGLE flags):
QUERY='frames=30&variant=gpu_simd' bash scripts/run.sh mine      # → results/mine/{result.json,img/}
# owner machine, real GPU (Chrome via Playwright, no SwiftShader flags):
QUERY='frames=120&variant=gpu_simd' bash scripts/run.sh realgpu --real-gpu --headed
#   or: npm run serve  → open the printed URL + '?frames=120&variant=gpu_simd' in desktop Chrome; JSON appears on the page.
npm run parity:native              # resvg + krilla/poppler parity, PDF text check (needs pdftoppm/pdftotext)
node scripts/sizes.mjs             # results/sizes.json
```
Query parameters: `count` (10000), `frames` (120), `budget` (tiles per frame, 4), `maxTiles` (256), `variant` (`gpu`,
`gpu_simd`, `gpu_o3_simd`), `corpus=0|1`, `images=0|1`. On a real GPU, read `perf.*.frame_ms` (median and p95 of submit →
`onSubmittedWorkDone`) and `perf.time_to_sharp`. Raw results are in `results/swiftshader-*` (two baseline runs and one
run per variant; frame times vary up to 1.5× between runs because of contention), and in `results/native/native.json`.
Screenshots and diffs (×8) are in `results/swiftshader-gpu-r1/img/`.
