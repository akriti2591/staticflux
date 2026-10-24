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

## Design direction (agreed, details pending)

- Canonical model: CRDT-based hierarchical document; ECS only as an internal runtime index; content-addressed workspace object store; local-first, cloud-ready.
- **Co-editing** (people and agents concurrently) is a first-class design constraint, even if networked multi-user ships later.
- Agent edits: validated change sets applied as reviewable proposal layers (attributed, single undo step).

## Open questions (under research)

- **Q1 Agent representation:** do agents need an intermediary format (HTML/SVG/JSX-like views) or can they use the canonical tree directly? What does projection cost? Should the canonical model change? → `research/05-agent-representation.md`.
