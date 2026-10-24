# Instaflow

> Status: **design, v1 draft for owner review** (2026-10-24). Supersedes the research reports where they
> disagree. Nothing in `apps/instaflow` is built until this set is agreed.

Instaflow is a local-first, agent-first authoring app for visual and time-based media, built at
`apps/instaflow` on StaticFlux. You **author an asset, then act on it**. A flyer, a deck with page transitions, a
reaction video, a generated clip that you trim and extend, and a reusable workflow are all **assets**, edited by
one authoring core seen through four lenses. Humans and agents use **the same capabilities**: the HUD, the
command bar, the chat and an external WebMCP agent all call the same typed actions, with the same validation,
preview, undo and attribution.

## Principles

1. **The asset is the data primitive.** Everything is an asset: media, designs, brand kits, templates, motion
   presets, workflows, prompts. Actions take assets and produce node edits or new assets with provenance.
2. **One authoring core, four lenses.** Pages (fixed formats), Canvas (infinite), Timeline (tracks and time) and
   Flow (step graphs) are views over one document tree. Switching lenses keeps selection, undo and chat.
3. **Say it or tap it: the same action.** Every UI action is a StaticFlux capability, and every capability is an
   agent tool. Chat has no hidden powers, and buttons never lag behind chat.
4. **Agents propose, people decide.** Agents read an agent-facing representation of the document and return
   **change sets**: typed op batches with a base version, an author and an intent. A change set is shown as a
   proposal layer. You accept it per op or as a whole, as one attributed undo step. *The agent-facing
   representation itself (HTML, SVG, JSX, a JSON tree or a DSL) is **open, pending research 05**.*
5. **Co-editing is a design constraint, not a feature flag.** People and agents edit the same document
   concurrently through a CRDT. Every tab and every agent is already a separate peer in V1, so networked
   multi-user later is a transport, not a redesign.
6. **Motion is first-class.** Keyframes, text animation, transitions between clips and between pages, zoom/pan and
   picture-in-picture use one time model (integer ticks) and one deterministic evaluator. Preview equals export.
7. **High-utility features, no gimmicks.** Ship flyers, decks with transitions, reaction videos and
   generate→edit→extend before novelty effects. Every HUD slot traces to a researched job (UX.md §7).
8. **Local-first and yours.** Work opens offline, saves continuously with no save button, lives in a browser store
   or a real folder you choose, and exports to an open single file. The format is ready for the cloud without a
   format change.
9. **Modern platform, one code path.** Chrome desktop is the target. WebGPU, WebCodecs, workers with
   OffscreenCanvas, Wasm, File System Access and EditContext. There are no legacy fallbacks. Unsupported browsers
   get a clear screen with an error code.
10. **Costs scale with size, never with age.** Milestones are full snapshots that share unchanged parts by hash.
    There are no diff chains and no unbounded history.
11. **Generic and open.** Framework-worthy primitives go into StaticFlux packages. Instaflow-specific meaning stays
    in the app. Others can extend it to other platforms.

## V1 scope

| In V1 | Later (the format already allows it) |
|---|---|
| Chrome desktop (Firefox desktop best effort) | Safari, mobile, tablets |
| Local-first: browser store (OPFS) or a real folder; `.iflow` single-file export/import | Cloud store (object storage + DB), sync, share links |
| Guest identity only (stable local actor id); no accounts, credits or metering | Accounts (plug in a provider plus the guest-upgrade hook), credits |
| Latest (continuous save, undo/redo) and named **Milestones**; "New document from milestone" | Automatic versions, restore-in-place, branches |
| Lenses: Pages, Canvas, Timeline, Flow; read-only and presentation modes | — |
| Concurrent co-editing by people (multiple tabs) and agents on one device, through the CRDT | Networked multi-user co-editing over a relay (only a transport is added) |
| Shapes, images, vectors, rich text, effects, brand kits, templates with slots | Auto-layout, text on path, HDR / Display P3 |
| Video and audio tracks, trim/split, constant speed, fades, crossfades, clip and page transitions, keyframes, text animation, zoom/pan, PiP person cutout, captions | Speed ramps, motion tracking, chroma key, LUTs, Lottie authoring |
| Generative capabilities with bring-your-own model (OpenAI, Anthropic), **mocked in development**: images, video, audio, "extend this clip", chat | Gemini and other providers, on-device generation |
| HUD + command bar + chat + WebMCP; proposals; attribution; per-actor undo; agent presence | Local MCP bridge for non-browser agents |
| Export: PNG, PDF, SVG, MP4 (H.264/AAC), WebM, GIF, viewer HTML, `.iflow` | Lottie/OTIO export, C2PA signing |

