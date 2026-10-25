# Instaflow — Plan

> Status: **Phase 0 complete; M1 next** (2026-10-25). Results: [PHASE0-FINDINGS.md](PHASE0-FINDINGS.md); M1 work
> plan: [M1-PLAN.md](M1-PLAN.md). Previously: draft for owner review (2026-10-24). [DECISIONS.md](DECISIONS.md) is authoritative. Phase 0
> produces **measurements, not product**. Every spike has a kill criterion and a named fallback. Durations assume
> one core team of 4–6 engineers plus a UX researcher; M2 and M3 can run in parallel with two teams.

## 0. Sequence

```
Phase 0  spikes S1–S9 + UX research R0 ........................ 4 weeks
M1  Core authoring: store, Latest/Milestones, Pages + Canvas ... 8 weeks
M2  Agent layer: HUD, bar, chat, agent views, proposals ........ 6 weeks   ┐ parallel
M3  Timeline: video/audio tracks, clip transitions, keyframes .. 8 weeks   ┘
M4  Motion & presentation: presets, text anim, page transitions  6 weeks
M5  Reaction & generative: cutout, captions, generate, extend .. 6 weeks
M6  Flows: record → flow → unit → app view, lineage ............ 5 weeks
M7  V1 hardening: a11y, budgets, Firefox pass, licenses ......... 4 weeks
Post-V1: comments UI · third-party extensions · cloud store + sync + share links · accounts · Gemini
```

## 1. Phase 0 — spikes with kill criteria

All spikes run on the reference machines: a mid-range iGPU laptop at 120 Hz and a mid-range discrete-GPU desktop,
in current Chrome stable. Each spike delivers a harness kept in `apps/instaflow/spikes/` (deleted at M1 end) and a
one-page result.

| # | Spike | Pass criteria | Kill → fallback |
|---|---|---|---|
| **S1** | **Render:** `vello_gpu`/wgpu in a render worker on a transferred OffscreenCanvas, 10k-element page, tiles plus lifted layer | Pan/zoom p95 ≤ 8.3 ms; drag of 100 elements p95 ≤ 8.3 ms; time to sharp ≤ 250 ms; GPU memory ≤ 512 MiB; quality matches resvg/Chrome on a 200-file SVG corpus | p95 over budget after tiling, or visible quality gaps → run CanvasKit (WebGPU) on the same harness and pick by numbers |
| **S2** | **Sequencing:** main → editor → render over the binary input ring and SAB view-state frames | Input-to-present p95 ≤ 1 frame + 4 ms; no snap-back or double draw across 10k scripted gestures (E-1…E-6) | Over budget → add the camera fast path. Still over → co-locate editor and render in one worker behind the same ports |
| **S3** | **Text:** Parley in a worker with Local Font Access bytes; EditContext IME round trip (Japanese, Chinese, Korean); `complex-scripts` size | Caret and IME candidate correctly placed; Arabic and Devanagari shaped correctly; authoring Wasm ≤ 350 KB brotli | Size over 450 KB → split complex scripts into a lazy module. IME unfixable → hidden-textarea adapter on Chrome too |
| **S4** | **CRDT:** Loro behind `DocumentCRDT` v2 with parts, fork, per-actor undo via commit metadata | 50k-node Latest open ≤ 1 s; heap ≤ 200 MB; a 1k-move drag commits ≤ 20 KB; 10k-op divergent merge ≤ 200 ms **per page**, run off the main thread (restated 2026-10-24 after S4; one CRDT doc per page); Wasm instantiate ≤ 150 ms warm; proposal accept per op works under concurrent edits | Any miss that cannot be tuned → LWW v2 (Kleppmann move, columnar encoding) + Yjs text behind the same interface |
| **S5** | **Media:** Mediabunny → WebCodecs → `importExternalTexture` in the render worker; AudioWorklet SAB ring with an audio-master clock; export | 3 × 1080p layers at 60 fps; exact seek on a 0.5 s-GOP proxy ≤ 60 ms; A/V drift ≤ 16 ms over 10 min (wired and Bluetooth); 60 s 1080p30 export ≥ 3× real time | External textures failing → `copyExternalImageToTexture`. Decode ceiling → 540p preview proxies by policy |
| **S6** | **Store:** OPFS writer with sync handles; folder backend; zip bundle; head CAS; leader-tab failover | Milestone of a 200-page doc ≤ 1 s, writing only changed parts; GC over 10k blobs ≤ 2 s; 100 forced leader kills lose no acknowledged commit; folder head swap is atomic | Folder writes too slow or non-atomic → OPFS primary with the folder as a continuously synced mirror |
| **S7** | **Export parity:** one IR through Vello GPU, `vello_cpu`, the SVG writer and krilla | SSIM ≥ 0.99 against `vello_cpu` on the corpus; text stays real text in PDF | Feature gaps → rasterize that feature at export DPI (Skia "expand" rule), recorded per feature |
| **S8** | **Agent views:** layout and timeline codecs on a real stage; round-trip suite; a 30-task slice of the format eval (IF-6.16) with mock and one real model | Round-trip suite green; page projection ≤ 2 ms; ≥ 80% task success for the best view/edit combination; zero clobbered concurrent edits | < 70% → test the JSON serializer and relational ops (`align`, `stack`, `place relativeTo`) before M2 |
| **S9** | **Matte:** a BiRefNet-class ONNX model on ORT Web (WebGPU) in the ML worker; license sign-off of weights | ≥ 5 fps at 720p on the iGPU machine; temporally stable edges after smoothing; weights licensed for commercial use | Too slow or unlicensed → MediaPipe-quality matte for V1 plus "Fix edges", and revisit at M5 |
| **R0** | **UX research** (UX.md §8) on a Figma prototype with a Wizard-of-Oz agent | Ranked job list; HUD slot map; T5 and T7 comprehension data | Findings change M2 scope, never the format |

