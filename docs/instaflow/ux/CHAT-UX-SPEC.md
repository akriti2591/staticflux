# Instaflow Chat — UX specification (Layer 2, M2)

> Status: **M2, written now so M1 leaves the right hooks.** Composes `FOUNDATIONS.md` (the **Card**, **Button**,
> **Switcher**, **Field**, **Slider**, **Toast**, **Dialog and sheet** and **Selection pill** blocks as Studio uses
> them). Sources: `docs/instaflow/design/ChatCP.dc.html`, `UX.md` §2 and §5, `EDITOR-AS-PRIMITIVE.md`, D12, D13,
> D16–D18. Flows: `FLOWS.md` F-40…F-46 (all marked M2).
> Nothing in this file is rendered in M1 except the Settings › Assistant pre-launch card (STUDIO-UX-SPEC §2.4).
> Overlay, feedback and deep-link rules come from `OVERLAYS-FEEDBACK.md` and `NAVIGATION-DEEPLINKS.md`; §7–§9 here
> apply them to provider setup, the no-provider state, chat errors, the empty thread and long turns.

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

## 7. Provider setup (Settings › Assistant)

The section STUDIO-UX-SPEC §2.4 reserves. It composes Settings' rules (every change applies immediately with a `Saved on
this device` line) and the feedback hierarchy (`OVERLAYS-FEEDBACK.md` §3). Keys never leave the device except to the
provider's own endpoint; the UI says so in one sentence at the top: "Keys are stored only on this device, never in
documents, milestones or exports, and never synced."

| Part | Contents | Behaviour |
|---|---|---|
| **Providers list** | One card per provider: `Chrome built-in`, `On-device model`, `Anthropic`, `OpenAI`, `Google`, `Custom endpoint`. Each card: name, a `<sf-status>` line (`Not set up` · `Downloadable · 1.2 GB` · `Downloading 43 %` · `Ready · claude-…` · `Key refused`), and its fields when expanded. | One card expanded at a time (click the header). The default provider carries a mist tag `Default`. |
| **Chrome built-in** | availability from `packages/ai` facts; `Download` (secondary) when `downloadable`; a determinate progress row while downloading with `Cancel`; `Ready` when available. | `Download` needs a gesture (SF-AI-002), so it is a button, never automatic. Unavailable (not Chrome, flag off): one muted line naming what is missing; no button. |
| **Remote provider** (Anthropic, OpenAI, Google) | `API key` field (password, `Show` toggle, paste accepted, masked to `sk-…9f2a` after blur), `Model ▾` (the provider's known models, typed default), `Test connection` (secondary). | The key saves on blur (local store `instaflow/settings`), status becomes `Key saved · not tested`. `Test connection` runs one minimal call with `aria-busy` on the button, then an **inline status row** under the fields: `● Connected · claude-… · 420 ms` (success) or the error as a **section error** with the fix (`Key refused · Check the key, or create a new one` with a link to the provider's console; `Over quota · Try again later`; `Couldn't reach <Provider> · Check your connection`). `Remove key` (ghost, at the right) clears it with the toast `Key removed · Undo` (8 s). |
| **Custom endpoint** | `Endpoint URL`, `API key` (optional), `Model` (free text), `Test connection`. | As remote. The URL must be `https:`; inline error otherwise. |
| **Defaults** | `Default provider ▾` for each task (`Write`, `Edit images`, `Decide`); `Default autonomy` as a switcher `Plan · Ask · Accept edits · Autopilot` with the D13 one-line explanations; `Autopilot limits` (steps, spend) fields shown only when Autopilot is chosen. | Each applies immediately. The top-bar chip reads the default provider. |

Deep link: `/settings/assistant` (Home shell) and `/s/:asset/d/settings?section=assistant` (Studio dialog).

## 8. The no-provider state

Settled by STUDIO-UX-SPEC §2.2: nothing assistant-shaped renders in Studio, and Home's hero shows `Set up an assistant`.
Added here for Chat itself:

- `/c/*` **opens** even without a provider: threads are the person's content and stay readable. The composer is
  replaced by one calm card: "Set up an assistant to continue this conversation." with `Open settings` (secondary). Mini
  editors still work by hand (D17: the agent is always a choice).
- A key that was **removed or refused** after threads exist shows the same card with the reason in the status line
  (`Claude's key was refused`), and the top-bar chip reads `✦ Set up an assistant`.