## Documents

| File | What it decides |
|---|---|
| [REQUIREMENTS.md](REQUIREMENTS.md) | Numbered requirements `IF-x.y` |
| [DOCUMENT-FORMAT.md](DOCUMENT-FORMAT.md) | Assets, the tree, components, store layout, `.iflow`, versioning, the change-set protocol |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Threads, engines, data flow, sequencing, StaticFlux mapping |
| [UX.md](UX.md) | Interaction model, layout, lenses and modes, agent UX, the owner's five scenarios, research plan |
| [PLAN.md](PLAN.md) | Phase-0 spikes with kill criteria, milestones, new StaticFlux packages and changes |
| [research/](research/) | Inputs: [01 format](research/01-document-format.md), [02 media](research/02-timeline-media-engine.md), [03 engine](research/03-rendering-authoring-engine.md), [04 agentic UX](research/04-agentic-authoring-ux.md) |

## Decisions that resolve disagreements between the reports

| Topic | Decision | Why |
|---|---|---|
| Text pipeline | **Parley (Rust → Wasm) for layout and shaping, rendered as Vello glyph runs**, for every output including video. harfbuzzjs is rejected. | One layout gives identical screen, PNG, PDF, SVG and video output. It also gives line breaking and bidi, which harfbuzzjs lacks. No Canvas2D. |
| Compositor | **One shared WebGPU compositor** (Vello + our WGSL compositor) in the render worker, used by pages, canvas, timeline preview and export. No WebGL2. | One render path. The timeline is a scene with a time camera. |
| Text editing | **EditContext** on Chrome. A hidden-textarea adapter behind the same `TextInput` port on Firefox. HTML-in-Canvas is used only for optional non-content overlays. | EditContext has shipped (Chrome 121+) and works with our own layout. HTML-in-Canvas is still an origin trial with renames. |
| Per-tab camera and tool state | A **per-tab editor worker** owns camera, selection, tools, gesture overlays, hit testing and the tab's CRDT peer. **One store worker per workspace** (in the leader tab) owns persistence. | The document is shared across tabs, but view state is per tab. OPFS sync access handles exist only in dedicated workers, so the store cannot be a SharedWorker. |
| CRDT | **Loro** behind `DocumentCRDT`. A phase-0 kill criterion falls back to an extended LWW engine plus Yjs text. | Loro provides a movable tree, movable lists, rich text, fork (proposals), undo and shallow snapshots in one engine. |
| Versioning | **Latest + Milestones** (owner). Milestones are engine-independent canonical tree parts addressed by hash. Report 01's frontier-based named versions and history checkout are rejected. | Costs scale with size. The format survives a CRDT engine swap. |
| Templates and remix | Instantiated as **New document from milestone** (detached). Report 01's live `base` layer is rejected. | One mechanism, no hidden ancestry dependencies. |
| Agent-facing representation | **Open: pending research 05.** The edit mechanism (change sets + proposal layer) is decided. The representation must meet IF-6.1. | Owner correction, 2026-10-24. |
| Catalog | A derived index in IndexedDB through `@staticflux/storage`. sqlite-wasm is rejected for V1. | Simplest build. The index is rebuildable from the store. |
