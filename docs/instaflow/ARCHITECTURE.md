# Instaflow — Architecture

> Status: **draft for owner review** (2026-10-24). Normative for IF-7 and IF-8. Format details are in
> [DOCUMENT-FORMAT.md](DOCUMENT-FORMAT.md). Framework changes `SF-Δn` are in [PLAN.md §3](PLAN.md#3-staticflux-packages-and-changes).
> [DECISIONS.md](DECISIONS.md) is authoritative. §9 (comments) and §10 (extensibility) are design direction.

## 1. Overview

```
 ┌──────────────── one tab ───────────────────────────────────────────────────────────────────────┐
 │ MAIN THREAD                                                                                    │
 │  Lit chrome (shell, lenses, HUD, command bar, chat) · capability registry · agent runtime     │
 │  WebMCP publisher · input forwarder · EditContext · a11y layer · AudioContext + Worklet node  │
 │        │ binary input ring        ▲ replicas (selection, inspector, outline, a11y projection) │
 │        ▼                          │                                                             │
 │  EDITOR WORKER (per tab) ─────────┘   CRDT peer for the open assets (Loro parts)              │
 │   stage (composition) · tools · camera/selection/overlays (view state) · rbush hit test      │
 │   authoring Wasm: Parley text layout, linesweeper/kurbo geometry · change-set engine · undo  │
 │        │ view-state frames (SAB, latest)   │ scene deltas (sequenced binary)                    │
 │        ▼                                   ▼                                                    │
 │  RENDER WORKER (per tab): scene IR · motion evaluator overrides · Vello raster · tiles ·      │
 │   compositor (WGSL) · video external textures · overlay pass ── OffscreenCanvas (WebGPU)      │
 │        ▲ VideoFrame handles                                                                     │
 │  MEDIA WORKERS (per tab, 1–2): Mediabunny demux · WebCodecs decoder pool · PCM cache ·        │
 │   audio pre-mixer ── SAB PCM ring ──► AudioWorklet (master, meters, sample clock)            │
 └───────────────────────────────┬────────────────────────────────────────────────────────────────┘
                                 │ CRDT updates / acks · blob writes (via tab coordinator)
 ┌───────────────────────────────▼──────────────── one per workspace (leader tab) ───────────────┐
 │ STORE WORKER: heads (CAS) · commit log · compaction · milestones · library doc · ingest +    │
 │  hashing · renditions scheduler · GC · catalog (IndexedDB) · folder / OPFS / bundle backends  │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 On demand (per tab): EXPORT WORKER (headless editor + render modules + encoders),
                      ML WORKER (matte, transcription, live mask).
```

## 2. Threads and ownership

One owner per kind of state (R11.2):

> **Topology (D15, from S2).** "Editor worker" and "render worker" below are **modules** with fixed ports, not
> necessarily separate threads. One worker or two is a boot-time setting; the default is **one worker hosting both
> modules**, because it met the latency budget on real hardware (S2 owner run). Ownership rules hold either way:
> the editor module never touches the GPU, the render module never decides anything about the document.

| Thread | Owns | Never does |
|---|---|---|
| **Main** | DOM chrome, focus, IME (EditContext), accessibility tree, capability registry and its ports, agent runtime and model calls, WebMCP publisher, AudioContext | Renders content, decodes media, holds the document |
| **Editor worker** (dedicated, per tab) | The tab's **CRDT peer** for open tree assets, the composed stage, **view state** (lens, camera, selection, active tool, gesture overlays), spatial index, text layout, geometry, change-set validation and proposals, the undo service, read projections for main and agents | Writes storage, touches GPU |
| **Render worker** (dedicated, per tab) | GPU device, scene IR store, tile cache, lifted layers, compositor, motion sampling during playback, frame metrics | Decides anything about the document |
| **Media workers** (dedicated, per tab) | Demux, decoder sessions, PCM cache, audio pre-mix | Composites |
| **Store worker** (dedicated, one per workspace, in the **leader tab**) | Every storage write: heads, logs, records, blobs; compaction; milestones; library doc; GC; the derived catalog | Composes or renders |
| **Export / ML workers** (on demand) | One export or ML job each | Long-lived state |

Decisions:

- **Per-tab camera and tool state lives in the tab's editor worker** (resolves report 03 §7). It is never in the
  CRDT and never in the store.
- **The store is a dedicated worker in the leader tab**, elected with `createTabCoordinator({ transport:
  'leader-tab' })`. OPFS `createSyncAccessHandle` is not available in SharedWorkers, so the store cannot be one.
  Other tabs reach the store over the coordinator's BroadcastChannel ports. On leader loss a new leader spawns
  the store worker, which reopens heads from disk. Editor workers resend unacknowledged commits (CRDT updates are
  idempotent).
- **Writes are single-writer, reads are anywhere.** Blobs are immutable, so any worker reads them by range through
  `FileSystemFileHandle.getFile().slice()`. Directory handles are passed to workers through the handle channel
  (SF-Δ17). Only the store worker writes.
- **Isolation is required** (IF-2.8), so frame channels always use SharedArrayBuffer rings. The framework's
  transfer fallback stays in place but is unused.

## 3. Data flows

### 3.1 Edit (human gesture)

```
pointer → main input forwarder (lossless, SF-Δ22) → binary input ring → editor worker
  tool state machine: hit test (rbush → kurbo) → gesture g, overlay Δ (no CRDT write)
  → view-state frame {viewSeq, g, Δ, guides} → render module draws a lifted layer at Δ as soon as the frame arrives (draw on arrival, S2)
pointerup → editor worker: one CRDT transaction (actor, via, label) → docVersion v
  → scene delta {v, commits:[g]} → render worker swaps "overlay off, committed on" in ONE frame (E-2)
  → commit record → store worker → append to log → ack → (no ack in 2 s → "Not saved yet")
  → other tabs' editor workers receive the update as a remote CRDT update
```

### 3.2 Edit (capability, human or agent)

```
HUD / bar / chat / WebMCP → registry.invoke(cap, input, { subject, origin }) on main
  validate → gate (agent subject, confirm port) → activate feature → run
  run: cap.plan(input) → change set (SF-Δ12) → editor worker: validate → proposal or apply (autonomy level)
  materializing caps: job (SF-Δ14) → provider/ML/export worker → blob → store ingest → new asset (provenance, SF-Δ13)
                      → change set binds the new asset → one transaction, one undo step
```

### 3.3 Agent read and write (research 05)

```
agent → agent/read-view {kind, scope, budget} → editor worker:
          composed stage (already maintained) → ViewCodec.project → view text + base + viewHash (+ lints, comments, changed-since)
agent → agent/screenshot → render worker headless pass on the same IR → PNG with id badges + legend
agent → agent/apply {base, ops | fragment} → editor worker: ViewCodec.compile (handles, unround, s → ticks,
          compound expansion, diff fragment vs BASE view) → ChangeSet → validate → stale fields reported →
          proposal or applied transaction (autonomy level) → result to agent
```

Views are built **on demand only** (no standing agent replica), scoped through the indexes the editor worker
already has (page parts, the rbush viewport index, the interval index for time windows), and cached per node.
Projection costs well under 1% of an LLM turn. The real budget is tokens, which scoping and omitted defaults
control.

### 3.4 Playback

The media worker's AudioWorklet consumes PCM and advances a shared sample counter (a seqlock "clock cell",
SF-Δ18). On each `requestAnimationFrame`, the render worker reads the clock and computes `t` (corrected for
`outputLatency`, snapped to the frame grid). It then calls the pure motion evaluator on the retained scene IR
(`@staticflux/motion`), asks the decoder pool for `(asset, mediaTime, nearest, deadline)`, and composites. Late
frames are dropped and counted. Nothing is written to the CRDT (E-6). The main thread only draws the playhead
from the same clock cell.