- A `?thread=` deep link into Studio without a provider opens the design without the panel and toasts the fix
  (`NAVIGATION-DEEPLINKS.md` §4).

## 9. Chat errors, the empty thread, long turns

### 9.1 Errors, by what happened

Errors show **in the thread**, as a turn-level card where the reply would have been, never as a dialog; a toast is used
only when the person is not looking at the thread (Studio with the panel closed). `SfError.message` is the first line,
`fix` the button (`OVERLAYS-FEEDBACK.md` §3.2).

| What happened | Card | Actions |
|---|---|---|
| **Auth failed** (401/403, key refused) | `Couldn't reach Claude: the key was refused.` | `Check the key` (→ Settings › Assistant, the card expanded) · `Retry` |
| **Quota or rate limit** (429, provider budget) | `Claude is over its limit right now.` + the provider's retry hint when given (`Try again in 30 s`) | `Retry` (enabled after the hint's delay, with a countdown in the label) · `Switch provider ▾` (menu of ready providers) |
| **Offline** | A **banner** above the composer `You're offline. The assistant needs a connection; editing works.`; the send button is disabled with the reason in its tooltip (`Send · You're offline`). The pending turn's card reads `Waiting for a connection…` with `Cancel`. | Resumes by itself when online returns (the turn is re-sent once). |
| **Provider down** (5xx, timeout after 90 s without tokens, network error) | `Couldn't reach Claude.` + `It may be a temporary problem.` | `Retry` · `Switch provider ▾` |
| **Refusal** (the model declines the request) | Not an error. The assistant's words render as an ordinary reply with a mist tag `Declined`; proposals are not created. | The composer keeps focus; a suggestion button `Rephrase` prefills the last message. |
| **Invalid output** (SF-AI-005: the change set did not validate) | `Claude's suggestion didn't fit this design.` | `Try again` · the raw text stays readable in a `Show details` disclosure |
| **Gated** (autonomy or lock refused a step) | A proposal card instead of an error: `Claude wanted to delete 3 elements, which needs your approval.` | `Allow` (agent) · `Skip` |
| **Model unavailable on device** (SF-AI-001 built-in) | `Chrome's built-in model isn't downloaded.` | `Download` (needs the gesture) · `Switch provider ▾` |

Every error card keeps the person's message above it intact and re-sendable (`↑` in the empty composer recalls it).
Codes never show; `Copy diagnostics` is in the card's `⋯`.

### 9.2 The empty thread

A new thread shows: the header with the asset chip (or `New design` when none), the empty transcript with **three
suggestion buttons** built from the D18 quick actions that apply (`Make a flyer from this`, `Resize for Instagram`,
`Write three headline options`) as small secondary buttons (never tags), the context chip when a selection exists, and
the composer focused. One muted line above the suggestions: "Describe what you want to make, or pick a start." No
illustration. In Studio's docked panel the same, in 288 px.

### 9.3 Long-running turns and cancel

- A turn streams; the reply bubble grows; a mini editor's preview appears as soon as its first change set validates.
- `Send` becomes **`Stop`** (secondary with a square icon) while a turn runs; `Escape` in the composer stops too. Stop
  keeps the partial reply, tags it `Stopped`, discards proposals still in flight, and keeps applied Accept-edits steps
  (each was an undo step already). Nothing is silently rolled back.
- After **8 s** without new tokens a muted line `Still working…` appears under the bubble; after **90 s** the turn is
  treated as provider down (§9.1). Autopilot shows a progress line `Step 12 of 40 · Stop` (D13) and stops at destructive
  steps with a proposal card.
- The person may keep editing by hand during a turn; conflicts follow §5 (the split chip).
- Leaving the thread (Home, another thread) does not stop the turn; the threads rail shows a pulsing agent dot on the
  running thread; returning shows the result. Closing the tab stops it (no background work without a page).

### 9.4 Deep links into a thread

`/c/:thread` opens the thread scrolled to the last turn; `?turn=<id>` scrolls to that turn and highlights it for 2 s
(an intent, consumed); `/s/:asset?thread=<id>` opens Studio with the panel docked on that thread. A missing thread opens
the threads list with the toast `That conversation is no longer here`. Copy link: the thread's menu and a turn's hover
`⋯` (`NAVIGATION-DEEPLINKS.md` §5).

## 10. What M1 must not do (hooks)

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
