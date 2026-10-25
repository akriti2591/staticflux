# Instaflow — the editor as a primitive

> Status: **accepted** (2026-10-25) as D16–D19 in [DECISIONS.md](DECISIONS.md). The agent is always optional: Studio
> works fully by hand.
> Builds on D4 (modes over one core), D7 (extend through contribution points), D12–D13 (agents, autonomy) and
> D15 (editor and render are modules).

## The idea

StaticFlux composes apps from capabilities, features and surfaces. Instaflow composes **editors** the same way.
An editor is not one fixed screen: it is a declarative **editor spec** that selects a lens, a scope, and a set
of registered tools, panels and actions over one shared engine. A pixel touch-up, a clip trimmer and the full
studio are the same engine with different specs. Specs come from people, from presets, and from the agent, one
turn at a time.

## Three surfaces, one session

| Surface | Route | What leads | What loads |
|---|---|---|---|
| **Home** | `/` | Recents, files, templates, quick actions | No engine, no GPU, no CRDT: the StaticFlux light boot path |
| **Chat** | `/c/:thread` | The conversation. Each turn may attach a **mini editor**: a live preview first, editable in place on click | Engine on the first mini editor; all mini editors in a thread share one engine and one GPU device |
| **Studio** | `/s/:asset` | The full editor, canvas first, with chat docked as a contextual panel | The maximal spec |

**One session moves across all three.** "Open in Studio" carries the thread and the current selection; returning
to Chat keeps every edit. The thread is a part of the asset (it survives reloads and milestones, never exports),
and handoff uses `@staticflux/handoff`. Nothing a person did in one surface is lost in another.

## Editor specs

```ts
interface EditorSpec {
  readonly id: SpecId;                    // e.g. 'pixel-touchup', 'clip-trim', 'studio'
  readonly lens: LensId;                  // 'canvas' | 'pages' | 'pixel' | 'timeline' | 'graph' (registered)
  readonly scope: ScopeRef;               // asset | page | node selection | time range | layer
  readonly tools: readonly ToolId[];      // registered tool contributions, in toolbar order
  readonly panels: readonly PanelPlacement[]; // registered panels and where they dock
  readonly hud: readonly ActionId[];      // contextual actions offered on selection
  readonly capabilities: readonly CapabilityId[]; // what may run here (still gated)
  readonly density?: 'focus' | 'standard' | 'pro';
  readonly pinned?: readonly SlotId[];    // what the person pinned; a new spec never removes these
}
```

Rules:
- **Closed vocabulary.** A spec may name only registered lenses, tools, panels and actions (contributions, D7).
  Nothing is invented at runtime, so generated UI stays predictable and accessible. Same lesson as S8: agents do
  best with a closed, documented vocabulary.
- **Validated and gated** like a change set: unknown ids, scope mismatches and capabilities the person may not
  use are rejected with typed errors and fixes. Specs never bypass locks, brand rules or gating (D13).
- **Small, animated diffs between turns.** The runtime diffs the next spec against the current one and changes
  only what differs, with the 120–200 ms motion from UX.md. Pinned slots stay. No full reshuffles.
- **Specs are data.** Presets ship as specs; people can save their own; the agent proposes them; Studio is the
  largest one. Modes (D4) become well-known specs.

Lifecycle of a spec in a turn: `proposed → validated → (shown as a preview) → mounted → updated* → unmounted`.
Autonomy modes apply: in Ask, a new mini editor appears as a preview the person opens; in Accept edits, it mounts.

## Mini editors in Chat

- A mini editor is the editor module with a narrow spec, mounted into a chat turn. It shows a live render of its
  scope first and becomes editable on click (cheap until touched).
- **One engine per thread:** editor module and render module are shared across all mini editors in the thread
  (D15 topology unchanged); each mini editor is a separate surface on the same GPU device. Off-screen mini
  editors drop to a cached image and release their tiles.
- Edits from a mini editor are ordinary document transactions (per-actor undo, attribution, milestones), so
  "Open in Studio" needs no conversion.

## Quick actions

Common jobs packaged as one-step capabilities with a declared input and output, built on the authoring and
render pipeline: remove background, resize for Instagram/Story/Post, make a reel from photos, add captions,
apply brand kit, export a set. Each quick action is a capability (often an `invokePlan` flow, PLAN Δ12) plus an
optional tiny spec for reviewing the result. They appear on Home, as chat suggestions, in the command palette and
in the HUD, and agents can call them. People and agents can save their own (M6 flows).

## Budgets per surface

| Surface | Target |
|---|---|
| Home | Interactive ≤ 1 s cold on the reference machine; no engine bytes |
| Chat | First mini-editor preview ≤ 500 ms warm after the turn arrives; editable ≤ 150 ms after the click |
| Studio | Existing IF-15 budgets |
| Spec diff | Applied within one frame; motion 120–200 ms |

## What changes in the plan

| Where | Change |
|---|---|
| M1a (running) | Nothing: store, document, render, threading, build and UI kit are shared by all surfaces |
| M1b | New WP **B0 Editor spec runtime** (spec schema, registry of lenses/tools/panels/actions, validation, diff and mount, pinning); tools and panels are built as contributions; Studio is the first spec |
| M1c | Add the **Home** route (light boot, recents, quick-action entry points) |
| M2 | Becomes the **Chat** surface: per-turn specs, inline mini editors, preview-then-edit, session handoff to Studio, quick actions as capabilities |
| UX.md | New information-architecture section; R0 tests the three surfaces with a clickable prototype |

## Proposed decisions

- **D16 — The editor is a composition.** Editor specs over a closed vocabulary of registered contributions;
  proposed by people, presets and agents; validated and gated; changed by small diffs.
- **D17 — Three surfaces, one session.** Home, Chat with mini editors, Studio with contextual chat; the thread is
  part of the asset; handoff keeps everything.
- **D18 — Quick actions are packaged capabilities**, available on every surface and to agents.
- **D19 — Studio is canvas-first.** Pages, timeline and pixel are lenses and specs on top of it.

## Open questions for R0

1. Does a mini editor open inline in the thread, or as a side sheet next to it?
2. How many concurrent mini editors per thread before older ones collapse to images?
3. When the agent proposes a different spec mid-edit, does it wait for the person to finish a gesture (likely),
   and how is the proposal shown?
4. Which ten quick actions matter most on day one?
