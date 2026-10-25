# Instaflow — Requirements

> Status: **draft for owner review** (2026-10-24). IDs are stable: `IF-<section>.<n>`. Error codes are
> `IF-<AREA>-<NNN>`, and each has a `fix` in the app's error catalog (StaticFlux rule 6). Framework changes
> referenced here are listed in [PLAN.md §3](PLAN.md#3-staticflux-packages-and-changes) as `SF-Δn`.
> "Must" is implied: every line is a requirement. Owner-locked decisions D1–D7 in [DECISIONS.md](DECISIONS.md)
> are authoritative over this file. §17 and §18 are **design direction**, not V1 features.

## 0. Conventions

- **IF-0.1** Each requirement traces to a phase in PLAN.md and to at least one test (unit, contract or e2e).
- **IF-0.2** Instaflow follows every StaticFlux rule (root `AGENTS.md`): typed tokens, units declaring
  `requires`/`provides`, no `if/else` on flags or modes, `AbortSignal` everywhere, `Result<T, SfError>`, layer
  boundaries, budgets, and tests shipping with code.
- **IF-0.3** App-specific code lives in `apps/instaflow`. A primitive that any media or design app would need goes
  into a StaticFlux package, changed in place in this monorepo, with its own requirement and `AGENTS.md` update.

## 1. Product

- **IF-1.1** **The asset is the data primitive.** Every importable, generatable or authored thing is an asset:
  image, video, audio, font, vector, composition (a design), template, brand kit, motion preset, workflow, prompt,
  and the derived matte and transcript.
- **IF-1.2** **Actions on assets** come in two kinds:
  - *parametric*: edits node properties and leaves the asset untouched (crop, trim, speed, style, text);
  - *materializing*: creates a new asset with provenance and swaps the reference in one undoable transaction
    (remove background, extend clip, generate, flatten, transcode).

  Both kinds are capabilities.
- **IF-1.3** **One authoring core, four lenses.** Pages, Canvas, Timeline and Flow edit one document tree. A lens
  is a feature with its own tools and chrome, never a document type and never an `if` on mode.
- **IF-1.4** **Human/agent parity.** Every user-visible action is a capability that agents can invoke through
  WebMCP (where `exposeToAgents` is set), with the same validation, gating, preview, undo and attribution.
- **IF-1.5** **Scenarios that define V1 done:** (A) campaign flyer, (B) multi-page piece with page transitions and
  text animation, (C) reaction video with a person cutout over background video and zoom, (D) generate → edit →
  extend a clip, (E) steps → atomic unit → workflow graph. Flows are in UX.md §6. Each scenario has an e2e test
  against mocked model providers.
- **IF-1.6** No gimmick features. A capability ships in V1 only if it traces to a job ranked in the UX research
  synthesis (UX.md §7) or to IF-1.5.

## 2. Platform and build

- **IF-2.1** **Target: Chrome desktop** (and Chromium Edge), current stable and the two previous versions.
  Support is detected by capability, never by user agent.
- **IF-2.2** **Required baseline** (all must pass at boot, otherwise IF-2.4): WebGPU with an adapter usable from a
  dedicated worker; `OffscreenCanvas` transfer; WebCodecs `VideoDecoder`/`VideoEncoder`/`AudioDecoder`/
  `AudioEncoder`; OPFS with `createSyncAccessHandle` in dedicated workers; Wasm SIMD; `SharedArrayBuffer` with
  cross-origin isolation; AudioWorklet; Compression Streams; Web Locks; BroadcastChannel.
- **IF-2.3** **Enhanced on Chrome, optional elsewhere:** File System Access folders (`showDirectoryPicker`),
  EditContext, Local Font Access, `importExternalTexture(VideoFrame)`. A missing enhancement is a platform fact
  that selects a variant binding. It is never a branch in feature code.
- **IF-2.4** **Unsupported screen.** If the baseline fails, the app shows one screen that names the missing
  capability and gives a stable code and fix: `IF-PLAT-001` browser unsupported ("use Chrome desktop"),
  `IF-PLAT-002` no WebGPU adapter (blocklisted GPU or VM), `IF-PLAT-003` not cross-origin isolated. Nothing else
  loads.
- **IF-2.5** **Firefox desktop is best effort.** OPFS plus zip import/export instead of folders, uploaded fonts
  instead of Local Font Access, a hidden-textarea `TextInput` adapter instead of EditContext. Where Firefox lacks
  WebGPU (for example Linux), IF-2.4 applies. No other Firefox-specific code.
- **IF-2.6** **Safari and all mobile are out of scope.** Exported outputs (MP4, PDF, PNG, viewer HTML) play
  anywhere.
- **IF-2.7** **No archaic paths.** No Canvas2D, DOM/SVG or WebGL renderers for content, no IndexedDB blob
  fallback, no download/upload substitute for a real folder on Chrome.
- **IF-2.8** **Isolation `required`** with COEP `credentialless`. On static hosts, the StaticFlux service-worker
  header plugin injects COOP/COEP (one reload on the first visit). "Build, deploy, it just works" on any static
  host.
- **IF-2.9** **Boot budget unchanged:** total boot JS ≤ 150 KB gzip (R12.7). The editor feature's initial JS is
  ≤ 50 KB gzip. Engines (render Wasm, authoring Wasm, CRDT Wasm, Mediabunny, ML runtimes) are lazy worker
  chunks with declared Wasm budget categories (IF-15.1).
- **IF-2.10** **Simplest build.** One pnpm workspace app (Vite through `@staticflux/vite-plugin`) plus one Rust
  workspace (`apps/instaflow/engine`) built by `pnpm build` with a pinned toolchain (`rust-toolchain.toml`,
  `wasm-bindgen`, `wasm-opt`). No other toolchains.
- **IF-2.11** **License allowlist.** CI fails on GPL, AGPL, non-commercial or watermark-licensed dependencies and
  model weights (for example ffmpeg GPL core, Bria RMBG, gifski, Remotion). MPL-2.0 (Mediabunny) is allowed
  unmodified.

## 3. Assets and the workspace store

- **IF-3.1** A **workspace** is a content-addressed object store with three storage classes: immutable **blobs**
  (`sha256:`), immutable **records** (asset, milestone, export), and a small set of mutable **heads** (one per
  tree asset plus the library). Everything else is a derived, rebuildable index (DOCUMENT-FORMAT §5).
- **IF-3.2** The same store layout works in OPFS (default, zero setup), in a **real user folder** (File System
  Access, Chrome) and later in cloud object storage plus a DB, with no format change.
- **IF-3.3** A workspace can move between OPFS and a folder by copying objects. The app offers "Move workspace
  to a folder" once media in the workspace exceeds 2 GB.
- **IF-3.4** Writers create **only new immutable files** and swap small heads atomically (compare-and-swap).
  Only the store worker writes (ARCHITECTURE §2). Any worker reads immutable blobs directly by range.
- **IF-3.5** Blobs up to 8 MiB are hashed whole. Larger blobs are stored as a **chunk manifest** of 4 MiB chunks,
  and the manifest's digest is the blob digest. Hashing uses WebCrypto per chunk in a worker, is cancellable and
  reports progress. An imported asset is usable through a provisional id before hashing finishes.
- **IF-3.6** **Blob assets are immutable.** A materializing action creates a new asset. Mutable library metadata
  (title, tags, folders, trash) lives in the workspace **library document** (a CRDT).
- **IF-3.7** **Tree assets** (composition, template, brand kit, motion preset, workflow, prompt) have a Latest
  state (CRDT docs) and Milestones (§5).
- **IF-3.8** **Provenance** is recorded on every asset that a capability creates, automatically by capability
  middleware (SF-Δ13): action, actor, ingredients (`parentOf | componentOf | inputTo`), the capability id and
  version with input, and for generated assets the provider, model, parameters, seed and source range. The
  vocabulary is C2PA-aligned.
- **IF-3.9** **Renditions** (thumbnail, poster, proxy, waveform peaks, filmstrip) are derived, regenerable blobs
  produced by cancellable, resumable background jobs.
- **IF-3.10** **Garbage collection** marks from roots (the library document's live assets, their heads, their
  milestones, export records, and blobs referenced from any of these) and sweeps after a 30-day grace period.
  Reference counts span all live documents. Deduplication by hash never creates a dependency between
  documents. GC cost is O(live store size).
- **IF-3.11** **Quota.** The app calls `navigator.storage.persist()` on first project, shows a storage panel
  (originals vs regenerable renditions), and fails writes with `IF-STORE-001` (quota) and a fix.
- **IF-3.12** **Folder mode resilience.** If folder permission lapses, the app stays usable read-only from OPFS
  caches and shows a one-click re-grant. External changes to the folder are detected on focus. Objects are
  verified by digest, and a mismatch raises `IF-STORE-002` and quarantines the object.

## 4. Document model and co-editing

- **IF-4.1** A tree asset's content is a **hierarchical node tree** with stable node ids and typed properties,
  grouped by component (spatial, temporal, source, style, text, motion, animation, lock, slot, step). Every
  node has a semantic `role` (a closed, extensible enum: headline, subhead, body, cta, logo, hero, price, legal,
  caption, reaction, background…) and a `name`, which agents and the accessibility layer both use.
  DOCUMENT-FORMAT §3 is normative. The ECS is only an internal runtime index of this tree.
- **IF-4.2** **Space and time are orthogonal components.** A page with `temporal` is a slide with a duration. A
  clip with `spatial` is an overlay or PiP. Lenses differ only in which components their tools edit.
- **IF-4.3** **Time is integer ticks at 705,600,000 per second.** Frames and samples exist only at the edges.
- **IF-4.4** **Ordering:** children use fractional keys. Clips inside a track are ordered by `temporal.start`,
  never by list position.
- **IF-4.5** **References** to other assets are either **pinned** (to a milestone) or **following** (Latest).
  Blob assets are immutable, so a reference to one is just its id. Documents never contain physical locations;
  a resolver maps references to bytes.
- **IF-4.6** **Composition arcs, V1 set only:** `reference` (instances, embedded designs, media), `inherit`
  (brand-kit classes and tokens) and `variant` (format, theme, locale). Strength order: local > variant >
  inherit > reference. `explain(node, path)` reports which opinion won and why (SF-Δ7).
- **IF-4.7** **Locks.** A UX lock (`position | content | all`) can be removed by anyone with edit rights. A
  **policy lock** (from a brand kit or template) can be removed only by a human with an explicit confirmation,
  never by an agent. Edits to locked paths are rejected (`IF-CS-004`).
- **IF-4.8** **Co-editing is a first-class design constraint.** The document is a CRDT (Loro behind
  `DocumentCRDT`). Every tab's editor worker, the store worker and every agent session is a distinct peer
  identity with its own actor record. All edits are CRDT transactions that commute, so concurrent people and
  agents converge without a lock server.
- **IF-4.9** **No edit depends on a global read-modify-write.** Ripple, insert and other multi-item timeline edits
  compute explicit per-item moves at intent time and commit them as one transaction. Reparenting is cycle-safe
  (movable tree).
- **IF-4.10** **Presence** (cursors, selection, agent status, held elements as soft locks, gesture previews) is
  ephemeral and never enters the CRDT. Remote gestures render as ghosts.
- **IF-4.11** **Networked multi-user is a transport, not a redesign.** Adding a `CollaborationTransport` (relay)
  must require no change to the format, the change-set protocol, undo or attribution.
- **IF-4.12** **Attribution.** Every transaction carries an actor record `{ kind: human | agent | flow, id,
  displayName, model?, via: hud | bar | chat | webmcp | flow | shortcut, invocationId }` (SF-Δ10).
- **IF-4.13** **Undo is per actor and transaction-grouped.** "Undo" never undoes another actor's concurrent edit.
  One capability invocation or one accepted change set is one undo step with a readable label.
- **IF-4.14** Component ids and field names are part of the format. Changes are additive, or they are versioned
  migrations (DOCUMENT-FORMAT §8).

## 5. Versioning

- **IF-5.1** Each tree asset has exactly two kinds of state: **Latest** and named **Milestones**. There is no
  save button.
- **IF-5.2** **Latest** is saved continuously. An edit is durable when the store worker acknowledges it (target
  ≤ 1 s after gesture end). After 2 s without an acknowledgement, the top bar shows "Not saved yet" with the cause.
- **IF-5.3** **The Latest op log is compacted** into a new snapshot (on close, or every 2 MB of log) and is not
  kept as long-term history. Undo history persists across reload up to an **undo horizon** of 200 steps per
  actor; history older than the horizon is dropped at compaction.
- **IF-5.4** A **Milestone** is created only by an explicit user (or user-approved agent) action. It has a name,
  an optional note, a creator, a time, and a `parent` link to the previous milestone **of the same document
  only**. It is immutable and can be pinned.
- **IF-5.5** **A milestone is a full snapshot**: a manifest of canonical, engine-independent tree **parts** (one
  per page, flow and root), each addressed by hash. Unchanged parts are shared by hash with earlier milestones.
  A milestone never depends on a diff chain.
- **IF-5.6** **No automatic versions in V1.** The format reserves a `kind: 'auto'` milestone value for later.
- **IF-5.7** **No restore.** Instead, **"New document from milestone"** creates a new asset with a fresh,
  detached baseline. It has no structural parent link. Provenance is only an informational label
  (`createdFrom: { asset, milestone, title }`). Blob dedup by hash is invisible and creates no dependency.
- **IF-5.8** Templates and remixes use IF-5.7. Using a template is "New document from milestone" plus slot
  filling.
- **IF-5.9** **Costs scale with document size, never with age or ancestry.** Opening Latest, creating a milestone,
  opening a milestone and creating a document from one are each O(size of the document), independent of how
  many milestones or edits exist.
- **IF-5.10** **Exports render from a frozen snapshot and leave no record (D10).** The export reads an internal,
  content-addressed snapshot of Latest taken when the export starts, so later edits never leak into a running
  export. Plain exports create no milestone and no list entry. **Publishing** creates a Release asset (rendered
  output, the frozen snapshot, and a "published from" label), never a milestone.
- **IF-5.11** Milestones open read-only (IF-13.1). Comparing two milestones visually (side by side) is in V1.
  Diffing them structurally is not.

## 6. Agent views and change sets (research 05 folded in)

- **IF-6.1** **Agents never read the canonical tree or the ECS.** They read **agent views**: read-only, on-demand
  projections of the **composed** stage, built and cached in the editor worker (DOCUMENT-FORMAT §7). The
  canonical model is unchanged. Field names and `role`s are chosen to read naturally, so the projection is a
  shallow 1:1 codec.
- **IF-6.2** **Views:**
  - `layout`: restricted, absolutely positioned HTML/SVG-like markup with a closed vocabulary (`<page>`, `<text>`,
    `<image>`, `<video>`, `<rect>`, `<group>`, `<slot>`, `<transition>`…) and stable ids, for pages and canvas;
  - `timeline`: OTIO-shaped JSON in **seconds** (never ticks);
  - `transcript`: words with ids and timeline times, for speech-driven edits;
  - `graph`: steps, ports and edges as JSON, for flows;
  - `screenshot`: on demand, with id badges and a legend.

  Real HTML+CSS, JSX, raw SVG documents, Lottie JSON and the raw canonical JSON are not agent views.
- **IF-6.3** **View rules:**
  - views are **scoped** (`selection | viewport | page | time window | subtree`) with a token **budget**, and are
    summarized outside the scope (focused, then blurry, then clusters);
  - defaults are omitted, and geometry is page-relative and rounded (rounding is undone on compile, so untouched
    fields keep full precision);
  - inherited values are annotated (`@token`, `from="brand|template"`, `locked`);
  - every view has a header (`base`, `viewHash`, scope, units) and, after the first turn, a `changed-since`
    section;
  - **lints** (overlap, off-page, text overflow, contrast, safe area, empty slot) come instead of pixels by
    default;
  - document text is marked as data, never as instructions.
- **IF-6.4** **Generated, not hand-written.** View codecs, the agent-op JSON Schema and the prompt vocabulary
  reference are generated from `defineComponent` schemas plus codec declarations (SF-Δ34). A shared round-trip
  contract suite gates every codec. An unmapped component appears as `<unknown kind id>`, which an agent can move
  but not edit.
- **IF-6.5** **Budgets:** projecting one page takes ≤ 2 ms, re-projecting after a one-node change ≤ 0.5 ms, and
  compiling an edit ≤ 1 ms. An outline of a 1,000-node document is ≤ 8k tokens. A whole-document request
  returns an outline, never a full view.
- **IF-6.6** **Edits are id-addressed JSON ops** over view handles (`set`, `create`, `delete`, `move`, `text`,
  `animate`, `motion`, `place`, `trim`, `split`, `cut`, `transition`, `step`, `connect`, `disconnect`, `input`,
  `invoke`), optionally with `expect` preconditions. A **markup fragment upsert by id** is allowed for creating
  nodes and for replacing agent-created subtrees. It is diffed against **the base view the agent read**, never
  against current state. Unified diffs, JSON Patch with indices and whole-view regeneration are rejected.
- **IF-6.7** **Compile to change sets.** Agent ops compile (resolve handles, unround, seconds → ticks, expand
  compound ops) into one canonical **change set** `{ id, base, author, intent, ops }` (DOCUMENT-FORMAT §7.4).
  Change sets are the only write path for agents, flows and extensions.
- **IF-6.8** **Validation** before anything is shown: schema, id existence and temp-id uniqueness, cycles,
  locks/finality, mode invariants (`in < out ≤ duration`, adjacency for transitions, port types), capability
  gating for the agent subject, referential integrity, and size limits (≤ 2,000 ops). Results are per op, with
  codes `IF-CS-001…` and a fix, returned to the agent as data. Validation of 500 ops takes ≤ 50 ms.
- **IF-6.9** **Stale views at submission.** An op that writes a field someone else changed after `base`, or whose
  `expect` fails, is not applied and is reported as `IF-CS-010 stale-field { id, field, theirs, yours, fix }`.
  Non-conflicting ops still apply (`partial`, the default), unless the agent asked for `atomic`.
- **IF-6.10** **Proposal layer.** A valid change set becomes a proposal: a forked CRDT layer rendered over Latest
  as a preview (ghosts, diffs, takes). Proposals are CRDT state, so every peer (other tabs, later other users)
  sees them. Accept applies the chosen ops (and their dependencies) to Latest as **one transaction and one undo
  step**, attributed to the author with the accepting human recorded. Reject drops the layer. Accepting one op,
  several ops or the whole set is always possible.
- **IF-6.11** **Conflicts under co-editing** are resolved by CRDT merge semantics, never by blocking. At accept
  time (a proposal that waited while others edited), any op whose target path changed in Latest since the change set's base is **flagged** with both values,
  and the user chooses per op. The default is to keep the current value.
- **IF-6.12** **Deterministic and replayable.** Applying the same change set to the same base yields the same
  tree. New node ids derive from `(changeSetId, applicationId, tempId)`. `capability.run` records its output
  asset on first apply. A replay reuses the output unless "re-run" is chosen. Change sets can be saved as
  parameterized steps in workflow assets (macros, templates).
- **IF-6.13** **Autonomy levels** per agent per document: `suggest` (always a proposal), `auto-apply-safe`
  (default: non-destructive edits apply immediately as undoable steps; generation, deletion and bulk changes over
  20 nodes are proposals), and `autopilot` (bounded by an op count, a generation count and a time box; stops at
  destructive steps for confirmation).
- **IF-6.14** Agents are a distinct gate subject (R6.17). Destructive capabilities need confirmation, through the
  agent client's `requestUserInteraction` for WebMCP calls.
- **IF-6.15** **Handles** (`n1…nN`) are per agent session, mapped to node ids in the editor worker, never reused
  within the session, and kept across worker respawn. Agent temp ids (`new:cta2`) map to fresh node ids and are
  returned in the apply result.
- **IF-6.16** **Format eval before lock-in.** Before M2 ships, a benchmark of about 100 tasks (flyer, deck,
  reaction cuts, flows, each with a concurrent human edit injected) compares markup vs JSON layout views, ops vs
  fragments, and with or without screenshots, across two or three model tiers. Defaults are set from the result.
  A JSON serializer of the layout view (same codec) is kept as a fallback for models that prefer it.

## 7. Authoring engine

- **IF-7.1** **Threads:** main (chrome, input, EditContext, accessibility layer, AudioContext), a per-tab
  **editor worker** (CRDT peer, composition, tools, view state), a per-tab **render worker** (WebGPU), per-tab
  **media workers**, one **store worker** per workspace, and on-demand export and ML workers. ARCHITECTURE §2 is
  normative. **D15:** editor and render are modules with fixed ports; whether they share one worker (default) or
  use two is a boot setting.
- **IF-7.2** **View state is per tab.** Camera, selection, active tool, gesture overlays and lens live in the
  tab's editor worker. They are never in the CRDT and never shared through the store.
- **IF-7.3** **Sequencing invariants E-1…E-6** (ARCHITECTURE §4) are tested invariants: ordered apply, atomic
  supersede of overlays on commit, overlays relative to committed state, one camera, commit on gesture end, and
  animation applied as an override.
- **IF-7.4** **Renderer:** Vello GPU on wgpu/WebGPU in the render worker, behind a `RasterBackend` port.
  Tiles of 512 logical px cached per zoom level, lifted layers for selected, edited and animated elements, and
  LOD. `vello_cpu` is the CI reference rasterizer.
- **IF-7.5** **One compositor** (WGSL, ours) composites tiles, lifted layers, video external textures, effects and
  transitions for every lens and for export.
- **IF-7.6** **Text:** Parley in the editor worker's authoring Wasm produces glyph runs for every output. Fonts
  are assets (Local Font Access bytes, uploads, or curated OFL fonts) shared across workers by content hash.
  Noto fallback subsets load on demand.
- **IF-7.7** **Text input:** EditContext (Chrome) or a hidden-textarea adapter (Firefox) behind one `TextInput`
  port (SF-Δ27). IME candidate windows are positioned from character bounds that the editor worker returns.
- **IF-7.8** **Hit testing and snapping** run in the editor worker: rbush candidates, then a precise kurbo test,
  with ink bounds for effects.
- **IF-7.9** **Boolean ops** (linesweeper) are derived, non-destructive geometry. SVG import goes through usvg.
- **IF-7.10** **Export parity:** one scene IR feeds Vello (PNG and video frames), our SVG writer and krilla (PDF).
  Every IR feature must be handled by every backend (exhaustive match). Pixel parity tests run against `vello_cpu`.
- **IF-7.11** **GPU device loss** recovers within 1 s from the retained CPU-side IR without reloading the
  document (SF-Δ23).
- **IF-7.12** **Accessibility layer:** a virtualized DOM projection (visible region, selection, focus path) with
  roles, names, reading order and keyboard traversal.

## 8. Timeline and media

- **IF-8.1** Video and audio editing is first-class: video, overlay, text and audio **tracks**; import, trim,
  split, move, delete, ripple delete, roll, slip, snapping, linked A/V, constant speed (0.25×–4×,
  pitch-preserving), reverse, freeze frame, volume, fades and crossfades (equal-power).
- **IF-8.2** **Clip model (OTIO-shaped):** placement `temporal { start, duration }` plus `source { asset, in,
  out, speed, reverse, loop }`. Transitions are nodes that bind two adjacent items.
- **IF-8.3** **One evaluator, two clocks.** `evaluate(stage, t) → RenderGraph` is pure (no I/O, no ambient time
  or randomness, seeded PRNG) and is shared by preview, export, thumbnails and agents. Preview is audio-master and
  may drop frames. Export uses a frame counter and waits on a readiness barrier.
- **IF-8.4** **Decode:** Mediabunny demux plus WebCodecs in media workers. A decoder pool with priorities,
  byte budgets and `reset()` cancellation. A keyframe index is persisted at import. Coarse-then-exact scrubbing.
- **IF-8.5** **Proxies** (720p H.264, keyframe every 0.5 s), thumbnail strips and multi-resolution waveform peaks
  are renditions built after import. Preview uses proxies; export uses originals.
- **IF-8.6** **Audio:** the media worker pre-mixes the timeline 100–250 ms ahead into a SharedArrayBuffer ring.
  The AudioWorklet pulls from it, applies the master gain and limiter, meters, and advances the shared sample
  clock. Export runs the same mixer offline.
- **IF-8.7** **Video frames** move between workers as transferred `VideoFrame` handles with close accounting
  (SF-Δ17) and bind as WebGPU external textures.
- **IF-8.8** **Picture-in-picture person cutout:** a clip with a matte from a **baked matte asset** (a
  BiRefNet-class model through ONNX Runtime Web on WebGPU, stored as a luma-mask video, with license-checked
  weights). A live MediaPipe mask is used for instant preview only. Mask shapes, feather, choke, outline and
  shadow are supported. Export always uses the baked matte.
- **IF-8.9** **Captions:** transcription (a Whisper-class model, on device or through the provider) produces a
  transcript asset with word timing. The caption track renders through the text pipeline. Export burns captions
  in.
- **IF-8.10** **Export:** MP4 (H.264 + AAC) by default, WebM (VP9/AV1 + Opus) where encodable, GIF (gifenc),
  image sequence, and audio-only. Codecs are chosen by `isConfigSupported` probes. Output streams to the store or
  a save-picker file, with backpressure, cancellation and GOP checkpoints for resume.
- **IF-8.11** Unsupported source codecs show a placeholder with code `IF-MEDIA-001` and a fix. There is no
  ffmpeg.wasm in V1.

## 9. Motion: animation and transitions

- **IF-9.1** **Keyframes:** every numeric, vector, color, rect, opacity, volume and effect parameter can be
  keyframed. Keys have ids, times relative to the node's start, and interpolation `hold | linear | bezier |
  spring` (springs pre-sampled deterministically). Moving a clip moves its animation.
- **IF-9.2** **Motion presets are assets** (in, emphasis, out, loop; text units `char | word | line` with
  stagger; transitions; zoom/pan; Ken Burns). A node references a preset with parameter overrides. "Bake to
  keyframes" is a capability.
- **IF-9.3** **Transitions between clips and between pages** use the same transition node and preset model:
  dissolve, dip to color, push, slide, wipe, zoom, blur, luma wipe, and **Smart move** (shared elements morph
  between pages, matched by a stable `matchKey`).
- **IF-9.4** **Text animation** is a pure function of `(t, glyph, word, line, seed)` applied after layout and
  evaluated on the GPU: fade up, typewriter, word-by-word, scale pop, mask reveal, karaoke highlight.
- **IF-9.5** **Zoom here / punch-in** writes eased keyframes on scale and anchor (or crop) from a selected
  rectangle or a transcript range, without exposing keyframe UI.
- **IF-9.6** **Animate** is a HUD action on every animatable selection, and also editable in the Timeline lens.
  Both use the same keyframe model.
- **IF-9.7** Editor preview respects `prefers-reduced-motion` (transitions become fades). Export is unaffected.

## 10. Capabilities and generative features

- **IF-10.1** Every action is a `defineCapability` with input/output schemas, a policy, `destructive`,
  `exposeToAgents`, an **applicability predicate** over the selection (SF-Δ11) and **presentation metadata**
  (group, icon, short label, pinned or ranked, examples).
- **IF-10.2** **Dry-run previews:** capabilities that change the document implement `plan(input) → change set`
  and run through the proposal layer (SF-Δ12). `registry.preview` keeps its authorization meaning.
- **IF-10.3** **Plans:** multi-step invocations (chat, autopilot) run as `invokePlan(steps, { atomic })` and
  produce one approval and one undo group.
- **IF-10.4** **Generation is additive.** With no model configured, every deterministic feature works, and
  generative HUD slots show "Connect a model". A document always renders without any model.
- **IF-10.5** **Bring your own model.** V1 provider adapters: OpenAI and Anthropic, for chat with tool use and for
  image, video and audio generation where the provider offers it. Gemini comes later. Keys are entered by the
  user, stored only on the device (encrypted at rest; not protection against page script), and sent only to the
  chosen provider.
- **IF-10.6** **Mocked during development.** Mock providers (scripted chat with tool calls; procedural images,
  video and tones with realistic latency, progress and failure) are the default in dev and e2e. Real providers
  are opt-in per developer.
- **IF-10.7** **Long-running jobs** (generation, matte, transcription, proxies, export) follow one lifecycle
  `queued → running(progress) → succeeded | failed | cancelled`. They resume after reload and appear as
  placeholder nodes. The canvas never blocks on them (SF-Δ14).
- **IF-10.8** **Extend this clip:** given a clip or range, generate a continuation from its last frame (optionally
  to a chosen end frame), with the prompt prefilled from the source recipe. The result lands as a new clip linked
  by provenance with a lineage badge. Regenerate re-runs that step with a new seed.
- **IF-10.9** **Recipes:** generated assets keep their recipe (capability, model, prompt asset, inputs, seed,
  source range), which powers Regenerate, Variants, Extend and the lineage view.

## 11. Flows (graphs)

- **IF-11.1** A **workflow** is a tree asset of `step` and `edge` nodes. A step names a capability, binds inputs
  to edges, asset references or values, and can expose parameters.
- **IF-11.2** **Record → flow:** a selected range of undo-history steps becomes a flow, and touched inputs become
  exposed parameters.
- **IF-11.3** **Collapse into unit:** a flow (or a selection of steps) becomes one capability, registered per
  workspace and exposed to the HUD, the command bar and agents.
- **IF-11.4** **Execution:** steps run through the capability pipeline in topological order with per-step
  progress. Deterministic steps memoize by `hash(capability version, inputs)`. Generative steps memoize only with
  an explicit seed.
- **IF-11.5** **App view:** a flow can be run from a form of its exposed parameters, including batch runs over a
  list of inputs with a grid preview and Apply all.
- **IF-11.6** **Lineage view:** any generated or derived asset can be opened as the graph of how it was made
  (derived from provenance, read-only).

## 12. Interaction and agent UX

- **IF-12.1** **Three surfaces:** a contextual **HUD** at the selection, a **"Say what you need" command bar**,
  and a docked **chat**. UX.md §2 is normative.
- **IF-12.2** **HUD stability:** type chip and direct-manipulation slots are fixed per element type. Only the
  ranked slots change, at most once per selection, and never while the HUD is open. Ranking uses an advisor with
  purpose `ui-ranking` (SF-Δ20) and is presentation only.
- **IF-12.3** HUD appears synchronously (0 ms), acts in ≤ 100 ms, and command-bar local results show in
  ≤ 50 ms.
- **IF-12.4** **Selection is shared context:** a reactive selection (nodes, ranges, lens) is readable by the HUD,
  the command bar, the chat context builder and agents.
- **IF-12.5** **Previews by type:** ghost overlay, before/after slider, A/B/C takes, text diff, timeline diff,
  graph diff. Apply, Reject and Apply part are always present.
- **IF-12.6** **Agents are visible collaborators:** name, color (from a palette separate from design colors),
  cursor with a status line, held-element highlight, and Pause, Stop (aborts in-flight work) and Take over.
- **IF-12.7** **History reads like a log** with actor, via and capability, with Undo and Show diff per entry.
  "Reject agent session" reverts an agent's work since the last approval and names conflicts.
- **IF-12.8** **Density levels** Focus, Standard and Pro are shell workspaces, not branches. Focus leaves the
  canvas ≥ 85% of the viewport.
- **IF-12.9** **Persistent UI docks, transient UI floats.** The right dock is tabbed: Layers, Properties (Pro),
  Chat, Comments, Assets/Library, History & Milestones, and extension panels. The bottom tray holds the filmstrip
  or tracks. HUD, command bar, menus, previews, toasts and agent cursors float. **Dialogs are only for
  Share/Export** (routable `/d/share`) and model-key setup. Every other confirmation is inline (UX.md §3).

## 13. Modes, sharing and export

- **IF-13.1** **Read-only mode** is the same renderer with editing capabilities not declared. It applies to
  milestones, imported viewer files, and documents marked read-only. The HUD offers Copy, Export and "New
  document from milestone".
- **IF-13.2** **Presentation mode:** full screen, no chrome. Pages play with transitions and on-click builds,
  timelines play as video, and flows run as App view. Presenter view in a second window shows notes, the next
  page and a timer.
- **IF-13.3** **Local-first sharing in V1:** `.iflow` (a milestone closure), viewer HTML (a self-contained,
  pre-rendered player of a milestone that runs in any modern browser with no engine), MP4, PDF, PNG and SVG.
  Share links arrive with the cloud.
- **IF-13.4** **Import:** opening an `.iflow` file (file handler, drag and drop or picker) creates new documents
  with fresh baselines (IF-5.7 semantics), deduplicating blobs. A whole-workspace backup zip exists for Firefox
  and for moving between machines.

## 14. Identity and gating

- **IF-14.1** **No authentication in V1.** The `guest` provider gives a stable local identity (`stableGuestId`)
  used for authorship and attribution, with a locally chosen display name.
- **IF-14.2** **Accounts later** plug in an identity provider plus the existing guest-upgrade hook, with no format
  change. Actor ids in documents stay valid.
- **IF-14.3** **Gating is used for:** modes (read-only, presentation), locks and brand rules, capability
  availability (for example "model configured"), platform facts, feature flags, and agent permissions and
  confirmation. Credits and metering wait for accounts.
- **IF-14.4** **Client gating is UX, not security** (rule 9). Nothing in V1 claims access control. Exported files
  are as private as the place you put them.

## 15. Performance budgets (reference: Chrome desktop, mid-range iGPU, 120 Hz)

- **IF-15.1** **Bytes:** boot JS ≤ 150 KB gzip. Editor initial JS ≤ 50 KB gzip. Render Wasm ≤ 300 KB brotli.
  Authoring Wasm ≤ 350 KB brotli. Loro Wasm ≤ 1.25 MB gzip (worker only, service-worker cached). Mediabunny chunk
  ≤ 150 KB brotli. Export extras (krilla, SVG writer) ≤ 400 KB brotli, loaded on export. Budgets ratchet (R12.8).
- **IF-15.2** **Canvas (10k elements):** pan and zoom p95 ≤ 8.3 ms per frame. Drag of up to 100 elements p95 ≤
  8.3 ms. Input-to-present p95 ≤ 1 frame + 4 ms. Time to sharp after a zoom ≤ 250 ms. First canvas frame after
  open ≤ 500 ms warm.
- **IF-15.3** **Playback:** 60 fps for a 1080p project with 3 video layers and text. ≤ 1% dropped frames. A/V
  drift ≤ 16 ms. Play start ≤ 120 ms. Exact seek on a proxy ≤ 60 ms. Coarse scrub frame within 1 display frame.
- **IF-15.4** **Export:** 1080p30 H.264 at ≥ 3× real time.
- **IF-15.5** **Editor worker:** no task longer than 4 ms during an active gesture (chunked with a worker-side
  scheduler, SF-Δ28).
- **IF-15.6** **Store:** a milestone of a 200-page document in ≤ 1 s. Opening Latest of a 50k-node document ≤ 1 s
  warm. GC over 10k blobs ≤ 2 s in the background.
- **IF-15.7** **Memory:** GPU caches ≤ 512 MiB (LRU, pressure-evicted, SF-Δ29). Decoded frames plus textures ≤ 1 GB.
  ≤ 8 concurrent decoders.

## 16. Quality

- **IF-16.1** WCAG 2.2 AA for chrome. Canvas content is reachable by keyboard and screen reader through the
  accessibility layer. Agent actions are announced in a live region. The HUD is a `toolbar` with roving tabindex,
  and `Alt+Enter` focuses it from a selection.
- **IF-16.2** All strings are localized through `@staticflux/i18n`. The chrome supports RTL.
- **IF-16.3** **Golden tests:** `RenderGraph` snapshots compared exactly, pixels compared perceptually
  (SSIM ≥ 0.99 against `vello_cpu`), plus a media corpus of short clips per codec.
- **IF-16.4** **Co-editing tests:** a property-based convergence suite with N peers (tabs and agents), partitions
  and reordering covers every op, ripple edits, proposals and per-actor undo.
- **IF-16.5** Every lifecycle (job, export, proposal, milestone creation, store head swap, decoder session, media
  clock) is a typed state machine mirrored into `docs/LIFECYCLES.md` when built.

## 17. Extensibility (design direction, not V1; D7)

- **IF-17.1** **Extensions extend, never remodel.** An extension uses only the fixed, declared contribution
  points: capabilities and HUD actions, docked panels, storage providers, importers and exporters, model
  providers, declarative element types, and comment actions.
- **IF-17.2** An extension cannot replace core behaviour, patch the engine or renderer, alter the document
  format, or bypass gating, locks, validation or confirmation. It touches documents **only** through capabilities
  and validated change sets, which is the same pipeline as agents (subject `extension`, narrower than `user`).
- **IF-17.3** Every extension ships a **manifest** (DOCUMENT-FORMAT §12) that declares its contributions and its
  permissions: document access (`none | read-views | propose`), asset access (`read | create`), allowed network
  origins, and its own storage namespace. Undeclared access fails with `IF-EXT-001`.
- **IF-17.4** Contributions declare **when** they apply (selection shape, node kinds, roles, lens) through
  applicability predicates. They are never tied to a mode.
- **IF-17.5** Untrusted extensions run in `@staticflux/sandbox` (iframe or worker) and reach the host only through
  granted capabilities. First-party extensions run in-process under the same manifest and permission checks.
- **IF-17.6** **First-party features are built as extensions** wherever a contribution point exists (for example
  the OpenAI and Anthropic model providers, the folder storage provider, the SVG/PDF exporters, the Comments
  panel), to prove the points before third parties use them.
- **IF-17.7** **Custom renderable node types are the hard open problem.** Within D7 they are **declarative types
  composed of core primitives** (a parameter schema plus a pure expansion into a primitive subtree, rendered,
  exported, hit-tested and shown to agents through the existing pipeline). Render-to-texture custom renderers are
  rejected because they would patch the renderer and break export parity. Open: expressiveness (layout,
  animation, interaction) and versioning of type definitions.

## 18. Comments and annotations (design direction, not V1)

- **IF-18.1** Comments are a document primitive with **anchors** to a node, a canvas point (relative to the
  nearest node when over one), a time range (relative to a clip, or story time), a text range, or a graph node.
  Anchors **follow their target** when it moves, retimes or is reparented. A comment whose target is deleted
  becomes orphaned and keeps its last position.
- **IF-18.2** Comments live in a **separate per-document CRDT doc** (the `comments` part). They are co-editable
  like content, but they are **not part of milestone content** and are **excluded from exports and releases**.
- **IF-18.3** Agents can read comments in scope (a `comments` section in views), leave comments, and propose
  change sets that address a comment (the change set links the comment id, and accepting it offers "resolve").
- **IF-18.4** Threads, mentions and notifications come with accounts. V1-era comments are single-level notes
  with author, time and open/resolved status.

## 19. Editor specs and the Studio shell (M1b B0; D16–D19)

- **IF-19.1** **The editor is a composition** (D16): an `EditorSpec` names a lens, a scope (`asset | page | selection |
  time-range | layer`), tools in toolbar order, panels with where they dock (`side | dock | inspector | tray`), HUD actions,
  capabilities, a density (`focus | standard | pro`) and the person's pins. Specs are data (`defineEditorSpec`).
- **IF-19.2** Specs draw only on the **closed vocabulary** of registered contributions: `LensContribution`,
  `ToolContribution`, `PanelContribution`, `HudActionContribution` (multi tokens `*ContributionsToken`, unit helpers
  `*Contribution(item)`) and declared capabilities, compiled by `createEditorRegistries` into the framework vocabulary
  (R13.25). Duplicate ids or unknown lenses are `IF-SPEC-002`.
- **IF-19.3** Applicability is data: a contribution's `lenses` and `scopes` become `when` conditions; a lens's `scopes`
  limits what it can open. A spec naming a tool outside its lens or a lens outside its scope is rejected (SF-SHELL-011).
- **IF-19.4** Untrusted specs (agents, saved specs) are parsed with `parseEditorSpec` against `EditorSpecSchema` (strict,
  per-scope required fields); malformed input is `IF-SPEC-001` with JSON paths. Agents get the JSON Schema from
  `proposeSpecCapability`.
- **IF-19.5** Specs are **gated** through `@staticflux/gate` (`gateSpecDecide(gate, subject)`): a spec proposed by an agent
  is decided as the agent (principal ∧ agent policies, R6.17); capabilities are gated at the `capability` level. Specs never
  bypass locks, brand rules or gating (D13).
- **IF-19.6** Spec changes are **minimal animated diffs** (R13.27–R13.28) with 120–200 ms motion, 0 under reduced motion;
  pinned slots stay (R13.29).
- **IF-19.7** **Spec lifecycle in a turn**: `proposed → validated → (previewing) → mounted`, or `rejected | declined |
  superseded | failed` (LIFECYCLES §20). Routing is a table over source × autonomy (D13): people and presets mount; agents
  preview in Plan and Ask and mount in Accept edits and Autopilot. Acting on a settled proposal is `IF-SPEC-003`.
- **IF-19.8** The agent seam (M2): `SpecProposer` (`SpecProposerToken`, `pull(proposer)`; a failed turn is `IF-SPEC-004`,
  nothing changes) and `proposeSpecCapability` through the capability pipeline. Tested with a scripted proposer.
- **IF-19.9** **Studio is a spec** (D19, canvas-first): `studioSpec` — the Canvas lens over the asset, the full toolbar,
  chat as a contextual side panel, the tabbed dock (Layers, Pages, Assets, Brand), Properties in the inspector, the HUD and
  the editor capabilities, at Pro density. Modes are well-known specs: `studioSpecFor(lens)` (variant tables per lens).
- **IF-19.10** Mini editors are narrow specs over the same engine; the example is `pixelTouchUpSpec(nodes)` (Pixel lens on a
  selection, three tools, the Adjust panel, one ✦ action, Focus).
- **IF-19.11** **The Studio shell** (`<if-studio>`, `createStudio`) is laid out from the mounted spec only, with kit
  components under the active theme (Clean Pop), matching `design/StudioCP.dc.html` structurally: top bar (home, breadcrumb,
  lens mode switcher with lens shapes, save state, agent chip, density, Milestone, Share), side panel, tabbed left dock,
  canvas region (tools, HUD slot, canvas surface, command bar, zoom, proposal card) and inspector.
- **IF-19.12** **Density** (UX §3): Focus collapses the side panel and dock to rails, Standard opens them, Pro opens
  Properties (`PanelContribution.minDensity`); a density change is a spec change; the person can open a collapsed dock.
- **IF-19.13** **Studio is fully usable by hand** (D17): every spec change has a non-agent path (mode switcher, density
  switch, pin buttons, keyboard). Keyboard: `1`–`4` lenses, tool letters (not while typing), `Alt+Enter` HUD, `Mod+K`
  command bar, `Escape` back to the canvas; toolbar, HUD, mode switcher and dock tabs follow their APG patterns.
- **IF-19.14** The canvas region mounts the A7 editor and render modules behind their ports (`CanvasPort`,
  `sequencingCanvas`); a canvas that cannot start is an inline alert (`IF-SPEC-005`) and the rest of Studio stays usable.
- **IF-19.15** The shell passes the testkit a11y audit (names, ARIA references, roles, nested controls) and its DOM satisfies
  `runSpecMountPortContract`.

## 20. Elements, styles and geometry (M1b B1)

Code: `apps/instaflow/src/elements` (TypeScript), `apps/instaflow/engine/crates/authoring/src/geometry` (Rust), scene IR v2
in `crates/render` + `src/render/scene-ir.ts`. Error codes `IF-EL-001…007`.

- **IF-20.1** **Element kinds** are typed `@staticflux/document/v2` components: `frame` (sized container that clips),
  `group` (free container; with `geometry.boolean` a live boolean), `shape` (`geometry.shape`: rect, ellipse, polygon, star,
  line), `vector` (`geometry.path`, SVG path data in the local box) and `image` (`source.asset` = a blob asset, `image.fit`).
  Text is B2's and plugs into the same components (`ELEMENT_COMMON_COMPONENTS`).
- **IF-20.2** **Transforms**: `spatial` (x, y, w, h, rotation clockwise in degrees, scale, anchor, flips, opacity, blend mode).
  x, y is the unrotated box's top-left; rotation, scale and flips act about the anchor.
- **IF-20.3** **Appearance stacks** (`style.fills`, `style.strokes`, `style.effects`): ordered, reorderable, toggleable
  (`visible`) lists with stable item `id`s. Fills: solid, linear, radial, conic gradients and images (cover, contain,
  stretch, tile), each with its own opacity and blend. Strokes: colour or gradient, uniform or per-side width (rects,
  frames, images), inside / centre / outside, dash pattern and offset, caps, joins, miter limit, own opacity and blend.
  Effects: drop and inner shadows (x, y, blur, spread, colour; several), outer and inner glows, layer blur and background
  blur. Values are plain data so they can be animated later.
- **IF-20.4** **Corner radius** on every element with corners: `style.radius` (linked) and per-corner
  `radiusTL/TR/BR/BL` (unlinked) on rects, frames and images; polygon vertices and star tips (`radius`) and a star's inner
  vertices (`radiusInner`); per-vertex radii on vector paths (`geometry.vertexRadii`). `style.smoothing` 0…1 gives smooth
  (squircle-like) corners. Radii scale down together when adjacent corners do not fit and never exceed half the shortest
  side. Masks, clips, strokes and shadows follow the rounded outline.
- **IF-20.5** **Versioned components with migrations**: `style` is version 2 (v1 = DOCUMENT-FORMAT §3.2's draft single
  `fill` / `stroke`); canonical parts written with v1 upgrade on read (`migrateComponentValues`).
- **IF-20.6** **Brand kits**: a `brand-kit` asset whose root (`kit`) holds `brand.tokens.<name>` (colours, numbers, fonts,
  effect presets, aliases to other tokens) and `brand.rules`; its `class` children are named style classes. Any colour,
  size or effect value may be `@name`. The stage's token rule resolves top-level tokens with provenance; tokens inside
  stacks resolve against the same kit; unresolved tokens are reported (`issues`) and draw nothing.
- **IF-20.7** **Style classes**: `style.inherit = { kit, class }` composes the class as the stage's `inherit` arc; a local
  value is an override visible in provenance (`overridesOf`), and resetting it (`null`) brings the class back. Class
  `policy.final` paths cannot be overridden (SF-STAGE-003 ↔ IF-CS-013).
- **IF-20.8** **Brand rules** (`{ when: { role, kind }, path, allow, severity }`, e.g. "CTAs use @primary") are enforced on
  every write through the undo service's write guard (`brandRuleGuard`, `IF-EL-003`) for people and agents; `warn` rules
  and existing content show as lints (`lintBrandRules`). Client gating is UX, not security.
- **IF-20.9** **Locks** (`lock.scope`, `lock.policy`) are enforced by the stage on every element action and panel edit
  (SF-STAGE-001/002); position-locked elements stay put in align/distribute and still count as anchors.
- **IF-20.10** **Geometry in the authoring Wasm** (kurbo 0.13.1, linesweeper 0.5.0): shape outlines, rounded and smooth
  corners, SVG path parsing, transforms, booleans, stroke outlines (with dashes), exact bounds, ink bounds, hit tests and
  marquee tests behind `GEOMETRY_VERSION` 1; TypeScript wraps them as `GeometryService` (`IF-EL-005`, loader `IF-EL-006`).
  Budget: authoring Wasm ≤ 350 KB brotli (measured 119.1 KB brotli with geometry only; render Wasm 191.1 KB with IR v2).
- **IF-20.11** **Booleans** (IF-7.9): union, subtract, intersect, exclude as **live** boolean groups whose operands stay
  editable children; the result is derived (never stored), robust on self-intersecting input (property tests on random
  polygons, Rust and TypeScript). Release puts the operands back; **Flatten** bakes a vector path; **Outline stroke** turns
  each stroke into a filled vector.
- **IF-20.12** **Masks** are first-class and non-destructive: any element or group with `mask.mode` (clip = its geometry,
  alpha, luminance; `mask.invert`) masks the siblings after it in its parent; text and images can be masks; releasing
  (`mask.mode = null`) restores everything. `mask.asset` names a matte image (S9) used as the mask's alpha.
- **IF-20.13** **Bounds for tools and the spatial index**: page-space geometry bounds, ink bounds (strokes, shadows, glows,
  blur; clipped by a non-inverted mask), centres, container (frame/page) bounds and centres, sibling bounds (smart guides,
  B3), and precise hits honouring fill, stroke and masks.
- **IF-20.14** **Layout grids** (`layout.grids` on frames and pages): columns and rows (count, gutter, margin, alignment,
  size) and a square baseline grid, several per container with a visibility toggle; `gridLines` gives exact lines and
  tracks for snapping (B3); they draw as a non-printing overlay (`gridOverlayBatch`) and never export.
- **IF-20.15** **Align** left / centre / right / top / middle / bottom to the selection, the container, the page or a key
  object, and **centre in container** as one action, on exact page-space geometry (rotation and curves included).
- **IF-20.16** **Distribute** horizontally or vertically by equal gaps (first and last stay) or by centres; **tidy up**
  snaps a rough grid into even rows and columns.
- **IF-20.17** **Every action is one change set and one undo step** (`commitEdit`): element values validated
  (`IF-EL-001`), locks and finals checked, brand rules guarded; inapplicable selections are `IF-EL-004`.
- **IF-20.18** **Match keys** (`lineage.key`) give every element a stable lineage for Smart Move (M4): duplicates of an
  element or a page keep it (fresh node ids); it is persisted in canonical parts and `.iflow`; repeat generators (B7) give
  instances the source's key plus an instance suffix.
- **IF-20.19** **Render projection**: the composed stage → `ElementProjection` (A7 `defineRenderProjection`: affine, size,
  opacity, blend, flags, mask, look and path ids) plus interned **resources** (looks, paths, stroke rings) sent before the
  delta that uses them → the render module's scene store → scene IR (`createElementSceneEncoder`, only changed nodes).
- **IF-20.20** **Scene IR v2** (A6 renders it on Vello GPU and vello_cpu): fill and stroke stacks with opacity and blend,
  conic gradients, dashes, ring strokes, per-corner rects, image fit, even-odd, drop / inner shadows (spread), layer and
  background blur, and masks (clip, alpha, luminance; invert). Ink bounds include effects so tiles never clip shadows.
- **IF-20.21** **Golden tests**: the TypeScript writer is byte-identical with Rust on the `elements` and `appearance`
  fixtures; the element pipeline's scene is a committed projection snapshot, a vello_cpu reference (cargo test) and a GPU
  golden plus GPU-vs-CPU parity on SwiftShader (`pnpm test:gpu`).
- **IF-20.22** **Contributions** (B0): each action is a capability (`instaflow/align-left`, …, `instaflow/flatten`,
  `instaflow/mask-luminance`, `instaflow/apply-token`; exposed to agents, gated per subject) with a HUD action running it;
  shortcuts give the keyboard path.
- **IF-20.23** **The Fill / Stroke / Effects panel** (`instaflow/appearance`, inspector placement) is built only from kit
  components under Clean Pop: per-item show/hide, reorder, remove and add; colour, opacity, blend, width, dash, position;
  effect parameters; corner radius with a link toggle and a smoothing slider; layer opacity and blend; brand-token pickers.
- **IF-20.24** The panel is a view over a headless model (`appearanceModel`) and emits `AppearanceEdit`s
  (`appearanceEditOps`); it passes the testkit a11y audit and every control is keyboard reachable.

| Code | Meaning |
|---|---|
| `IF-EL-001` | Element value has the wrong shape (paint, stack item, effect, radius, grid, mask, geometry) |
| `IF-EL-002` | Unknown brand token, or a token of the wrong type for the field |
| `IF-EL-003` | Write breaks a blocking brand rule |
| `IF-EL-004` | Action does not apply to the selection |
| `IF-EL-005` | Geometry engine rejected the input |
| `IF-EL-006` | Authoring Wasm missing or wrong geometry version |
| `IF-EL-007` | Style class or brand kit unavailable |

## 21. Text (M1b B2)

Code: `apps/instaflow/src/text` (TypeScript), `apps/instaflow/engine/crates/authoring/src/text` (Parley), glyph drawing and
fonts in `crates/render` (scene IR v3), the `TextInput` port in `@staticflux/surface/text-input` (SF-Δ27, R11.54–R11.57).
Error codes `IF-TXT-001…010`. Lifecycles: LIFECYCLES §22. Implements IF-7.6 and IF-7.7.

- **IF-21.1** **Text element**: node kind `text` with B1's common element components (spatial, style, mask, lineage, lock)
  plus `text` (`content` rich text, `box`: auto-width / auto-height / fixed, `align`, `verticalAlign`).
- **IF-21.2** **Rich text** is CRDT text with A4 v2 marks: `bold`, `italic`, `underline`, `strike`, `size`, `weight`,
  `letterSpacing`, `color` (CSS colour or `{ token }`), `font` (`{ font: sha256 }` asset or `{ token }`), `link`
  (`{ href }`: http(s), mailto, #). Values are validated (IF-TXT-001).
- **IF-21.3** **Paragraph styles** (`align`, `list`, `lineHeight`, `spaceBefore`, `spaceAfter`, first-line `indent`) are marks on
  each paragraph's terminating break; the content always ends with a break. Enter copies the paragraph style; deleting a
  break keeps the first paragraph's style.
- **IF-21.4** **Anchored ranges**: selections and comments anchor to text (`anchorRange` / `resolveRange`) and survive
  concurrent edits; concurrent rich-text edits converge with marks covering the same characters (property-tested).
- **IF-21.5** **Mark expansion** is one table (`TEXT_MARK_EXPAND`): style marks grow when typing at their end, links and
  paragraph marks never grow. Every peer uses it.
- **IF-21.6** **Brand tokens** in colour and font marks resolve through the brand kit at layout time; an unresolved token
  falls back to the element default and is reported (IF-TXT-009), never fatal.
- **IF-21.7** **Layout**: Parley 0.12 (HarfRust shaping, ICU4X bidi and line breaking) in the `authoring-text` Wasm, no system
  fonts. Paragraphs are laid out separately (own alignment) and stacked. Per-script fallback families (S3).
- **IF-21.8** **Shaping parity**: glyph ids and positions equal HarfBuzz on 40 Arabic and 40 Devanagari strings (100%),
  with a negative control.
- **IF-21.9** **Layout output** is one encoded array: paragraphs, lines (bounds, baseline), glyph runs (font, size, brush,
  direction, synthetic bold/italic, variation coordinates, glyphs), clusters, words, decorations (underline, strikethrough).
- **IF-21.10** **Caret and selection**: hit test, caret rect (with affinity), selection rects (bidi aware), per-UTF-16 character
  bounds (for the IME), word at offset, caret motions (visual left/right, words, line start/end, up/down with a sticky
  column, grapheme boundaries). Caret → hit test round-trips for every offset.
- **IF-21.11** **Complex scripts**: dictionary line breaking (Thai, Lao, Khmer, Myanmar) is a lazy `authoring-text-complex`
  chunk loaded only when the text needs it; it gets the same fonts, fallbacks and font ids.
- **IF-21.12** **Animation addressing**: `clusters()`, `words()` and `lines()` of a layout have stable indices for a given text
  and layout (clusters in logical order, words between UAX #29 word starts), with bounds; glyphs name their cluster. No
  animation is built here (M4 Auto Animate uses it).
- **IF-21.13** **Scene projection**: a text element becomes a group with one glyph leaf per run (fill from the run's brush)
  and one rect per decoration (`textSceneNodes`).
- **IF-21.14** **Fonts in the render scene** are retained by content hash (scene IR v3 `FONT`/`DROP_FONT`): bytes once, aliases
  afterwards, released when no id references them; a resnapshot never resends bytes.
- **IF-21.15** **Glyph drawing**: Vello fills each run as one path from unhinted outlines (TrueType via skrifa's glyf scaler,
  CFF/CFF2 via read-fonts), with variation coordinates, synthetic italic (shear) and bold (stroke); GPU output matches
  vello_cpu for Latin, Arabic and Devanagari (golden render tests).
- **IF-21.16** **Fonts are assets keyed by sha-256** (the blob digest): uploads (.ttf, .otf, .ttc; WOFF rejected) are stored
  in the workspace blob store; documents reference fonts by hash and load them from the store.
- **IF-21.17** **Local Font Access** follows a permission flow (`instaflow/local-fonts`): availability fact, permission
  state, request from a user gesture, denied state with guidance (IF-TXT-007/008); picked faces are copied into the
  workspace so documents work elsewhere.
- **IF-21.18** **Brand-kit font tokens** resolve to font assets (`BrandTokenSource.font`).
- **IF-21.19** **Accessibility data** for B6: plain text, paragraphs and lines with bounds, links, the selection while
  editing, and a role from the element's semantic role (`headline` → heading level 1, …; `textbox` while editing).
- **IF-21.20** Variable fonts keep their variation coordinates from layout to drawing (S3: CJK fonts default to weight 100).
- **IF-21.21** **Text input** goes through the `TextInput` port; the implementation (EditContext or hidden textarea) is a
  variant binding on the `editContext` platform fact. `?input=textarea` style overrides are data, not branches.
- **IF-21.22** **Editing session**: typing, paste, deletes by grapheme / word / line from the layout, Enter (paragraph split),
  arrows / Home / End / Select All, typing style (Bold on a collapsed selection), each change one undo step with a label.
- **IF-21.23** **IME compositions** are local previews (underlined) until commit; the IME is positioned from selection bounds
  and per-character bounds of the composition (pushed on every update and on request).
- **IF-21.24** Remote edits refresh the session without losing the selection range.
- **IF-21.25** **Human IME check** (owner, desktop Chrome, Japanese / Chinese / Korean): candidate window at the composition,
  following wraps and RTL, under page zoom. **INCONCLUSIVE** until confirmed (`src/text/ime-check/`).
- **IF-21.26** **Text tool** (`T`, Canvas and Pages lenses; Studio's toolbar): click places an auto-width text element, drag sets a width (B3 runs the
  pointer flow; `placeTextOps` creates it).
- **IF-21.27** **Typography panel** (`instaflow/typography`; Studio places it in the inspector of the Canvas and Pages
  lenses, Pro density like Properties) from kit components: font, size, style toggles,
  alignment, line height, colour (hex and brand tokens), Fit to box; mixed values shown as Mixed.
- **IF-21.28** **HUD actions** on selected text: Font, Size, Fit to box (scales every run so the laid-out height fits the box).
- **IF-21.29** **Typography service**: the same commands for the panel, the HUD, shortcuts and agents (one pipeline).

| Code | Meaning |
|---|---|
| `IF-TXT-001` | Invalid text style value |
| `IF-TXT-002` | Not a text node |
| `IF-TXT-003` | Offset or range outside the text |
| `IF-TXT-004` | Authoring text Wasm missing or wrong ABI |
| `IF-TXT-005` | Layout engine rejected a request |
| `IF-TXT-006` | Not a usable font file |
| `IF-TXT-007` | Local Font Access refused (permission or gesture) |
| `IF-TXT-008` | Local Font Access unavailable |
| `IF-TXT-009` | Brand token unresolved |
| `IF-TXT-010` | Font blob store failure |

## 22. Versioning in M1 (work package B5; D2, D9, D10)

Refines §5 for the M1 build (`apps/instaflow/src/versioning`). Errors are `IF-VER-001…010`; lifecycles in
`docs/LIFECYCLES.md` §23.

- **IF-22.1** The Latest service turns commit acknowledgements into a save state `saving | saved |
  offline-mirror-behind` for the top bar. `saving` turns `stalled` ("Not saved yet: <cause>") after 2 s without an
  acknowledgement or on an append failure, and a failed flush is retried until it succeeds (IF-5.2).
- **IF-22.2** `offline-mirror-behind` is shown only when every commit is durable in the browser store and the folder
  mirror is paused (permission lapsed) or failing; a mirror that is merely batching shows `saved`.
- **IF-22.3** Creating a milestone flushes Latest, captures canonical parts, writes the record (its digest is the
  milestone id), prepends it to `head.app.versioning.milestones` by compare-and-swap with retry, then flushes the folder
  mirror. A failed mirror flush is reported (`mirrored: false`) but never undoes the milestone. Creations queue (one at
  a time per document).
- **IF-22.4** A milestone writes **only changed parts**: a part whose CRDT frontier did not move since the last capture is
  not re-encoded, and a canonical digest already known (the newest milestone's parts) is not written again.
- **IF-22.5** Pin and rename are head fields (`pinned`, `names`); they never rewrite an immutable record. Names are 1–120
  characters after trimming (IF-VER-001); notes at most 2,000.
- **IF-22.6** Opening a milestone is read-only and reads only its record and the parts actually viewed (lazy, cached
  per part, `parse → migrate` on read). No CRDT is created.
- **IF-22.7** Compare opens two read-only documents side by side: two milestones, or a milestone and Latest frozen at that
  moment (a snapshot, not a milestone). It offers no structural diff.
- **IF-22.8** **Cost is independent of age:** creating a milestone reads the head and the newest record only (never the
  list); opening and New document read the record and each part once. A deterministic test holds store operations and
  bytes equal at ages 3, 20 and 60; a bench file reports the wall-clock numbers.
- **IF-22.9** New document from milestone writes a new head (generation 1) whose parts are rebuilt from canonical parts
  with one fresh peer and one commit of history, keeps node ids, and refuses an asset id in use (IF-VER-008). The new
  asset record carries `createdFrom { asset, milestone, title }` as a label only; nothing in the new head names a source
  object, so the copy opens and edits with every source object deleted, and edits on either side never reach the other.
- **IF-22.10** Templates mark slots on existing elements — text, image or colour — as the `slot` component (`name`,
  `accepts`, `target` path, `required`, `maxChars`). Marking and unmarking are ordinary commits through the stage undo
  service (one undo step per actor). Slots sharing a name must accept the same kind.
- **IF-22.11** Using a template is New document from milestone plus slot filling: one fill fills every slot of its name;
  text keeps the first span's marks; image fills take an asset id, colour fills a hex colour; markers are dropped unless
  `keepSlots`. Unknown slot names, wrong value types, over-long text (IF-VER-006) and empty required slots (IF-VER-007)
  fail before anything is written.
- **IF-22.12** The frozen export snapshot is a content-addressed manifest (`sn_…`) over canonical parts of what is
  applied in memory when the export starts. It writes blobs only: no record, no head change, no list entry (D10). Its
  parts dedupe with milestones by digest.
- **IF-22.13** A `ReleasePort` hook exists for publishing (rendered outputs + frozen snapshot + "published from" label);
  M1 binds `unavailableReleasePort` (IF-VER-009).
- **IF-22.14** The Milestones panel (`<if-milestones-panel>`) offers create (name, note), the list (name, date, pinned),
  open read-only, compare (one with Latest, or two side by side), pin, rename and New document from milestone, built only
  from kit components under Clean Pop with the design's button variants, fully usable by keyboard, results announced
  in a polite live region.
- **IF-22.15** The top bar's save status (`<if-save-status>`) shows the save state in words in a polite live region
  (kit `<sf-status>`).
- **IF-22.16** "Milestone" is one capability (`instaflow/create-milestone`, `Mod+Alt+S`) for the top bar, the palette and
  agents: with a name it creates the milestone as the invoking actor; without one it opens the panel's name field.

## 23. Library and lenses in M1 (work package B4; D4, D19; IF-1.3, IF-3.5–3.10)

- **IF-23.1** The workspace **library document** is the `library` asset of the workspace's `DocumentRepo`
  (`heads/library.json`, one part `root`), created on first open (`openLibraryDocument`). Each listed asset is one
  top-level `asset` node (id = the asset id) with the `library` component (`libraryRegistry`, version 1); reads are per
  node and every write is a validated op batch committed through the open document (one commit per action).
- **IF-23.2** Library metadata is mutable and lives only in the library document: title (1–200 characters), tags
  (1–40 characters, lower case, no commas, a CRDT list deduplicated on read), folder (`/`-separated names of 1–60
  characters), favourite, trash state and time. Invalid metadata is `IF-LIB-007`; an unknown asset `IF-LIB-003`; listing
  an id twice `IF-LIB-008`.
- **IF-23.3** **Trash is a state**, not a delete: `trash` stamps `trashedAt`, `restore` clears it. `gcRoots()` returns live
  entries plus trashed ones younger than 30 days (`TRASH_RETENTION_MS`, IF-3.10 grace period).
- **IF-23.4** Ingest classifies a file by its media type, its aliases or its extension (`MEDIA_TYPES`,
  `EXTENSION_TYPES`; data) into a blob asset kind before reading a byte; anything else is `IF-LIB-001`.
- **IF-23.5** An import is listed at once under a **provisional id** (`pv_…`) with its progress (`pending()`), and
  `resolve(pv)` names the asset once listed (IF-3.5: usable before hashing finishes).
- **IF-23.6** Content is hashed and stored by `@staticflux/blob` (`BlobStore.put`: SHA-256, chunk manifests above 8 MiB,
  progress, cancellation). The same bytes already live in the library return that entry (`deduplicated`); no second
  asset is listed. A store failure is `IF-LIB-002`; cancellation is `SF-CORE-002` and lists nothing.
- **IF-23.7** The kind's **media probe** (a data table; images: decode once) records media facts (width, height,
  alpha); a decode failure is `IF-LIB-005` and lists nothing.
- **IF-23.8** Every import writes one immutable **`instaflow.asset/1` record** (canonical JSON, RFC 8785, stored as a
  `application/vnd.instaflow.asset+json` blob) with `content`, `media` and C2PA-aligned provenance (`imported`, actor,
  no ingredients; IF-3.8), then lists the entry pointing at the record and the content.
- **IF-23.9** **Renditions** are derived, regenerable blobs recorded in the library document
  (`library.renditions.<role>`), never in the immutable record. `RENDITION_PRODUCERS` (data) says which roles each kind
  gets; in M1 images get a `thumbnail` fitted in 256 × 256 px, never upscaled.
- **IF-23.10** Rendition jobs are background work: a queue (concurrency 1 by default) with one machine per job
  (`instaflow/rendition-job`); a job writes nothing before its blob is stored, so a cancelled or failed job leaves no
  trace (`IF-LIB-006` with the cause). `resume()` re-queues every live entry still missing a rendition (resumable across
  sessions); regenerating with the same params gives the same blob (deterministic PNG).
- **IF-23.11** Thumbnails render **through the A6 render path** where a raster backend exists
  (`sceneThumbnailRenderer`: the pixels become one scene IR image node rendered headlessly by the backend at the target
  size, then the scene is cleared; jobs serialized per backend). The **documented fallback** is
  `scaleThumbnailRenderer` (CPU area averaging) for contexts without WebGPU. The choice is a DI binding, never a branch.
- **IF-23.12** The **Assets panel** (`<if-library-panel>`, the `instaflow/assets` panel contribution) is built only from
  kit components under Clean Pop: Import (the one primary action), search, a filter switcher (`LIBRARY_FILTERS`: all,
  images, video, audio, designs, favorites, trash; predicates in a table), the asset list, a preview of the selected
  thumbnail (12 px corners), an actions toolbar (Place, Favorite, Rename, Trash/Restore) and an inline rename form. Each
  row carries the lens mark of its kind (`ASSET_KIND_LENS`, the typed lens palette).
- **IF-23.13** Every Assets panel action has a keyboard path: Tab order Import → search → filter → list → toolbar; in the
  list Enter places, Delete trashes (restores in Trash), F2 renames; Enter / Escape in the rename field; dropping files has
  the Import button as its keyboard path. Results are announced in a polite live region; the panel passes the testkit a11y
  audit.
- **IF-23.14** Placing an asset and picking files are host ports (`LibraryHost.place`, `pickFiles`; element creation is
  B1/B3's). `browserPickFiles` uses a transient file input (never laid out) and reports a cancelled pick as `SF-CORE-002`.
  Thumbnail object URLs load lazily and are revoked with the panel.
- **IF-23.15** **One authoring core, lenses as features** (IF-1.3, D4, D19): a lens's arrangement, focus and overview are a
  `LensFeature` looked up by lens id in the feature registry (`LensFeaturesToken`). Pixel, Timeline and Flow fall back to
  the Canvas feature. No code outside a feature asks which lens is mounted; lens chrome comes from the spec's variant
  tables (`STUDIO_LENS_TOOLS`, `STUDIO_LENS_HUD`, `STUDIO_LENS_PANELS`).
- **IF-23.16** The lenses read the composition from its root part only (`readCompositionStructure`: the `composition`
  node, page stubs in story `order` with `page.size` and `page.canvas` as `vec2`, loose elements with a `spatial` box);
  a page without a valid size takes `composition.format`, else 1080 × 1350. A part without a composition is `IF-LIB-010`.
- **IF-23.17** **Pages lens** (`instaflow/lens-pages`, Layout palette, shortcut `5`): pages at their own sizes stacked
  down a centred column in story order, no loose elements; navigation follows the story; focusing a page fits it.
- **IF-23.18** **Canvas lens** feature (`instaflow/lens-canvas`): pages at `page.canvas` plus loose elements; unplaced
  pages go to the right of everything placed, in story order; navigation is reading order (rows top to bottom, left to
  right); focusing keeps the zoom when the page fits at it, else fits it.
- **IF-23.19** The **lens controller** follows the mounted lens and the root part reactively: a lens switch re-arranges and
  keeps the focused page in view (or shows the overview), remote edits re-arrange, a deleted current page is forgotten.
  The camera is the canvas's; the controller only asks the `CameraPort` to show one. Unknown pages are `IF-LIB-011`.
- **IF-23.20** Page navigation has keyboard paths from anywhere in Studio (`bindLensShortcuts`): PageDown / PageUp next and
  previous, Mod+Home / Mod+End first and last, Alt+0 fit everything; never while typing.
- **IF-23.21** **Story edits**: moving a page in the story is one `move` of its stub in the root part, one commit,
  attributed and undoable per actor (`createStoryWriter`); an index out of range is `IF-LIB-013`.
- **IF-23.22** The **Pages panel** (`<if-pages-panel>`, the `instaflow/pages` panel contribution) lists the story in order
  from kit components only; selecting a page shows it through the controller, Alt+↑/↓ moves it in the story, the toolbar
  has Previous, Next and Fit all; announcements go to a polite live region; it passes the testkit a11y audit.

## 24. Tools: hit testing, selection, transforms, smart guides and snapping (M1b B3; IF-7.2, IF-7.8)

Code: `apps/instaflow/src/tools` (editor worker, headless; export `@instaflow/app/tools`). Error codes `IF-TOOL-001…004`.
Lifecycle: LIFECYCLES §25.

- **IF-24.1** **Per-tab view state** (IF-7.2): camera (pan, zoom 0.02–256), selection, the entered container, the active
  tool, hover and the tool overlay live in the tab's editor worker (`createViewState`, `createViewStates`); they never enter
  the CRDT or the store, and two tabs on one document keep independent cameras and selections. Bad cameras and unknown
  tabs are `IF-TOOL-003`.
- **IF-24.2** **Hit testing** (IF-7.8): a broad phase over A7's rbush spatial index of B1's page-space ink bounds, then an
  exact narrow phase on B1 geometry in the authoring Wasm (kurbo: fills, strokes, tolerance), honouring masks, frame
  clips and live booleans (operands stand for their boolean group). The topmost hit in paint order wins.
- **IF-24.3** The **element index** of a page is bulk-built once and kept current from the stage's invalidations (a moved
  container re-indexes its subtree; deleted nodes drop), refreshed lazily before a query and disposed with its scope.
- **IF-24.4** **Selection targets**: a click selects the child of the entered container under the pointer, seen through
  frames (transparent) but not into groups (opaque); Mod+click selects the leaf itself; a double click or Enter enters a
  group or frame, Shift+Enter selects the parent, a click on empty canvas leaves it. Fully locked elements (position and
  content) are not selectable on the canvas and let the click through.
- **IF-24.5** **Click and marquee**: click selects, Shift+click toggles, pressing an element of a multi-selection keeps it
  for dragging (releasing without a drag selects just that element), a click on empty canvas clears. A drag on empty
  canvas is a live **marquee** over the entered container's children (exact geometry: touched; with Alt: fully inside);
  Shift adds to the selection; Escape restores the selection from before the marquee.
- **IF-24.6** **Transform handles** are round (Clean Pop): eight resize handles and four rotate zones outside the corners,
  sized in screen pixels; one element's frame follows its rotation, several elements use the union of their bounds.
- **IF-24.7** **Move, resize, rotate** work in page space and write `spatial.*` in each element's parent space (nested and
  rotated containers included). One element resizes in its own frame with the opposite handle fixed on the page;
  Shift keeps the aspect ratio, Alt resizes about the centre, sizes never go below 1. Several elements scale with their
  frame. Rotation is about the frame centre; Shift snaps it to 15°.
- **IF-24.8** **Snap targets** per gesture: edges and centres of the moving elements' siblings (snapping to other
  elements, plus optional extra elements), the container's edges and centre lines, and the lines of the container's layout
  grids (B1 `containerGrids` / `gridLines`).
- **IF-24.9** **Snapping** picks per axis the nearest candidate within 6 screen pixels (divided by zoom) over the box's
  min edge, centre and max edge; a resize snaps only the dragged edges (axis-aligned frames); Mod disables snapping while
  dragging; Shift locks a move to one axis.
- **IF-24.10** **Equal spacing**: a moving box snaps to the centre between its row neighbours, or to a gap that already
  exists between two boxes of its row, next to the nearest neighbour on either side; the equal gaps carry **distance
  labels**.
- **IF-24.11** **Smart guides** show every line the snapped box touches (edges, centres, container centre lines, grid
  lines) and the equal gaps; they render as a non-printing overlay and never reach the document or an export.
- **IF-24.12** **Snapping properties** (fast-check): the snapped box is never further than the threshold from the input,
  and snapping a snapped box again moves it by zero (stable).
- **IF-24.13** **Align, centre in container and distribute** are B1's actions and capabilities (IF-20.15–20.16); the tools
  reuse them and define no duplicates.
- **IF-24.14** **One drag is one undo step**: while dragging, new values are previews in the stage's session layer (drawn
  through the render projection, never persisted); release commits them as one change set through B1's `commitEdit`
  (value shapes, locks, final paths, brand rules). Escape or pointercancel commits nothing and clears the preview.
- **IF-24.15** **Locks**: position-locked elements never move (they stay out of the gesture); a gesture or command with
  nothing movable is `IF-TOOL-002`. The stage checks every committed write as well (SF-STAGE-001…003).
- **IF-24.16** A target deleted during a gesture (collaborator, agent) is dropped and pruned from the selection; when every
  target is gone, nothing commits (`IF-TOOL-004`). Pointer events out of order are `IF-TOOL-001`.
- **IF-24.17** The **overlay** (selection frame, round handles, hover outline, marquee, guides) is its own scene IR batch
  (`toolOverlayBatch`) with stroke widths constant on screen and colours from the active theme's tokens (Clean Pop
  `accent`, `surface1`, `accentSubtle`); no colour is hard-coded.
- **IF-24.18** Distance labels render as kit tags (`<sf-tag mono>`, `guideLabelTemplate`) placed in screen space.
- **IF-24.19** **No branch on mode** (rule 4): what a press starts is data (`PRESS_GESTURES[behaviour][pressTarget]`), each
  gesture kind is a strategy (`GESTURES`), a tool's pointer behaviour comes from `TOOL_BEHAVIOURS` and the arrow keys'
  meaning from `ARROW_ACTIONS`; the gesture state machine is `instaflow/tool-gesture`.
- **IF-24.20** **Nudge**: arrow keys move the selection 1 unit, Shift+arrows 10; each key press is one undo step.
- **IF-24.21** **Keyboard transforms**: Mod+Alt+arrows grow or shrink width and height by 1 (Shift 10) with the top-left
  corner fixed; Alt+] / Alt+[ rotate ±15° (Mod+Alt+] / Mod+Alt+[ ±1°).
- **IF-24.22** **Keyboard selection**: Tab / Shift+Tab select the next / previous element of the entered container in paint
  order, Mod+Shift+ArrowRight / ArrowLeft extend the selection (the keyboard path for a marquee), Mod+A selects all,
  Enter / Shift+Enter go in and out, Escape clears.
- **IF-24.23** **Keyboard view**: Mod+= / Mod+- zoom in steps, Shift+0 100 %, Shift+1 fit everything, Shift+2 fit the
  selection; with the hand tool the arrows pan. Bindings live in `CanvasToolsShortcutScope` (a child of Studio's scope)
  and have no conflicts.
- **IF-24.24** **Contributions** (B0): the Select (V) and Hand (H) tools under B0's ids `instaflow/select` and
  `instaflow/hand`; capabilities `instaflow/move-by`, `instaflow/resize-by`, `instaflow/rotate-by`,
  `instaflow/rotate-90-cw`, `instaflow/rotate-90-ccw` (exposed to agents, gated per subject, attributed, one undo step) and
  HUD actions for the two 90° turns.
- **IF-24.25** **Wheel**: the wheel pans; Mod+wheel (and pinch) zooms about the pointer; handles keep their screen size.
- **IF-24.26** **Parity** (fast-check): on random nested scenes (frames, groups, rotations, strokes, ellipses, stars,
  locks), the broad + narrow hit test and marquee equal their brute-force references for every point, tolerance, entered
  container and deep flag, also after edits.
- **IF-24.27** Capability runs honour the run's `AbortSignal`; the element index registers in its scope (`scope.defer`).

| Code | Meaning |
|---|---|
| `IF-TOOL-001` | Pointer event in a gesture state that does not accept it |
| `IF-TOOL-002` | Nothing to transform (empty selection, or every element position-locked) |
| `IF-TOOL-003` | View state out of range (camera, zoom) or unknown tab |
| `IF-TOOL-004` | Every gesture target was deleted before the gesture ended |

## 25. Accessibility layer (M1b B6; IF-7.12)

Code: `apps/instaflow/src/a11y` (export `@instaflow/app/a11y`; projection and announcer headless, the DOM mount main
thread). Error codes `IF-A11Y-001…003`. Lifecycle: LIFECYCLES §26.

- **IF-25.1** **Virtualized DOM projection** (IF-7.12): only elements whose ink bounds meet the visible region (the tab
  camera's viewport in page space, grown by a margin of half the viewport per side) get DOM nodes, found through B3's
  rbush element index; their ancestors, the selection and the entered container are always kept, so the tree and the
  focus path stay whole when they scroll out of view.
- **IF-25.2** The projection **stays in sync** with the stage (its invalidations, including elements created since) and
  the tab's view state (camera, viewport, selection, entered container); a burst of changes is one flush per scheduled
  turn (`createCanvasProjector`, machine `instaflow/a11y-projection`). Under random edits and camera moves it equals a
  brute-force reference (fast-check).
- **IF-25.3** **Reading order** is the document tree (child order), never the paint stack or screen position.
- **IF-25.4** **Roles** come from data tables, never from branches on mode or lens: element kind (`frame`, `group` →
  group; `shape`, `vector`, `image` → img; `text` → group), refined by shape (`rect` → "rectangle"), repeat kind
  ("radial repeat") and the semantic role (headlines and subheads → heading with B2's level). Only roles that allow a
  name and a roving tabindex are used (`group`, `img`, `heading`); the role description says what the element is.
- **IF-25.5** **Names**: the element's `name`, else the first line of its text (B2, at most 80 characters), else its role
  description ("Ellipse"). Text elements also carry their full text in the DOM (find in page, braille).
- **IF-25.6** Node bounds are surface CSS pixels through the camera (nested nodes relative to their parent), so magnifiers
  and touch exploration land where the element is drawn.
- **IF-25.7** **Repeats (B7)**: derived instances never get nodes. A live repeat group is described with its instance
  count; a selected instance focuses its source node, described as "instance k of n".
- **IF-25.8** Fully locked elements are not focusable and are described as locked; position-locked ones say so.
- **IF-25.9** A plain group is in view when one of its descendants is (its own index bounds are not trusted).
- **IF-25.10** **Focus path**: the focused node is the last selected element (as its source) or else the entered
  container; it alone is in the tab order (`tabindex="0"`), every other selectable node is `-1` (roving tabindex).
- **IF-25.11** The DOM focus follows the focus path only while the canvas (or one of its nodes) has focus; it never steals
  focus from the chrome. With nothing selected, or when the focused element is deleted, focus returns to the canvas
  surface, never to `<body>`.
- **IF-25.12** A node focused by assistive technology or the pointer selects that element; focus the layer moved itself
  is not reported back (no select → focus → select loop).
- **IF-25.13** **Keyboard paths match B3's**: the layer activates nothing on Enter or Space, so arrow keys, Tab /
  Shift+Tab, Enter / Shift+Enter and Escape run B3's commands with and without a screen reader.
- **IF-25.14** **Selection announcements** go to the polite live region after a 300 ms quiet period, once per settled
  change: "Name, role description, facts, selected", "n elements selected", "Selection cleared", prefixed by "Inside
  Name" when the entered container changed.
- **IF-25.15** Nothing is announced while a pointer gesture runs (drags, live marquee); the final selection is spoken once
  when it ends (machine `instaflow/a11y-announce`). Announced text is never sent to telemetry.
- **IF-25.16** The focused canvas node shows the theme's focus ring: 2 px `color.focusRing` (Clean Pop deep tangerine),
  2 px offset, `Highlight` in forced colours, at least 3:1 on the canvas well and the chrome in every appearance.
- **IF-25.17** `createCanvasA11y` wires the projector, the DOM mount and the announcer for one tab and disposes them with
  the tab scope. In the split topology the projector runs in the editor worker and its snapshots (plain data) are
  applied on the main thread by `mountCanvasA11y`.
- **IF-25.18** Capability `instaflow/describe-canvas` (read-only, exposed to agents): the selection or what is in view, in
  reading order, in the words a screen reader hears; HUD action "Describe" runs it by hand. Honours the run's
  `AbortSignal`; `IF-A11Y-003` without an open canvas.
- **IF-25.19** **Chrome audit**: every Instaflow custom element (panels, save status, the Studio frame) runs the full
  `@staticflux/testkit/a11y` audit under Clean Pop in its test; a guard test fails when a new element lacks it or narrows
  the rules. The Studio frame is also audited with the canvas layer mounted in its canvas surface.
- **IF-25.20** The audit includes ARIA states on unsupported roles, names on roles that prohibit them, and duplicate ids
  (R15.6). Fixed in this package: kit inspector rows no longer name plain text (B1's paint panel named a gradient label).
- **IF-25.21** **Target sizes**: every control and row size token is at least 24 × 24 px in every density (SC 2.5.8).
- **IF-25.22** **Reduced motion**: every theme motion duration is 0 ms under `prefers-reduced-motion`; Studio's slot
  phases stop animating.
- **IF-25.23** Colours come only from the theme (no colour in B6 code); text and control contrast is the theme's tested
  pairs.
- **IF-25.24** **No keyboard trap** (SC 2.1.2): the canvas layer's description names the ways out (Alt+Enter actions,
  Mod+K command bar), and Studio's keys stay active while the canvas has focus.
- **IF-25.25** The DOM mount is main-thread only (`SF-SURF-004` without a document); the projection and the announcer
  need no DOM.
- **IF-25.26** Everything registers in the tab scope (rule 5); a projector or mount used after dispose is `IF-A11Y-002`.
- **IF-25.27** A projection whose root page is not on the stage is `IF-A11Y-001`.

| Code | Meaning |
|---|---|
| `IF-A11Y-001` | The projected page (root) is not on the stage |
| `IF-A11Y-002` | Projector or DOM mount used after dispose |
| `IF-A11Y-003` | `describe-canvas` with no open canvas |

## 26. Repeat (M1b B7)

Code: `apps/instaflow/src/repeat` (exports `@instaflow/app/repeat`, `@instaflow/app/repeat/panel`). Error codes
`IF-REP-001…005`. Lifecycle: LIFECYCLES §27.

- **IF-26.1** **Live, non-destructive repeats**: a `group` with the `repeat` component (`repeat.kind` = `radial` | `grid` |
  `mirror`) repeats its children (the **source**). Instances are derived when the stage is read, never stored as elements;
  releasing or switching the generator never changes the source.
- **IF-26.2** **Radial**: `count` (1…360, the source included), `radius` (≥ 0), `startAngle` (degrees clockwise from
  12 o'clock: where the source sits on the circle), `sweep` ((0, 360]; 360 spreads copies evenly with no overlap at the end,
  less spreads them over the arc, ends included) and `rotate` (copies turn with the circle, or keep the source's orientation).
- **IF-26.3** **Grid**: `rows` and `columns` (1…100), `gapX` / `gapY` between cells of the source's bounds, `rowOffset`
  (x shift per row) and `columnOffset` (y shift per column), `brick` (`none` | `rows` | `columns`) with `brickShift`
  (−1…1 cells; 0.5 = brick or hex pattern).
- **IF-26.4** **Mirror**: the source and its reflection across an axis — `vertical`, `horizontal` or `angle` (`angle` in
  degrees) — that touches the source's bounds and moves out by `offset`.
- **IF-26.5** Parameters are typed, one LWW register each (concurrent edits of different parameters merge); writes are
  validated (IF-REP-001); a repeat makes at most 1,000 instances (IF-REP-002); reads clamp, so the live view never exceeds the
  limits.
- **IF-26.6** **The repeat view** (`createRepeatStage`) presents each repeat as one zero-size **instance wrapper** group per
  instance (`<repeat>~<k>`, spatial values = the placement) holding the source (instance 0, the real nodes) or **copies**
  (`<repeat>~<k>^<id>`, the source's composed values: classes, tokens and appearance as the source shows them). Nested
  repeats nest.
- **IF-26.7** **Instance 0 is the identity**: the source is drawn where it is stored, so editing it on canvas edits the
  document directly.
- **IF-26.8** **Editing the source updates every instance**: the view invalidates a node's copies and the wrappers of every
  repeat above it (placements depend on the source bounds); a smaller count invalidates the wrappers it drops.
- **IF-26.9** Placements are pure similarity transforms (rotation, reflection, translation) computed in the repeat's local
  space from the parameters and the source's geometry bounds (`instancePlacements`); live and expanded instances use the same
  spatial values, so they draw identically.
- **IF-26.10** **Render**: B1's element render projection runs over the view unchanged; instances are projected as groups
  and leaves like any element (A7 → A6 scene IR).
- **IF-26.11** **Composition with B1**: appearance stacks, classes and tokens are copied as resolved; masks act per instance
  (each wrapper scopes the masks of its copy); a boolean group that is also a repeat combines all instances (groups are
  boolean operands: a plain group's outline is the union of its children); a repeat may be the source of another repeat.
- **IF-26.12** **Instance-aware hit query** for B3: `hitInstance(ctx, node, x, y)` returns the top-most drawn leaf with its
  editable `source`, instance `index` and the full instance `path` (nested repeats); `resolveInstance(id)` maps any view id
  back; `instanceBounds` gives per-instance page bounds for guides.
- **IF-26.13** **Derived nodes are read-only**: the view reports them locked and refuses any write that targets them
  (IF-REP-004 names the source to edit instead). Client gating is UX, not security.
- **IF-26.14** **Make repeat** (radial, grid, mirror) wraps sibling elements in a new repeat group at the bottom element's
  place, keeping their page positions; on a selected repeat it switches the generator (IF-REP-003 otherwise).
- **IF-26.15** **Edit** writes any parameters as one change set; a `kind` switches the generator and keeps the other
  generator's values for switching back.
- **IF-26.16** **Release** clears the repeat: the group keeps only the source, unchanged.
- **IF-26.17** **Expand** turns a repeat into real elements in **one undo step**: one group per instance with the wrapper's
  exact spatial values, the source moved into the first one unchanged, deep copies (local opinions: classes, tokens and nested
  live repeats kept) in the others.
- **IF-26.18** **Deterministic match keys**: instance `k` of a node keyed `key` is `key~k` (wrappers `<repeat key>~k`), in
  the live view and after expand alike, so Auto Animate (M4) matches live and expanded instances; nodes without a key get
  `lk_<id>` first (as duplicate does); re-expanding the same repeat writes the same keys. The source keeps its keys (lineage).
- **IF-26.19** **Expand → render equals the live render** for any parameters (property-tested over the canonical render
  tree: projected records with resources resolved, ids dropped).
- **IF-26.20** **On-canvas handles** (headless, for B3's overlay): radial radius (at the circle's centre) and count (on the
  second instance), grid columns and rows (past the last column / row), mirror offset (on the axis); `repeatHandles` gives
  page positions and drag directions, `handlePatch` maps a page point to a parameter patch.
- **IF-26.21** **Handle drags** (`beginHandleDrag`) preview in the stage's session layer (the instances follow live, nothing
  is written), map against the state at drag start, commit **one change set** on release, and cancel cleanly on Esc or when
  the `AbortSignal` aborts (machine `instaflow/repeat-handle-drag`; IF-REP-005 after the drag ended).
- **IF-26.22** Every handle has a keyboard path: the same parameter in the Repeat panel.
- **IF-26.23** **The Repeat panel** (`instaflow/repeat`, inspector placement) is built only from kit components under Clean
  Pop: generator switch, number fields per parameter, segmented choices, a sweep slider, Expand and Release; it passes the
  testkit a11y audit.
- **IF-26.24** The panel is a view over a headless model (`repeatModel`) and emits `RepeatEdit`s (`repeatEditOps`: one change
  set each).
- **IF-26.25** **Contributions** (B0): each operation is a capability (`instaflow/repeat-radial`, `-grid`, `-mirror`, `-edit`,
  `-expand` (destructive), `-release`; input `{ nodes, params? }`, exposed to agents, gated per subject, attributed) with a
  HUD action running it; capability runs honour the run's `AbortSignal`.
- **IF-26.26** Applicability is input validation (IF-REP-003 / IF-REP-004), never a lens or mode check; parameter variants are
  tables (generators, handles, brick shifts, mirror axes), never branches on flags.
- **IF-26.27** The view registers in a scope (`scope.defer`) and stops forwarding invalidations when disposed.

| Code | Meaning |
|---|---|
| `IF-REP-001` | Repeat parameter has the wrong type or is out of range |
| `IF-REP-002` | The repeat would make more than 1,000 instances |
| `IF-REP-003` | Repeat action does not apply to the selection |
| `IF-REP-004` | Write, expand or edit targets a derived instance |
| `IF-REP-005` | Handle drag used after it ended, or an unknown handle |

## 27. Studio integration (M1b B8, the M1b demo)

Code: `apps/instaflow/src/app` (the composition root; not a package export), the dev entry `apps/instaflow/dev/studio`,
the smoke scenario `apps/instaflow/test/smoke`. Error codes `IF-INT-001…005`. Lifecycle: LIFECYCLES §29.

- **IF-27.1** Studio's canvas runs **A7's sequencing ports**: scene records on one ordered delta stream, then one view
  frame that references them; A7's render module (now over a scene adapter) draws only consistent pairs.
- **IF-27.2** **Resources travel ahead of projection deltas**: a scene record frames the resource batch, the asset uploads,
  the projection payload and the text IR in that order (`encodeSceneRecord`); a snapshot carries every live resource.
- **IF-27.3** The render source is B1's element source **over B7's repeat view**, so live repeat instances draw like
  elements; text (B2) is laid out and drawn on the record's IR section; library images upload ahead of their elements.
- **IF-27.4** Placement (D15): editor and render modules run in one realm on the `local` medium (the one-worker default
  with the editor services next to their DOM pieces); the split topology is a follow-up.
- **IF-27.5** One **canvas tab** per shown page: B3's view state, element index, tool session, pointer controller and
  keyboard commands; canvas shortcuts are live while the surface has focus and no text is being edited.
- **IF-27.6** Studio's fonts: the bundled OFL faces registered by content hash with per-script fallbacks; new text uses the
  first face at 48 px.
- **IF-27.7** B3's overlay (selection frame, round handles, smart guides, marquee) and the page edge are drawn above the
  page, never into the document or the projection; distance labels are kit tags over the canvas.
- **IF-27.8** **Shape** (`R`) and **Frame** (`F`) draw by dragging (Shift square, Alt from the centre) or place their
  default size on a click; one create is one undo step; the new element is selected and the toolbar returns to Select.
- **IF-27.9** **Text** (`T`) places a text element on a click (auto width) or with the dragged width (auto height) and
  starts editing it; a double click on text edits it.
- **IF-27.10** What a creation tool makes is a table row (`CREATION_TOOLS`), never a branch on the tool.
- **IF-27.11** Typing goes through B2's text session on a `TextInput` host over the text box (EditContext or the hidden
  textarea, a variant binding); each keystroke is one undo step together with the box size it implies.
- **IF-27.12** While text is edited, the text host is the element's `textbox` for assistive technology and its projected
  node steps aside (B6); Escape or Tab returns to the canvas; an element left empty is deleted.
- **IF-27.13** B6's accessibility layer (projection, focus path, announcements) runs over the tab's index, view and
  repeat view.
- **IF-27.14** Studio's vocabulary replaces B0's placeholders by id with the real contributions (Select, Hand, Text,
  Pages, Assets, Typography, Milestones) and adds Fill / stroke / effects, Repeat and every M1b HUD action.
- **IF-27.15** **Studio's scope follows the selection**: with elements selected the spec is scoped to them and the
  selection's HUD actions and inspector panels mount (variant tables `STUDIO_SCOPE_HUD`, `STUDIO_SCOPE_PANELS`).
- **IF-27.16** HUD actions of tone `more` share one "More actions" menu; the HUD keeps at most two rows and the canvas keeps
  its size.
- **IF-27.17** A HUD click runs its capability on the selection through the capability pipeline (subject `user`, the stage
  attribution port's actor); results with text are spoken politely, problems too; placeholders say they arrive later.
- **IF-27.18** The canvas port lays out the canvas, label layer and accessibility layer inside the surface, routes pointer,
  wheel and resize events to the tab, and switches pages without recreating the raster.
- **IF-27.19** The Pages panel's lens controller chooses the page the canvas shows.
- **IF-27.20** The Milestone button creates a milestone through B5's capability; the top bar shows B5's save status.
- **IF-27.21** The library's **Place** decodes the asset once, uploads its pixels and adds an image element (image fill)
  centred in the view, as one undo step.
- **IF-27.22** Duplicate (`Mod+D`) keeps rich text (B2) and match keys (B1); Delete and Undo / Redo are canvas shortcuts.
- **IF-27.23** B3's element index re-indexes the ancestors of a changed node, so group bounds stay fresh.
- **IF-27.24** One command runs Studio locally (`pnpm --filter @instaflow/app dev` after `pnpm build`).
- **IF-27.25** A Playwright smoke scenario (open Studio, draw a rectangle, type text, create a milestone) runs in Chromium
  with WebGPU on SwiftShader.

| Code | Meaning |
|---|---|
| `IF-INT-001` | The canvas pipeline could not start |
| `IF-INT-002` | A record on the canvas stream is not a framed scene record |
| `IF-INT-003` | No open page (or the canvas has not started) |
| `IF-INT-004` | The canvas renderer could not start (Wasm, WebGPU, canvas) |
| `IF-INT-005` | The Studio document could not be created or opened |

## 28. Home route (M1c C0; D17, D18)

Code: `apps/instaflow/src/home` (export `@instaflow/app/home`: Home's model, element, boot, capabilities, routes, formats,
the Home index format), `apps/instaflow/src/workspace` (the persistent workspace and Studio's store side for Home), the
dev entries `apps/instaflow/dev/home` and `dev/studio`, the smoke scenario `apps/instaflow/test/smoke/home.smoke.mjs`.
Error codes `IF-HOME-001…007`. Lifecycle: LIFECYCLES §30. Framework: R13.31 (`<sf-card>`).

- **IF-28.1** The local workspace is **persistent**: documents (heads, part snapshots, commit logs) in IndexedDB, blobs in
  OPFS (memory where OPFS is missing); a reload, or a trip to Home and back, keeps every design.
- **IF-28.2** The persistent `DocumentStore` passes testkit's DocumentStore contract on any `AsyncStore`; head swaps and log
  appends of one asset run one at a time in a tab and inside a Web Lock across tabs; log keys sort in seq order.
- **IF-28.3** Studio's dev demo document and every design opened by URL load from the workspace (created on first use).
- **IF-28.4** The **Home index** is a Loro-free projection of the library kept in the library head (`app.home`,
  `instaflow.home-index/1`); reads are tolerant (malformed entries dropped, never thrown).
- **IF-28.5** The projection lists live entries only (trash hidden) with the kind's lens, the design's format and
  `editedAt` = the newest of this session's edit, the stored index and the creation; it never moves backwards.
- **IF-28.6** The store side keeps the index in step: a library change or a write of a design's document (log append,
  head swap) schedules one coalesced write; leaving Studio flushes it.
- **IF-28.7** Index writes are compare-and-swap on the library head with retries (IF-HOME-005); an unchanged index writes
  nothing; the repo adopts the newer head (with `app`) on its next compaction.
- **IF-28.8** **Design formats** are data (post, story, carousel, slides, poster: page size and page count); New design
  takes a format id, never a size.
- **IF-28.9** **New design** is a capability (`instaflow/new-design`, optional `format`) that resolves Studio's `/new`
  href and navigates.
- **IF-28.10** **Open design** is a capability (`instaflow/open-design`, `asset`); an asset that is not a live design in
  the index is IF-HOME-002 and goes nowhere.
- **IF-28.11** **Use template** is a capability (`instaflow/use-template`, `template`; IF-HOME-003 for a non-template);
  Home's **quick actions** are data rows over capabilities (M1: one per format), so later quick actions are rows.
- **IF-28.12** Home's model reads the index once at boot and derives **recents** (designs, newest edit first, at most 8),
  **files** (every listed asset) and **templates**.
- **IF-28.13** Home's model is a machine (`instaflow/home`: loading → ready | failed; refresh → loading; dispose); the
  newest read wins when reads overlap.
- **IF-28.14** Every Home action runs through the capability pipeline (subject `user`, channel `ui/home`); failures are
  spoken in a polite live region.
- **IF-28.15** Agents call the same declarations (described with typed input and output, `exposeToAgents`) and get the
  same result: the Studio href.
- **IF-28.16** The index is read again when the page returns from the back/forward cache or the tab becomes visible.
- **IF-28.17** `<if-home>` follows `design/HomeCP.dc.html` under Clean Pop with kit components only: top bar (logo, the
  one primary "New design"), hero, Quick actions, Jump back in, Templates, Files; lens colour and shape mark each kind.
  The agent composer arrives with Chat (M2).
- **IF-28.18** Cards and file rows are **real links** to their Studio href; a plain click or Enter runs the capability; a
  modified click (new tab) is the browser's.
- **IF-28.19** Keyboard: every action is one native focusable control in reading order (no positive tabindex); "Try
  again" is the way out of a failed read.
- **IF-28.20** Accessibility: sections are named regions, previews are decorative, the testkit audit passes in every
  state (unit tests) and on the live page (smoke).
- **IF-28.21** Loading (busy main, status), empty (how to start) and failed (alert with the cause and "Try again")
  states are shown.
- **IF-28.22** Whole-card links use the kit's `<sf-card href>` (R13.31); thumbnails are format-shaped placeholders until
  page thumbnails land (B4 follow-up).
- **IF-28.23** The surfaces' routes are typed values (`@staticflux/router`): Home `/`, Studio `/s/:asset`, New design
  `/new?format=…|template=…`; a new design's URL becomes `/s/:asset` (other query keys kept).
- **IF-28.24** **Home boots with no engine and no GPU** (D17): the import graph of Home's entries reaches no editor,
  render, Loro / CRDT, worker, Wasm or GPU module (`home-imports.test.ts`); the smoke sees no worker, no Wasm and no
  GPU adapter request.
- **IF-28.25** Size budgets for Home's whole boot and Home's own code (`.size-limit.json`); the surfaces' boot plans as
  loader data (Home: `surface:home` and the kit only; Studio: the engine eager with reasons).
- **IF-28.26** **Save as template** (Studio top bar, a capability agents can call): a milestone of the design, then a
  detached template asset with its own first milestone (B5), listed in the library as `template`.
- **IF-28.27** Use template makes a new composition from the template's newest milestone (B5 `createDocumentFromTemplate`,
  no fills in M1) and opens it; a template with no milestone is IF-HOME-006.
- **IF-28.28** Studio plans its document from the URL (open, new from a format or a template, demo), lists it in the
  library only after the editor opened it, and its Home link saves (Latest and the index) before leaving.
- **IF-28.29** A Playwright smoke scenario (Home, keyboard New design, Studio on an empty document, draw a shape, Home
  link, the design in recents, reopen it with the shape) runs in Chromium with WebGPU on SwiftShader.

| Code | Meaning |
|---|---|
| `IF-HOME-001` | Home could not read the workspace index |
| `IF-HOME-002` | No such design in the workspace (or it is in the trash) |
| `IF-HOME-003` | No such template in the workspace |
| `IF-HOME-004` | A Home or Studio href could not be built |
| `IF-HOME-005` | The Home index write lost every compare-and-swap retry |
| `IF-HOME-006` | The template has no milestone to start from |
| `IF-HOME-007` | Studio could not create or list the design it was asked to open |

## 33. Editor in the worker (M1c B9; D15)

Code: `apps/instaflow/src/workers` (the worker host, the editor module, protocols and ports; the browser entry
`studio.worker.ts`), the page-side adapters in `apps/instaflow/src/app` (`studio-canvas.ts`, `panel-mirrors.ts`,
`studio-app.ts`), the smoke scenarios `apps/instaflow/test/smoke`. Error codes `IF-WRK-001…006`. Lifecycle: LIFECYCLES §35.
Supersedes IF-27.4 (B8's one-realm placement).

- **IF-33.1** Studio's editor module and render module run in the **D15 topology**: one worker by default, two by the boot
  setting `instaflow/sequencing-topology` (`?topology=split` in the dev entry); `planSequencing` turns the setting into
  roles and media, and no module code branches on it.
- **IF-33.2** Main boots the workers (`bootStudioWorkers`): creates A5's input ring and the store port, starts each worker
  with its roles, and relays the editor's pipe endpoints to the render worker when the modules are split; requests go
  to the worker that hosts the module owning them.
- **IF-33.3** A worker that fails to spawn, load its script, Wasm or fonts, open the document or create its pipes fails the
  boot with `IF-WRK-001` naming the step; a request a worker's roles do not cover is `IF-WRK-002`.
- **IF-33.4** **Everything that decides runs in the editor module**: the document peer, stage, undo, repeat view, B3 view
  state, tools, snapping and overlay, creation tools, B2 text layout and the text session, B6's projector and announcer,
  B5 versioning and B4 story edits.
- **IF-33.5** The render module draws with Vello into the **transferred `OffscreenCanvas`**; main keeps no raster. The canvas
  is handed over once (`IF-WRK-006` otherwise); size and device pixel ratio changes reach both modules.
- **IF-33.6** **The overlay is drawn in the same frame as the content it frames**: B3's selection frame, handles, guides and
  the page edge travel as the overlay section of the same scene record as the content change (record format 2), applied
  last; during a drag every record that moves content carries the overlay that frames it.
- **IF-33.7** Scene records carry an **image table** (asset key → scene image ids) with the uploads, so the encoder on the
  render side resolves image paints wherever the uploads were made.
- **IF-33.8** **Pointer, wheel and keys reach the editor only through A5's input ring**; events from the text host are not
  forwarded; keys are forwarded only from inside the canvas surface. The editor recognises a double click by time and
  distance (`DOUBLE_CLICK`, 500 ms and 4 px); the surface allows no native text selection or drag (a native drag would
  cancel the pointer).
- **IF-33.9** Canvas shortcuts (B3's keymap, Undo, Redo, Delete, Duplicate) are registered in Studio's registry on main with
  handlers that do nothing there (the browser default is prevented, the help lists them, the canvas scope is active as
  in B8) and run in the editor's registry on the keys from the ring.
- **IF-33.10** **EditContext (or the hidden textarea) stays on main** on the text host; a TextInput port carries the
  platform's intents, bounds requests and focus to the editor, and the session's state, caret, selection, control and
  character bounds back (surface px; main adds the surface's client offset). The port passes the shared TextInput
  contract with both platform implementations.
- **IF-33.11** A state from the editor is applied to the platform input only when no intent is in flight, so a late state
  never rewinds what the person typed; `composing` on the editor side follows the intents as the platform input does;
  events of an earlier host are dropped.
- **IF-33.12** **The editor never owns storage**: it reaches the store side (main until the store worker, C0) through the
  store port — every `DocumentStore` call and blob reads by reference; the port passes the shared `DocumentStore` and
  repository contracts; transport failures are `IF-WRK-005`.
- **IF-33.13** The store side keeps the workspace store, the blob store, the library document and B4's library services
  on main; Place asks the editor, which reads the blob through the store port.
- **IF-33.14** **Read projections back to main**: the tab's view (page, tool, selection, context, camera, viewport, editing,
  gesture), B6 accessibility snapshots (mounted with `mountCanvasA11y`; a focused node selects in the editor), distance
  labels, announcements and problems.
- **IF-33.15** Panels read **mirrors** of the editor's services (typography, appearance, repeat, milestones, Latest, story):
  reads are plain data posted when they differ, actions are forwarded; sync panel actions answer optimistically and a
  failure is announced; an unknown mirror or action is `IF-WRK-003`. Main asks for a repost once it listens.
- **IF-33.16** Capabilities are validated and gated in the registry on main and **run in the editor**: main forwards
  exactly the capability ids the editor reported at start (`IF-WRK-004` for any other); outputs cross as plain data.
- **IF-33.17** **The worker bundle is DOM-free**: nothing the worker imports reaches Lit, the kit, the UI runtime or a
  main-thread module (a test walks the import graph from `studio.worker.ts`).
- **IF-33.18** B4's lens controller stays on main as the Pages panel's navigation model over the mirrored structure; it
  starts on the page the canvas shows and picks the page the editor shows.
- **IF-33.19** A7's frame metrics stay available: the render module keeps its presented-frame log on the worker's display
  ticks; `metrics()` reports draws, holds, failures and the input → present estimate of every worker (for C4).
- **IF-33.20** The Playwright smoke runs **in both topologies**: B8's scenario (draw, type, milestone) plus select, move,
  resize and rotate by pointer.
- **IF-33.21** In the smoke, the overlay matches the content during a paused drag (pixels of the shape and its frame, and the
  editor's frame corners).
- **IF-33.22** In the smoke, the tab hidden (reported hidden and frozen) then visible keeps its state and draws again.
- **IF-33.23** In the smoke, switching lens (Canvas → Pages → Canvas) and page (p1 → p2 → p1) keeps the document.
- **IF-33.24** In the smoke, an IME composition through Chrome's IME path (CDP) on Studio's text host commits through the
  worker, with the EditContext's character bounds inside the text box.
- **IF-33.25** A text element is hit across its box (B1 fix found here: double click inside text edits it).
- **IF-33.26** A release whose press went elsewhere (a double click into text) is not reported as a problem.
- **IF-33.27** Studio's spec changes run one after another on the latest spec (B0 fix found here: a lens switch during a
  scope change put the old scope back), and Studio's scope is compared with the selection it should follow, not with the
  last scope asked for.

| Code | Meaning |
|---|---|
| `IF-WRK-001` | A Studio worker could not start (step in `details.step`) |
| `IF-WRK-002` | A request reached a worker that does not host its module (or a second start) |
| `IF-WRK-003` | Unknown mirror or mirror action |
| `IF-WRK-004` | The editor does not implement this capability |
| `IF-WRK-005` | The store port is closed or did not answer |
| `IF-WRK-006` | The canvas could not be handed to the render module |

## 34. Transform tools, basics (M1c B10a)

Code: `apps/instaflow/src/tools` (`free-transform.ts`, `transform-mode.ts`, `transform-bar.ts`, and B3's `transform.ts`,
`gesture.ts`, `keyboard.ts`, `overlay.ts`, `view-state.ts`, `contributions.ts`), the model field in
`apps/instaflow/src/elements` (`spatial.skewX`), the wiring in `apps/instaflow/src/app` and `apps/instaflow/src/workers`,
the smoke `apps/instaflow/test/smoke`. Error codes `IF-XF-001…002`. Lifecycle: LIFECYCLES §36. Distort, perspective and
warp are B10b (early M2).

- **IF-34.1** **Flip horizontal and vertical** (Shift+H, Shift+V, HUD, capabilities `instaflow/flip-horizontal` /
  `instaflow/flip-vertical`) mirror the selection over its pivot: one element along its own axes (its rotation stays,
  `flipX` / `flipY` toggles), several along the page axes. Flipping twice is the identity.
- **IF-34.2** A resize dragged **past the opposite edge** (or the pivot, with Alt) flips the box over the fixed point on that
  axis instead of stopping at the minimum size; the magnitude is never below 1.
- **IF-34.3** **Skew**: Mod-drag a side handle — top and bottom lean the frame horizontally, left and right vertically —
  about the opposite edge (Alt: the pivot). One element skews in its own frame (rotated, flipped and nested elements alike);
  the steepest lean is ±80°.
- **IF-34.4** With Shift a skew snaps the edge's lean (the element's existing skew included) to 15° steps.
- **IF-34.5** The box model carries a horizontal skew, `spatial.skewX` (degrees; local transform rotation · flips and scale ·
  skew about the anchor); any page-space affine of an element is written back as rotation, skew, flips and size, so every
  B10a transform composes with B3's. Position locks cover the skew.
- **IF-34.6** **The pivot (reference point)** is per selection, in selection-frame fractions (default the centre), held in the
  tab's view state: never in the document or the store; it resets when the selected set changes.
- **IF-34.7** The pivot handle is shown in transform mode and whenever the pivot is not the centre; dragging it snaps to the
  frame's nine reference points (Mod: free); Alt prefers it over a resize handle under it; **Alt-click resets it** to the
  centre. Rotate (pointer, keys, `rotate-by`) and Alt-resize work about it, and keep it fixed.
- **IF-34.8** **The numeric transform bar** (`instaflow/transform`, a B0 panel contribution in the inspector, first on a
  selection, Canvas lens) shows X, Y, W, H, the angle and the skew: one element's box in its parent, or several elements'
  frame on the page.
- **IF-34.9** A bar edit is one undo step (or one step of the active session); W and H can be linked (the ratio is kept); the
  bar also flips; out-of-range or non-finite values are `IF-XF-001` (W and H ≥ 1, skew within ±80°).
- **IF-34.10** The bar is kit components only under Clean Pop and keyboard-first: Enter or leaving a field applies it,
  ArrowUp / ArrowDown step by 1 (Shift: 10) and apply at once; it passes the full a11y audit.
- **IF-34.11** The bar runs on main over the editor's `TransformMirror` (reads: the model and whether a session is active;
  actions: apply, commit, cancel); the editor computes everything (B9's mirror path).
- **IF-34.12** While a session is active the bar shows Apply and Cancel and says how to finish (Enter / Escape).
- **IF-34.13** **Mod+T** (and the HUD's Free transform, since browsers reserve Mod+T outside full screen and installed apps)
  starts a transform session on the selection: all handles, the pivot and a thicker frame.
- **IF-34.14** In a session every drag, key command and bar edit is a session-layer preview the next one builds on; a press
  outside the frame rotates; a cancelled step restores the staged previews.
- **IF-34.15** **Enter commits the whole session as one undo step**; Escape cancels the whole session (nothing written); Undo
  during a session cancels it; a new selected set commits it; a page switch cancels it. `IF-XF-002` for commit or cancel
  without a session.
- **IF-34.16** Enter and Escape mean apply and cancel only while a session is active, through its own shortcut scope (a child
  of the canvas scope); otherwise they keep B3's meaning (select children, deselect).
- **IF-34.17** A session stages only the fields that differ from where it started, so it never hides a concurrent change by
  an agent or a collaborator when it shows its previews again.
- **IF-34.18** Every transform is a **capability agents can call**: `flip-horizontal`, `flip-vertical`, `skew-by` (x and y in
  degrees), `set-transform` (X, Y, W, H, angle, skew in that order, linked W/H, one undo step), and B3's `rotate-by`; each
  takes an optional page `pivot`. Locks apply (`IF-TOOL-002`).
- **IF-34.19** Skew, flips and the pivot handle live in the editor worker (B9): pointer and keys arrive through the input
  ring; the overlay (pivot ring and cross hair, the session's frame) travels in the scene record with the content.
- **IF-34.20** Every transform keeps working on rotated and nested elements (children of rotated frames and groups).
- **IF-34.21** The smoke test, in both topologies: flip (Shift+H twice is the identity), skew (Mod+Shift-drag the top handle of
  the rotated rectangle, 15° steps), a numeric-bar edit (W typed + Enter, one undo step) and a transform session (Escape
  cancels, Enter applies a nudge and a flip as one undo step).

| Code | Meaning |
|---|---|
| `IF-XF-001` | A numeric transform value is not a finite number in its range |
| `IF-XF-002` | A transform session was committed or cancelled while none was active |
