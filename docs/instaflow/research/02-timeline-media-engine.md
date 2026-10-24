# Instaflow research 02: Timeline and media engine

Status: research input, not a decision record. Compiled 2026-10-24.
Scope: video, audio, timeline editing, programmatic compositions, preview playback, export, segmentation, and the StaticFlux
primitives these need. Runs entirely in the browser (web, PWA, mobile web), with no server.

Method: npm versions and licenses were checked against `registry.npmjs.org` on 2026-10-24. Browser support comes from MDN,
caniuse, WebKit, Chrome and web.dev pages found through web search. caniuse.com and mediabunny.dev could not be fetched
directly from this environment, so claims about them come from search snippets and mirrors. **UNVERIFIED** marks claims I
could not confirm from a primary source. Validate every support claim with runtime feature detection on real devices
before relying on it. Sources are listed in section 9.

---

## 0. Findings that shape the design

| Topic | Finding (late 2026) | Consequence for Instaflow |
|---|---|---|
| WebCodecs | Chrome/Edge 94+ and Firefox desktop 130+ support it. Safari 16.4–18.x was **partial (video only)**. **Safari 26 (macOS + iOS) is listed as full support, including AudioEncoder/AudioDecoder.** Firefox for Android: **not supported** (caniuse snapshot at 150). | WebCodecs is the decode/encode backbone. Minimum full-feature target: **iOS/macOS Safari 26**. On iOS 16.4–18 and Firefox Android, run a degraded mode (section 3). |
| Codecs | H.264 decode and encode works everywhere WebCodecs exists. MDN advises against HEVC as a general-purpose encode target: encode works only on Apple platforms plus hardware-dependent Chrome on Windows, macOS and Android. AV1 encode is strong on desktop but limited on Safari and Android. | Default export: **H.264 + AAC in MP4**. WebM (VP9/AV1 + Opus) is a second option. Pick the codec with `isConfigSupported` probes, never with UA sniffing. |
| Container I/O | **Mediabunny 1.62.1 (MPL-2.0, released 2026-10-22)** is a zero-dependency TypeScript demuxer and muxer for MP4/MOV/WebM/MKV and more. It is built on WebCodecs. Its author's earlier libraries **mp4-muxer and webm-muxer are superseded by it** (the mp4-muxer migration guide calls itself obsolete). **Remotion's own web renderer encodes through Mediabunny.** | **Buy Mediabunny** for demux, mux and conversion. MPL-2.0 is file-level copyleft: we can use it unmodified in closed source, but modified Mediabunny files must be published. |
| ffmpeg.wasm | `@ffmpeg/ffmpeg` 0.12.15, with no release since 2025-01. The core is ~25–31 MB. The multithreaded core needs SharedArrayBuffer and cross-origin isolation. It is "significantly slower than native". `@ffmpeg/core` is published as **GPL-2.0-or-later**. | Use it only as an **on-demand escape hatch** (exotic import formats such as legacy codecs or odd containers). Never put it in the play or export path. Do not ship the GPL build: build an LGPL core ourselves or avoid it. |
| Remotion | Frames are a pure function of frame number (`useCurrentFrame()`). Frames render "independently and out of order". `@remotion/web-renderer` (`renderMediaOnWeb`, **experimental**, v4.0.538) renders in the browser through WebCodecs and Mediabunny, supports "a subset of tags and CSS properties", and needs Chrome 94+, Firefox 130+ or Safari 26+. The license is source-available and **paid for companies of 4 or more people**; embedding the Player or building an editor falls under the "Automators" tier ($0.01 per render, $100/month minimum). | **Copy the model, not the code.** Use a `(document, time) → frame` pure function, out-of-order rendering, and an explicit "asset readiness" barrier (their `delayRender`). The owner said "not Remotion", and the license fits a product poorly anyway. |
| Other OSS engines | Diffusion Studio core 4.0.3: npm says MPL-2.0, but the README requires a **"Made with Diffusion Studio" watermark unless you buy a key**. Etro 0.14.1: **GPL-3.0**. Twick 0.15.x: **"Sustainable Use License"** (source-available). Revideo 0.11.0 (MIT, 2026-07) is an active Motion Canvas fork. Motion Canvas 3.17.2 (MIT) has had no release since 2024-12. | None of these fits as the core: each has a licensing problem or the wrong shape (generator-scripted animation, not a document timeline). Mine them for ideas only (section 2). |
| GPU | **WebGPU ships in Safari 26 on macOS, iOS, iPadOS and visionOS**, and WebKit says WebGPU "supersedes WebGL" there. Chrome has it. Firefox has it on Windows since 141 and on Apple-silicon macOS since 145; Linux and Android are still in progress. `importExternalTexture` with a `VideoFrame` source exists in Chrome 116+. Safari support for that path is **UNVERIFIED**. | The compositor needs a **WebGPU primary backend and a WebGL2 fallback**, both behind one `RenderEngine`. Feature-detect WebGPU **inside the worker** (OffscreenCanvas context support has differed per context in Safari before). |
| Segmentation | MediaPipe `@mediapipe/tasks-vision` 1.1.1 (Apache-2.0, 2026-10-14) offers a selfie and multiclass segmenter with a GPU delegate. There is a **reported bug: scrambled classes with the GPU delegate on iOS Safari**. Bria **RMBG-2.0 is CC BY-NC 4.0 (non-commercial)**. BiRefNet is MIT (per a secondary source). ONNX Runtime Web 1.30.0 (MIT) and Transformers.js 4.3.1 (Apache-2.0) run models on WebGPU. | Use **two tiers**: a real-time low-resolution preview mask (MediaPipe) and a **pre-baked high-quality matte** (BiRefNet-class model through ORT Web), stored as an asset. Export always uses the baked matte. **Do not ship RMBG-2.0 weights.** |
| Mobile Safari memory | iOS has a historical **total canvas memory cap (224 MB reported)**. The GPU process is shared across tabs, and OOM kills the GPU process (WebKit bugs 256366, 229825). A per-device hardware decoder limit exists (32 on iPhone 6 per a 2019 bug; **UNVERIFIED** today). | Hard **byte budgets** for decoded frames, textures and canvases, plus explicit `VideoFrame.close()` discipline. Use proxy media on mobile, and limit concurrent decoders per device class. |
| Industry | CapCut web: a C++ engine compiled with Emscripten, Wasm SIMD (~3x), WebCodecs hardware decode (can run "several 4K videos at once"), installable as a PWA. Clipchamp: ffmpeg-in-Wasm for demux and filters, with WebCodecs stubs for encode. **Canva job posts (2026)** describe moving off a CSS/JS rendering stack to a "native video rendering engine" built with WebGL/WebGPU/Wasm/workers ("Timeline 2.0"). | The industry has converged on **WebCodecs + GPU compositor + workers (+ Wasm for DSP)**. DOM/CSS-rendered video (Remotion-style) is what Canva is moving away from. |

---

## 1. Recommended engine architecture

### 1.1 Principles

1. **One evaluator, two clocks.** Preview and export call the same pure function
   `evaluate(snapshot, t) → RenderGraph`. Only the clock (audio-master vs frame counter) and the readiness policy differ.
   Preview may drop frames; export waits.
2. **Time is rational, never float frames.** Use integer **ticks** at 1/705,600,000 s ("flicks": evenly divisible by
   24/25/30/48/50/60/90/120 fps and 8–192 kHz sample rates). Store ticks as f64-safe integers, which is exact for about 148 days.
   Convert to frames or samples only at the edges. This avoids 29.97 drift and keeps cuts sample-exact.
3. **The document is the source of truth. The engine holds only caches.** Everything in the playback and decoder workers
   can be rebuilt from the document plus the asset store. This matches StaticFlux's "surfaces are projections" (R11.20) and
   respawn rule (R11.11).
