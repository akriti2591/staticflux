# StaticFlux — Feature Needs (outside-in API design)

> Every package API must trace to a need listed here (R11.12). These are the
> example app's features, written as if the framework already existed.
> Example app: **"Studio"** — an AI-assisted mixed-media document editor.

## The example features

| Feature | Kind | Weight | Modes | Notes |
|---|---|---|---|---|
| `studio-desktop` / `studio-mobile` | UI + logic | heavy (archive) | expanded+medium / compact | Document editor; doc lives in a document worker; co-editing + presence |
| `agent-chat` | headless logic + UI panel | warm | all | Agentic chat; tools call capabilities (edit doc, insert image); consumes credits |
| `onboarding` | wizard | cheap | all | Steps as sub-routes; persisted progress; coach marks |
| `settings` | UI | cheap | all | User-data slices (theme, locale); workspace switch (expert mode) |
| `billing` | UI + dialogs | cheap | web, pwa | Upsell dialog (routable), credit balance banner, plan facts |

## Needs per package

### core (DI, scopes, telemetry) — implemented
- Studio: `required` doc store, `lazy` presence, `functional` exportPdf (pre-warm on hover).
- Every feature: `onReady` hooks to subscribe to stores; `refreshOn: [SessionToken]`.

### runtime
- App: boot → core-ready → running; `pause()` while a modal "reconnecting" shows; `refresh()` after token change; degraded when the document worker dies.
- Feature host: activate/mount/hide/unmount/deactivate/archive studio; ref-count (agent-chat depends on studio's document capability while mounted).
- Scheduler: read/write phases for the editor's canvas measurement; `yield` in long ops; idle tasks.
- Resource manager: archive studio under memory pressure on compact devices.

### platform / config
- Facts: form factor (compact → studio-mobile), host mode (embed-agent-host → no SW, memory history), device tier, network, reduced motion, AI availability.
- Flags: `studio/ai-suggestions: boolean`, `onboarding/variant: 'A' | 'B'` (experiment → variant binding), pre-auth-safe flags.

### auth
- Guest can open `/` and `/onboarding`; `/studio/*` needs login; login redirect keeps the deep-link intent.
- Providers used: `bff-cookie` (default), `embed-host` (ChatGPT), `guest`.
- Session change → `refresh('epoch')` across app; logout disposes session scope.

### gate
- Policies: `route:/studio` requires authenticated; `capability:agent/insert-image` requires `plan:pro` or credits ≥ cost; `ui-slot:studio/ai-panel` requires flag + entitlement.
- Decisions explain themselves (devtools); denied → upsell surface.
- Meters: `credits` (reserve → commit/release around each agent call).

### data
- Resources: `docs.list` (paginated), `doc.get` (single), `agent.reply` (streamed), `user.batchProfiles` (batched).
- SWR caching keyed by epoch; retries with jitter; breaker on `agent` endpoint.
- Stores: schema-first `DocumentListStore`, `ChatStore` with snapshots/patches.
- User-data slices: `settings/theme` (user), `onboarding/progress` (user), `studio/last-doc` (device).

### worker / document
- Document worker owns `DocumentStore`; main thread has a read-only replica; edits are intents.
- Core context (session state, flags, decisions, platform, trace context) replicated to every worker.
- Worker crash → respawn → rehydrate from snapshot; app degraded until ready.
- Document engine: ECS entities (text block, image block), CRDT-backed text, presence.

### router / urlstate
- `/studio/doc/:id?tab=comments` — path → studio feature; `tab` is view state.
- `/studio/doc/:id/d/share` — routable share dialog.
- `?panel=chat&prompt=…` — intent consumed by agent-chat after authorize; prefill only.
- Exit guard: studio blocks navigation until pending save flushes.
- Sticky: `workspace`, `lang`, `sf-debug`.

### loader / perf
- Chunks: `feature:studio-desktop` (heavy), `feature:agent-chat` (likely), `feature:onboarding`.
- Warmup: `agent-chat` likely after studio first render; `billing` speculative on hover of upgrade CTA.
- Journey: cold `/studio/doc/42` → boot, pipeline stages, feature first-render/interactive/complete.

### ui / messaging / shell
- Components declare `render`/`lazy`/`functional` deps; placeholders sized.
- Surfaces: share dialog (routable), credit toast, low-balance banner, coach mark on the AI button.
- Shell: slots (`header`, `sidebar`, `main`, `panel`), theme tokens, `expert` workspace adds the inspector panel.

### i18n / a11y / handoff
- Messages per feature, lazy locale catalogs, runtime locale switch.
- Route-change focus, dialog focus trap, announcer for "Saved".
- Handoff: guest draft → after login; studio archive snapshot; scroll position on reload.

### ai / webmcp / advisors
- Advisor: predict next feature to warm (statistical default).
- WebMCP: expose `agent/insert-image`, `studio/summarize` capabilities as tools (gated, confirmed).

### platform: baseline, web API facts, async facts (Instaflow M1 A1, SF-Δ26)
- Instaflow boot (IF-2.2–2.4): declare a required baseline (WebGPU + an adapter, OffscreenCanvas transfer, WebCodecs, OPFS + sync handles, Wasm SIMD, cross-origin isolation + SharedArrayBuffer, AudioWorklet, Compression Streams incl. `deflate-raw`, Web Locks, BroadcastChannel) with app codes `IF-PLAT-001` (use Chrome), `-002` (no GPU adapter), `-003` (not isolated) → `defineBaseline`, `requireApi`, `requireFact`, `checkBaseline`.
- Instaflow unsupported screen: Safari or a blocklisted GPU boots one screen with the missing capabilities, codes and fixes, and nothing else → `unsupportedHostMode`, `unsupportedBootPlan`, `unsupportedUnits`, `mountUnsupportedScreen`.
- Instaflow variant bindings (IF-2.3, IF-2.5): `TextInput` picks EditContext vs hidden textarea, font source picks Local Font Access vs uploads, workspace home picks folders (`showDirectoryPicker`, `FileSystemFileHandle.move`) vs OPFS + zip → `facts.apis`.
- Instaflow render and media modules: the WebGPU adapter's info, features and limits (sizing tiles, fallback-adapter warning) and the WebCodecs codec matrix (export formats) without delaying boot → `createAsyncFactLane`, `webGpuAdapterFact`, `codecSupportFact`, `asyncFactLaneUnit`.

### tooling: Rust/Wasm build and licenses (Instaflow SF-Δ32, M1 A2)
- Instaflow engines (render: Vello GPU; authoring: Parley) are Rust crates in one workspace
  (`apps/instaflow/engine`) built by `pnpm build`, SIMD on, with content-hashed files and a manifest a worker
  loader reads (R20.7). A TypeScript-only contributor runs `pnpm check` without Rust and sees a warning.
- IF-15.1 budgets: render Wasm ≤ 300 KB brotli and authoring Wasm ≤ 350 KB brotli, reported next to the JS
  budgets and enforced in CI (R20.8).
- IF-2.11: CI rejects GPL/AGPL, non-commercial or watermark-licensed npm and cargo dependencies and model weights;
  the matte feature may use MediaPipe selfie (Apache-2.0) and BiRefNet (MIT) but never RMBG (non-commercial) (R20.9).

### testkit — render, GPU and media (Instaflow M1, WP A9)
- Render module (A6): test device-loss recovery (`running → lost → attaching`, re-init from retained IR) and pipeline warm-up without a
  GPU → `createFakeGpu` (`loseDevice`, consumed adapters, `callsTo`, `uncapturedErrors`); assert tiled vs full and GPU vs `vello_cpu`
  frames → `compareImages` + `RENDER_THRESHOLDS`; a few golden frames per feature → `createGoldenStore`; real WebGPU in CI on SwiftShader
  and on the owner's GPU → `runGpuPage` / `pnpm test:gpu` / `sf-gpu-run --real-gpu`; texture readback in pages → `readbackTexture`.
- Platform facts (A1): fake adapters with `isFallbackAdapter`, features and limits, and `requestAdapter() → null` → `createFakeGpu({ adapter })`.
- Export (C1): SVG/PDF parity rasterized by another engine → `RENDER_THRESHOLDS.crossRasterizer` (SSIM + blurred SSIM); PNG export
  goldens → `createGoldenStore`.
- Media (M3, groundwork now): decoders hand out frames that must be closed → `createMediaFakes().expectAllClosed()`.

### document v2 (Instaflow editor, M1 · A4)
Second consumer: the Instaflow editor (`docs/instaflow/`), written against `@staticflux/document/v2` (R11.8a–R11.8j).
- Editor worker: open a 200-page, 50k-node design in under a second by loading the document-level part and the visible
  pages only (`repo.open`, `doc.part(id)`); pages scrolled away are evicted by the resource manager (`doc.evict`, `stats()`).
- Canvas tools: a drag of 100–1,000 elements stages a frame per pointer move and commits once on release (`doc.gesture`);
  moving an element to another page is one undo step (`doc.moveAcross`).
- Two tabs on the same asset converge: each tab's commit records go to the store worker and arrive in the other tab
  (`onCommit` → `applyRemote`); a tab crash loses no acknowledged edit (`durable` = log append acknowledged).
- Undo service (A8): per-actor inverse steps with readable labels from commit `meta`, persisted up to 200 steps
  (`undoHistory(actor)`, compaction's undo horizon); D14's "flag an undo over someone else's later overwrite" uses
  `changedSince(commit.after)`.
- Agents: stale-field detection for a view's `base` (`changedSince(base, { subtree, paths })`, IF-CS-010); proposals preview
  on a fork (`fork(peer)`); every agent session commits as its own peer with its actor record.
- Text (B2): rich text with marks; comments and selections anchored to text that survives concurrent edits (`anchor`/`resolve`).
- Milestones (B5) and `.iflow` (C2): canonical, engine-independent part bytes and digests shared by unchanged parts
  (`encodeCanonicalPart`, `canonicalPartDigest`); "new document from milestone" rebuilds fresh parts
  (`buildPartFromCanonical`); old milestones open after component upgrades (`migrateCanonicalPart`).
- Change-set validation (B1/agents): component registry validates paths, kinds and values and publishes JSON Schema for
  agent tools (`registry.validateOps`, `registry.pathSchema`, `registry.jsonSchema`).
- Workspace store (A3): `@staticflux/blob` implements the `DocumentStore` port (head CAS under Web Locks, blobs, log).

### blob (Instaflow workspace store, A3)
- Store worker: open the OPFS workspace, become leader through a Web Lock, recover Latest from head + journal, ack each edit only once journaled (`createWorkspaceStore`, `createStoreLeader`, `createLatestStore`).
- Every other tab and worker: commit through the leader and survive its death without losing an acknowledged edit (`leader.commit`, resend until ack).
- Document engine (`DocumentRepo`, A4): persist CRDT parts as opaque snapshots and records; compact incrementally; keep milestones and pins in the head (`LatestStore.updateHead`).
- Import/media: hash large files in chunks with progress and cancel; range-read video by byte offset (`put(stream, { onProgress, signal })`, `get(ref, { range })`).
- Folder mode: mirror the workspace to a picked folder in batches; go read-only with a one-click re-grant when permission lapses; notice external edits on focus (`createFolderMirror`).
- Storage panel: usage/quota, persistence request, GC of unreferenced blobs after the grace period (`estimateStorage`, `requestPersistence`, `collectGarbage`).
- `.iflow` export/import (C2): write a bundle with milestone parts copied as stored, read one in place, dedupe on import (`createZipWriter`, `openZip`, `addBlobToZip`, `importZipBlob`).

### worker pipeline (Instaflow M1: editor ↔ render, SF-Δ17–Δ19, Δ22, Δ28)
Instaflow's editor and render modules run in one worker or two (D15). Each need names the API that serves it (R11.30–R11.42).
- Boot picks one worker or two from a setting; feature code never branches on it (`selectMedium`, pipes on `local` / `shared` / `message`).
- The editor publishes the view-state frame (camera, selection, gesture overlay, `viewSeq`, `docVersion`) and the render
  draws only whole frames (`defineCell` + `createCell` / `attachCell`, seqlock + checksum).
- Scene deltas go editor → render in order. The render applies them up to the frame's `docVersion` and recovers from a
  lost delta or a respawn with a snapshot (`createDeltaStream` / `attachDeltaStream`, `apply({ upTo })`, `onResnapshot`).
- Geometry, paint and glyph runs are sent once by digest beside the deltas (`createBlobSender` / `createBlobReceiver`).
- The main thread forwards pen strokes with every coalesced point, pressure and tilt into a binary input ring; the editor
  reads every sample, and the render's camera fast path reads coalesced ones (`createInputForwarder({ sinks })`,
  `inputRingSink`, `drainInputRing`).
- The canvas goes main → render as an `OffscreenCanvas`; the workspace directory goes main → store worker as a
  `FileSystemHandle`; M3 decoded `VideoFrame`s go to the compositor and must be closed (`createHandleChannel`, `createHandleLedger`).
- When the render worker crashes, the editor keeps its channel object and re-sends its pipe endpoints on reconnect
  (`createPeerBroker` + `workerHost`, `acceptPeer`, `peer.onConnect`; colocated: `createPeerPair`).
- A drag shows immediately and its overlay disappears in exactly the frame that shows the committed move
  (`createOptimisticIntents`: `stage`, `commit`, `advance`).
- The accessibility layer on main mirrors only the nodes in the viewport (`createWindowedPublisher` /
  `createWindowedReplica` over the editor's spatial index as a `WindowedSource`).
- CRDT merges and index rebuilds in the editor worker yield to input work, and stalls are reported (`createWorkerScheduler`,
  `scheduler.yield`, `createLongTaskDetector` from `@staticflux/runtime/worker`).
- M3: the playhead position is shared with the render worker and an AudioWorklet without messages (`defineClockCell`).
