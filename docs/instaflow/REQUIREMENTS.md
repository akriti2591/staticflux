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