4. **Compositing is GPU-only, and media bytes never touch the main thread.** The main thread holds the DOM timeline UI,
   input, the `AudioContext` (which must live on the main thread or an AudioWorklet global), and HTML-in-Canvas text editing.
5. **Everything is cancellable.** Every seek or scrub request carries an `AbortSignal`. Stale requests map to
   `VideoDecoder.reset()`, never `flush()`. Per MDN and the spec, `flush()` forces the next chunk to be a keyframe, and it
   should not be used to force progress.
6. **Hard byte budgets** for decoded frames, GPU textures and PCM, enforced by the engine and reported as metrics. Mobile
   Safari kills the tab otherwise.

### 1.2 Threads

```
 Main thread (UI)                         Document worker (exists: ECS + Yjs)
 ─────────────────                        ───────────────────────────────────
 Lit timeline UI, inspector, transport    timeline entities: tracks/clips/transitions/
 input forwarder → intents  ────────────► keyframe channels/pages; undo; CRDT
 AudioContext + AudioWorkletNode          publishes replica (patches per frame)
 HTML-in-Canvas text editing overlay            │ replica (control channel)
        ▲  playhead/frame metrics               ▼
        │                          ┌──────────────────────────────────────────┐
        │  (control)               │ Composition / playback worker            │
        └──────────────────────────│  • timeline evaluator (pure)             │
                                   │  • render graph → WebGPU|WebGL2           │
   OffscreenCanvas (transferred) ─►│  • texture cache, effect/transition shaders│
                                   │  • media clock follower (reads audio SAB) │
                                   │  • frame scheduler (rAF in worker)        │
                                   └───────▲──────────────────┬───────────────┘
                     VideoFrame handles     │ (transfer)       │ decode requests (t, asset, priority, signal)
                                   ┌────────┴──────────────────▼───────────────┐
                                   │ Media worker(s) = decoder pool             │
                                   │  • Mediabunny demux (OPFS-backed sources)  │
                                   │  • VideoDecoder sessions (LRU, capped)     │
                                   │  • AudioDecoder → PCM cache                │
                                   │  • audio pre-mixer (timeline audio eval)   │──► SAB ring (PCM) ─► AudioWorklet
                                   └────────────────────────────────────────────┘    (mixer tail, master gain, meters,
                                                                                       writes consumed-sample counter)
 Export worker (on demand): same evaluator + renderer on its own OffscreenCanvas, its own decoder sessions in
 "exact" mode, VideoEncoder/AudioEncoder → Mediabunny Output → OPFS file / File System Access / download.
 ML worker (on demand): ORT Web / MediaPipe for baked mattes, transcription, beat detection; writes assets.
```

Thread count by device class:
- **Desktop:** UI, document, composition, 2 media workers, export (on demand), ML (on demand).
- **Mobile:** UI, document, composition, **1** media worker. On mobile, export reuses the composition worker while preview is
  paused (memory).

Option considered: decode inside the composition worker, which saves one hop. A `VideoFrame` transfer is a cheap handle
move, not a pixel copy, so separate workers keep demux and decode stalls (parsing large moov atoms, OPFS reads) off the render
loop. Keep both behind the `DecoderPool` contract so a device class can co-locate them.

### 1.3 Per-frame data flow (preview)

1. **Clock read.** The composition worker's frame callback reads `audioPos` (samples consumed by the worklet, from a
   shared Int32/Float64 header) and the latency estimate. It computes the presentation time
   `t = ticks(audioPos / sampleRate) + outputLatency + displayLead`. It snaps `t` to the project frame grid.
2. **Evaluate.** `evaluate(snapshot, t)` returns a `RenderGraph`: an ordered list of layer nodes, each with its source ref
   `(assetId, mediaTime)`, transform matrix, crop, opacity, blend, effect stack, matte ref, and transition nodes
   `(a, b, kind, progress)`. This step is pure and does no I/O. It is memoized per `(snapshot.version, frameIndex)`.
3. **Resolve sources.** For each source ref, ask the texture cache, then the decoder pool:
   `pool.frame(assetId, mediaTime, { mode: 'nearest' | 'exact', deadline, signal })`. Preview uses `nearest` with a deadline
   and accepts the previous frame if the exact one is late. This counts as a dropped or late frame metric, never a stall.
4. **Prefetch.** The evaluator also yields `lookahead(t, t + 2s)`: clips starting soon, so decoders pre-roll from the
   previous keyframe before the cut.
5. **Render.** The renderer runs passes: video `VideoFrame → importExternalTexture` (WebGPU) or `texImage2D(VideoFrame)`
   (WebGL2), effects, transitions, text atlas, and present. Close each `VideoFrame` after import (WebGPU external textures
   are valid only for the current task) or keep a GPU copy in the texture cache.
6. **Report.** `surface/frame-time`, dropped frames, **A/V drift** (presented `t` vs audio `t`), and decode latency go to
   `SurfaceMetrics` and the new media metrics.

Audio flows separately and ahead of the playhead. The media worker evaluates the audio part of the timeline in 10–20 ms
blocks, 100–250 ms ahead. For each block it reads clip PCM at the correct media time with speed and time-stretch, applies
gain envelopes, fades and crossfades, pans, and sums into stems. It writes the result into an SPSC ring (`SharedArrayBuffer`
when isolated, using the existing `frame-channel` ring format). The AudioWorklet `process()` only pulls, applies master gain
and a limiter, meters, and advances the shared sample counter. When not isolated, PCM blocks travel by `MessagePort` transfer
to the worklet with a larger lookahead (this is the frame channel's `transfer` mode).

### 1.4 Clock and sync model: audio-master

- **Master clock = samples actually consumed by the AudioWorklet.** This clock cannot drift from what the user hears. Map it
  to wall time with `AudioContext.getOutputTimestamp()` (`contextTime` ↔ `performanceTime`) and `outputLatency`
  (web.dev "Synchronize audio and video playback"). Bluetooth outputs can add 100–300 ms. Compensate by presenting video
  late by `outputLatency`. The latency must not be ignored.
- **Video follows audio.** Each display frame picks the frame for the audio time predicted at its display moment. When video is
  late, drop frames. If decode cannot keep up for more than N frames, the clock goes to `stalled` (audio pauses and the UI
  shows buffering). Audio never time-stretches to wait for video.
- **No audible audio** (muted project, or `AudioContext` suspended before the user gesture that iOS requires): fall back to a
  `performance.now()` clock with the same API. The `MediaClock` contract hides which source is active.
- **Scrub:** the clock is `scrubbing`. `t` comes from the pointer, audio plays short scrub grains (optional), and the decoder
  pool uses "coarse first, then exact" (section 1.6).
- **Export:** the clock is a frame counter `t_n = n · frameDuration`. Audio is rendered by the **same mixer code** run offline,
  so preview and export mix identically. `OfflineAudioContext` is the alternative if we adopt native Web Audio nodes for
  effects. Prefer our own DSP (JS or Wasm) to guarantee parity and determinism across browsers.

### 1.5 Compositions as pure functions of (document, time)

```ts
// Deterministic contract (shared by preview, export, thumbnails, agents)
type Ticks = number & { readonly __ticks: unique symbol };
interface EvalContext { readonly snapshot: TimelineSnapshot; readonly fps: Rational; readonly seed: number }
function evaluate(ctx: EvalContext, t: Ticks): RenderGraph;            // pure, no I/O, no Date/Math.random
function requiredMedia(ctx: EvalContext, range: TickRange): MediaNeed[]; // for prefetch & export readiness
```

Rules, borrowed from Remotion's rules and made enforceable:
- **No ambient time or randomness.** Randomness comes from `seed` and the element id (a hash-based PRNG). "Wiggle" and
  particle effects stay reproducible.
- **Out-of-order safe.** Frame 50 may be rendered before frame 10 (parallel export, thumbnails, agent previews). No effect
  may keep state across frames. Effects that need history (motion blur, echo, temporal matte smoothing) request explicit
  extra samples `t − k·dt`, and the evaluator turns that into extra source refs.
- **Readiness barrier.** In export, the renderer waits until every `MediaNeed` for the frame is resolved: exact video frame,
  font loaded, matte decoded, image decoded. Preview renders with whatever is ready and marks the frame `approximate`.
- **Bundled fonts only.** Text layout must not depend on system fonts, or export differs per device. Fonts are assets.
- **Golden tests.** The `testkit` renders frame hashes with a software path (WebGL2 via headless or a CPU reference) for a
  corpus of documents. GPU output is not bit-exact across vendors, so compare perceptually (SSIM ≥ threshold), and compare
  the `RenderGraph` exactly.

This gives agents a first-class API: an agent can ask for `evaluate(snapshot, t)` as JSON (what is on screen at 3.2 s) or a
thumbnail at any `t`, without playing anything.

### 1.6 Decoding, seeking, decoder pool, proxies

- **Index on import.** Mediabunny demux gives the sample table: packet timestamps and keyframe flags. Persist a compact index
  (keyframe ticks, GOP sizes) next to the asset so seeks never re-parse.
- **Session = (asset, track, rendition).** A session holds one `VideoDecoder`, a demux cursor, and a small output queue (2–8
  frames). Close frames promptly: hardware decoders own a bounded frame pool, and un-closed `VideoFrame`s stall output or
  exhaust GPU memory.
- **Pool policy.**
  - Cap concurrent sessions per device class (mobile 2–4, desktop 6–8; tune by measurement, since the iOS limit is
    UNVERIFIED).
  - LRU eviction, with priority `playing > prerolling > scrub > thumbnail`.
  - A session that is reused for a forward-moving playhead never seeks.
  - Mediabunny's `VideoSampleSink.getSample(t)` and `samplesAtTimestamps()` (decodes each packet at most once for sorted
    timestamps) cover the simple cases. Our pool wraps them, or calls WebCodecs directly when we need `reset()` cancellation
    and session reuse.
