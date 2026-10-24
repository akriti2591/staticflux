# Instaflow research 03: the rendering and authoring engine

Status: research, not a decision record. Date: 2026-10-24. Scope: the engine behind every Instaflow authoring
surface (fixed pages, infinite canvas, timeline, node graphs). It covers the thread layout, the sequencing protocol that
keeps UI edits and the authoring thread consistent at high frame rates, the renderer choice, the text, effects and export
pipelines, how this maps onto StaticFlux, the new primitives StaticFlux needs, a phased plan and risks.

Related: [01 document format](01-document-format.md) (document authority, CRDT, storage),
[02 timeline and media engine](02-timeline-media-engine.md) (decode, clock, audio, video export).
§7 lists where this document disagrees with 02.

**Owner decisions applied (from the coordinator, 2026-10-24):** target **Chrome desktop**. Firefox desktop is best
effort. Safari and all mobile are **dropped**. The engine should be the **simplest possible engine on modern
foundations**: WebGPU first (compute welcome), WebCodecs, OffscreenCanvas in workers, Wasm, Local Font Access, scheduler
APIs, and HTML-in-Canvas where it is shipped or in origin trial. **No Canvas2D or DOM/SVG renderer paths.** WebGL2 only if it
is trivially cheap; otherwise show an "unsupported browser" message. Several requirements in the original brief
("works on web/PWA/mobile web", fallback ladder WebGPU → WebGL2 → Canvas2D) are therefore **out of scope**, and §1.4 explains
what replaces them.

---

## 0. Summary

1. **Recommended engine: Rust → Wasm, built from Linebender crates, running in two workers.**
   - **Render worker:** `vello_gpu` (Sparse Strips: CPU preprocessing, GPU raster and compositing) on `wgpu` → WebGPU,
     plus a thin compositor of our own (tile cache, lifted layers, external video textures). It draws into a transferred
     `OffscreenCanvas`.
   - **Authoring worker:** the document owner from 01, ECS plus CRDT. It also runs a geometry and text Wasm module
     (`parley` for rich text layout, `linesweeper` and `kurbo` for boolean ops and precise hit tests), an R-tree for hit
     testing and snapping, and the tool state machines.
   - **Main thread:** Lit chrome, input forwarding, EditContext for text input, and the accessible DOM layer. It never
     renders the canvas.
2. **Sequencing.** One owner, the authoring worker, holds both the document and the **view state** (camera, gesture
   overlays, selection chrome).
   - Input goes **main → authoring worker**, which runs hit tests, snapping and tools. Each input batch writes a
     *view-state frame* into a shared-memory frame channel, and the render worker reads the latest frame on every
     `requestAnimationFrame`.
   - Drags are **optimistic overlays** keyed by a gesture id, so the CRDT is not touched per pointer move.
   - At gesture end, the authoring worker commits one transaction. The scene delta that carries that commit names the
     gesture it supersedes, so the render worker swaps "overlay off, committed state on" **in the same frame**. This removes
     snap-back and flicker by construction.
3. **Frame rate on 10k+ elements comes from caching, not raw raster speed.**
   - Use **512 logical-px tiles** cached per zoom level, rendered progressively from the centre out. Penpot's render-wasm
     does exactly this.
   - **Lift the selection into its own layer** while dragging, so background tiles are not re-rasterized.
   - Add LOD for tiny elements and a glyph atlas for text.
   - Pan becomes a composite of cached textures. Only invalidated tiles are rasterized by Vello, within a per-frame budget.
4. **Build vs buy.** Buy the rasterizer (Vello), text layout (Parley/HarfRust/Skrifa/ICU4X), boolean ops
   (linesweeper), spatial index (rbush/flatbush), PDF writer (krilla) and media (Mediabunny/WebCodecs, per 02). Build the
   compositor, tile cache, scene IR, sequencing protocol, tools and SVG writer.
   - **CanvasKit is plan B.** It is mature and its npm build exposes WebGPU and Paragraph, but it is **2.22 MB brotli**
     (measured), it costs a JS↔Wasm call per draw op, and its npm build has no PDF.
5. **Measured engine size** (Rust 1.97, `opt-level=z`, LTO, before `wasm-opt`):
   - `vello_gpu` + `wgpu` WebGPU backend: **262 KB brotli**.
   - `parley`: **237 KB**.
   - `linesweeper`: **64 KB**.
   - All three in one module: **525 KB brotli**.
   - For comparison: CanvasKit 2.22 MB, Rive WebGL2 runtime 744 KB, PixiJS 184 KB (JS).
   - The whole engine is lazy, so initial JS does not change.
6. **Export parity: one scene IR and three backends.**
   - Vello renders screen and PNG; video frames go through 02's encoder.
   - Our SVG writer handles SVG.
   - krilla handles PDF.
   - Parity is enforced as in Penpot: a capability trait every backend must implement, exhaustive matches, and pixel parity
     tests.
   - `vello_cpu` shares the Sparse Strips pipeline with `vello_gpu`, so it serves as a **GPU-free reference rasterizer in
     CI**.
7. **Text on Chrome desktop:**
   - **EditContext** (Chrome 121+) for IME and text input.
   - **Local Font Access** for system fonts, with font bytes shared between the two workers.
   - Our own layout (Parley) everywhere, so screen, PNG, PDF, SVG and video match exactly.
   - **HTML-in-Canvas is optional.** It is still an origin trial with renames in Chrome 155, so it is not on the critical
     path.
8. **New StaticFlux primitives** (§5.2), most important first:
   - Optimistic intents with supersede-on-ack on replicas.
   - A sequenced binary delta stream.
   - Brokered worker↔worker channels that survive respawn.
   - Lossless pointer input (coalesced points, pressure, tilt) carried over a binary input ring.
   - A GPU device lifecycle (`lost`) and GPU facts.
   - Headless and export surfaces.
   - A shared, content-addressed blob registry for fonts and images.
   - A worker-side priority scheduler and long-task detector.
   - A GPU memory budget in the resource manager.
   - An "unsupported browser" boot plan.

---

## 1. Recommended engine architecture

### 1.1 Principles

- **One core, many modes.** Pages, infinite canvas, timeline and node graph are *view policies* over one scene IR: camera
  constraints, layout policy, tool set and chrome. They are not separate renderers. A timeline track area is a scene with a
  time→x camera, and a node graph is a scene of frames, text and edge paths.
- **One owner per kind of state.** The document and view state belong to the authoring worker. GPU resources belong to the
  render worker. DOM, focus, IME and the accessibility tree belong to the main thread. This is StaticFlux R11.2 applied to
  the engine.
- **The renderer is a pure consumer.** It never decides anything about the document. It applies deltas, samples overrides
  (gesture overlays and animation), culls, rasterizes and composites. That makes it replaceable (Vello, CanvasKit or a
  future compute renderer) behind one port.
- **Same layout and same fonts for every output.** No browser text layout anywhere in the content path, which also means no
  Canvas2D `fillText` and no DOM text in content. This is the only way to get PNG, SVG, PDF and video "identical to
  on-screen".
- **Simplest thing first.** There is one renderer path (WebGPU), one text engine (Parley), one boolean library
  (linesweeper) and one sequencing protocol. Complexity such as camera fast paths, compute raster or multi-threaded raster
  is added only when a metric demands it.

### 1.2 Threads

```
 Main thread (UI)                         Authoring worker (document owner, per 01)
 ────────────────                         ─────────────────────────────────────────
 Lit chrome, inspector, panels            ECS world + CRDT (01) ── undo, transactions
 input forwarder ──binary input ring──►   tool state machines (select, transform, pen, text…)
 EditContext (text input, IME)  ──intents─► camera + selection + gesture overlays (view state)
 accessible DOM layer  ◄──a11y projection─ spatial index (rbush) → hit test, snapping, marquee
 HTML-in-Canvas overlays (optional)        geometry/text Wasm: parley (layout), linesweeper+kurbo
        ▲ caret/IME bounds                 render projection: ECS → scene IR deltas (binary)
        │                                        │ view-state frames      │ scene deltas (sequenced)
        │                                        ▼ (SAB ring, latest)     ▼ (binary delta stream)
        │                          ┌─────────────────────────────────────────────────────────┐
        │  frame metrics           │ Render worker  (OffscreenCanvas transferred, WebGPU)     │
        └──────────────────────────│  scene IR store (retained) + culling index               │
                                   │  overrides: gesture overlays, animation sampling (02)    │
                                   │  tile cache per zoom level, lifted layers, LOD           │
                                   │  Vello (vello_gpu/wgpu) raster → tile textures           │
                                   │  compositor: tiles + layers + video external textures    │
                                   │  overlay pass: selection, handles, guides, cursors       │
                                   │  rAF in worker; frame budget; GPU timestamp queries       │
                                   └────────▲────────────────────────────────────────────────┘
                     VideoFrame handles      │ (from 02's media workers, transfer)
 Export worker (on demand): same scene IR + same Vello engine on a headless texture (PNG, video frames),
 SVG writer and krilla PDF writer (vector). Fonts and images come from the shared blob registry.
```