### 1.1 Phase 0 outcome (2026-10-25)

All nine spikes ran; details in [PHASE0-FINDINGS.md](PHASE0-FINDINGS.md). Changes to this plan:

| Spike | Outcome | Plan change |
|---|---|---|
| S1, S7 | PASS (owner GPU); SVG parity 0.9945 median | Tiles mandatory; tile prep off the frame; pipeline warm-up; SVG metric or per-feature rasterize list in M1 |
| S2 | PASS with one worker | **D15**: editor and render are modules; topology is a boot setting, default one worker |
| S3 | PASS (IME placement needs a human) | `complex-scripts` lazy |
| S4 | PASS with the merge criterion restated per page | **D14**: one CRDT document per page |
| S5 | PASS (owner Mac, Bluetooth included) | Catch-up rule, settled-clock start, per-machine encoder settings in M3 |
| S6 | PASS (real-folder crash test) | Folder backend is a batched mirror of the OPFS journal |
| S8 | PASS on two model families | Markup view + relational ops is the M2 default; fragments optional |
| S9 | Fallback | V1 live mask = MediaPipe; baked matte model chosen at M5 |

## 2. Milestones

Each milestone ends with green e2e tests for its scenarios, budgets enforced in CI, and `AGENTS.md` for every
new package and app area.

| Milestone | Delivers | Requirements | Needs (SF-Δ) |
|---|---|---|---|
| **M1 Core authoring** | Workspace store (OPFS journal, folder as a batched mirror), library doc, ingest and hashing, renditions (thumbnails); Latest with continuous save, per-actor undo, multi-tab co-editing; Milestones, compare, New document from milestone, templates with slots; Pages and Canvas lenses; shapes, images, vectors, booleans, rich text, effects, brand-kit tokens and classes; select, marquee, transform, snapping; PNG/PDF/SVG/`.iflow` export and import; unsupported screen; guest identity; read-only mode | IF-2, IF-3, IF-4, IF-5, IF-7, IF-13.1, IF-13.3–4, IF-14 | Δ1–6, Δ7 (local + session layers), Δ9, Δ10, Δ17–19, Δ22–29, Δ31–33 |
| **M2 Agent layer** | **The Chat surface (D17):** per-turn editor specs (D16) and inline mini editors (preview, then edit), session handoff to and from Studio, quick actions as capabilities (D18); Capability metadata and applicability; HUD, command bar, chat; mock providers plus OpenAI and Anthropic (built on the model-provider contribution point); agent views (layout) and `agent/*` tools; change sets, proposals, conflict UI, attribution, agent presence, autonomy levels; WebMCP; format eval (IF-6.16); first-party extension host (in-process, manifest-checked) | IF-1.4, IF-6, IF-10.1–6, IF-12, IF-17.6 | Δ7 (proposal layers), Δ8, Δ11–13, Δ20, Δ21, Δ30 (chat), Δ34, Δ35 |
| **M3 Timeline** | `@staticflux/media` and `@staticflux/motion`; tracks; import, trim, split, ripple, roll, slip; constant speed, reverse, freeze; volume, fades, crossfades; clip transitions; keyframes on every animatable property; proxies, filmstrips, waveforms; audio-master playback; MP4 export; timeline and transcript agent views | IF-8.1–8.7, IF-8.10–11, IF-9.1, IF-15.3–4 | Δ14 (jobs), Δ15, Δ16, Δ24 (clocked and offline loops), Δ34 (timeline codec) |
| **M4 Motion & presentation** | Motion preset assets; text animation; page transitions including Smart move; Zoom here and Ken Burns; Animate HUD; presentation and presenter view; viewer HTML; WebM, GIF, image sequence | IF-9, IF-13.2–3 | Δ15 (complete) |
| **M5 Reaction & generative** | Baked matte jobs (model chosen here; BiRefNet at 512² first) with the MediaPipe live preview mask; PiP cutout presets; transcription and captions; silence and filler removal; generate image, video and audio; Extend this clip; recipes and lineage badges | IF-8.8–9, IF-10.7–9 | Δ14 (complete), Δ30 (media tasks) |
| **M6 Flows** | Workflow assets; record → flow; collapse into unit (registered capability); App view and batch runs; lineage view; graph agent view | IF-11 | Δ12 (`invokePlan`), Δ34 (graph codec) |
| **M7 V1 hardening** | Accessibility audit (WCAG 2.2 AA chrome, canvas layer); performance lab runs; Firefox best-effort pass; license audit; scenarios A–E green; documentation | IF-2.5, IF-15, IF-16 | — |