- **Seek algorithm.**
  1. Find the keyframe ≤ target from the index.
  2. If the session cursor lies between that keyframe and the target, continue decoding. Otherwise `reset()`, configure,
     and feed from the keyframe.
  3. Discard output until the timestamp is ≥ the target.
  4. Cost is O(GOP), so proxies with short GOPs matter.
- **Scrub:** first show the nearest cached frame or a thumbnail-strip frame (instant), then the exact frame. Coalesce pointer
  moves to one request in flight per session, and abort superseded requests.
- **Reverse playback and fast speed ramps:** decode a GOP forward into a frame cache, then present it backward. Use
  all-intra proxies for heavy reverse use.
- **Proxy and preview media** (background job after import, cancellable, resumable):
  - Mobile or large sources (4K, HEVC 10-bit, high bitrate): a **proxy at 540p or 720p H.264 with a keyframe every 0.5 s**
    via WebCodecs + Mediabunny, saved to OPFS.
  - **Thumbnail strips** (sprite sheets at a fixed interval per zoom tier) and **waveform peaks** (min/max per 256/1024/4096
    samples, multi-resolution).
  - Preview uses the proxy when one exists. Export uses originals by default, with a "fast export from proxies" option on
    low-memory devices.
- **Codec fallbacks.** If `VideoDecoder.isConfigSupported` fails (for example HEVC on Firefox Linux, or ProRes anywhere), offer
  a one-time **transcode on import** through ffmpeg.wasm (lazy, isolated, LGPL build) into an H.264 intermediate. Otherwise
  the clip shows an "unsupported" placeholder with a fix.

### 1.7 Caching layers (all byte-budgeted, all observable)

| Cache | Lives in | Key | Budget (mobile / desktop, starting point) | Eviction |
|---|---|---|---|---|
| Evaluated `RenderGraph` | composition worker | (snapshot version, frame) | 120 entries | LRU, cleared on patch for affected range |
| GPU textures of decoded frames | composition worker | (asset, rendition, mediaTime) | 96 MB / 512 MB | LRU, priority to frames around the playhead |
| Decoder output queues | media worker | session | 4 / 8 frames per session | close on consume |
| Effect intermediate textures | composition worker | pass id | pooled per resolution | pool reuse |
| Text and glyph atlases | composition worker | (font, size bucket) | 16 MB / 64 MB | LRU by font |
| PCM cache (decoded audio) | media worker | (asset, range) | 32 MB / 256 MB; Int16 at rest, float at mix | LRU by range; re-decode on miss |
| Thumbnails, peaks, mattes, proxies | **OPFS asset store** | content hash + derivation | quota-managed | user-visible "storage" panel |

### 1.8 Timeline evaluation: tracks, transitions, keyframes, animations

**Model** (OTIO-shaped, so we can import and export `.otio`; `opentimelineio` on npm is 0.1.0 and Apache-2.0, a young project):
- `Project → Pages[]`. Each page is a `Stack` of `Track`s (video, overlay, text, audio, adjustment). Tracks hold `Clip | Gap |
  Transition`. A clip refers to a `MediaRef` (`assetId`, `availableRange`) with `sourceRange` (in and out points).
- **Pages:** the project timeline is a top-level sequence of pages, each with its own stack. **Page transitions** reuse the
  `Transition` item at the top-level sequence. Canva's "page-based video" and CapCut's "single timeline" are two views of
  one model.
- **Ordering** uses `keyBetween` fractional keys (exists in `@staticflux/document`). The overlap in a transition comes from
  `inOffset` and `outOffset` (OTIO semantics), so ripple and trim math stays local.
- **Edits are intents** in the document worker: `trim`, `split`, `ripple-delete`, `roll`, `slip`, `slide`, `set-speed`,
  `add-transition`, `insert`, `overwrite`, `link/unlink A/V`, `group`, and magnetic snapping. Each is one `transact()` so undo
  is atomic and CRDT-safe. Ripple across tracks needs a defined policy (sync-locked tracks), because concurrent ripples from
  two users can interleave. Resolve this with the "ripple as a set of explicit moves" approach: the intent computes concrete
  new starts.

**Time mapping per clip:** `mediaTime = sourceIn + R(t − clipStart)`, where `R` is either linear (`speed`) or a **time-remap
curve** (a monotone keyframe channel for speed ramps or freeze frames). Audio follows the same `R`, with pitch-preserving
time-stretch (Signalsmith Stretch, MIT) when "preserve pitch" is on.

**Keyframes:** any animatable property (position, scale, rotation, anchor, opacity, crop rect, volume, pan, effect params)
is a `Channel<T> = { keys: [{ t: Ticks, v: T, ease: CubicBezier | 'hold' | Spring }] }`. Evaluation:
1. Binary-search the channel.
2. Ease with a cubic-bezier solve. Springs are pre-sampled to a deterministic table, never integrated per frame.
3. Interpolate per type: lerp; slerp or shortest-path for rotation; per-component for rect and color in linear light.

Keyframe times are **clip-relative**, so moving a clip moves its animation, and trimming offers "keep" vs "stretch". A
missing channel means a static value. **Expressions are out of scope for MVP**; agents write keyframes.

**Transitions** are nodes with `progress p ∈ [0,1]` over the overlap. Built-ins: cross-dissolve, dip to color, push, slide,
wipe, zoom, blur, and luma-matte wipes (a texture asset). Each is a WGSL/GLSL shader with declared params. **Audio
crossfades** are the same item applied to linked audio (equal-power curve by default).

**Text animations** are **pure functions of (t, glyphIndex, wordIndex, lineIndex, seed)** applied after shaping:
typewriter, rise, pop, wave, karaoke highlight (word timing from captions). They compile to per-glyph transforms and opacity
evaluated on the GPU (instanced quads from the glyph atlas). Presets live in the document as `{ preset, params, in, out }`,
not as baked keyframes, so they stay editable.

