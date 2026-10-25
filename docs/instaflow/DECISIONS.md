# Instaflow — Decision log

Owner-locked decisions. These override anything in the research reports or design drafts.
Open questions are listed separately and are **not** decisions.

## Locked (2026-10-24)

| ID | Decision |
|---|---|
| D1 | **Platform:** Chrome desktop only, modern web tech only (WebGPU, WebCodecs, OffscreenCanvas in workers, File System Access + OPFS, Wasm). Firefox desktop best-effort; Safari and all mobile dropped. Unsupported browsers get a clear "use Chrome" screen. No archaic fallbacks. |
| D2 | **Versioning:** exactly two things — **Latest** (continuously saved; undo/redo within it; no save button) and **named Milestones** (explicit, immutable, pinnable full snapshots that share unchanged parts by content hash; never diff chains). **No automatic versions** in V1. No restore: **"New document from milestone"** creates a new document with a **detached baseline** (provenance is an informational label only). Costs scale with document size, never with age or ancestry. |
| D3 | **No accounts in V1** (logged-out; local guest identity for attribution). **Gating is used** (modes, locks/brand rules, capability availability, platform facts, flags, agent permissions). |
| D4 | **Modes over one core:** pages, infinite canvas, timeline and graphs/flows are modes of one generic authoring core; the asset is the data primitive. |
| D5 | **Must-haves:** timeline video and audio editing, animations and transitions. |
| D6 | **Location:** `apps/instaflow` in the StaticFlux monorepo; framework changes happen in place. Publishing to npm is on demand only. |

| D7 | **Extensions extend, never remodel.** Extensions use only a fixed set of safe, declared contribution points (actions/capabilities, panels, storage providers, importers/exporters, model providers, declarative element types, comments). They cannot replace core behaviour, patch the engine, bypass gating/locks/validation, or touch the document except through capabilities and change sets. |

| D8 | **Storage start:** new users start in browser storage (OPFS, `navigator.storage.persist()`), Excalidraw-style; "Open folder" always available; Instaflow suggests moving to a folder past ~2 GB or under storage pressure. Memory scales with what is open (lazy pages, streamed media). |
| D9 | **Undo:** 200 steps per actor, persisted across reloads. |
| D10 | **Publishing creates a Release artifact**, not a milestone: a separate read-only asset (rendered HTML/MP4/PDF + an internal frozen snapshot + "published from" label). Plain exports create nothing. |
| D11 | **Comments:** fast follow immediately after V1; agents are first-class commenters. |
| D12 | **Agent access:** V1 = WebMCP + in-app chat; optional local MCP bridge (`instaflow mcp` companion connecting desktop agents to the open tab) as an M7 stretch. Same views/change sets/proposals/gating pipeline. |
| D13 | **Agent autonomy modes** (modelled on Claude Code permission modes): **Plan** (propose only), **Ask** (approve each change set; default for external agents), **Accept edits** (auto-apply undoable document edits; still asks for destructive, spend and outward-facing actions; default for the in-app agent), **Autopilot** (everything within gating up to a user-set spend/step limit; for flows and batch runs). No mode bypasses locks, brand rules, gating or validation. Mode is switchable per agent from its presence chip. |
| D14 | **CRDT granularity (from S4):** Loro behind `DocumentCRDT` v2 with **one CRDT document per page** (plus a small document-level doc for shared styles, assets and page order). Cross-page edits (move element between pages) commit to both docs as one undo step. The S4 merge criterion is restated as **≤ 200 ms per page, off the main thread**; no LWW v2 benchmark before M1. Adapter rules: never materialise the whole doc to JS, free every Loro handle (leak test required), one commit per gesture, each agent session is its own peer. Undo over another actor's later overwrite is **flagged** to the user, never silently applied or skipped. |
| D15 | **Editor/render topology (from S2):** editor and renderer are separate modules that talk only through the S2 ports (input ring, deltas, SAB view-state frames). **One worker or two is a boot-time setting, not a code path.** Default: **one worker (colo)**, the configuration that met the 1 frame + 4 ms p95 budget on the owner's real GPU (9.8 ms vs 19.7 ms split). Heavy work (CRDT merges, media decode, ML) stays in its own workers. The split becomes the default only if it meets the budget on the reference machines after the main-rAF-driven tick fix. Rules for both: draw on arrival, publish deltas before the view frame, render applies deltas only up to the frame's version; the S2 oracle check is a shared test suite. |
| D16 | **The editor is a composition** ([EDITOR-AS-PRIMITIVE.md](EDITOR-AS-PRIMITIVE.md)). An editor is a declarative **editor spec** (lens, scope, tools, panels, HUD actions, capabilities) over one engine, drawn from a closed vocabulary of registered contributions. Specs come from people, presets and agents; they are validated and gated like change sets and change the UI by small animated diffs that never remove pinned slots. Modes (D4) are well-known specs. |
| D17 | **Three surfaces, one session.** **Home** (no engine), **Chat** (conversation leads, per-turn mini editors, preview then edit) and **Studio** (full editor, chat as a contextual side panel). **The agent is always a choice:** anyone can open Studio directly and edit by hand with no chat at all. The thread is part of the asset; handoff between surfaces keeps every edit. |
| D18 | **Quick actions are packaged capabilities** (declared input and output, often a flow) available on Home, in chat suggestions, the command palette and the HUD, and callable by agents. |
| D19 | **Studio is canvas-first.** Pages, timeline and pixel are lenses and specs on top of the infinite canvas. |
| D20 | **Text input on Chrome stays on EditContext (from the IME check, 2026-10-25).** With real macOS input methods (Japanese, Chinese, Korean) in Chrome 155, EditContext placed the candidate window at the composition every time, across wrapped lines, after Arabic text and under browser zoom; the hidden-textarea adapter passed the same checks. So the platform fact keeps choosing EditContext where it exists, and the hidden textarea stays the fallback for browsers without it (Firefox). No branch on browser in feature code. |

## Design direction (agreed, details pending)

- Canonical model: CRDT-based hierarchical document; ECS only as an internal runtime index; content-addressed workspace object store; local-first, cloud-ready.
- **Co-editing** (people and agents concurrently) is a first-class design constraint, even if networked multi-user ships later.
- Agent edits: validated change sets applied as reviewable proposal layers (attributed, single undo step).

## Open questions (under research)

- **Q1 Agent representation:** do agents need an intermediary format (HTML/SVG/JSX-like views) or can they use the canonical tree directly? What does projection cost? Should the canonical model change? → `research/05-agent-representation.md`.