### 3.5 Export

The user picks a format. The app creates a milestone if needed (IF-5.10). The export worker loads the milestone's
parts into a headless editor module (compose, layout) and a headless render module (SF-Δ24 headless surface),
with its own decoder sessions in exact mode. It renders frames out of order with in-order submission, encodes
through WebCodecs and Mediabunny, and streams to the store. The store writes the output blobs and an
`ExportRecord`.

## 4. Sequencing protocol (from report 03, adopted unchanged)

| Counter | Owner | Meaning |
|---|---|---|
| `inputSeq` | main | Monotonic per input batch, events carry absolute `ts` |
| `gestureId` | editor worker | One per tool gesture |
| `docVersion` | editor worker | Increments on every applied transaction, local or remote |
| `viewSeq` | editor worker | Increments on every view-state frame |

Channels: input ring (main → editor, binary, lossless); view-state frames (editor → render, SAB, latest wins);
scene delta stream (editor → render, sequenced binary records with content-addressed geometry, paint and glyph
blobs, SF-Δ18); render metrics (render → main).

Invariants (tested, IF-7.3; mirrored into `docs/LIFECYCLES.md` when built):

- **E-1 Ordered apply.** Deltas apply in increasing `docVersion`. A gap or an epoch change triggers a
  resnapshot, and the last good frame stays on screen.