**Motion graphics / moving graphics:** vector shapes (paths with stroke and fill animation, trim paths), Lottie import
(evaluate with a deterministic player at `t`, either one rendering into a texture per frame or one converted into our shape
layers), and image sequences.

**Zoom/pan (Ken Burns, zoom-to-region):** a preset that writes two or three keyframes on the clip's `transform` and `crop`
channels. "Zoom to region" picks a rectangle on the canvas and generates keyframes with ease-in-out. Nothing special is needed
in the engine.

**Picture-in-picture "reaction" cutout:** a clip with `matte: { source: 'baked' | 'live', assetId?, feather, choke, smooth }`
plus a mask shape (circle, rounded rectangle) and a drop shadow or outline effect. Section 1.9 covers the matte.

**Generative additions** ("extend this clip", "generate b-roll", "remove object"): agent/advisor actions that **produce new
assets** (with provenance metadata: model, prompt, seed, source range) and insert them as ordinary clips. They never run in the
evaluation path. They stay additive: if the model is unavailable, the document still renders.

### 1.9 Segmentation and mattes

| Tier | Model / runtime | Use | Notes |
|---|---|---|---|
| Live preview mask | MediaPipe Image Segmenter (selfie or multiclass, ~256×256 input) via `@mediapipe/tasks-vision` (Apache-2.0); GPU delegate on desktop, CPU delegate on iOS until the GPU bug is fixed | Immediate feedback when the user toggles "remove background"; webcam reaction recording | Vendor claims 1–3 ms per frame on WebGPU and 5–10 ms on Wasm CPU (M2/i7), **UNVERIFIED**. The mask stays a GPU texture. Low resolution gives soft edges. |
| Baked matte (default for export) | BiRefNet-class or MODNet-class model in ONNX via ONNX Runtime Web 1.30 (WebGPU EP, Wasm fallback) or Transformers.js 4.x | Background job after the user confirms; per frame at proxy resolution, refined at export resolution if time allows | Verify the **license of each weight file** (BiRefNet MIT per a secondary source; RMBG-1.4 and RMBG-2.0 are Bria non-commercial / commercial licensed: **avoid**). Expect far below real time on phones; show progress, and make it resumable per frame range. |
| Temporal stabilization | Our shader: EMA or bilateral in time on the mask, plus optional guided-filter edge refinement against the color frame | Removes flicker | Deterministic because the baked matte is data. |

Store baked mattes as a **luma-mask video** (a separate H.264 track at mask resolution, which decodes everywhere) rather than
VP9-alpha WebM (alpha decode support is uneven; Safari support **UNVERIFIED**). The asset is content-addressed by
`(sourceHash, model, version, params)`. Export never runs live ML (determinism, plus GPU ML is not bit-reproducible across
devices).

### 1.10 Text rendering in video

- **Shaping:** `harfbuzzjs` (MIT, 1.6.4) in the composition worker, with font files from the asset store. This gives
  deterministic layout, complex scripts and per-glyph positions for animation. Line breaking and bidi need our own layer or
  ICU4X-wasm (cost to evaluate).
- **Rasterization:** glyph atlas rendered with Canvas2D on an OffscreenCanvas (`fillText` of single glyphs with the bundled
  `FontFace`) or as MSDF for large, scaling text. Static, non-animated text blocks can be drawn to a texture once per change.
- **Editing:** inline text editing on the canvas uses the DOM. Use the HTML-in-Canvas adapter where available (Chromium origin
  trial, extended; APIs renamed in Chrome 155) and fall back to positioned DOM overlays (already in `@staticflux/surface`).
  The **video render never depends on HTML-in-Canvas**, because it is not in Safari or Firefox.
- **Captions** are a text track with word timing (from an ML transcription job, e.g. Whisper via Transformers.js), rendered
  by the same text pipeline. Export burns them in or muxes them as a subtitle track (Mediabunny supports subtitle tracks in
  some containers; per-container **UNVERIFIED**).

### 1.11 Export pipeline

```
export worker: for n in 0..N (bounded concurrency, out-of-order allowed, in-order submit):
  graph = evaluate(snapshot, t_n) → await readiness(graph) (exact frames, fonts, mattes)
  render → OffscreenCanvas → new VideoFrame(canvas, { timestamp }) → VideoEncoder.encode (keyframe every 2 s)
audio: offline mixer (same DSP as worklet) → AudioData blocks → AudioEncoder (AAC; Opus for WebM)
Mediabunny Output(Mp4OutputFormat{ fastStart }) ← encoded chunks → StreamTarget → OPFS file (chunked) → save/share
```
- **Backpressure:** watch `encodeQueueSize`, and keep at most about 3 frames in flight on mobile.
- **Write to OPFS** in fragments (fragmented MP4, or `fastStart: 'reserve'` style), not to memory. A 1080p 60 s export is
  ~60–120 MB.
- **Save:** File System Access (`showSaveFilePicker`) on Chromium; on iOS, the Web Share API with files, or a download from
  a blob URL.
- **Formats:**
  - MP4 (H.264/AAC) everywhere.
  - WebM (VP9/AV1 + Opus) where encodable.
  - **GIF** via `gifenc` (MIT, ~5–9 KB, fast PnnQuant palette, no dithering), with palette per segment and frame-diff
    cropping. Or encode GIF in Wasm (gifski is AGPL: avoid).
  - **Image sequence** as PNG/WebP via `OffscreenCanvas.convertToBlob`, zipped streaming to OPFS.
  - **Audio-only** as AAC/MP3/FLAC (Mediabunny extensions `@mediabunny/aac-encoder|mp3-encoder|flac-encoder`, MPL-2.0;
    they wrap libavcodec/LAME/libFLAC, so check the LGPL obligations of the shipped Wasm).
- **Fallback encoder:** when `AudioEncoder` lacks AAC (iOS < 26, some Firefox platforms, **UNVERIFIED**), use
  `@mediabunny/aac-encoder` (Wasm). When `VideoEncoder` is missing, export is unavailable, with a clear reason and fix
  (update iOS). Software H.264 in Wasm is too slow on phones and has patent and licensing issues.
- **Export must survive** backgrounding as far as the platform allows. iOS suspends background tabs, so keep the user in the app
  with a progress screen and a Wake Lock (`navigator.wakeLock`). Checkpoint by GOP so an interrupted export can resume.

---

## 2. Build vs buy

