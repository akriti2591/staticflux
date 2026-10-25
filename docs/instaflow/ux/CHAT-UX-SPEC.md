# Instaflow Chat — UX specification (M2)

> Status: **M2, written now so M1 leaves the right hooks.** Shares the principles of `STUDIO-UX-SPEC.md` §0 and its
> icon, motion, toast and settings rules. Sources: `docs/instaflow/design/ChatCP.dc.html`, `UX.md` §2 and §5,
> `EDITOR-AS-PRIMITIVE.md`, D12, D13, D16–D18. Flows: `STUDIO-FLOWS.md` F-40…F-46 (all marked M2).
> Nothing in this file is rendered in M1 except the Settings › Assistant pre-launch card (STUDIO-UX-SPEC §2.4).

## 1. What Chat is

Chat (`/c/:thread`) is the second surface (D17): the conversation leads, and each assistant turn may attach a **mini
editor**, a live preview of part of the asset that becomes editable in place on click (D16: a narrow editor spec over
the same engine). The thread is part of the asset: it survives reloads and milestones and never exports. The assistant
is always optional: every mini editor is hand-editable with no message sent, and `Open in Studio` carries the thread and
the selection into the full editor and back without losing an edit.

## 2. Entry points (provider-agnostic)

- **Home hero composer** (HomeCP): a 22 px-cornered card with a 2-row textarea (`Describe what you want to make`),
  `＋ Attach`, a brand chip (`Brand · Night Market`), the autonomy chip (`✦ <Provider> · Accept edits`) and the
  Claude-variant button `✦ Start making`. It renders **only when a provider is configured**; otherwise the hero shows
  one secondary button `Set up an assistant` → Settings › Assistant, and M1's format row. Sending creates a thread and
  opens Chat.
- **Studio**: the `✦ <Provider> · <Autonomy>` chip (top bar) opens the docked Chat side panel (288 px, StudioCP); the
  selection pill's `✦` actions and the command bar's natural-language input post to the same thread with the selection
  as context (`Context: Headline selected` chip in the composer).
- **Home nav `Chats`**: the thread list.
- Provider display follows STUDIO-UX-SPEC §2.2: `✦` plus the provider's display name; raspberry is the agent role
  colour; no vendor marks. With no provider: nothing assistant-shaped except the Settings entry.

## 3. Layout (ChatCP)

| Region | Content |
|---|---|
| Threads rail (256 px) | Logo slot, `＋ New chat` (secondary, full width), threads grouped by day as ghost/selected pills (title only). Context menu: Rename, Open asset in Studio, Delete thread (keeps the asset). |
| Header (60 px) | Thread title (Bricolage 800 20 px, click to rename), a mist chip with the asset facts (`2 assets · Night Market brand`), `Open in Studio` (secondary with the lens square) at the right. |
| Transcript (860 px column) | Person's bubbles right-aligned (mist, 20/6 px corners); assistant text plain; **mini editor cards**; proposal cards; attachment chips under a bubble. Streams; the canvas in a mini editor never blocks. |
| Composer (bottom, 22 px card) | 2-row textarea (`Ask for a change, or describe the next thing to make`), `＋ Attach`, autonomy menu `✦ Accept edits ▾` (D13), provider menu `<Provider> ▾` (switch per thread), `Send` (Claude variant, `Mod+Enter` / `Enter`; `Shift+Enter` newline). A context chip shows the current selection when Chat is docked in Studio. |

## 4. Mini editors

- A mini editor is an 18 px card with a header (lens shape, Bricolage 16 title, a mono chip `canvas · page 1` /
  `pixel · touch-up` / `timeline · trim`, tools switcher when editing, `Edit here` / `Done` toggle, `Open in Studio`),
  and a body on the mist canvas (`#E4E9EF`) with the preview at a fixed height (270 px page, 240 px photo, 170 px
  timeline strip).
- **Preview first:** the body is a cached render until clicked (cheap). **`Edit here`** (or clicking the preview)
  mounts the narrow spec: the body becomes live in ≤ 150 ms, the card header gains the spec's tools (e.g. `Select ·
  Text`, `✦ Rewrite`; or `Brush · Erase object · Crop`; or `▶ 00:04.2 / 00:15.0`), and the selection pill from Studio
  appears inside the card. Fields beside the preview (Warmth, Exposure sliders) are the spec's inspector.
- `Done` returns to preview; edits are ordinary document transactions (per-actor undo, attribution), so nothing is
  converted on `Open in Studio`.
- At most **3** live mini editors per thread; older ones drop to a cached image (D16 budgets). Off-screen ones release
  their tiles.
- Spec changes between turns are small animated diffs (120–200 ms) that never remove pinned slots; the assistant
  waits for a gesture to finish before swapping a spec.

## 5. Proposals, autonomy and undo (D13)

| Mode | Chip | Behaviour |
|---|---|---|
| Plan | `✦ Plan` | The assistant only describes steps; nothing changes. |
| Ask | `✦ Ask` (default for external agents) | Every change set is a **proposal card** (ChatCP / StudioCP: raspberry-soft card, `✦ <Provider> proposes`, one sentence, `3 changes · one undo step`, `Accept` (agent variant) / `Reject` (secondary)); on the canvas the affected elements get a dashed raspberry outline and a `<Provider>` name tag; ghosts at 60 % for additions. `Apply part` by clicking a ghost. |
| Accept edits | `✦ Accept edits` (default for the in-app assistant) | Non-destructive edits apply as labelled undo steps with a `✦ <Provider> · 1 undo step` chip under the turn; deletions, bulk edits over 20 nodes, generation spend and outward-facing actions still propose. |
| Autopilot | `✦ Autopilot · 40 steps` | Bounded by step and spend counts; live progress line; stops at destructive steps. |

- The person's `Mod+Z` undoes the person's last step only (UX.md §5). Assistant steps undo from the turn's chip
  (`Undo`) or the History tab; `Reject session` reverts everything since the last approval.
- Conflicts (the person moved what the assistant changed) show a split chip `yours / <Provider>'s`; default keeps
  yours.
- Every applied change is announced politely ("Assistant changed 3 headlines").

## 6. Handoff Studio ⇄ Chat

- `Open in Studio` opens `/s/:asset` with the thread docked as the side panel, the mini editor's selection selected
  and the camera on it. The dock remembers the thread. `← Chat` in the side panel header returns to `/c/:thread`
  scrolled to the last turn; every Studio edit is already in the asset.
- Thread persistence: a `thread` part of the asset (never exported, kept in milestones so a milestone's chat context
  survives; "New document from milestone" copies the thread as history).
- Deleting a thread never deletes the asset; moving the asset to trash hides its threads until restored.

## 7. What M1 must not do (hooks)

1. Never hard-code a vendor name in strings, ids or colours: the agent role colour is `agent*` tokens; copy uses
   "assistant" or the configured provider name from Settings.
2. Keep `instaflow/chat` as a panel id with `side` placement, and the 288 px side region in the Studio spec, so docking
   is a spec change, not a layout change.
3. The command bar is a capability palette whose input can later be routed to a model (`if-command` → palette now;
   the same event carries natural language later).
4. The document format keeps a reserved `thread` part id (DOCUMENT-FORMAT) excluded from export and the Home index.
5. Selection facts (`selectionFacts`) and the frozen snapshot are the context the assistant reads; do not add UI-only
   state that proposals would need.
6. Toasts and proposal cards share the kit `status` and `card` components; do not introduce a second notification
   system.
7. Home's hero keeps the composer slot (the 760 px card width) so M2 drops the composer in without re-flowing the
   format row.