- **E-2 Atomic supersede.** Overlay `g` disappears in exactly the frame that applies the delta with
  `commits: [g]`.
- **E-3 Relative overlays.** Overlays are deltas over committed state, so remote edits arriving mid-gesture
  compose. If a remote edit deletes or locks a target, the gesture is cancelled with `IF-ENG-001` (toast).
- **E-4 One camera.** A hit test uses the camera that was displayed when the event happened.
- **E-5 Commit at gesture end.** Long gestures do not write intermediate transactions. Remote peers see presence
  ghosts.
- **E-6 Animation is an override.** Playback and animation previews never write the CRDT.

The camera fast path (wheel deltas sent straight to the render worker) is held in reserve and is added only if
spike S2 fails (PLAN §1).

## 5. Engines

### 5.1 Render module (Rust → Wasm, render worker)

- `vello_gpu` on `wgpu` (WebGPU) behind `RasterBackend`. Our compositor: 512 logical-px tiles cached per zoom
  level (powers of 2), rendered from the centre out within a 4 ms per-frame raster budget. Lifted layers for the
  selection, the text being edited and animated nodes. LOD below 0.5 device px, and greeked text below 4 px.
- **One compositor for every lens and for export** (resolves report 02 vs 03). Pages and canvas are scenes with a
  2D camera. The timeline preview is the same scene evaluated at `t`. Video frames bind with
  `importExternalTexture`. Effects and transitions are WGSL passes with declared parameters.
- **Device loss** (SF-Δ23): the surface goes `running → lost → attaching`. The engine rebuilds from the retained
  CPU-side IR. Target ≤ 1 s, with no document reload.
- `vello_cpu` (same Sparse Strips pipeline) renders golden images in CI.

### 5.2 Authoring module (Rust → Wasm, editor and export workers)