Why two workers instead of rendering inside the authoring worker:
- CRDT merges of large remote updates, text re-layout of long stories and boolean ops on complex paths are all
  unpredictable in duration.
- If they share a thread with the frame loop, pans stutter.
- The extra hop costs one `postMessage` or one shared-memory write per input batch (sub-millisecond when the receiver is
  idle) and does not add a frame, provided the authoring worker answers input within its 4 ms task budget (§3.3).
- For a first spike, both can share a thread behind the same ports.

Why the authoring worker, not the main thread, owns tools and the camera:
- **Hit testing and snapping need the spatial index and the document,** and both live in the authoring worker.
- **Hit tests need the camera.** They must use the same camera the user saw, so a single owner of the camera avoids
  "clicked what was displayed a frame ago" bugs.
- **The main thread stays free** for DOM chrome, which is where jank usually comes from in large apps.

### 1.3 Sequencing protocol (the core of "edits synced properly, sequenced, at high frame rate")

Four counters:

| Counter | Owner | Meaning |
|---|---|---|
| `inputSeq` | main (forwarder) | Monotonic per input batch. Each event carries an absolute `ts` (already in `@staticflux/surface`). |
| `gestureId` | authoring worker | One per tool gesture (drag, resize, rotate, pen stroke, marquee, text composition). |
| `docVersion` | authoring worker | Increments on every applied CRDT transaction, whether local commit or remote merge. |
| `viewSeq` | authoring worker | Increments on every view-state frame (camera, overlays, chrome). |

Channels:

- **Input ring** (main → authoring): binary, lossless. It carries coalesced pointer points, pressure, tilt and buttons
  (§5.2 P4).
- **View-state frame channel** (authoring → render): a "latest wins" SAB ring. Each frame holds:
  - `viewSeq` and `inputSeqConsumed`;
  - the camera;
  - the active overlays: `gestureId`, target entity ids, and an **affine delta or replacement geometry**;
  - selection chrome, snap guides, marquee and caret/selection rects.
- **Scene delta stream** (authoring → render): sequenced binary records. These are upsert/remove of IR nodes and geometry,
  paint and glyph-run blobs (content-addressed). Each delta carries a `docVersion` and an optional `commits: gestureId[]`.
  A gap or epoch mismatch triggers a resnapshot, exactly like R11.3.

Gesture lifecycle (drag shown; resize, rotate and pen strokes follow the same shape):

```
pointerdown   → authoring: hit test (rbush → precise kurbo test) → gestureId=g, overlay {targets, Δ=identity}
pointermove*  → authoring: Δ = snap(pointer − origin)              → view-state frame {g, Δ}   (no CRDT write)
              → render (next rAF): draw lifted layer of targets at Δ over cached tiles (targets hidden in tiles)
pointerup     → authoring: transaction(set transforms) → docVersion=v; scene delta {v, commits:[g]}
              → render: in ONE frame apply delta v, drop overlay g, re-raster tiles under old+new bounds
Esc / cancel  → authoring: overlay dropped in the next view-state frame; no transaction
```

Invariants (to be mirrored into `docs/LIFECYCLES.md` once the primitives exist):

- **E-1 Ordered apply.** The render worker applies scene deltas in strictly increasing `docVersion` order. A gap triggers a
  resnapshot request and keeps the last good frame on screen.
- **E-2 Atomic supersede.** An overlay `g` is removed in exactly the frame that applies the delta containing `commits: [g]`,
  never before (snap-back) and never after (double draw).
- **E-3 Relative overlays.** Overlays are expressed **relative to committed state** (Δ transforms, or a geometry replacement
  for path edits). A remote edit arriving mid-gesture therefore composes instead of being overwritten. If a remote change
  removes or locks a target, the authoring worker cancels the gesture with a typed error (for example, a new
  `SF-ENG-001 gesture-target-gone`, which shows a toast).
- **E-4 One camera.** The view-state frame that a hit test used is the one displayed. Hit tests run on the authoring
  worker's camera at the time of the event (`ts`), not on a later camera.
- **E-5 Throttled commits for long gestures.** Pen strokes and long resizes can commit intermediate transactions every N ms
  for collaboration presence. Each commit supersedes the overlay prefix it contains. Default: **commit only on gesture
  end**, and send presence (01) for live remote cursors and ghosts.
- **E-6 Animation is an override, too.** Playback samples the evaluator from 02 at `t` in the render worker and applies the
  result as per-frame overrides on top of committed state, with the same mechanism as overlays. Nothing is written to the
  CRDT.

Latency strategy (the "optimistic UI-thread preview vs worker round-trip" question):

- **Chosen: worker-owned preview.** The input path is main → authoring (one hop) → shared memory → render rAF.
  - It is consistent: snapping, hit tests and constraints are all in one place.
  - It adds **no frame** when the authoring worker is responsive.
  - The cross-thread latency metric (§3.3) proves or disproves this on reference hardware in phase 0.
- **Rejected: preview on the main thread.** The main thread has no GPU surface (the canvas is transferred), no spatial
  index and no snapping data. Mirroring them there breaks the one-owner rule.
- **Kept in reserve: camera fast path.** If wheel or pinch zoom shows latency above budget, the main thread can *also* send
  wheel deltas directly to the render worker. The render worker then applies a **predicted camera** that the authoring
  worker's next view-state frame reconciles (`viewSeq` wins). This is added only when the metric fails.
- **Pen and ink:** use `getCoalescedEvents()` for full-fidelity points and `getPredictedEvents()` for a cosmetic predicted
  tail. A `desynchronized` canvas trades tearing for about one frame of latency, according to the Ink enhancement
  explainer. Measure it in phase 0 before using it.

### 1.4 Renderer choice (owner-constrained) and the fallback ladder

The ladder from the brief (WebGPU → WebGL2 → Canvas2D) is **replaced** by:

1. **WebGPU (only path).** Chrome desktop has shipped WebGPU since 113. Firefox 141 ships it on Windows and Firefox 145 on
   macOS ARM, which covers Firefox best effort with the same code. WebGPU is available in dedicated workers with
   `OffscreenCanvas`.
2. **No WebGL2 at launch.** `vello_gpu` does have a WebGL2 backend, and its WebGL2 build measured **199 KB brotli**, so
   *vector raster* would be cheap. But our compositor (external video textures, effects passes, tile atlas) would need a
   second backend. That is not "trivially cheap", so it is deferred. It is the first fallback to revisit if telemetry shows
   meaningful Chrome-desktop users without a WebGPU adapter (blocklisted GPUs or VMs).
3. **Unsupported browser.** The boot plan checks `'gpu' in navigator` synchronously. The feature checks
   `requestAdapter()` asynchronously and shows a typed, explained "unsupported browser or GPU" screen (§5.2 P10). Safari and
   mobile get this screen.

Candidates compared:

| Option | Size (brotli, measured unless noted) | WebGPU | Text | Effects | Fit |
|---|---|---|---|---|---|
| **Vello GPU** (`vello_gpu` 0.3 + `wgpu` 30) | **262 KB** | Yes (wgpu → WebGPU); no compute required | Glyph runs via `glifo`; layout via Parley (+237 KB) | Blend, opacity, clip and mask layers, blurred rounded rect, and a filter graph mirroring SVG Filter Effects (blur, drop shadow, color matrix, morphology, turbulence…) | **Recommended.** Rust API, so scenes are built in Wasm with no per-op JS boundary cost. Same imaging model as SVG and canvas. |
| Vello compute (`vello`, under `research/`) | not measured | Yes, needs compute | via Parley | Same model | Upstream calls it "experimental". Candidate for phase 4 behind the same port. |
| Vello CPU (`vello_cpu` 0.3) | 195 KB | n/a | yes | yes | **CI reference rasterizer** and golden tests. Upstream: "currently overall more mature". |
| CanvasKit 0.42.0 | **2,222 KB** wasm + 32 KB JS (full: 2,482 KB) | Yes (`MakeGPUDeviceContext`, `MakeGPUCanvasContext` in the npm types) | Skia Paragraph (mature) | Full Skia | **Plan B.** Proven (Penpot, Flutter), but about 4× the size of the whole recommended stack, a JS↔Wasm call per draw op, and no PDF in the npm build (no `MakePDF` in its types). |
| Rive renderer | 744 KB (`@rive-app/webgl2` wasm) | WebGL2 package; GPU Canvas WGSL layer (social post, unverified) | — | Vector feathering | Excellent for .riv playback. Not a general document renderer. |
| PixiJS 8.22 | 184 KB JS | Yes | Canvas-based text (excluded) | Filters, masks, blend modes | Sprite and scene-graph engine. Weak vector fidelity. Its own scene graph duplicates ours. |
| Custom WebGPU vector renderer | — | Yes | — | — | Many person-years (path raster, AA, strokes, gradients, filters). Do not build. |
| Konva 10.9 (49 KB) / Fabric 7.4 (76 KB) | JS | No (Canvas2D) | Canvas2D | Canvas2D | **Excluded** by owner decision (Canvas2D). |
| tldraw (DOM/SVG) / Excalidraw (Canvas2D) | — | No | DOM / Canvas2D | — | **Excluded** as renderers. Their interaction patterns are still worth copying (§2.2). |

Why Vello GPU rather than the compute renderer, given that "compute is welcome":
- Sparse Strips is the path upstream says will become primary.
- It has the broadest backends, and its CPU sibling shares the pipeline, which gives the CI reference renderer for free.
- The compute renderer stays behind the `RasterBackend` port as a phase-4 experiment.
- Compute is still used where it is clearly simpler: blur and filter passes and tile compositing are ours.

### 1.5 Large documents: tiles, layers, culling, LOD

- **Scene IR** in the render worker: a flat SoA store of nodes with parent, z-key (fractional, from the ECS `keyBetween`),
  world transform, world AABB, paint ref, geometry ref, effects ref and flags. Geometry, paint and glyph runs are
  content-addressed blobs uploaded once.
