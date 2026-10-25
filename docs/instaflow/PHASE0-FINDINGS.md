# Instaflow — Phase 0 findings

Date: 2026-10-24. Spikes live in `apps/instaflow/spikes/<spike>/README.md` (deleted at M1 end; this page is the summary
that stays). Cloud runs: 4 shared cores, no GPU (SwiftShader). Owner runs: Chrome 155, macOS Apple Silicon, Metal GPU.
The plan's reference machine (mid-range iGPU laptop) has not been measured yet.

## Verdict

**Proceed to M1.** No spike hit a kill criterion that forces a different architecture. Two took their planned fallback
(S9 matte for V1; S4 merge criterion restated per page) and four produced new locked decisions (D14, D15 and the folder
mirror and agent-view rules below).

| Spike | Verdict | Where measured | Decision / change |
|---|---|---|---|
| S1 Render (Vello GPU, tiles, lifted layer) | **PASS** | Owner GPU | Tiles required; tile prep off the frame; warm pipelines (cold first frame ≈ 1 s) |
| S2 Sequencing | **PASS** (one worker) | Owner GPU + 33 cloud runs | **D15**: modules + one-or-two-worker boot setting, default one; draw on arrival |
| S3 Text (Parley, EditContext) | **PASS** (IME placement needs a human) | Cloud | `complex-scripts` loads lazily |
| S4 CRDT (Loro) | **PASS** with restated merge criterion | Cloud | **D14**: one CRDT doc per page, adapter rules |
| S5 Media | **PASS** incl. Bluetooth | Owner Mac | Audio-master clock, catch-up rule, gate playback on settled output clock |
| S6 Store | **PASS** incl. real-folder crash | Cloud + owner folder | Folder mode = OPFS journal + batched folder mirror |
| S7 Export parity | **PARTIAL**: PDF/SVG content right, SVG SSIM 0.9945 median | Cloud + owner | Per-feature rasterize rule, or tolerance-aware metric |
| S8 Agent views | **PASS** (Claude Sonnet; Qwen 27B quick set 95%) | Cloud + owner local model | Markup view + relational ops leads; omitted text = unchanged |
| S9 Matte | **Fallback** | Cloud | V1: MediaPipe live mask + EMA; BiRefNet revisited at M5 (512²) |

## Key numbers

| Criterion | Target | Result |
|---|---|---|
| Pan/zoom/drag p95 (S1, owner GPU) | ≤ 8.3 ms | tiled pan 0.49–0.58, zoom 7.13, drag-100 0.85 |
| Time to sharp (S1) | ≤ 250 ms | 40 ms worst |
| Input → screen p95 (S2, owner, ≈100 Hz) | 1 frame + 4 ms (14 ms) | one worker 9.82; split 19.69 |
| Shaping / caret (S3) | correct | 100% match vs HarfBuzz; 393 caret positions round-trip |
| Authoring Wasm (S3) | ≤ 350 KB br | 266.8 KB |
| 50k-node open (S4) | ≤ 1 s | ≈ 0.45 s browser (per-page docs + node cache) |
| 1k-move drag commit (S4) | ≤ 20 KB | 12.8 KB |
| 10k-op merge (S4, restated) | ≤ 200 ms per page, off main | 24–167 ms per page |
| 3 × 1080p layers (S5, owner) | 60 fps | 739 fps |
| Exact seek (S5, owner) | ≤ 60 ms | 19 ms max, 0 wrong in 1,350 |
| A/V drift 10 min (S5, owner) | ≤ 16 ms | 6.4 median, no trend; Bluetooth in sync |
| 60 s export (S5, owner) | ≥ 3× RT | VP9 8.0×, AV1 5.6× |
| Milestone, 5 of 200 pages (S6) | ≤ 1 s | 254 ms OPFS, 230 ms real folder |
| 100 leader kills (S6) | 0 lost commits | 0 of ≈37k lost; real-folder kill -9 intact |
| Agent task success (S8) | ≥ 80% | Sonnet 95–100% all combos; Qwen 27B 95% on markup.rel |
| Concurrent edits clobbered (S8) | 0 | 0 of 521 |
| Matte fps at 720p (S9) | ≥ 5 fps | not reachable with BiRefNet 1024² in a browser |

## What changed in the design

1. **D14 — one CRDT document per page** plus a small document-level doc. Never materialise a whole doc into JS; free
   every Loro handle (leak test); one commit per gesture; each agent session is its own peer; undo over another
   actor's later overwrite is flagged.
2. **D15 — editor and renderer are modules; one or two workers is a boot setting, default one.** Draw on arrival,
   publish deltas before the view frame, the S2 oracle becomes a shared test suite.
3. **Folder storage is a mirror, never on the keystroke path** (S6): a real folder swap costs ≈ 113 ms vs 0.8 ms in
   OPFS. Commits ack from the OPFS journal; the folder is flushed in batches (idle, ≤ 1/s, always on milestone/close).
4. **Agent views**: views read the in-memory mirror, never Loro directly (5–11 ms vs 0.02 ms); text edits use a
   three-way merge anchored at the agent's base; omitted text in a fragment means unchanged; relational ops are part of
   the format (hand arithmetic on rounded view geometry fails "space evenly"); the `gap` meaning is spelled out.
5. **Media clock**: audio is master (headless audio drifted 351 ms vs wall clock in 10 min); video catch-up skips to
   the next keyframe when more than a GOP behind; playback waits for a settled output clock (Bluetooth ≈ 1 s);
   proxies are 540p H.264, 0.5 s GOP, no B-frames; benchmark encoder `latencyMode` per codec at export start.
6. **Render**: tiles are mandatory; tile raster moves to a helper worker/idle (a 512 px tile is ≈ 6.7 ms CPU); Wasm
   SIMD on; warm GPU pipelines during boot and show a cached frame until the GPU path is ready.
7. **Matte (V1)**: MediaPipe live mask with EMA smoothing on the GPU; the baked-matte job swaps models through the model
   registry; licensing table kept (BiRefNet/MODNet/U²-Net/MediaPipe OK; RMBG non-commercial, excluded).

## Surprises worth remembering

- The cloud harness could not present WebGPU to a canvas until ANGLE SwiftShader flags were added (S1 found it).
- CanvasKit's npm build has no WebGPU; plan B for rendering would mean our own Skia build.
- krilla (PDF) is 389–529 KB brotli: load only on export.
- Loro Wasm is 822 KB brotli: load in the background while the shell paints.
- `FileSystemFileHandle.move()` exists (not on `FileSystemHandle`); without a Web Lock 16 of 16 racing writers "won".
- H.264 encode works in this Chromium; AAC encode does not.
- Integer-rounded agent views make models do slightly wrong arithmetic; relational ops fix it.

## Still open

| Item | Owner | Blocks |
|---|---|---|
| Reference iGPU laptop runs (S1, S2, S5) | owner / later | M1 budgets confirmation, not M1 start |
| Split-worker tick fix and re-measure (D15) | M1 | switching the default only |
| S8 full 140-prompt run on a second model family (Qwen) and a cloud non-Claude model | owner | M2 format lock (IF-6.16) |
| S3 IME candidate placement (JA/ZH/KO) in real Chrome | owner | M1 text input sign-off |
| S7 SVG parity metric or per-feature rasterize list | M1 | export criteria |
| Hugging Face license pages and training-data terms for matte weights | owner/legal | shipping any baked-matte model |
| Cold first frame ≈ 1 s (S1) | M1 | "first sharp frame" budget |