- **Parley** (HarfRust shaping, Skrifa, ICU4X bidi and segmentation, Fontique fallback) produces positioned glyph
  runs, line metrics and cluster geometry. Glyph runs go to the render worker as content-addressed blobs.
  **This is the only text pipeline** (resolves report 02's harfbuzzjs plus Canvas2D atlas): screen, PNG, PDF,
  SVG and video use the same glyphs.
- **linesweeper + kurbo**: booleans as derived geometry, precise hit tests, arc length. **usvg** for SVG import.
- The editor worker's JS side holds the ECS world (an internal runtime index of the tree only), the stage, rbush,
  tools, the change-set engine and the **agent view codecs** (`@staticflux/agentview`, SF-Δ34). Codecs are pure
  `project` / `compile` pairs generated from component schemas, one per view kind (layout, timeline, transcript,
  graph), contributed by the lens features. A per-agent-session handle table is kept in the worker's session
  archive, so it survives respawn.

### 5.3 Text input

`TextInput` port (SF-Δ27). The **EditContext** implementation on Chrome attaches to the canvas host. Text
updates become intents to the editor worker, which re-lays out and returns caret, selection and character
bounds, so main can call `updateCharacterBounds` and `updateSelectionBounds`. The hidden-textarea implementation
covers Firefox. HTML-in-Canvas is not on the text path and is used only for optional DOM-rich overlays.

### 5.4 Stage and motion

- `@staticflux/stage` (SF-Δ7) composes `session > proposal/* > local` with the `reference`, `inherit` and
  `variant` arcs incrementally. A dependency index invalidates only affected `(node, path)` entries.
  `explain()` serves devtools, the inspector and agents.
- `@staticflux/motion` (SF-Δ15): ticks, rationals, channels, easing (cubic-bezier solve, sampled springs), typed
  interpolators (linear-light color), `TimeMap`, seeded PRNG. Lint bans `Date`, `Math.random` and `performance`
  in evaluator modules. The same code runs in the render worker (preview), the export worker and tests.

### 5.5 Media

`@staticflux/media` (SF-Δ16):

- `MediaClock` (audio | wall | offline | scrub);
- `DecoderPool` (sessions per asset, track and rendition; priorities playing > prerolling > scrub > thumbnail;
  ≤ 8 sessions; LRU; byte budgets; `reset()` on abort);
- `MediaIndex` (keyframe table persisted as `media.keyframeIndex`);
- the container port wrapping **Mediabunny** (the only file importing it);
- codec facts from `isConfigSupported` probes;
- the AudioWorklet host, mixer graph and offline render path (the same DSP for preview and export; Signalsmith
  Stretch for pitch-preserving speed).

Proxies, filmstrips and waveform peaks are rendition jobs scheduled by the store worker and executed in a media
worker.

### 5.6 ML

ONNX Runtime Web (WebGPU EP) runs a BiRefNet-class matte model, with license-verified weights recorded in a model
card registry. Jobs work per frame range at proxy resolution, are resumable, and write a luma-mask video matte
asset. MediaPipe Image Segmenter provides the live preview mask. A Whisper-class model handles transcription.
These run only in the ML worker and are never in the evaluation path.

## 6. Co-editing architecture (first-class, IF-4.8–IF-4.11)

- **Peers.** Each tab's editor worker is a Loro peer for the assets it has open. The store worker is the
  persistence peer and the local relay: it appends every peer's commits to the log and fans them out to the
  other tabs. Agents act through the editor worker of the tab they are attached to, and are distinguished by the
  **actor record** on every commit (SF-Δ10), not by transport.
- **Everything commutes.** Property writes are LWW per path. Tree moves are cycle-safe. Text uses Loro rich text.
  Keyframes and proposals are keyed maps. Timeline edits that touch many items compute explicit moves at intent
  time (IF-4.9). There is no lock server and no "global" operation.
- **Proposals are shared state** (DOCUMENT-FORMAT §7.5). Previews are deterministic per peer, and accepting in
  one tab updates every tab.
- **Undo is per actor** from commit metadata (SF-Δ9). It uses inverse ops, so other actors' concurrent edits
  survive.
- **Presence** (`createPresenceStore`, extended for agents and gesture ghosts, SF-Δ25) travels on the coordinator
  bus and never reaches the CRDT or the store.
- **Networked multi-user later** = a `CollaborationTransport` from the store worker to a relay (per-asset room),
  plus server-side validation of policy locks. Nothing else changes: the same commit records, actor records,
  proposals and undo.
- **Test harness:** the mock collaboration network (`createMockCollaborationNetwork`, partition and heal) runs N
  editor peers, scripted agents and a store peer in property-based convergence tests (IF-16.4).

## 7. Capabilities, agents and models

- **Registry on main.** Instaflow capabilities are declared per feature (`defineCapability` with `appliesTo`,
  `presentation` and `plan`, SF-Δ11–12). Implementations call the editor worker through a typed protocol, or start
  jobs.
- **Agent runtime** (a headless feature on main): the chat loop over `@staticflux/ai` (chat with tool calls,
  SF-Δ30). Its tools are the same registry (`agent/*` view and apply tools plus every exposed capability). The
  system prompt prefix is the generated vocabulary from `agent/describe`, kept stable for provider prompt caching.
  Its default verify loop: read view → apply ops → read lints → screenshot once after a batch. Autonomy levels are enforced
  here and in the proposal engine. Autopilot bounds are op count, generation count and a time box.
- **WebMCP** (`@staticflux/webmcp`) publishes the same capabilities to external agents. The WebMCP client's name
  becomes the agent actor's `displayName`. Confirmations run in the client's `requestUserInteraction`.
- **Model providers:** OpenAI and Anthropic adapters as `RemoteLlmTransport`s with direct browser access. Media
  generation runs as jobs. **Mock providers are bound by default in dev and e2e** (scripted chat and tool calls,
  procedural media). Availability is a fact ("model configured") that gates generative capabilities.
- **HUD ranking:** an advisor decision point `instaflow/hud-next-action` (purpose `ui-ranking`, `latency: 'sync'`,
  Markov over local `capability.invoke` sequences, SF-Δ20). It changes presentation only.

## 8. StaticFlux mapping

| Need | StaticFlux |
|---|---|
| Boot, DI, lifecycles, budgets | `core`, `runtime` (`bootApp`, feature host, resource manager), `loader`, `perf` |
| Platform baseline and unsupported screen | `platform` facts + boot plan + `unsupported` preset (SF-Δ26) |
| Lenses, density levels | `shell` workspaces (`defineWorkspace`, `switchWorkspace` with View Transitions); one feature per lens |
| HUD, sheets, toasts, palette | `messaging` (new `toolbar` kind, SF-Δ21), `shell` command palette (the command bar wraps it), `a11y` |
| Workers, replicas, multi-tab | `worker` (supervised workers, replication, tab coordinator, frame and data channels; new handle, delta, peer channels SF-Δ17–19) |
| Document | `document` (ECS, engine, projections, presence, collab) + SF-Δ3–6, 8–9, 25 |
| Composition | `stage` (new, SF-Δ7) |
| Storage | `blob` (new, SF-Δ1–2) for objects; `storage` (IndexedDB) for the catalog, preferences and encrypted provider keys |
| Surfaces | `surface` (render worker hosting, metrics, a11y layer) + SF-Δ22–24, 27 |
| Wasm | `wasm` (`defineWasmModule` for render, authoring and Loro modules; `budgetCategory: 'wasm'`) |
| Actions | `capabilities` + SF-Δ10–14; `webmcp`; `ai` + SF-Δ30; `advisors` + SF-Δ20 |
| Agent views | `agentview` (new, SF-Δ34): view codecs, schema and vocabulary generation, handle tables, round-trip suite |
| Extensions (later) | `sandbox` (untrusted extensions); manifests checked by the extension host feature (§10) |
| Gating | `gate` (subjects `user`, `guest`, `agent`; facts: lens mode, read-only, model configured, platform, flags) |
| Identity | `auth` `guestProvider` (`stableGuestId`); `GuestUpgradeHook` reserved for accounts |
| Reload continuity | `handoff` (open asset, lens, selection, playhead, running job ids) |
| PWA | `pwa` (service worker, COOP/COEP injection, `.iflow` file handler) |

### 8.1 App layout

```
apps/instaflow/
├── AGENTS.md · README.md · index.html · vite.config.ts · package.json
├── src/app/            boot, units, profiles, unsupported screen, error catalog (IF-*)
├── src/model/          node kinds, components (defineComponent), property paths, change-set ops,
│                       asset kinds, canonical part codec — app-specific meaning
├── src/features/       home · library · editor-frame · lens-pages · lens-canvas · lens-timeline · lens-flow ·
│                       hud · command-bar · chat · agent-runtime · proposals · milestones · export · present ·
│                       read-only · settings-models · webmcp-tools · storage-panel   (features never import features)
├── src/workers/        editor.worker · render.worker · media.worker · store.worker · export.worker · ml.worker
├── src/capabilities/   declarations (typed ids) per feature area
├── mocks/              mock model providers (chat, image, video, audio), media corpus
├── engine/             Rust workspace: if-ir (shared layouts via defineLayout source('rust')),
│                       if-render (vello_gpu, wgpu, compositor), if-author (parley, linesweeper, kurbo, usvg),
│                       if-export (krilla, SVG writer)
└── e2e/                Playwright (Chrome), the five scenarios against mocks
```

### 8.2 Modes and gating without branches

- Lenses, read-only and presentation are **features** selected by shell workspaces. Read-only binds a feature set
  with no editing capabilities declared.
- Firefox differences are **variant bindings** on platform facts: `TextInput` (EditContext vs textarea),
  workspace home (folder picker vs OPFS plus zip), font source (Local Font Access vs uploads).
- Generative capabilities are gated on the `model configured` fact. With the fact false they stay visible as
  "Connect a model" (gating is UX).

## 9. Comments (design direction)

Comments live in the asset's `comments` part (DOCUMENT-FORMAT §11), a separate CRDT doc carried by the same head,
log and peers, so they co-edit and sync like content. The editor worker resolves anchors against the composed
stage every time it composes, which is how anchors follow node moves, retimes and reparenting. It projects the
comments in scope into agent views and into the Comments panel replica. Milestone creation and export skip the
part.

## 10. Extensibility (design direction, D7: extend, never remodel)

```
extension (sandboxed iframe/worker, or first-party in-process)
   │ manifest: contributions + permissions
   ▼
extension host feature (main) ── validates manifest ──► registers contributions:
   capabilities (appliesTo, presentation) → capability registry → HUD / bar / agents
   panels → right-dock tab slot           storage providers → @staticflux/blob backend port
   importers / exporters → import/export capabilities     model providers → @staticflux/ai providers
   declarative element types → component registry (expansion into primitives)    comment actions
   │
   └─ document access ONLY via capabilities: agent/read-view (if 'read-views'), agent/apply (if 'propose')
      → same codecs, validation, locks, gating (subject 'extension'), confirmation, proposals, undo, attribution
```

- **Fixed contribution points only.** There are no hooks into the engine, the renderer, the sequencing protocol,
  the store layout or the format. An extension cannot remove or replace a core capability. It can only add one.
- **When, not where.** Contributions declare applicability (selection shape, kinds, roles, lens). The HUD, the
  command bar and the panels pick them up wherever they apply, in every lens.
- **Isolation.** Untrusted extensions run in `@staticflux/sandbox` with a capability bridge. Network origins are
  limited to the manifest's list, and storage to an own namespace. First-party extensions run in-process under the
  same manifest checks, and are the proof that the contribution points are sufficient (IF-17.6).
- **The hard open problem: custom renderable node types.** Decided constraint: declarative types composed of core
  primitives, expanded by a pure, sandboxed function, with the expansion cached in the document so it renders and
  exports without the extension. Open: how expressive the expansion can be (layout, per-instance animation,
  interactivity), how type versions migrate, and how agent views describe an `x:` type (as its own element, or as
  its expansion).

## 11. Failure handling

| Failure | Behaviour |
|---|---|
| Editor worker crash | Supervisor respawns. The CRDT peer reloads from the store and replays unacked local commits kept in a per-tab OPFS journal. View state comes back from handoff. |
| Render worker crash / GPU device lost | Re-attach from the retained IR (SF-Δ23). The editor worker resends a scene snapshot (E-1 resnapshot). |
| Media worker crash | Decoder sessions rebuild. Playback pauses with a toast. |
| Leader tab closes | Coordinator failover. The new leader starts the store worker. Editors resend unacked commits. |
| Folder permission lapses | Read-only from OPFS caches with a re-grant banner (`IF-STORE-004`). |
| Quota | Writes fail with `IF-STORE-001`. The storage panel offers to delete renditions or move to a folder. |
| Provider failure or key missing | The capability fails with a `Result` and a fix. Placeholders keep their job state, and Retry is offered. |

## 12. Rejected alternatives

- **Store in a SharedWorker:** no sync access handles there.
- **Document owner in a SharedWorker plus per-tab tool workers (report 03 §7 option):** adds a hop on every commit
  and duplicates the CRDT anyway. The per-tab peer plus a store relay is simpler, and it is the co-editing model
  we need regardless.
- **View state on main:** main has no spatial index and no GPU surface, so it would break the one-owner rule.
- **Separate composition worker for the timeline (report 02):** replaced by the shared render worker.
- **WebGL2 fallback, Canvas2D glyph atlas, DOM-overlay text editing:** owner constraints, and each would be a
  second render path.
- **CanvasKit:** 2.2 MB, a JS↔Wasm call per draw op, no PDF. It is kept only as the S1 escape hatch.
- **ffmpeg.wasm in V1:** 25–31 MB and a GPL default build. Unsupported codecs get a placeholder.
- **Remotion or another OSS video engine:** licensing problems and a DOM-rendering model.
- **A standing agent replica of the document:** views are cheap enough to build on demand, and a replica would
  double memory.
- **Agent code against the engine:** if code-as-edit is added later, it runs in `@staticflux/sandbox` against a
  view-level API that only emits ops, which then pass the same validation.
- **Extension hooks into the renderer or format:** they violate D7, and export parity could no longer be
  guaranteed.