| Component | Decision | Choice and license | Rationale and alternatives rejected |
|---|---|---|---|
| Demux / mux / conversion | **Buy** | **Mediabunny 1.62** (MPL-2.0); extensions for AAC/MP3/FLAC/AC-3 encoders (MPL-2.0 wrappers over L/GPL codecs: audit) | Actively maintained (release 2026-10-22), zero dependencies, used by Remotion's web renderer. mp4box.js 2.4.1 (BSD-3) is a good **demux-only** fallback and inspector. mp4-muxer and webm-muxer are deprecated in favour of Mediabunny. |
| Decode / encode | **Platform** | WebCodecs | Hardware accelerated. ffmpeg.wasm only for import transcoding of unsupported codecs (build LGPL `@ffmpeg/core` ourselves; the published core is GPL-2.0+). |
| Decoder pool, seek, prefetch, proxies | **Build** | `@staticflux/media` (new) | The core of perceived performance; no library does pool policy, budgets and cancellation the StaticFlux way. |
| Timeline model and edit ops | **Build** | Instaflow `timeline` feature on `@staticflux/document` ECS + CRDT | Must be CRDT-native and agent-addressable. OTIO for interchange (`opentimelineio` npm 0.1.0 Apache-2.0 is immature; write our own mapper). |
| Evaluator, keyframes, easing, time | **Build** | `@staticflux/motion` (new, framework-generic) | Small and pure; must be deterministic and shared by preview, export and agents. Reference: Remotion `interpolate`/`spring` semantics, Motion Canvas tweens, OTIO opentime. |
| GPU compositor | **Build** on raw WebGPU + WebGL2 | Optional: PixiJS 8.22 (MIT) as the WebGL2/WebGPU abstraction | Raw gives full control of external textures, color management (Rec.709 vs sRGB, 10-bit), and the frame budget. PixiJS is a viable shortcut for MVP 2D layers, but adds ~100+ KB and its own scene graph, which duplicates our render graph. Recommendation: **build a thin compositor** (~3–5k LOC) behind `RenderEngine`. |
| Text shaping | **Buy** | harfbuzzjs (MIT) | Native-quality shaping. Alternative: troika-three-text (MIT, Three.js-bound), not a fit. |
| Audio graph / mixer | **Build** (JS first, Wasm later) on AudioWorklet | ringbuf.js (MPL-2.0) as a reference; our own `frame-channel` ring already exists | Mixer parity between preview and export requires our own DSP. |
| Time-stretch / pitch | **Buy** | Signalsmith Stretch (MIT, JS/Wasm) | Rubber Band is GPL; SoundTouch is LGPL (`@soundtouchjs/audio-worklet` is MPL-2.0, but its core is SoundTouch: check). |
| Waveforms | **Build** (peaks in media worker, draw in timeline canvas) | wavesurfer.js 8 (BSD-3) only as a reference | Need multi-resolution peaks from our PCM cache, drawn in our virtualized timeline. |
| Segmentation | **Buy runtimes, choose weights carefully** | MediaPipe tasks-vision (Apache-2.0); ONNX Runtime Web 1.30 (MIT); Transformers.js 4.3 (Apache-2.0) | Avoid RMBG-1.4/2.0 (Bria licensing). Verify BiRefNet and MODNet weight licenses before shipping. |
| GIF | **Buy** | gifenc (MIT) | gif.js is older; gifski is AGPL. |
| Programmatic compositions | **Build** | Our evaluator + a TS/JSON "composition" schema that agents emit | Remotion: source-available, paid for teams of 4+, React/DOM rendering. Revideo (MIT) and Motion Canvas (MIT) are generator/scene-graph, imperative-in-time, and not CRDT documents. Diffusion Studio: watermark unless licensed. Etro: GPL-3.0. Twick: Sustainable Use License. **Read their code for ideas, take no dependency.** |
| Lottie | **Buy** (later) | lottie-web (MIT) rendering to canvas at `t`, or a Wasm player (e.g. ThorVG, MIT; **UNVERIFIED** web build maturity) | Deterministic `goToAndStop(frame)`. |
| Captions / transcription | **Buy model** | Whisper-family via Transformers.js (WebGPU) | Background job; output is a document text track. |

What to learn from each system:
- **Remotion:** frame-as-pure-function; out-of-order rendering; `calculateMetadata` (durations and dimensions from assets
  before render); Editor Starter separates undoable state (tracks, items, assets, fps, size) from transient UI state.
- **Motion Canvas / Revideo:** tween and easing vocabulary; signals for derived values; Revideo turning rendering into a
  headless function call.
- **Diffusion Studio:** WebCodecs-native layering and its API shape for clips and tracks.
- **Etro:** a layer + effect (GLSL) stack.
- **Twick:** separate timeline, canvas and media-utils packages.
- **OTIO:** `Stack/Track/Clip/Gap/Transition`, `in_offset/out_offset`, `available_range` vs `source_range`.
- **CapCut:** native C++ engine compiled to Wasm SIMD (a later option for our compositor and mixer).
- **Clipchamp:** WebCodecs encoder "preflight" to obtain codec extradata (Mediabunny now handles this).
- **Canva:** moving from CSS/JS rendering to a GPU engine, which validates our choice.

---

## 3. Browser support matrix (late 2026, verify at runtime)

| Capability | Chrome/Edge desktop | Chrome Android | Firefox desktop | Firefox Android | Safari macOS 26 | Safari iOS/iPadOS 26 | Safari iOS 16.4–18 |
|---|---|---|---|---|---|---|---|
| WebCodecs video decode/encode | ✅ 94+ | ✅ | ✅ 130+ | ❌ | ✅ | ✅ | ⚠️ video only |
| WebCodecs audio (AudioDecoder/Encoder) | ✅ | ✅ | ✅ (AAC encode **UNVERIFIED**) | ❌ | ✅ (26) | ✅ (26) | ❌ |
| H.264 encode | ✅ | ✅ | ✅ (platform codecs; Linux **UNVERIFIED**) | ❌ | ✅ | ✅ | ✅ |
| HEVC decode / encode | hw-dependent / Win, macOS, Android hw only | hw | decode 136+ / ❌ | ❌ | ✅ / ✅ | ✅ / ✅ | ✅ / partial |
| AV1 decode / encode | ✅ / ✅ | ✅ / limited | ✅ / ✅ | ❌ | hw-dependent / limited | hw-dependent (newer devices) / limited | hw-dependent / ❌ |
| WebGPU | ✅ | ✅ (Android 12+ class devices; **UNVERIFIED** coverage) | Win 141+, Apple-silicon macOS 145+; Linux in progress | ❌ in progress | ✅ 26 | ✅ 26 | ❌ |
| WebGPU in worker (OffscreenCanvas) | ✅ | ✅ | ✅ where WebGPU exists (**UNVERIFIED**) | ❌ | **UNVERIFIED**: detect in worker | **UNVERIFIED** | ❌ |
| `importExternalTexture(VideoFrame)` | ✅ 116+ | ✅ | **UNVERIFIED** | ❌ | **UNVERIFIED** | **UNVERIFIED** | ❌ |
| WebGL2 in worker (OffscreenCanvas) | ✅ | ✅ | ✅ | ✅ | ✅ (17+) | ✅ (17+) | ⚠️ 16.4–16.6 no WebGL in worker |
| AudioWorklet | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SharedArrayBuffer (needs COOP/COEP) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 15.2+ |
| OPFS (+ sync access handles in workers) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (16.4+, **UNVERIFIED** for sync handles) |
| File System Access save picker | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| HTML-in-Canvas | origin trial | origin trial | ❌ | ❌ | ❌ | ❌ | ❌ |

**Tiers and fallbacks:**
- **Tier A (full):** Chromium desktop and Android, Safari 26 on macOS and iOS. WebGPU compositor, WebCodecs everything,
  AudioWorklet with SAB ring when isolated.
- **Tier B (no WebGPU):** Firefox Linux and Android, older Safari. WebGL2 compositor (same render graph, GLSL shader variants).
  Still needs WebCodecs for editing, so **Firefox Android is "view and light edit" only**: playback through `<video>` elements
  drawn to WebGL2 with a wall clock (no frame accuracy), and **no export**. Show an "Open in Chrome" fix (gate as UX with a
  reason, rule 9).
- **Tier C (iOS 16.4–18):** video WebCodecs but no audio codecs. Decode audio with `decodeAudioData` (Web Audio) into the PCM
  cache, encode AAC through `@mediabunny/aac-encoder` (Wasm). WebGL2 only. Proxies are mandatory, and the 1080p export cap is
  reduced to 720p.
- **Not isolated** (embedded hosts, or `isolation: 'preferred'` without headers): the frame channel switches to `transfer`
  mode automatically (R11.16a). AudioWorklet receives PCM by `MessagePort` with ~250 ms lookahead. No multithreaded Wasm
  (ffmpeg.wasm single-thread only).