- **Culling index:**
  - The render worker rebuilds a `flatbush` index (5 KB) of node AABBs per page on commit. Its benchmark indexes 1,000,000
    rectangles in 109 ms (M1 Pro), so 10k nodes take about 1 ms.
  - The index is static during gestures because lifted layers are drawn separately.
  - A tile→nodes map (Penpot's `TileHashMap` dual index) gives per-tile invalidation.
- **Tile cache:**
  - **512 logical-px tiles, independent of zoom and DPR** (Penpot).
  - Cached per discrete zoom level (powers of √2 or 2). The previous zoom level's tiles are scaled while new ones
    rasterize.
  - Rendered in Manhattan order from the viewport centre, inside a **per-frame raster budget** (Penpot renders 5–10 tiles
    per frame with a time check every N shapes).
  - An interest ring of one tile around the viewport is pre-rendered.
  - Tiles are textures in a GPU atlas or array. The cache is LRU, budgeted in bytes and evicted on memory pressure (§5.2
    P9). Estimate: a 512² tile at DPR 2 is 1024² × 4 B = 4 MiB, and a 1920×1080 viewport with its ring is about 30 tiles,
    so about 120 MiB.
- **Lifted layers.** Selected or dragged elements, the text being edited, and elements with running animations are drawn
  every frame into a separate layer and excluded from the tiles under them. This keeps a drag over a 10k-element page at
  "composite N tiles + raster K selected elements" per frame.
- **LOD:**
  - Below about 0.5 device px, an element is skipped or drawn as a filled AABB.
  - Text below about 4 device px renders as greeked bars from line metrics.
  - Expensive filters are drawn from cached results at a lower zoom.
  - tldraw does the same kind of LOD (simplified styles when zoomed out) and reports culled counts per frame. We should
    expose the same counts as metrics.
- **What 60–120 fps means here:**
  - During pan, a frame is a tile composite (a few hundred textured quads) plus the overlay pass, comfortably under 2 ms of
    GPU time.
  - During zoom, it is a scaled composite plus budgeted re-raster.
  - During edits, it is lifted-layer raster plus local invalidation.
  - Vello raster throughput only affects *how fast tiles sharpen*, not frame rate. This is the design point that makes the
    choice of rasterizer low-risk.

### 1.6 Hit testing, selection, snapping, transforms

- **Spatial index (authoring worker): `rbush`** (2.1 KB), because it is dynamic. It is updated by an ECS system on bounds
  changes, and bulk-loaded on document open, which upstream says is 2–3× faster to build and 20–30% faster to query.
- **Precise hit test:**
  - Run in Wasm (kurbo) on candidates from the index, ordered by z.
  - Use path winding for fills, stroke distance ≤ half-width plus a tolerance in screen px, text hits through Parley
    cluster geometry, and image alpha optionally through a downsampled mask.
  - Handles and chrome are hit-tested first, in screen space.
- **Snapping:**
  - Candidates are edges, centres, spacing and grid of nearby nodes, queried from rbush around the moving AABB expanded by
    the snap radius.
  - The result (Δ and the guide segments) goes into the view-state frame, and the render worker draws the guides.
- **Transforms with handles:**
  - The tool state machine lives in the authoring worker, and overlays are Δ affine.
  - Rotation and skew are handled in the local frame.
  - The resize policy (scale vs reflow) is per entity kind, for example text boxes reflow through Parley.
- **Marquee:** an rbush query plus a precise test for containment or intersection mode.
- **Constraints and auto-layout (later):** Taffy (Rust flexbox and grid, not measured) in the authoring Wasm module, as a
  system that writes child transforms. Yoga is the alternative (42 KB brotli measured, base64-inlined wasm).

### 1.7 Text pipeline

| Stage | Where | Choice | Notes |
|---|---|---|---|
| Fonts | main → blob registry | Local Font Access (`queryLocalFonts()`, then `FontData.blob()`), uploaded or Google Fonts files, Noto fallbacks | Font bytes are content-addressed and shared with both workers (SAB when isolated). The browser's fallback fonts cannot be used, so ship **Noto subsets** on demand, as Penpot does. |
| Shaping and layout | authoring worker (Wasm) | **Parley 0.12** (Fontique fallback, HarfRust shaping, Skrifa outlines and metrics, ICU4X bidi and segmentation) | 237 KB brotli measured without the `complex-scripts` feature (measure with it in phase 0). Output: positioned glyph runs, line metrics, cluster geometry for caret, selection and hit tests. |
| Rendering | render worker | Vello glyph runs (`glifo`; glyph atlas caching in `vello_gpu`) | Same glyph ids and positions as export. Large or rotated text renders as outlines. |
| Editing | main ↔ authoring | **EditContext** attached to the canvas host (Chrome 121+). Firefox best effort: a hidden-textarea adapter behind the same `TextInput` port. | Text updates become intents. The authoring worker re-lays out and returns caret, selection and character bounds, and main calls `updateCharacterBounds` / `updateSelectionBounds` so the IME candidate window is positioned correctly. `textformatupdate` gives composition underline styles, which the render worker draws. |
| Text on path (later) | authoring worker | Parley glyph runs re-positioned along kurbo arc length | Penpot documents the text→path conversion via line and style metrics. |
| Export | export worker | Same glyph runs. PDF: real text with subset embedded fonts (krilla). SVG: `<text>` with `@font-face` subset, or outlines (option). | Font subsetting only at export: harfbuzz-subset is 216 KB brotli if krilla's own subsetting is not enough. |

Why not the alternatives:
- **Canvas `measureText`/`fillText`** is excluded by the owner, and it is also unfit for the job:
  - you must reimplement line breaking;
  - emoji and `system-ui` measure differently from the DOM;
  - `letterSpacing` is uneven across versions;
  - it cannot give exports identical to the screen.
- **harfbuzzjs alone** (144 KB) shapes but does no line breaking or bidi, which is why 02 lists "our own layer or
  ICU4X-wasm" as a cost to evaluate.
- **CanvasKit Paragraph** is mature but carries the 2.2 MB engine.
- **HTML-in-Canvas (`drawElementImage`)** would let the browser lay out and draw text into the canvas. It is still an origin
  trial: Chrome 148–150, then extended (reported to Chrome 160). Chrome 155 renamed `copyElementImageToTexture` →
  `drawElementImageToTexture` and `layoutsubtree` → `content="drawable"`, and it requires explicit texture
  pre-allocation. Its privacy rules also exclude IME pop-ups and system colors from painting, and browser layout cannot
  match our PDF or SVG output. **Use it only for DOM-rich, non-content overlays** (for example an embedded form or widget
  preview), through the existing `@staticflux/surface` adapter.

### 1.8 Vector geometry, booleans, SVG import

- **Boolean ops: `linesweeper` 0.5** (64 KB brotli measured). It runs a robust Bentley–Ottmann sweep directly on Bézier
  paths (kurbo), with n-ary ops via `Topology`. Upstream calls it "early beta" and it has moved to Radicle.
  - **Fallback: Clipper2** (`clipper2-wasm` 0.4.0, 63 KB brotli measured). It is polygon-only, so curves must be flattened
    and re-fitted, which loses curve fidelity. Its maintainer also notes a six-month pause.
  - Run booleans as *derived geometry* (a non-destructive node, like Figma's boolean groups). They are recomputed in the
    authoring worker and cached by input hash.
- **Tessellation (lyon)** is not needed. Vello rasterizes paths directly. lyon is only relevant for a custom
  triangle-based renderer, which we reject.
- **SVG import:** use usvg (resvg's parser and normalizer; size not measured) in the authoring worker. It resolves CSS,
  `<use>` and transforms into paths, paints and filters, which map 1:1 onto our IR because Vello's filter set mirrors SVG
  Filter Effects. Unsupported features are reported per element.
- **SVG generation (agents):** agents emit SVG or IR JSON through capabilities (04). Both go through the same importer, so
  there is one validation path.

### 1.9 Effects, images, video frames, color

- **Effects:**
  - Vello layers cover blend modes, opacity, clips, masks (`push_mask_layer`) and filters (`push_filter_layer`: Gaussian
    blur, drop shadow, color matrix and the SVG primitive set). A fast path covers blurred rounded rects (cheap shadows).
  - Results are cached per element at the tile zoom level.
  - Background blur ("glass") needs the backdrop. That means a lifted layer, or a compositor pass in our WGSL that samples
    tiles under the element.
- **Images:**
  - Decode with `createImageBitmap` in a worker, through StaticFlux's CORS-clean image loader policy.
  - Upload with `copyExternalImageToTexture`.
  - Make mipmaps for zoomed-out views. Store bytes in the blob registry.
- **Video frames:**
  - Use the `VideoFrame` handles from 02's decoder pool.
  - Bind them with WebGPU `importExternalTexture`. `vello_gpu`'s `wgpu_external_texture` feature binds multi-planar YCbCr
    frames directly.
  - **The compositor is shared with 02** (§7).
- **Color:**
  - v1 renders sRGB, with document colors stored as CSS Color 4 values including their color space (01).
  - Display P3 output comes later via `GPUCanvasConfiguration.colorSpace: 'display-p3'`, and HDR via
    `toneMapping: { mode: 'extended' }` with `rgba16float` (Chrome 129+). Vello's `color` crate supports per-gradient
    interpolation spaces.
  - Export embeds an ICC profile (PDF OutputIntent, PNG `iCCP`).

### 1.10 Export pipeline and parity

| Output | Path | Parity mechanism |
|---|---|---|
| PNG / JPEG / WebP | Export worker: same scene IR → Vello into a headless `GPUTexture` at target scale. Exports larger than `maxTextureDimension2D` are rendered in tiles and stitched. Read back with `copyTextureToBuffer`, encode with `OffscreenCanvas.convertToBlob` (verify for WebGPU contexts, else via `bitmaprenderer`). | The pixels come from the same code as the screen, at a higher resolution. |
| Video frames | 02's export worker calls our renderer per frame at `t` → `VideoFrame` from the canvas or texture → `VideoEncoder` → Mediabunny. | Same evaluator (02) and same renderer. |
| SVG | Our SVG writer walks the IR: paths, paints, Vello filters as `<filter>`, glyph runs as `<text>` + subset font, or outlines. | **Capability trait plus exhaustive match** (Penpot's guards): adding an IR feature fails to compile until every backend handles it. |
| PDF | **krilla 0.8.2** (Rust, high-level PDF creation with font embedding and subsetting; size not measured). Pixel-only effects (blur) are rasterized at export DPI, as Skia's PDF backend "expands" them. Blend modes PDF lacks are rasterized too. | Same trait. Golden tests rasterize PDF and SVG back and diff them against `vello_cpu`. |
| Print / headless CI | `vello_cpu` renders the IR with no GPU. | Reference images for visual regression in Node CI. |

Penpot's write-up describes the exact failure we must avoid. Its live GPU path composites many intermediate surfaces,
while its vector path draws directly to a Skia PDF canvas, so "keeping them in sync is the whole game". Penpot added
compile-time guards and plans pixel parity tests. We start with both guards on day one.

### 1.11 Accessibility of canvas content

- **Accessibility layer:**
  - A projection of the ECS (role, name, description, bounds, reading order) feeds `createAccessibleLayer` in
    `@staticflux/surface`.
  - It is virtualized to the visible region, the selection and the focus path, so 10k elements do not produce 10k DOM nodes.
  - Keyboard navigation (Tab or arrow traversal, Enter to edit) works through the shortcut registry in `@staticflux/a11y`.
- **Text:** the EditContext host element is the focus target, and the a11y layer exposes the story's text with character
  bounds for screen-magnifier tracking. Google Docs' 2021 move to canvas rendering shows this approach is viable at scale,
  provided the parallel tree is maintained.
- **Reduced motion:** animation playback respects `prefers-reduced-motion` in editor preview (R12.19). Export is not
  affected.

---

## 2. Prior art and what each one teaches

### 2.1 Numbers from sources

| System | Finding | Source |
|---|---|---|
| Figma | C++ engine compiled to Wasm: load time cut by more than 3× vs asm.js (2017). | Figma blog (archived copy) |
| Figma | Renderer moved to WebGPU on 2025-09-18. Motivations: compute shaders, no WebGL global state, better errors. It kept WebGL support while adding WebGPU, with a dynamic fallback and a GLSL→WGSL shader processor (secondary summaries). Help center: WebGPU needs Chrome 113+, Firefox 141, Safari 26 for shader features. | Figma blog; Figma help; summaries |
| Penpot | render-wasm: Rust + Skia (rust-skia) via Emscripten, with two build targets (frontend `-O3`, exporter `-Oz`). 512 px logical tiles, `TileHashMap`, Manhattan order, 5–10 tiles per frame, `TileTextureCache`. Text via Skia Paragraph with Noto fallbacks. Two render paths (GPU live, CPU Skia PDF) with parity guards. | penpot/render-wasm docs |
| Vello | Three renderers. **Vello CPU is the most mature.** Vello GPU will become the primary production GPU renderer and has native WebGL2 and wgpu backends without compute. The compute renderer is experimental. | linebender/vello README, ARCHITECTURE.md |
| PixiJS v8 | Bunnymark, 100k sprites: moving CPU 50 → 15 ms and GPU 9 → 2 ms; static CPU 21 → 0.12 ms (vs v7). WebGPU is not automatically faster than WebGL; it is better with many batch breaks (filters, masks, blend modes). | PixiJS v8 launch post |
| tldraw | DOM culling (`display: none`) driven by a spatial index: "10,000 shapes might render only 50". LOD when zoomed out. Per-frame culled counts. | tldraw docs |
| flatbush | Indexes 1M rectangles in 109 ms; 10k searches at 0.01% area take 51 ms (M1 Pro). Index is one ArrayBuffer or SharedArrayBuffer. | flatbush README |
| rbush | Bulk load is 2–3× faster than one-by-one inserts, and queries are 20–30% faster afterwards. | rbush README |
| Flutter skwasm | Multithreaded Skia needs SharedArrayBuffer (COOP/COEP) and WasmGC. Without isolation it runs single-threaded. | Flutter docs |
| CanvasKit | 1.5–2.9 MB compressed depending on build and source; we measured 2.22 MB brotli for 0.42.0. | third-party, plus our measurement |
| HTML-in-Canvas | OT Chrome 148–150, extended. Chrome 155 renamed methods and attributes and requires texture pre-allocation. Edge OT expiry listed as 2026-10-20. `ElementImage` is transferable to workers. | Chrome blog posts, explainer, Edge OT page |
| EditContext | Chrome and Edge 121+. Not in Firefox or Safari. | caniuse, MDN |
| WebGPU | Chrome 113 (desktop), Android 121; Firefox 141 (Windows), 145 (macOS ARM); Safari 26. | web.dev, Khronos |

### 2.2 Measured sizes (npm tarballs and our own Rust builds, 2026-10-24)

Method:
- npm packages were fetched with `npm pack`.
- Rust crates were built for `wasm32-unknown-unknown` with Rust 1.97, `opt-level="z"`, `lto=true`, `codegen-units=1`,
  `panic="abort"` and `strip`, with **no `wasm-opt` and no `wasm-bindgen` post-processing**. Expect a further 5–15%
  reduction from those steps (not measured).
- Each Rust crate was exercised with a minimal real call (fill, stroke, transform; a layout; a boolean op) so dead-code
  elimination keeps a representative subset.
- Compression: gzip level 9 and brotli quality 11 (Node zlib).

| Artifact | Version | Raw | gzip | brotli |
|---|---|---|---|---|
| **vello_gpu + wgpu (WebGPU)** | 0.3.0 / 30 | 1,406 KB | 369 KB | **262 KB** |
| vello_gpu (WebGL2 backend) | 0.3.0 | 1,036 KB | 273 KB | 199 KB |
| vello_cpu (default features: png, text) | 0.3.0 | 1,408 KB | 319 KB | 195 KB |
| **parley** (std, no complex-scripts) | 0.12.0 | 804 KB | 299 KB | **237 KB** |
| **linesweeper** + kurbo | 0.5.0 / 0.13 | 206 KB | 77 KB | **64 KB** |
| **vello_gpu/wgpu + parley + linesweeper (one module)** | — | 2,333 KB | 711 KB | **525 KB** |
| canvaskit.wasm (+ canvaskit.js 32 KB brotli) | 0.42.0 | 7,146 KB | 2,891 KB | **2,222 KB** |
| canvaskit.wasm "full" | 0.42.0 | 8,050 KB | 3,237 KB | 2,482 KB |
| @rive-app/webgl2 rive.wasm | 2.47.0 | 2,252 KB | 947 KB | 744 KB |
| @rive-app/canvas-lite rive.wasm | 2.47.0 | 789 KB | 327 KB | 256 KB |
| harfbuzzjs harfbuzz.wasm / harfbuzz-subset.wasm | 1.6.4 | 434 / 668 KB | 177 / 270 KB | 144 / 216 KB |
| clipper2-wasm clipper2z.wasm | 0.4.0 | 209 KB | 80 KB | 63 KB |
| pixi.js pixi.min.mjs | 8.22.0 | 822 KB | 232 KB | 184 KB |
| fabric index.min.mjs | 7.4.0 | 292 KB | 90 KB | 76 KB |
| konva konva.min.js | 10.9.0 | 192 KB | 57 KB | 49 KB |
| pdf-lib (last published 2022-05) / @pdf-lib/fontkit | 1.17.1 / 1.1.1 | 511 / 698 KB | 201 / 316 KB | 162 / 248 KB |
| mediabunny min | 1.62.1 | 687 KB | 177 KB | 145 KB |
| yoga-layout (wasm inlined as base64) | 3.2.1 | 118 KB | 48 KB | 42 KB |
| flatbush / rbush | 4.6.2 / 4.0.1 | 20 / 6 KB | 6 / 2 KB | 5 / 2 KB |

How to read the split: the authoring worker module would hold Parley, linesweeper and kurbo (about 300 KB), and the render
worker module would hold Vello and wgpu (about 262 KB). They share crates such as kurbo, peniko and skrifa, so splitting
costs some duplication. That is accepted, because each worker loads only what it runs.

### 2.3 Patterns worth copying

- **Penpot:** tiles, progressive raster and parity guards. Penpot also builds a size-optimized `-Oz` exporter target, which
  is worth copying for our export worker.
- **Figma:** dynamic per-device fallback, staged rollouts with device telemetry, and treating the renderer as a C++ or Rust
  core with a thin JS host.
- **tldraw:**
  - culling through a spatial index;
  - `canCull()`-style opt-outs for elements whose ink extends beyond bounds (shadows and blurs need *ink bounds*, not
    geometry bounds, in our index);
  - per-frame perf events.
- **Excalidraw:** the per-element cached canvas idea, which corresponds to our per-element effect cache and lifted layers.
  Upstream issues show eraser lag on big canvases, which is a reminder that tools must use the index too, not only the
  renderer.
- **Graphite:** a node-graph core with tools wrapping it, using Vello for vector rendering (integrated in 2024, later split
  into separate renderer crates). This validates "modes over one core" and Vello for editing workloads.

---

## 3. Performance budgets (proposed starting points, ratcheted per R12.8)

### 3.1 Bytes

| Item | Budget | Notes |
|---|---|---|
| Boot JS (R12.7) | **unchanged ≤ 150 KB gzip** | The engine adds nothing to boot. |
| Editor feature initial JS (render host, protocol, tools glue) | ≤ 50 KB | `@staticflux/surface` (≈ 10 KB) plus Instaflow engine host. |
| Render Wasm (`budgetCategory: 'wasm'`) | **≤ 300 KB brotli** | Measured 262 KB pre-`wasm-opt`. |
| Authoring Wasm (text + geometry) | **≤ 350 KB brotli** | Measured 237 + 64 KB; `complex-scripts` adds more (measure it). |
| Noto fallback subsets | ≤ 60 KB per script, on demand | Penpot-style language detection. |
| Export worker extras (krilla, SVG writer, subsetter) | ≤ 400 KB, only on export | Lazy chunk, warmup `speculative` on hover of Export. |

R12.7's "heavy feature ≤ 200 KB" is a JS budget. The Wasm modules are a separate declared category (`describeWasmModule` →
`budgetCategory: 'wasm'`). Warmup is `likely`: compile streaming in idle after the shell's first render, so opening a
document does not wait for it.

### 3.2 Frames (reference: Chrome desktop, mid-range iGPU, 120 Hz, document of 10k elements)

| Metric | Budget |
|---|---|
| Pan/zoom frame time (render worker CPU + GPU) | p95 ≤ 8.3 ms at 120 Hz; ≤ 1% of frames dropped per 120-frame window |
| Drag of up to 100 selected elements | p95 ≤ 8.3 ms |
| Input → presented frame (`surface/input-latency`, cross-thread) | p95 ≤ 1 frame + 4 ms (≤ 12.3 ms at 120 Hz) |
| Tile raster budget per frame | ≤ 4 ms CPU (Vello strip prep) + ≤ 2 ms GPU |
| Time to sharp after zoom stop (viewport fully re-rastered) | ≤ 250 ms |
| Render Wasm compile + instantiate (streaming, warm cache) | ≤ 150 ms |
| First canvas frame after document open (warm) | ≤ 500 ms (matches R12.7 `feature.first-render` warm) |
| GPU memory: tile cache + layers + images | ≤ 512 MiB, evict LRU; device-lost recovery ≤ 1 s |

### 3.3 Authoring worker

- **No task longer than 4 ms while a gesture is active.** CRDT merges, re-layout and booleans are chunked with
  `scheduler.yield()` or `postTask` where available in workers, with a `MessageChannel` yield as fallback.
- Input batches are processed before any other queued work. Their priority is `interaction` (R12.18), using a worker-side
  scheduler (§5.2 P8).
- Measure: `engine/authoring-task-max`, `engine/input-to-viewframe`, `engine/viewframe-to-present`, `engine/tiles-pending`,
  `engine/culled-count`, plus GPU timestamp queries (`timestamp-query` feature) per pass.

---

## 4. Build vs buy

| Component | Decision | Choice (license) | Why |
|---|---|---|---|
| Vector rasterizer | **Buy** | Vello GPU 0.3 (Apache-2.0/MIT) on wgpu 30 | Rust, so scenes are built without crossing JS. Small (262 KB). SVG imaging model. Filter set mirrors SVG. Active upstream. |
| Reference rasterizer (CI) | **Buy** | Vello CPU 0.3 | Same Sparse Strips pipeline. No GPU in CI. |
| Plan B rasterizer | Keep evaluated | CanvasKit 0.42 (BSD-3) | Mature, but 2.2 MB and per-op JS boundary cost. Revisit if Vello parity or quality blocks phase 2. |
| Compositor, tiles, layers, overlays | **Build** | Our WGSL (~3–5k LOC Rust, shared with 02) | This is the core of perceived performance and must own budgets and caching. |
| Text layout | **Buy** | Parley 0.12 (+ HarfRust, Skrifa, ICU4X; Apache-2.0/MIT) | Full rich-text layout and editing helpers. rustybuzz is archived, and upstream recommends HarfRust, which Parley uses. |
| Text input | **Platform** | EditContext; hidden textarea on Firefox | EditContext is built for canvas editors. The hidden-input pattern hurts a11y (W3C explainer), so it is the fallback only. |
| Fonts | **Platform + buy** | Local Font Access; Noto (OFL) | License note: embedding *local* fonts in shared docs or exports needs policy (§6). |
| Boolean ops | **Buy** | linesweeper 0.5 (Apache-2.0/MIT) | Curves stay curves. Fallback Clipper2 (BSL-1.0). |
| Curves | **Buy** | kurbo 0.13 | Arc length, nearest point, offsets, winding. |
| Spatial index | **Buy** | rbush 4 (authoring), flatbush 4.6 (render) | Tiny and fast. |
| SVG import | **Buy** | usvg (resvg; Apache-2.0/MIT) | Normalizes SVG to paths, paints and filters. |
| SVG export | **Build** | Our IR → SVG writer | Small, and must be parity-guarded. |
| PDF export | **Buy** | krilla 0.8 (Apache-2.0/MIT) | Rust, high-level, subsetting. pdf-lib has been unpublished since 2022 and is 162 KB + 248 KB fontkit in JS. Skia PDF would need CanvasKit plus a custom build. |
| Video encode and mux | **Platform + buy** | WebCodecs + Mediabunny (per 02) | — |
| Auto-layout (later) | **Buy** | Taffy (MIT) | Flexbox and grid in Rust, same module as Parley. |
| Animation evaluator | per 02 | `@staticflux/motion` | Overrides mechanism E-6. |

---

## 5. Mapping onto StaticFlux

### 5.1 What exists and fits

| StaticFlux | Use in the engine | Gap |
|---|---|---|
| `@staticflux/surface`: `createWorkerSurface` / `hostRenderSurfaces`, `RenderEngine` (`init/frame/resize/input/dispose`), `supportsWebGpu`, frame loop (rAF in dedicated workers), `SurfaceMetrics` (`surface/frame-time`, `dropped-frames`, `input-latency`), `createAccessibleLayer`, HTML-in-Canvas adapter (already detects `content="drawable"` and `drawElementImageToTexture` \| `copyElementImageToTexture`), CORS-clean image loader | Render worker host, a11y layer, optional overlays | No GPU device lifecycle (`lost`); no headless or export surface; input is forwarded only to the render worker; HTML-in-Canvas adapter must add Chrome 155's texture pre-allocation. |
| `surface/input.ts`: `CompactInputEvent` with absolute `ts`, coalescing, microtask batches | Input timestamps for latency | **Coalescing drops intermediate points** (`n` counts them); no pressure, tilt or twist; no `getCoalescedEvents`/`getPredictedEvents`; events are objects, not binary. |
| `@staticflux/worker` channels: `defineFrameChannel` (SAB ring + Atomics; transfer fallback), `defineLayout` (AoS/SoA plus C/Rust source with identical offsets), data channels | View-state frames (ring, `readLatest`); IR node layouts shared with Rust via `layout.source('rust')` | No sequenced binary delta stream; no direct worker↔worker wiring; no handle channel (also requested by 02). |
| `@staticflux/worker` replication (`createPublisher`/`createReplica`, intents, epochs) | Main-thread replicas of selection, inspector values, a11y projection | No optimistic intents with supersede-on-ack. |
| `@staticflux/document`: ECS (SoA stores, queries, systems, `keyBetween`), engine transactions, projections, presence | Authoring worker world (or 01's successor) | Projections emit JSON patches; the engine needs a **binary render projection**. No spatial-index system. |
| `@staticflux/wasm`: worker-scoped modules, feature facts (SIMD, threads), variants, streaming compile, budgets, `liveView` | Both Wasm modules | Needs shared font and image bytes across two modules in two workers. |
| `@staticflux/runtime` frame scheduler (`interaction \| critical \| visible \| idle`), resource manager (budgets, pressure) | — | Scheduler is documented for the main thread; workers need the same priorities. Resource manager has no GPU memory budget. |
| Isolation (R11.16a/b): `IsolationPolicy`, COEP flavours | Choose `isolation: 'required'` with **COEP `credentialless`** (Chrome) | Fine as is. On a static host, use the optional service-worker header plugin. |
| `@staticflux/perf` journeys, metrics, budgets | Engine metrics (§3.3) feed budgets and CI lab runs | No long-task detection inside workers (LoAF is main-thread only). |
| `@staticflux/platform` boot plans (R12.9) | "unsupported browser" plan | Needs a WebGPU capability fact and an unsupported preset. |
| `@staticflux/capabilities` / `webmcp` | Agents call engine operations (create shape, boolean, export) as typed capabilities (04) | — |

### 5.2 New primitives StaticFlux needs (proposed requirements, numbered for tracking)

- **P1 Optimistic intents with supersede-on-ack** (worker replication, extends R11.2/R11.3):
  - A replica may apply a local *overlay* tagged by an intent or gesture id.
  - The owner's next patch or delta carries `acks: id[]`, and the replica drops the overlay atomically in the same apply.
  - Overlays are relative and composable with remote changes. Dev guard: an overlay older than N s is flagged.
  - This is invariant E-2 generalized. It is useful beyond the canvas, for example optimistic inspector values.
- **P2 Sequenced binary delta stream** (`defineDeltaStream({ id, layout | codec })` in `@staticflux/worker/channels`):
  - Versioned records, with batching per frame.
  - Gap or epoch triggers a resnapshot handshake.
  - Content-addressed blob side channel (send once, refer by hash).
  - Read-your-writes, as with replication.
  - It is the binary sibling of `createPublisher`/`createReplica`.
- **P3 Brokered peer channels** (`connectPeers(workerA, workerB, channels)`):
  - The main thread creates a `MessageChannel`, hands one end to each supervised worker, and **re-wires on respawn of
    either side** with epoch bump and resnapshot.
  - Today links are main↔worker only.
- **P4 Lossless pointer input and binary input ring** (`@staticflux/surface`):
  - Capture `getCoalescedEvents()` points, pressure, tilt and twist, `getPredictedEvents()` (flagged as predicted), and
    optional `pointerrawupdate`.
  - Encode them into a `defineLayout` record in a frame channel ring.
  - Allow **multiple sinks** (authoring worker for tools, render worker for an optional camera fast path).
  - Keep coalescing as an opt-in per consumer.
- **P5 GPU device lifecycle and facts** (`@staticflux/surface` + `@staticflux/platform`):
  - `GpuFactsToken`: adapter info, features (`timestamp-query`, `shader-f16`, `float32-filterable`…), limits
    (`maxTextureDimension2D`, buffer sizes).
  - Surface states extend to `running → lost → attaching` on `device.lost` or `uncapturederror` policy. The engine re-inits
    from the retained IR (CPU-side) without reloading the document.
  - New error codes `SF-SURF-01x`.
- **P6 Headless and export surfaces:** `createHeadlessSurface({ engine, size, format })`. It renders to a texture in a
  worker, reads back with `copyTextureToBuffer`, and supports tiled export beyond texture limits, cancellation
  (`AbortSignal`) and progress. The same `RenderEngine` is used, which is the parity guarantee.
- **P7 Shared blob registry** (`@staticflux/storage` + `worker`):
  - A content-addressed byte store (fonts, images, geometry) backed by OPFS.
  - Exposed to multiple workers as SAB views when isolated, else by transfer of copies.
  - Ref-counted, with budgets. This is the cross-worker home for Local Font Access data.
- **P8 Worker-side priority scheduler and long-task detector:**
  - `createFrameScheduler` (or a `createWorkerScheduler`) runs in workers with injected env: `postTask` priorities where
    available, a `MessageChannel` fallback, and `yieldToMain` adapted to workers.
  - It reports `worker/long-task` with chunk or system attribution, because LoAF does not cover workers.
- **P9 GPU memory budget** in the resource manager: GPU caches (tiles, layers, image textures) register byte sizes and
  eviction callbacks. Memory pressure and budgets evict LRU before any feature demotion.
- **P10 Unsupported-browser boot plan** (`@staticflux/platform`):
  - The mode detector adds a sync `webgpu.present` fact.
  - The profile maps to an `unsupported` shell preset with an explained message and a stable code (for example
    `SF-PLAT-0xx`, fix: "use Chrome or Edge desktop").
  - The async adapter check runs in the feature's `activate` and shows the same screen on failure.
- **P11 Binary render projection** (`@staticflux/document`): `defineRenderProjection(world, layout)` is an ECS system that
  emits P2 records for changed entities (transform, bounds, paint, geometry refs) instead of JSON patches.
- **P12 Spatial index system** (`@staticflux/document`): `spatialIndexSystem({ bounds: Component, inkOutset })` maintains
  an rbush index from ECS bounds, exposing `query(rect)`, `nearest(point, k)` and a deterministic z order.
- **P13 Text input port** (`@staticflux/a11y` or `surface`): `TextInput` with an EditContext implementation (Chrome) and a
  hidden-textarea implementation (best effort), emitting typed text intents and accepting caret, selection and character
  bounds. Main thread only.
- **P14 Handle channel** (also requested by 02): transfer of `VideoFrame`, `ImageBitmap`, `ElementImage` and
  `OffscreenCanvas` with ownership and `close()` accounting.

Package placement follows the layers:
- P1–P3 and P14 belong in `@staticflux/worker` (vertical).
- P4–P6 and P13 belong in `@staticflux/surface` (ui).
- P7 spans storage and worker.
- P8 and P9 belong in `@staticflux/runtime`, injected into workers.
- P10 belongs in platform.
- P11 and P12 belong in document.
- The engine itself is an **Instaflow feature package plus two Wasm modules**, not a StaticFlux package. StaticFlux hosts
  engines and stays engine-agnostic (R11.21).

### 5.3 Engine ports (feature-level, so each one can be swapped)

```ts
// Render worker side (inside RenderEngine.frame): the only place that knows Vello.
export interface RasterBackend {
  rasterTile(tile: TileKey, nodes: NodeSpan, target: GpuTextureRef, signal: AbortSignal): Result<RasterStats, SfError>;
  rasterLayer(nodes: NodeSpan, overrides: OverrideSpan, target: GpuTextureRef): Result<RasterStats, SfError>;
}
// Authoring worker side
export interface TextLayoutPort { layout(story: StoryRef, width: number | null): Result<LaidOutStory, SfError> }
export interface GeometryPort { boolean(op: BoolOp, paths: readonly PathRef[]): Result<PathRef, SfError>; hit(path: PathRef, p: Vec2, tol: number): boolean }
export interface ExportBackend { readonly kind: 'png' | 'svg' | 'pdf'; export(scene: SceneSnapshot, opts: ExportOptions, signal: AbortSignal): Promise<Result<Blob, SfError>> }
```

---

## 6. Phased plan

**Phase 0: spikes with kill criteria (2–3 weeks).**
1. **Render spike:** Vello GPU via wgpu → WebGPU in a worker on a transferred `OffscreenCanvas`, with a 10k-element
   synthetic page and tiles plus a lifted layer. Measure p95 frame time, time to sharp and GPU memory on two reference
   machines. *Kill or escalate:* p95 above 8.3 ms at 120 Hz during pan after tiling, or visible quality gaps against
   CanvasKit on the reference SVG corpus → evaluate CanvasKit WebGPU on the same harness.
2. **Sequencing spike:** main → authoring → render with a SAB view-state ring, measuring cross-thread input-to-present.
   *Kill or escalate:* above 1 frame + 4 ms p95 → add the camera fast path (§1.3), and re-measure with `desynchronized`.
3. **Text spike:** Parley in a worker with Local Font Access bytes, an EditContext round trip for IME (Japanese and Chinese
   IME candidate positioning), and the size with `complex-scripts`.
4. **Parity spike:** the same IR rendered by Vello GPU, `vello_cpu`, the SVG writer and krilla, with a diff harness in CI.

**Phase 1: MVP, pages and infinite canvas.**
- Content: rects, ellipses, paths, images, single-style text.
- Interaction: select, marquee, move, resize, rotate, snapping and guides, zoom and pan.
- Infrastructure: tile cache, culling, LOD, PNG export, accessibility layer.
- StaticFlux: P1–P5, P8, P10–P12.

**Phase 2: rich content.**
- Content: multi-style rich text, boolean ops (derived nodes), effects (shadows, blur, blend modes, masks), SVG
  import/export, PDF export (krilla), font fallback subsets.
- Editing: EditContext editing with IME and a11y text exposure.
- StaticFlux: P6, P7, P9, P13.

**Phase 3: time and graphs.**
- Timeline mode, using 02's compositor which is this compositor: video `VideoFrame` external textures, animation
  overrides (E-6), video export frames.
- Node-graph mode (edges as paths, ports, auto-routing).
- StaticFlux: P14.

**Phase 4: depth.**
- Auto-layout and constraints (Taffy), text on path, Display P3 and HDR output.
- An evaluation of the Vello compute renderer and threaded raster behind `RasterBackend`.
- Presence ghosts for remote gestures.
- An optional WebGL2 backend if telemetry justifies it.

---

## 7. Disagreements with sibling research (to resolve)

- **02 §1.10 proposes harfbuzzjs plus a Canvas2D glyph atlas** (`fillText` on an OffscreenCanvas).
  - Under the owner's "no Canvas2D" decision, and for screen/PDF/SVG parity, we propose **Parley in Wasm plus Vello glyph
    runs for all text**, including video.
  - harfbuzzjs lacks line breaking and bidi, which 02 flags itself.
- **02 §2 says the GPU compositor is "raw WebGPU + WebGL2".** We propose **one compositor**, owned by this engine, used by
  both the canvas and the timeline, and **WebGPU only**.
  - 02's composition worker and our render worker should be the **same worker type** (the same `RenderEngine`). Video
    preview is then one more scene with a time camera.
- **02 §1.10 uses the HTML-in-Canvas overlay for inline text editing.** We propose **EditContext** as primary, because it
  has shipped in Chrome 121+, has no origin-trial churn, and works with our own layout. HTML-in-Canvas is kept for non-content
  DOM overlays.
- **01 §3.3 places the document in a workspace SharedWorker.** If the authoring worker is a SharedWorker (multi-tab), then:
  - each tab's render worker connects through P3 brokered ports;
  - view state stays **per tab**, so it must be separated from the shared document owner;
  - the clean split is a per-tab "tool and view" worker plus the shared document worker.
  - That adds one hop for commits but not for gestures. This needs a joint decision with 01.

---

## 8. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **Vello maturity.** It is at 0.3, and upstream says Vello CPU is more mature than Vello GPU. Quality or perf gaps (conflation artifacts, filter coverage, memory strategy) are possible. | Medium / high | `RasterBackend` port; reference SVG corpus diffed against resvg or Chrome; CanvasKit kept as evaluated plan B; contribute upstream; pin versions. |
| Cross-thread latency or a busy authoring worker stalls gestures | Medium / high | 4 ms task cap with chunked merges; input-first worker scheduler (P8); camera fast path in reserve; metrics in CI lab runs. |
| Sequencing bugs (snap-back, double draw, lost overlays) | Medium / high | E-1…E-6 as tested invariants; shared contract suites in testkit (frozen ports, reordered deltas, respawn mid-gesture). |
| GPU memory blow-ups on huge zoom ranges or many images | Medium / medium | Byte-budgeted LRU (P9), mip levels, pressure eviction, device-lost recovery (P5). |
| WebGPU unavailable on some Chrome desktops (blocklisted GPUs, VMs, remote desktops) | Low–medium / medium | Clear unsupported screen with a code and fix; telemetry; WebGL2 via `vello_gpu`'s backend is the first fallback to add if numbers justify it. |
| Text fidelity: our layout ≠ browser and other tools (fallback fonts, emoji, complex scripts) | Medium / medium | Parley with HarfRust (near-HarfBuzz conformance); Noto fallbacks; complex-script test corpus; `complex-scripts` feature cost measured in phase 0. |
| **Font licensing.** Local Font Access fonts embedded in shared documents or exports. | Medium / high (legal) | Store only references for local fonts in shared docs; read the embedding permissions (`fsType`) before subsetting into PDF or SVG; warn on missing fonts for collaborators. |
| HTML-in-Canvas churn (renames in 150 and 155, OT window) | High / low | Not on the critical path; adapter isolates the names (already in `@staticflux/surface`). |
| Firefox best effort lacks EditContext and HTML-in-Canvas | High / low | Hidden-textarea `TextInput` adapter; no other Firefox-specific code. |
| linesweeper is early beta and moved off GitHub | Medium / medium | Clipper2 fallback behind `GeometryPort`; fuzz tests; booleans are derived, so the original paths are never lost. |
| COOP/COEP breaks third-party embeds or images | Medium / medium | COEP `credentialless` (Chrome); CORS image loader policy (R11.16b); transfer-mode fallbacks already exist in channels. |
| Two Wasm modules duplicate crates (kurbo, skrifa, peniko) | High / low | Accept the duplication (~50–80 KB est.); revisit with a shared-memory single module later. |
| Wasm budget vs R12.7 "heavy feature ≤ 200 KB" (JS) | — | Declare the Wasm category per module (`budget.bytes`) with a reason; it is not counted as JS. |

---

## 9. Open questions

1. Per-tab tool and view worker vs shared document worker topology (with 01): where exactly does view state live?
2. Do we need the camera fast path at all on Chrome desktop? Phase 0 will tell.
3. Tile zoom quantization (powers of 2 vs √2) vs memory: tune with real documents.
4. Effects caching granularity: per element, per tile, or both? Background blur needs a compositor pass of our own.
5. Exact krilla feature coverage (blend modes, masks, gradients, ICC) and size: not measured yet.
6. Whether `OffscreenCanvas.convertToBlob` on a WebGPU context is reliable in Chrome for PNG export (else use a
   `bitmaprenderer` hop).
7. Whether `scheduler.yield()` is exposed in dedicated workers in current Chrome (P8 fallback ready either way).
8. Shared single Wasm module with threads (SAB memory) for authoring and render: worth it later for zero-copy IR?

---

## 10. Sources

Primary repositories (READMEs and docs read at their default branch on 2026-10-24 via raw.githubusercontent.com):
- Vello: [README](https://github.com/linebender/vello), [ARCHITECTURE.md](https://github.com/linebender/vello/blob/main/ARCHITECTURE.md), [vello_gpu README](https://github.com/linebender/vello/tree/main/vello_gpu), [vello_cpu README](https://github.com/linebender/vello/tree/main/vello_cpu); crates [vello_gpu 0.3.0](https://crates.io/crates/vello_gpu), [vello_cpu 0.3.0](https://crates.io/crates/vello_cpu) (source read for scene, filter and WebGL APIs); [Vello CPU thesis (ETH, 2025)](https://ethz.ch/content/dam/ethz/special-interest/infk/inst-pls/plf-dam/documents/StudentProjects/MasterTheses/2025-Laurenz-Thesis.pdf)
- Penpot render-wasm: [README](https://github.com/penpot/penpot/tree/develop/render-wasm), [rendering_architecture.md](https://github.com/penpot/penpot/blob/develop/render-wasm/docs/rendering_architecture.md), [tile_rendering.md](https://github.com/penpot/penpot/blob/develop/render-wasm/docs/tile_rendering.md), [texts.md](https://github.com/penpot/penpot/blob/develop/render-wasm/docs/texts.md)
- [Parley](https://github.com/linebender/parley) (and [parley 0.12.0](https://crates.io/crates/parley)), [kurbo](https://github.com/linebender/kurbo), [fontations / skrifa](https://github.com/googlefonts/fontations), [rustybuzz (archived; recommends HarfRust)](https://github.com/harfbuzz/rustybuzz), [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs)
- [linesweeper](https://github.com/jneem/linesweeper) (0.5.0 on crates.io), [Clipper2](https://github.com/AngusJohnson/Clipper2), [lyon](https://github.com/nical/lyon)
- [rbush](https://github.com/mourner/rbush), [flatbush](https://github.com/mourner/flatbush)
- [HTML-in-Canvas explainer (WICG)](https://github.com/WICG/html-in-canvas)
- [Graphite](https://github.com/GraphiteEditor/Graphite), [PixiJS](https://github.com/pixijs/pixijs), [Rive runtime](https://github.com/rive-app/rive-runtime), [tldraw](https://github.com/tldraw/tldraw), [Excalidraw](https://github.com/excalidraw/excalidraw), [pdf-lib](https://github.com/Hopding/pdf-lib)
- Crates: [krilla 0.8.2](https://crates.io/crates/krilla), [harfrust 0.15.0](https://crates.io/crates/harfrust)

Web (search results; some pages could not be fetched directly from this environment, so claims marked "secondary" rely on summaries):
- Figma: [Figma rendering: Powered by WebGPU (2025-09-18)](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/); secondary summaries [techreport.ngo](https://techreport.ngo/performance/figma-rendering-powered-by-webgpu/), [daily.dev](https://daily.dev/posts/figma-rendering-powered-by-webgpu-stte7gi23), [Graphics Programming weekly 410](https://www.jendrikillner.com/post/graphics-programming-weekly-issue-410/); [Figma system requirements](https://help.figma.com/hc/en-us/articles/360039827194-What-are-the-system-requirements-for-Figma); [WebAssembly cut Figma's load time by 3x (archived)](https://madebyevan.com/figma/webassembly-cut-figmas-load-time-by-3x)
- WebGPU support: [web.dev: WebGPU is now supported in major browsers](https://web.dev/blog/webgpu-supported-major-browsers), [Khronos: WebGL and WebGPU (SIGGRAPH 2026)](https://www.khronos.org/developers/linkto/webgl-and-webgpu-sigg26), [Chrome: HDR canvas tone mapping (WebGPU in Chrome 129)](https://developer.chrome.com/blog/new-in-webgpu-129), [MDN GPUCanvasContext.configure](https://developer.mozilla.org/docs/Web/API/GPUCanvasContext/configure)
- HTML-in-Canvas: [Chrome: origin trial](https://developer.chrome.com/blog/html-in-canvas-origin-trial), [Chrome: HTML-in-Canvas updates (Chrome 150/155 changes)](https://developer.chrome.com/blog/html-in-canvas-ot-changes), [three.js PR #34732 (Chromium 155 API changes)](https://github.com/mrdoob/three.js/pull/34732), [Edge origin trial page](https://developer.microsoft.com/en-us/microsoft-edge/origin-trials/trials/a297467e-0030-4c4c-8739-48e130026c03)
- Text input: [W3C EditContext explainer](https://w3c.github.io/editing/docs/EditContext/explainer.html), [MDN EditContext](https://developer.mozilla.org/docs/Web/API/EditContext), [caniuse EditContext](https://caniuse.com/wf-edit-context), [Edge blog: custom editing with EditContext (2024)](https://blogs.windows.com/msedgedev/2024/02/13/custom-web-editing-experiences-with-editcontext/), [Google Docs canvas-based rendering (2021)](https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html)
- Latency: [Ink enhancement explainer (desynchronized canvas, worker input)](https://github.com/dontcallmedom/ink-enhancement), [web.dev OffscreenCanvas](https://web.dev/articles/offscreen-canvas)
- tldraw: [performance](https://tldraw.dev/sdk-features/performance), [culling](https://tldraw.dev/sdk-features/culling), [many shapes example](https://tldraw.dev/examples/many-shapes)
- PixiJS: [v8 launch post (benchmarks)](https://pixijs.com/blog/pixi-v8-launches)
- Rive: [Canvas vs WebGL renderers](https://rive.app/docs/runtimes/web/canvas-vs-webgl.md), [feathering blog](https://rive.app/blog/how-rive-reinvented-feathering-for-the-vectorian-era)
- Flutter: [web renderers (skwasm threading, COOP/COEP, WasmGC)](https://docs.flutter.dev/platform-integration/web/renderers.html); CanvasKit sizes (third-party): [startdebugging.net (2026-09)](https://startdebugging.net/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/), [React Native Skia web](https://www.mintlify.com/shopify/react-native-skia/getting-started/web)
- Canvas text limits: [PixiJS TextMetrics (letterSpacing behaviour)](https://cdn.jsdelivr.net/npm/pixijs@7.1.4/text/TextMetrics.d.ts); Excalidraw perf: [Excalidraw issues](https://github.com/excalidraw/excalidraw/issues), [Mozilla bug 1161818 (large canvas)](https://bugzilla.mozilla.org/show_bug.cgi?id=1161818)
- PDF: [Skia PDF backend ("expand" semantics)](https://skia.googlesource.com/skia/+/chrome/m65/site/user/sample/pdf.md), [@pdf-lib/fontkit](https://socket.dev/npm/package/%40pdf-lib%2Ffontkit)
- Media: [Mediabunny](https://mediabunny.dev/guide/introduction)
- Graphite + Vello history: [GSoC 2024 project](https://summerofcode.withgoogle.com/archive/2024/projects/v5z2Psnc)

Measurements: npm registry tarballs (`npm pack`, 2026-10-24), and local Rust builds of `vello_gpu`, `vello_cpu`,
`parley` and `linesweeper` for `wasm32-unknown-unknown` (method in §2.2). The build harness lives in the session scratchpad
and is not committed.