**Post-V1 (format already allows it):** comments UI (IF-18, Δ36), third-party sandboxed extensions and
declarative element types (IF-17, Δ37), automatic versions, a cloud store plus a relay transport and share links,
accounts, credits, and Gemini.

## 3. StaticFlux packages and changes

Deduplicated across reports 01–05. Every item gets requirement IDs in `docs/REQUIREMENTS.md`, an `AGENTS.md`
update, lifecycles in `docs/LIFECYCLES.md`, `SF-*` error codes with fixes, budgets, and tests (shared contract
suites where there is a port).

### 3.1 New packages

| Δ | Package (layer) | Contents | Phase |
|---|---|---|---|
| **Δ1** | **`@staticflux/blob`** (vertical) | `BlobStore` port: `put(stream, { signal }) → Result<BlobRef>` with chunked hashing, `get(digest, { range })`, `has`, `stat`, `verify`; chunk manifests; GC roots and mark-sweep with a grace period; quota facts; errors `SF-BLOB-*` | M1 |
| **Δ2** | `@staticflux/blob` backends | OPFS (sync-handle writer in dedicated workers, `getFile().slice` readers); File System Access folder as a **batched mirror** of the OPFS journal (create-only objects, temp + `move()` head swap under a Web Lock, permission re-grant flow; S6); zip bundle reader/writer (central directory, stored entries, Compression Streams); resolver port | M1 |
| **Δ7** | **`@staticflux/stage`** (vertical, on document) | Layer stack (session, proposal/*, local); arcs `reference`, `inherit`, `variant`; final paths; incremental composed stage with a dependency index; `read(node)` with value provenance; `explain()` | M1 (local + session), M2 (proposals) |
| **Δ15** | **`@staticflux/motion`** (vertical, pure) | `Ticks`, `Rational`, `TickRange`, conversions; channels; easing (cubic-bezier, steps, hold, sampled springs); typed interpolators (linear-light color); `TimeMap`; seeded PRNG; lint banning ambient time and randomness | M3 (core), M4 (presets, text units) |
| **Δ16** | **`@staticflux/media`** (vertical) | `MediaClock` (audio, wall, offline, scrub); `DecoderPool` and `DecoderSession` lifecycle; `MediaIndex`; codec facts; Mediabunny container port (the only importer); `ExportJob` lifecycle with checkpoints; AudioWorklet host, mixer graph and offline render (shared DSP) | M3 |
| **Δ34** | **`@staticflux/agentview`** (vertical, on core, document, capabilities) | `defineViewCodec({ elements, attrs, units, rounding, defaults, summarize })` → `project(stage, scope, { budget })` / `compile(edit, { base, handles })`; schema, vocabulary and example generation; handle tables; view caching and `viewHash`; metrics (`agentview.project.ms`, `.tokens`, `.conflicts`); shared round-trip contract suite in testkit | S8, M2 (layout), M3 (timeline, transcript), M6 (graph) |

### 3.2 Changes to existing packages

| Δ | Package | Change | Phase |
|---|---|---|---|
| **Δ3** | document | **`DocumentRepo`**: many assets and parts per repo, lazy part loading, head CAS, snapshot plus log persistence through a store port, compaction with an undo horizon, eviction under the resource manager | M1 |
| **Δ4** | document | **`DocumentCRDT` v2**: cycle-safe tree move, movable list, rich-text marks with stable anchors, per-transaction `meta`, version/frontier, `changedSince(base, scope)`, fork, shallow snapshot, inverse ops for undo | M1 |
| **Δ5** | document | **Loro adapter** (`loro-crdt.ts`, the only importer), with its own Wasm budget category; LWW v2 kept as the S4 fallback | M1 |
| **Δ6** | document | **Component versions and migrations** (`defineComponent(id, schema, { version, migrations })`); field types `ticks`, `ref`, `vec2`, `color`, `enum`, `map`; `role` and `name` as first-class fields; **JSON Schema generation** from component definitions; **canonical part encoding** (RFC 8785) for milestones | M1 |
| **Δ8** | document | **Change sets and proposals**: typed op batches, temp ids, deterministic expansion and ids, `validateChangeSet` (generic plus feature validators), per-op results, `partial | atomic`, stale-field detection against `base`, shared proposal state, accept per op, accept-time conflict flags | M2 |
| **Δ9** | document | **Undo service**: per actor, transaction-grouped, inverse-op based, persisted to the undo horizon | M1 |
| **Δ10** | capabilities ↔ document | **Attribution**: an actor record (`kind`, `id`, `displayName`, `model`, `via`, `invocationId`) passed from `RunContext` into `transact(meta)` through a port; replaces the coarse `CrdtOrigin`/`'agent'` subject for history. webmcp passes the client's name | M1 |
| **Δ11** | capabilities | **Applicability predicates** (`appliesTo: SelectionShape`, `registry.applicable(selection, lens)`, reactive, separate from authorization) and **presentation metadata** (group, icon, short label, pinned or ranked, params UI, examples) | M2 |
| **Δ12** | capabilities | **Real dry-run previews**: `implementCapability(cap, run, { plan })` returning a change set plus preview assets; `commit` / `discard`; **`invokePlan(steps, { atomic })`** with one approval and one undo group | M2, M6 |
| **Δ13** | capabilities | **Provenance middleware**: every asset a capability creates gets `operation` and `actor` automatically | M2 |
| **Δ14** | capabilities | **Long-running jobs**: `queued → running(progress) → succeeded | failed | cancelled`, partial results (takes), resume after reload through a handoff slot, result = asset reference | M3, M5 |
| **Δ17** | worker | **Handle channel**: transfer of `VideoFrame`, `AudioData`, `ImageBitmap`, `OffscreenCanvas` and `FileSystemHandle` with ownership and close accounting (dev guards, leak counters) | M1 |
| **Δ18** | worker | **Sequenced binary delta stream** (versioned records, gap → resnapshot, content-addressed side channel); **AudioWorklet-compatible ring reader**; **clock cell** (seqlock f64 position and state) | M1, M3 |
| **Δ19** | worker | **Brokered peer channels** that re-wire on respawn; **optimistic intents with supersede-on-ack** (ephemeral edits, overlays); **query/windowed replicas** (viewport, time window, subtree) | M1 |
| **Δ20** | advisors | Purpose **`ui-ranking`** (presentation only, never access) | M2 |
| **Δ21** | messaging | **`toolbar` surface kind**: anchored, non-modal, follows its target, top-edge snap; arbitration keeps coach marks off it | M2 |
| **Δ22** | surface | **Input forwarding fidelity**: lossless `getCoalescedEvents` points, pressure, tilt, twist, flagged predicted events, a binary input ring (`defineLayout`), multiple sinks, coalescing opt-in per consumer | M1 |
| **Δ23** | surface + platform | **GPU device lifecycle**: `running → lost → attaching` on `device.lost`, re-init from the retained IR; GPU facts (adapter info, features, limits); `SF-SURF-01x` | M1 |
| **Δ24** | surface | **Headless/export surface** (`createHeadlessSurface`, tiled beyond texture limits, readback, cancellation); **clocked and offline frame loops**; `frame(state, dt, { presentationTime, mode })`; color-space handling for `VideoFrame` | M1, M3 |
| **Δ25** | document | **Binary render projection** (ECS → delta stream); **spatial index system** (rbush with ink bounds); presence extended for agents (status, held elements) and gesture ghosts | M1, M2 |
| **Δ26** | platform | Facts: WebGPU adapter (async), WebCodecs, OPFS sync handles, File System Access, EditContext, Local Font Access, Compression Streams; an **async fact lane** (codec matrix); the **unsupported boot plan and preset** with `IF-PLAT-*` mapping | M1 |
| **Δ27** | surface | **`TextInput` port**: EditContext implementation and hidden-textarea implementation, typed text intents, character and selection bounds | M1 |
| **Δ28** | runtime | **Worker-side scheduler** (priorities, `scheduler.yield` / `MessageChannel` fallback) and **long-task detector** for workers | M1 |
| **Δ29** | runtime | **GPU and media memory budgets** in the resource manager: caches register bytes and eviction callbacks; memory pressure evicts before feature demotion | M1 |
| **Δ30** | ai | **Chat with tool calls** (streaming), **media generation tasks** (image, video, audio) run as jobs, OpenAI and Anthropic transports (direct browser access, keys from an encrypted local store), **mock chat and media providers** with scripted latency, progress and failures | M2, M5 |
| **Δ31** | testkit | Fakes for `VideoDecoder`, `VideoFrame`, `AudioContext` and the GPU device; deterministic media clock; golden `RenderGraph` snapshots; perceptual diff; a media corpus; contract suites for `BlobStore`, `DocumentRepo`, change sets, view codecs, and N-peer convergence | M1 → |
| **Δ32** | tooling | License allowlist check (fails on GPL, AGPL, NC and watermark licenses, plus a model-weights registry); Rust/Wasm build integration in `pnpm build`; Wasm budget categories in size reports | M1 |
| **Δ33** | pwa | `.iflow` file handler (launch queue) and COOP/COEP injection verified for static hosts | M1 |
| **Δ35** | gate | Subject kind **`extension`** (narrower than `user`, like `agent`) and manifest-permission facts | M2 |
| **Δ36** | document | **Comments part**: anchors that follow targets, orphan handling, exclusion from milestones and exports | Post-V1 |
| **Δ37** | sandbox | **Extension capability bridge**: manifest-checked contributions, network-origin allowlist, own storage namespace, declarative element-type expansion in a sandbox | Post-V1 |

### 3.3 Stays in the app (not framework)

Node kinds, components and their meaning; the agent view vocabularies; timeline edit intents (ripple, roll, slip);
effects, transitions and the text-animation library; the Rust engine (render, authoring, export modules); the
matte, transcription and generation capabilities; lenses and UI features; export presets; mock providers'
content.

## 4. Risks

| Risk | Mitigation |
|---|---|
| Vello maturity (0.3) | `RasterBackend` port; S1 corpus; pinned versions; upstream contributions. S1: passes on a real GPU; CanvasKit's npm build has no WebGPU, so a fallback would mean our own Skia build |
| Loro maturity or size | S4 numbers; `DocumentCRDT` seam; one doc per page (D14); LWW v2 fallback; canonical, engine-independent milestones and bundles; 822 KB brotli loads in the background |
| Co-editing bugs (ripple, proposals, undo) | Explicit-move intents; N-peer property tests; multi-tab is real co-editing from M1 |
| Agent edit quality (geometry, composition confusion) | S8: relational ops beat hand-computed geometry on Claude and Qwen; lints, relational ops, `from=` and `@token` annotations, the screenshot verify loop, format eval before lock-in |
| Rust toolchain adds build complexity | One pinned toolchain, one workspace, CI caches; built artifacts are content-hashed chunks |
| Licensing contamination (codecs, weights) | Δ32 allowlist; model-card registry; MPL used unmodified |
| Scope creep from "everything is an asset" | Blob assets immutable; tree assets share one mechanism; no per-kind special cases in the store |
| Prompt injection through document content | Document text marked as data in views; destructive capabilities confirmed (fail closed); client gating is UX only |

## 5. Open questions for the owner

All six were answered on 2026-10-24 and are locked in [DECISIONS.md](DECISIONS.md): default home → D8; undo
horizon → D9; exports and milestones → D10 (publishing creates a Release, plain exports create nothing); comments →
D11 (fast follow after V1); external agents → D12 (WebMCP + chat, local bridge as an M7 stretch); default autonomy →
D13 (Ask for external agents, Accept edits for the in-app agent).