- **iOS specifics:**
  - `AudioContext` must be resumed in a user gesture.
  - The silent switch can mute Web Audio unless `navigator.audioSession.type = 'playback'` (Safari 16.4+ Audio Session API;
    behaviour **UNVERIFIED** per version).
  - Background tabs are suspended.
  - The WebKit 7-day cap on script-writable storage applies to non-installed sites, while **Home Screen web apps are exempt**.
    Push "Add to Home Screen" and `navigator.storage.persist()` before the user invests in large projects (Safari's exact
    quota is **UNVERIFIED**).

---

## 4. Mapping onto StaticFlux

### 4.1 Existing packages

| Package | Role in Instaflow media | Gaps |
|---|---|---|
| `@staticflux/document` | Timeline entities as ECS components (`Track`, `Clip`, `Transition`, `Channel`, `Page`, `MediaRef`, `TextAnim`), `keyBetween` ordering, `transact` for atomic edits, replicas to UI + composition worker, CRDT co-editing. | Keyframe arrays and track ordering need efficient CRDT encodings (per-key LWW entities instead of a `json` blob per channel, so two users editing different keys merge). Ticks need an exact integer field type (`f64` is fine up to 2^53; document the invariant). |
| `@staticflux/worker` | Control channel for replicas and intents; **frame channels** (SAB ring + Atomics / transfer fallback) for **PCM to the AudioWorklet** and for **playhead/clock state**; data channels for proxy and thumbnail bytes; supervised workers with respawn (decoder pool and composition worker restart without losing the document). | **Data channels move only ArrayBuffers.** We need a **handle channel** for transferable non-buffer objects: `VideoFrame`, `AudioData`, `ImageBitmap`, `OffscreenCanvas`, `MessagePort`, with ownership and `close()` semantics (a frame not closed by the receiver is a leak, so add dev guards and counters). The ring consumer must be usable from an **AudioWorklet global** (no `Atomics.waitAsync` there; poll per `process()` quantum). |
| `@staticflux/surface` | Composition worker = `hostRenderSurfaces` with an Instaflow `RenderEngine` (WebGPU, then WebGL2); `createRenderSurface` main-thread fallback; input forwarding for canvas manipulation (handles, crop); `SurfaceMetrics`; HTML-in-Canvas adapter for text editing; accessible layer (layer list is focusable). | `createFrameLoop` is driven by rAF `dt`. Playback needs a **clock-driven frame loop** (frame time from `MediaClock`, not `dt`) and an **offline loop** (no rAF, as fast as readiness allows) for export. `RenderEngine.frame(state, dt, info)` should get `info.presentationTime` and `info.mode: 'live' | 'offline'`. `acquireContext` should include WebGPU, with an adapter feature/limits fact. |
| `@staticflux/wasm` | Hosts optional Wasm: Signalsmith Stretch, AAC/MP3/FLAC encoders, ffmpeg.wasm (on-demand chunk, budget exemption), future mixer/compositor in Wasm SIMD; SIMD and threads variants picked by facts. | Budget categories for large Wasm (ffmpeg ~25–31 MB: lazy, `on-demand` warmup, cached by the service worker only after first use). |
| `@staticflux/runtime` (frame scheduler) | Timeline UI rendering (DOM ruler, clips, waveforms canvas) uses `schedule`/`measure`/`mutate` and `postTask` priorities; resource manager demotes the media feature when hidden (close decoders, drop GPU caches). | The UI scheduler coalesces at rAF. **Playback must not depend on main-thread rAF.** It runs in the composition worker. The main thread only shows the playhead (reading the shared clock). Add a memory-pressure input from media caches to `MemoryPressure`. |
| `@staticflux/storage` | `AsyncStore` over IndexedDB for the asset index and metadata. | OPFS **blob/file store** (large, streaming, random-access reads for demux). Probably a new backend or a sibling interface (`BlobStore`), because KV is the wrong shape for multi-GB files. |
| `@staticflux/platform` | Facts: WebCodecs presence, codec support (probed `isConfigSupported` matrix, cached per UA version), WebGPU adapter and limits, WebGPU-in-worker, OffscreenCanvas contexts, AudioWorklet, `outputLatency`, device memory class, isolation. Variants pick Tier A/B/C bindings (no `if/else` in features, rule 4). | Async probes (codec checks are async). Facts need an "async fact" lane with caching. |
| `@staticflux/perf` | Budgets: playback FPS, dropped frames, A/V drift, seek latency, scrub latency, export real-time factor, decoder count, GPU and texture bytes. | New metrics declared via `metric.*()`. |
| `@staticflux/gate` / `config` | Export resolution and format entitlements; ML features gated by device capability (UX, not security). | none |
| `@staticflux/ai` / `advisors` / `webmcp` | Agent tools: `timeline.evaluate(t)`, `timeline.applyEdits(ops)`, `media.thumbnail(t)`, `media.generate(extend clip)`, `export.start(preset)`. | Tool schemas must be generated from the same edit-intent definitions. |

### 4.2 New primitives StaticFlux needs

These are framework-generic (any media app, not just Instaflow). Each follows the house rules: tokens, units, `Result`,
lifecycle machines in `LIFECYCLES.md`, `SF-*` codes with fixes, an `AGENTS.md`, and budgets.

1. **`@staticflux/motion` (core-adjacent, pure, no DOM):**
   - `Ticks`, `Rational`, `TickRange`, conversions (frames and samples, NTSC rates)
   - `Channel<T>` keyframes, easing (cubic-bezier solver, steps, hold, sampled springs), typed interpolators (number, vec2,
     rotation, rect, color in linear light)
   - `evaluateChannel`, a seeded PRNG
   - a `TimeMap` (linear or remap curve, inverse lookup for media time)
   - **Deterministic by construction:** lint rule bans `Date`, `Math.random` and `performance` in evaluator modules.
     Shared contract test suite.
2. **`@staticflux/media` (vertical):**
   - `MediaClock` (token): sources `audio | wall | offline | scrub`; `now()`, `state`, `onTick`, latency compensation.
     Lifecycle `stopped → prerolling → playing ⇄ stalled → paused`, plus `seeking` and `scrubbing`.
   - `DecoderPool`: sessions, priorities, byte budgets, `frame(asset, t, { mode, deadline, signal })`, `prefetch(range)`;
     `DecoderSession` lifecycle `idle → configuring → ready ⇄ decoding → resetting → closed | failed` (fallback: software
     decoder or transcode).
   - `MediaAssetStore`: content-addressed (SHA-256) originals and derived renditions (proxy, thumbs, peaks, matte) in OPFS;
     derivation jobs (cancellable, resumable, progress); quota and persistence facts.
   - `MediaIndex` (sample tables, keyframes)
   - `CodecFacts` (probed matrix)
   - A **container port** wrapping Mediabunny, so no feature imports it directly (like `yjs` in `yjs-crdt.ts`).
   - `ExportJob` lifecycle `queued → preparing → rendering → finalizing → done | failed | cancelled`, checkpointed.
3. **`@staticflux/audio` (vertical, or part of media):** an `AudioWorklet` host (`audioWorklet.addModule` as a chunk, R12.2
   ids), a worklet-side ring consumer, a mixer graph description (buses, gain, pan, envelopes, meters), and the offline render
   path that shares the DSP code; latency facts.
4. **`@staticflux/worker` additions:** `defineHandleChannel` (transferable handles with close accounting); an
   AudioWorklet-compatible ring reader; a "clock cell" layout (seqlock-protected f64 position and state shared via SAB, with a
   transfer fallback).
5. **`@staticflux/surface` additions:** `createClockedFrameLoop({ clock })`; `createOfflineFrameLoop()`; `RenderGraph`
   execution helpers (texture pool, pass graph, external-texture import with WebGL2 fallback); GPU memory accounting
   (`surface/gpu-bytes`); color-space handling for `VideoFrame` (BT.709/BT.2020, full vs limited range).
