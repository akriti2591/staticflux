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

### ui theme contract + kit (`@staticflux/ui/theme`, `@staticflux/kit`; Instaflow M1 A10)
Two consumers, so the kit stays generic: Studio (migrated, every control) and Instaflow (`docs/instaflow/UX.md`).
- **Studio** — theme: default theme as a contribution, appearance applied to `<html>` before the first frame,
  restored after first paint (device store); the settings slice maps System / Light / Dark / High contrast onto the
  appearance, density Focus / Standard / Pro remembered per device. Controls: header and login buttons, guest draft
  field (lazy kit chunk, boot stays ≤ 150 KB), editor title field, **toolbar** of document actions, **tabs** for the
  document views, block paragraphs as multiline fields, chat composer (form submit from a kit button), settings as
  **segmented** controls, onboarding and billing buttons. Messaging: confirm / share / upgrade / reconnecting dialogs in
  the kit **dialog frame** (routable `/d/share`, `/d/upgrade` unchanged), saved **toast**, credit banner, coach mark —
  rendered by `<sf-surface-layer>` (native `<dialog>`, Popover API). Keyboard: `Mod+K` opens the **capability palette**
  (summarize, clear document) instead of an empty command list; capability shortcuts show in it (`Mod+Shift+U`).
- **Instaflow** — the "Say what you need" bar (`Mod+K`) is the capability palette over the same registry agents use;
  the contextual **HUD** is a `toolbar` pill (roving focus, `Alt+Enter` focus, ≥ 1 ✦ accent action, `⋯ More` → menu,
  every action labelled or tooltipped with its shortcut); the right **dock** is tabbed, resizable and collapsible to an
  icon rail; **Layers** is a virtualized tree (50k nodes, lock/visibility actions, ✦ badges, drag **and** keyboard
  reorder through the undo model); **Properties** (Pro density) are inspector groups and rows (precise numbers, color
  fields for brand kits, sliders for dials, `explain` hints); lens switch Pages | Canvas | Timeline | Flow is a
  segmented control; Share/Export is a routable dialog (`/d/share`); toasts ("Saved", `Mod+S` → "Create milestone"
  action); density Focus (default, dock collapsed to a rail) / Standard / Pro; motion 120–200 ms, none when reduced;
  one accent for generative ✦ and calm neutrals; the **Instaflow brand theme** from the design track is
  `extendTheme(defaultTheme, …)` contributed with a higher order and must pass the shared theme contract suite.

### stage, attribution, undo (Instaflow editor, M1 · A8)
Consumer: the Instaflow editor worker (`docs/instaflow/`), over `@staticflux/document/v2` (R11.8k–R11.8s).
- Inspector and agents: "why is this value here?" — `stage.explain(node, path)` names the layer, arc and source (local,
  `format=story` variant, brand class, instance source) and what it beat (`agent/explain`, IF-4.6).
- Variants (format, theme, locale): the session's variant selection switches what every node shows without writing the
  document (`session.select('format', 'story')`); previews and solo/mute are session opinions (`session.set`).
- Brand kits and templates (B1, B5): classes via `style.inherit`, final paths that brand rules keep, policy locks that
  agents can never remove (`checkWrite`, `stageWriteGuard` on every write, IF-4.7, IF-CS-004/013).
- Instances and embedded designs: pinned (milestone) or following (Latest) references composed as proxies; a change in a
  followed brand kit or component recomposes only what reads it (`onInvalidate` drives the render projection).