6. **`@staticflux/testkit` additions:** a fake `VideoDecoder`/`VideoFrame`/`AudioContext`; a deterministic clock; golden
   `RenderGraph` snapshots; perceptual image diff; a "media corpus" fixture set (short clips per codec).

Instaflow-specific (app or feature layer): the timeline component schema, edit intents (ripple, roll, slip, slide), effects,
transitions and text-animation libraries, the matte job, generative actions, the timeline UI, and export presets.

### 4.3 Proposed performance budgets (starting points, ratchet per R12.8)

| Metric | Mid-tier phone (e.g. 2023 Android / iPhone 13) | Desktop |
|---|---|---|
| Preview FPS at 1080p project, 3 video layers + text | 30 fps sustained (proxies) | 60 fps (originals ≤ 4K H.264) |
| Dropped frames during playback (per 120-frame window) | ≤ 5% | ≤ 1% |
| A/V drift (presented video vs audible audio) | ≤ 1 frame (±33 ms) | ≤ 1 frame (±16 ms) |
| Play-start latency (press play → first frame and audio) | ≤ 250 ms | ≤ 120 ms |
| Seek to exact frame (proxy, 0.5 s GOP) | ≤ 150 ms | ≤ 60 ms |
| Scrub: coarse frame on screen | ≤ 1 display frame (cache or thumbnail) | ≤ 1 display frame |
| Composition worker frame CPU time | ≤ 8 ms | ≤ 4 ms |
| Main-thread work during playback | ≤ 2 ms per frame (playhead and UI only) | ≤ 1 ms |
| Export speed, 1080p30 H.264 | ≥ 1x real time | ≥ 3x real time |
| Decoded-frame plus texture memory | ≤ 150 MB | ≤ 1 GB |
| Concurrent decoders | ≤ 3 | ≤ 8 |
| Media feature JS (excl. Wasm, Mediabunny) | ≤ 200 KB heavy-feature exemption, lazily loaded | same |
| Mediabunny chunk (tree-shaken) | measure (MP4 muxer alone ~17 KB per the migration guide) | same |

---

## 5. Phased plan

**Phase 0: spikes (2–3 weeks).** Each spike produces a measurement, not a product.
- Mediabunny demux, then WebCodecs decode, then WebGPU `importExternalTexture`, in a worker, on iPhone (iOS 26), Pixel-class
  Android, and desktop. Measure seek latency vs GOP length, and the concurrent-decoder ceiling on iOS.
- AudioWorklet SAB ring with an audio-master clock: measure drift over 10 minutes, Bluetooth latency compensation.
- Export 60 s 1080p H.264/AAC on iPhone: real-time factor, memory peak, thermal throttling.
- Check WebGPU-in-worker and the VideoFrame external texture on Safari 26 (open question in the matrix).

**Phase 1: MVP timeline (8–10 weeks).**
- `@staticflux/motion`, plus `@staticflux/media` with clock, pool and asset store (minimal versions).
- One page, multiple video, audio and text tracks.
- Edits: import, trim, split, move, delete, ripple delete, snapping, speed (constant), volume, fades, cross-dissolve, basic
  transforms with keyframes (position, scale, rotation, opacity), static text.
- WebGPU compositor with a WebGL2 fallback, proxies plus thumbnails plus waveforms.
- Audio-master playback, MP4 export (H.264/AAC).
- Agent tools: `evaluate`, `applyEdits`, `export`.
- Tier A browsers only, with gated messaging elsewhere.

**Phase 2: Canva/CapCut parity basics (8 weeks).**
- Pages with page transitions, transition library, crop keyframes, Ken Burns and zoom-to-region presets.
- Text animation presets (HarfBuzz glyph pipeline), captions from transcription.
- Overlays and blend modes, audio envelopes and crossfades, ducking.
- WebM and GIF and image-sequence export, Tier B/C fallbacks, OTIO import/export.
- Co-editing of timelines (CRDT edit semantics for ripple).

**Phase 3: advanced (ongoing).**
- Speed ramps (time remap), pitch-preserving time-stretch, reverse.
- Reaction PiP with live preview mask, baked matte jobs and temporal smoothing.
- Motion graphics (shapes, trim paths, Lottie), chroma key, LUTs and color correction, motion blur (multi-sample),
  masks and tracking.
- Generative additions (extend clip, b-roll), Wasm SIMD mixer and compositor hot paths, 4K export on desktop, HDR (10-bit)
  investigation.

---

## 6. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| iOS memory kills (canvas cap, GPU process OOM, frame leaks) | High / high | Byte budgets, mandatory proxies on mobile, `VideoFrame` close accounting via handle channels, a memory-pressure response that drops caches and lowers the preview resolution, device-class tuning from spike data. |
| Safari WebCodecs and WebGPU edge cases (codec quirks, external textures, worker contexts) | High / medium | Feature-detect in the worker, keep the WebGL2 path first-class, per-browser contract tests in CI (Playwright WebKit) plus a manual device lab. |
| Frame-accurate seeking cost on long-GOP sources (phone footage, screen recordings) | High / medium | Proxies with 0.5 s GOP, keyframe index, decoder session reuse, coarse-then-exact scrub. |
| A/V drift with Bluetooth or variable output latency | Medium / medium | Audio-master clock with `getOutputTimestamp`, continuous re-estimation, user offset setting. |
| Preview ≠ export (non-determinism) | Medium / high | Pure evaluator, offline mixer shared with the worklet, bundled fonts, baked mattes, golden tests. |
| Licensing contamination (GPL ffmpeg core, Bria weights, gifski AGPL, Remotion, Diffusion Studio watermark, MPL changes) | Medium / high | License allowlist in `tooling` (fail CI on GPL/AGPL/NC), LGPL ffmpeg build, a model card registry for weights, contribute Mediabunny patches upstream. |
| Codec patents / availability (H.264/AAC are platform-provided; HEVC encode only on Apple) | Low / medium | Use only platform encoders for patented codecs; ship no Wasm H.264/HEVC encoder. |
| Storage eviction (Safari 7-day cap, quota) | Medium / high | Push PWA install, `storage.persist()`, an explicit "project backup" export (zip of document + originals), and treat proxies and thumbnails as regenerable. |
| Firefox Android lacking WebCodecs | Certain / low (small share) | Tier B view mode and a clear fix message. Track Bugzilla 1746557. |
| Export interrupted by backgrounding on mobile | High / medium | Wake Lock, in-app progress screen, GOP checkpoints, resume. |
| CRDT semantics for ripple edits under concurrency | Medium / medium | Intents compute explicit moves; a sync-lock policy; property tests on the mock collaboration network. |
| ML matte speed on phones | High / low | Baked jobs at proxy resolution, live tier for preview, an optional "process on desktop" (same app, another device, via the synced document). |
| Framework scope creep (media primitives too app-specific) | Medium / medium | Keep `motion` and `media` generic and trace every API to `FEATURE-NEEDS.md` (R11.12); Instaflow-specific logic lives in features. |

---

## 7. Open questions

1. Is a cross-origin isolated deployment acceptable for the PWA (COOP/COEP everywhere, or service-worker-injected isolation)?
   This decides the SAB ring vs transfer path as the default.
2. Color management target: sRGB/Rec.709 SDR only for v1? (HDR iPhone footage is HLG/HEVC 10-bit and needs tone mapping.)
3. Maximum project and export length on mobile (e.g. 10 min at 1080p) as a gate, for memory and storage.
4. Do we own a Lottie and vector-motion pipeline, or import only?
5. Matte model choice and weights license sign-off (BiRefNet variants vs MODNet vs MediaPipe-only for v1).

## 8. Glossary
- **GOP:** the group of pictures between keyframes; seek cost is bounded by it.
- **Proxy:** a lower-resolution, short-GOP copy of the media, used for editing.
- **Matte:** a per-frame alpha mask.
- **Render graph:** the evaluator's output describing exactly what to draw at time `t`.
- **Ticks:** the integer time unit (1/705,600,000 s).

## 9. Sources

- WebCodecs support: [caniuse WebCodecs](https://caniuse.com/webcodecs), [Digital Samba: WebCodecs explained (2026)](https://www.digitalsamba.com/blog/webcodecs-api-explained), [Softvelum: Nimio on Safari/iOS 26](https://softvelum.com/2025/09/nimio-safari-ios-macos-26/), [Mozilla Bug 1746557](https://bugzilla.mozilla.org/show_bug.cgi?id=WebCodecs), [utsubo: Frontier Web APIs 2026](https://www.utsubo.com/blog/frontier-web-apis-2026-production-ready)
- Codec selection: [MDN WebCodecs codec selection](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection), [blink-dev: H26x codec updates](https://groups.google.com/a/chromium.org/g/blink-dev/c/YJ1QijNiHeM/m/3EhMjMVwAgAJ), [caniuse HEVC](https://www.caniuse.com/hevc), [WebCodecs codec support dataset](https://zenodo.org/records/19187467)
- Seeking and flush semantics: [MDN Using the WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API), [w3c/webcodecs#698](https://github.com/w3c/webcodecs/issues/698), [Chrome: Video processing with WebCodecs](https://developer.chrome.com/articles/webcodecs)
- Mediabunny: [npm README 1.61.3](https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/README.md), [Media sinks guide](https://mediabunny.dev/guide/media-sinks), [VideoSampleSink API](https://mediabunny.dev/api/VideoSampleSink), [mp4-muxer migration guide](https://raw.githubusercontent.com/Vanilagy/mp4-muxer/HEAD/MIGRATION-GUIDE.md), [SVTA talk](https://university.svta.org/conference-proceedin/performant-and-accessible-client-side-media-processing-with-mediabunny/)
- ffmpeg.wasm: [Shotstack: FFmpeg.wasm](https://shotstack.io/learn/ffmpeg-wasm/), [Transloadit: thumbnails with ffmpeg.wasm](https://transloadit.com/devtips/extract-thumbnails-from-videos-in-browsers-with-ffmpeg-wasm/)
- Remotion: [Client-side rendering](https://remotion.dev/docs/client-side-rendering/), [Web renderer](https://www.remotion.dev/docs/web-renderer/), [renderMediaOnWeb](https://www.remotion.dev/docs/web-renderer/render-media-on-web), [Flickering / determinism](https://v4.remotion.dev/docs/flickering), [CSS animations troubleshooting](https://www.remotion.dev/docs/troubleshooting/css-animations), [License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md), [Pricing](https://www.remotion.dev/docs/license/pricing), [Editor Starter client-side rendering](https://www.remotion.dev/docs/editor-starter/client-side-rendering), [Building a timeline](https://remotion.dev/docs/building-a-timeline)
- Other engines: [Diffusion Studio docs](https://docs.diffusion.studio), [Revideo docs](https://docs.re.video/), [Etro on npm](https://npmjs.com/package/etro), [Twick (dev.to)](https://dev.to/anujkanojia29/twick-react-sdk-for-building-video-editors-captions-timelines-effects-46fm), Twick LICENSE.md (github.com/ncounterspecialist/twick), Diffusion Studio 4.0.3 README and LICENSE from the npm tarball
- OTIO: [Timeline structure](https://opentimelineio.readthedocs.io/en/v0.15/tutorials/otio-timeline-structure.html), [Serialized schema](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/v0.16.0/docs/tutorials/otio-serialized-schema.md)
- GPU: [WebKit: News from WWDC25, WebGPU in Safari 26](https://webkit.org/?p=16993), [WebKit bug 299237](https://bugs.webkit.org/show_bug.cgi?id=299237), [web.dev: WebGPU supported in major browsers](https://web.dev/blog/webgpu-supported-major-browsers), [Simon Willison: Firefox 141 WebGPU](https://simonwillison.net/2025/Jul/16/webgpu-firefox), [gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/implementation-status), [Chrome: New in WebGPU 116 (VideoFrame external textures)](https://developer.chrome.com/blog/new-in-webgpu-116), [WebKit bug 235043 (video upload perf)](https://bugs.webkit.org/show_bug.cgi?id=235043)
- HTML-in-Canvas: [Chrome: HTML-in-Canvas origin trial](https://developer.chrome.com/blog/html-in-canvas-origin-trial), [HTML-in-Canvas updates](https://developer.chrome.com/blog/html-in-canvas-ot-changes)
- Audio: [web.dev: Synchronize audio and video playback](https://web.dev/articles/audio-output-latency), [ringbuf.js](https://github.com/br-matt/ringbuf.js), [Web Audio issue 1713](https://github.com/WebAudio/web-audio-api/issues/1713), [Chrome: Audio worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern)
- Segmentation: [MediaPipe interactive segmenter (web)](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter/web_js), [MediaPipe iOS GPU delegate issue #6142](https://github.com/google-ai-edge/mediapipe/issues/6142), [Fora Soft: MediaPipe selfie segmentation on WebGPU (2026)](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/mediapipe-selfie-segmentation-webgpu-background-blur), [Bria RMBG-2.0](https://github.com/Bria-AI/RMBG-2.0), [RMBG-1.4 transformers.js](https://huggingface.co/kittypdf/RMBG-1.4-transformersjs), [Xenova remove-background-webgpu](https://huggingface.co/spaces/Xenova/remove-background-webgpu/discussions/1), [ComfyUI BiRefNet node (license note)](https://comfy.icu/node/BackgroundRemoverMEC)
- Mobile Safari memory: [Apple forums: canvas memory 224 MB](https://developer.apple.com/forums/thread/112218), [WebKit bug 256366](https://bugs.webkit.org/show_bug.cgi?id=256366), [WebKit bug 229825](https://www2.webkit.org/show_bug.cgi?id=229825), [WebKit bug 193449 (concurrent decoders)](https://bugs.webkit.org/show_bug.cgi?id=193449), [WebKit: Full third-party cookie blocking and more (7-day storage cap)](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)
- Industry: [web.dev: CapCut case study](https://web.dev/case-studies/capcut), [web.dev: Clipchamp case study](https://web.dev/case-studies/clipchamp), [W3C workshop: Clipchamp WebCodecs](https://www.w3.org/2021/03/media-production-workshop/talks/soeren-balko-clipchamp-webcodecs.html), [Canva Staff Frontend Engineer (Video) posting](https://jobs.generalcatalyst.com/companies/canva/jobs/93112903-staff-frontend-engineer-video), [GitNation: Pushing the limits of video encoding with WebCodecs](https://gitnation.com/contents/pushing-the-limits-of-video-encoding-in-browsers-with-webcodecs)
- GIF: [gifenc](https://github.com/mattdesl/gifenc)
- Versions and licenses: npm registry (`registry.npmjs.org`) on 2026-10-24 for mediabunny 1.62.1, @mediabunny/* 1.62.1, mp4box 2.4.1, @ffmpeg/ffmpeg 0.12.15 / @ffmpeg/core 0.12.10, remotion and @remotion/web-renderer 4.0.538, @motion-canvas/core 3.17.2, @revideo/core 0.11.0, @diffusionstudio/core 4.0.3, etro 0.14.1, gifenc 1.0.3, @mediapipe/tasks-vision 1.1.1, onnxruntime-web 1.30.0, @huggingface/transformers 4.3.1, harfbuzzjs 1.6.4, wavesurfer.js 8.0.3, pixi.js 8.22.0, signalsmith-stretch 1.3.2, soundtouchjs 0.3.0, rubberband-wasm 3.3.0, opentimelineio 0.1.0, ringbuf.js 0.4.0