- Undo (IF-4.13, D9, D14): Mod+Z / Shift+Mod+Z per actor (`undo.undo(actor)`), one step per gesture, per capability
  invocation and per accepted change set; the UI shows a flagged undo ("Agent changed this after you — restore yours /
  keep theirs") from the typed `conflict`; the agent's own undo (`agent/undo`, M2) uses the same service.
- History and attribution badges: every commit's actor record (`actorOf(meta)`), from capability runs
  (`metaForRun(attribution, run, label)`), WebMCP clients named by their client name.
- Proposals (M2): a `proposal/<id>` layer plugs into `stage.addLayer`; accepting it is one undo step via `changeSet`.

### document render projection + spatial index, sequencing oracle (Instaflow M1 A7: SF-Δ25, D15)
- The editor module sends the render module only what it draws, as compact binary deltas with array slots instead of
  node ids, and a snapshot after a gap (`defineRenderProjection`, `createRenderProjector`: `project(change, { supersedes })`,
  `snapshot()`; render side `createSceneStore`: `apply(payload)`, `column(field)`, `forEach`).
- A drag's overlay disappears in exactly the frame that shows its commit: the delta lists the gesture ids it supersedes.
- Hit tests and marquee selection look up candidates by ink bounds without scanning the page (`bindSpatialIndex({ part,
  bounds, paths })`: `rebuild`, `apply(change)`, `follow`; `createSpatialIndex`: `hit`, `search`; `inkBox`).
- One worker or two for editor and render is a boot setting, and the S2 correctness check runs on every topology and
  medium in CI (`runSequencingOracleContract(name, subject, runner, { gestures, configs, faultConfigs })`,
  `generateSequencingScript`, `checkPresentedFrames`, `driveSequencingScript`).

### render: raster backends, GPU device lifecycle, headless, cache budgets (Instaflow M1 A6)
- **Instaflow canvas** (render worker): pan, zoom and drag 100 elements on a 10k-element page within 8.3 ms p95
  (S1) → `createTiledRenderer` over the Vello `RasterBackend` (512 px tiles per √2 level, idle-lane tile prep, the
  previous level while sharpening, a lifted layer for the selection being dragged).
- **Instaflow boot**: the first canvas frame ≤ 500 ms warm while Vello's first render compiles pipelines (S1: ≈ 1 s)
  → `renderer.warmUp` during document load plus `showSnapshot(captureSnapshot())` from the previous session;
  `render/first-sharp-frame` in the perf lab.
- **Instaflow resilience**: a GPU reset must not lose the document or reload the tab (IF-7.11) →
  `createGpuDevice({ provider, restore })` re-attaches from the retained scene; `deviceRestored()` re-renders.
- **Instaflow export (C1) and agent screenshots**: PNG at print resolution beyond the texture limit →
  `createHeadlessSurface({ backend }).render({ world, width, height, signal })`.
- **Instaflow memory** (IF-15.7: GPU caches ≤ 512 MiB): tiles and media frames register with
  `createMemoryBudgets` (`MemoryBudgetsToken` in workers); pressure evicts caches before features are demoted.
- **Tests**: Studio and Instaflow render code is tested in Node against `createMemoryRasterBackend` and testkit's
  GPU fake; real pixels through `pnpm test:gpu`.

### theme contract: control shape, control edge, agent actions, tag, slider (Instaflow design track · DS1)
Consumer: the Instaflow **Clean Pop** theme (`apps/instaflow/src/theme`, `docs/instaflow/design/README.md`) and any app
that themes the kit (R13.21–R13.23).
- "Anything you press is a pill", but cards stay 18 px and fields 12 px: one shape token for pressables
  (`radius.control`) that buttons, icon buttons, switchers and tags read; fields keep `radius.md`.
- Secondary buttons and fields need an edge that reads as a control (≥ 3:1) while dividers stay hairline:
  `color.controlEdge` next to `color.border`. Switchers are a borderless mist track with a white selected pill.
- Buttons 42 / 34 / 28 px with 15 / 13.5 / 12.5 px text and 20 / 14 / 12 px padding: per-size `type.control*` and
  `size.controlPad*` tokens (other themes keep their own).
- "Claude" actions (Start making, Send, Accept) and "✦ Rewrite" in toolbars look different from the one primary action:
  `<sf-button variant="agent">` / `variant="agent-soft"` over `color.agent*` tokens; agent tags use the same soft pair.
- Headings use a display face (Bricolage Grotesque in Instaflow): `font.familyDisplay`, `font.weightDisplay`.
- Labels that are not pressable — brand kit, "✦ Claude · Accept edits", lens type (solid lens colour), tokens (mono):
  `<sf-tag tone .color .ink mono>`; the lens colours stay in the app's typed lens palette (`lensTag(lens)`).
- Dials (Warmth, Exposure): `<sf-slider>` with a thin track, filled part, ringed thumb and the value in a pill.

### versioning: Latest, milestones, new document, templates, export snapshot (Instaflow M1 B5)
Consumer: Instaflow (`apps/instaflow/src/versioning`; D2, D9, D10; IF-5, IF-22). Built on `DocumentRepo` + the
`DocumentStore` port and canonical parts (A4), the stage undo service (A8), the kit and Clean Pop (A10, DS1).
- "There is no save button, but I want to know my work is safe" → a save state from commit acknowledgements
  (`createLatestService`), shown by `<if-save-status>` over the kit's new **`<sf-status>`** (dot + words in a polite live
  region, R13.24). "The folder copy is behind" is its own state, not an error.
- "Keep the version I sent the client, then keep working" → `milestones.create({ name, note, actor })` writes only the
  changed parts (frontier cache + digest dedupe in `createPartCapture`), costs the same in a document with 60 milestones
  as in one with 3, and is reachable from the Milestones panel, `Mod+Alt+S` and agents (one capability).
- "Show me what they saw next to what I have now" → `openComparison(…, milestone, 'latest')`: two read-only documents
  (canonical parts, no CRDT), the Latest side frozen through an export snapshot; no structural diff in V1.
- "Start a variant from what they saw next week" → `createDocumentFromMilestone`: a new asset with a detached baseline;
  the source can be edited or deleted without affecting it.
- "Use this flyer as a template" → `markSlot` (text, image, colour; undoable) and `createDocumentFromTemplate({ fills })`.
- "Export while I keep editing" (C1) → `snapshots.freeze()` at export start, `snapshots.open(frozen)` to render; nothing
  is recorded. Publishing later goes through `ReleasePort`.
- The editor (B0) mounts everything through contributions (`PanelContribution`, `TopBarContribution`,
  `CommandContribution`) and the `VersioningHost` port (show read-only, show comparison, open document).


### shell/spec: declarative editor specs over a closed vocabulary (Instaflow M1b B0, D16)
Consumer: Instaflow's editors — Studio (the maximal spec), mini editors in Chat (M2), presets and agent-proposed specs
(`apps/instaflow/src/spec`, `src/studio`) — and any app that composes screens from registered contributions (R13.25–R13.30).
- "An editor is a lens, a scope and a set of registered tools, panels and actions": `createSpecVocabulary({ sections, contributions })`
  with `defineSpecSection` / `defineSpecContribution`; the app compiles its schema to `ShellSpec` (`toShellSpec`).
- "Agents may only name what exists, and never bypass gating": `validateSpec(spec, vocabulary, { decide })` returns every issue with a
  code and a fix (SF-SHELL-009…013); agents are decided as agents through the gate adapter.
- "A new turn changes only what differs, with 120–200 ms motion, never reshuffles": `diffSpecs` (LIS-minimal moves, insertion
  anchors), `createSpecRuntime({ vocabulary, port, decide, motion, reducedMotion })` → `apply`, `preview`, `revalidate`.
- "What I pinned stays": `runtime.pin(key)` / `unpin`; pins in a spec are added, never removed by another spec.
- "Render the layout with enter/exit motion without a DOM in the runtime": `createSpecLayoutPort()` (`entries(group)` with phases,
  `groups()`, `mountedContext`).
- **Tests**: `runSpecRuntimeContract`, `runSpecMountPortContract` (Studio's `<if-studio>` DOM runs the port suite).
