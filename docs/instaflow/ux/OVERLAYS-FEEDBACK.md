# Instaflow overlays, feedback and hints (Layer 1)

> Status: **normative.** Part of the foundations: `FOUNDATIONS.md` §4.8–4.11 summarise the blocks and point here; every
> Layer 2 spec composes these rules and never redefines them; `FLOWS.md` exercises them. Visual source: **Clean Pop ·
> final** (`docs/instaflow/design/Components.dc.html`). Each section ends with **Code**: the `@staticflux/*` piece or
> Instaflow module that implements it, or **missing** with where it belongs (StaticFlux = generic, Instaflow =
> app-specific). The block → code rows are collected in `FOUNDATIONS.md` §6.
>
> Why this file exists: the primitives every surface is built from (overlays, feedback, hints) used to get seven lines
> each. A bad primitive becomes bad UX everywhere, so they are designed here once, with nesting and deep links, and the
> surfaces only arrange them. Conventions: **Figma** (overlay stacking, light dismiss, Escape ladder), **Canva** (the
> colour and font popovers, hints that never block), **macOS** (menus and submenus), **Linear** (toasts with Undo).

## 1. Overlay system

### 1.1 One layering model

Six layers, bottom to top. Nothing renders outside them; a feature never sets a z-index.

| # | Layer | Holds | Rendered where | Modal? |
|---|---|---|---|---|
| 1 | **Canvas HUD** | Handles, size/angle pills, smart guides, frame labels, the selection pill (the HUD), hover outlines | The canvas region's overlay layer (`z.raised` inside `main`) | no |
| 2 | **Floating bars** | Tool picker, zoom pill, command bar, Focus-density floating dock card, the bulk action bar (Files) | The surface's floating slot (`z.raised`, above layer 1 because it is a later sibling) | no |
| 3 | **Popovers and menus** | Menus, context menus, submenus, popovers (colour, font, alignment, milestone form, access), the command palette, coach marks | The browser **top layer** (Popover API, `popover="manual"`); JS fallback `z.overlay` | no (light dismiss) |
| 4 | **Sheets and dialogs** | Dialogs (confirm, destructive, form, wizard), sheets, full-screen takeovers, blocking errors | The top layer (native `<dialog>` `showModal()`); fallback `z.overlay + 1` | yes (sheets: no, see §2.1) |
| 5 | **Toasts and banners** | Toast stack; persistent banners sit in-flow at the top of their region (not an overlay) | Toasts: top layer (`popover="manual"`), re-asserted above any dialog; fallback `z.toast` | no; `data-sf-keep-interactive` |
| 6 | **Tooltips** | Tooltips only | Top layer, created per hover; fallback `z.tooltip` | no |

The top layer stacks by **open time**, not by z-index, so the order between layers 3–6 is enforced by the surface
manager, not by CSS: opening a layer-4 surface **closes** every layer-3 surface first (a dialog never opens over a menu);
a toast is re-shown (`hidePopover(); showPopover()`) whenever a modal opens so it stays above it; a tooltip is created
on hover, so it is always newest. Layers 1–2 are ordinary in-document stacking (`z.raised`) and are **inert while a
modal is open** (`inert` on everything but the dialog, toasts and live regions).

**Code:** `@staticflux/kit/surfaces` `<sf-surface-layer>` (native `<dialog>`, Popover API), `@staticflux/messaging`
`SurfaceManager` (one modal stack, toast cap, tooltip one-at-a-time), `@staticflux/ui/theme` `z.*` tokens, `a11y`
`inertSiblings`. **Missing:** the "close layer 3 before opening layer 4" and "re-assert toasts above a modal" rules in
`<sf-surface-layer>` (StaticFlux kit); `z.hud` is not needed (layer 1 is `z.raised` inside the canvas region).

### 1.2 Nesting rules

| Parent → child | Allowed? | Rule |
|---|---|---|
| Menu → submenu | **yes, one level** | Opens on hover after 150 ms or on `→` / Enter; closes on `←` or when the pointer leaves both for 300 ms; the parent row stays highlighted. No sub-submenus: a third level becomes a searchable menu or a dialog step. |
| Menu → popover | **no** | A row that needs a popover (e.g. `Set size…`) closes the menu and opens the popover **anchored to the menu's original trigger**, never to the vanished row. |
| Menu → dialog | yes | The menu closes, the dialog opens; focus returns to the menu's trigger on close. |
| Popover → menu | **yes, one level** | A `▾` inside a popover (e.g. `Align to ▾`, a provider's `Model ▾`) opens a menu over the popover; Escape closes the menu only. |
| Popover → popover | **no** | A popover grows or swaps content in place (`Custom ▸` expands the picker inline; `Link settings` replaces the Share step), never spawns a second popover. The eyedropper is a mode of the colour popover, not a surface. |
| HUD → popover | yes | The pill's swatch, `Font ▾`, `Align ▾` open one popover anchored to that item (§6 of `STUDIO-UX-SPEC.md` §4.2). Opening another item's popover replaces it. |
| Dialog → popover / menu | yes | A dialog's fields may open menus and popovers (access menu, colour swatch); they sit above the dialog in the top layer; Escape closes them first. |
| Dialog → dialog | **no** | One modal at a time. A confirmation inside a dialog is an **inline confirm row** (§2.4); a sub-task is a **step** of the same dialog (§2.3). The only thing that replaces a dialog is a blocking error (§3.1). |
| Sheet → dialog | yes | Sheets are non-modal; a dialog may open over one. |
| Takeover → popover / menu / toast | yes | A takeover (Compare, milestone preview) is a surface: its own chrome opens menus and popovers; toasts show over it. A takeover never opens a dialog over itself except a blocking error. |
| Anything → tooltip / toast | yes | Tooltips and toasts are allowed everywhere, including over dialogs. |

### 1.3 Focus

- **Trap:** dialogs and takeovers trap focus (Tab cycles inside; the background is `inert`). Menus use roving focus
  (arrows) with Tab closing the menu and moving on. Popovers **move focus in** when they contain a focusable control
  (colour popover: the hex field; milestone form: the name) and otherwise leave focus on the trigger. Sheets do not
  trap; Tab leaves them normally.
- **Return:** on close, focus returns to the **trigger**. If the trigger is gone (the selection changed, the row was
  deleted), focus goes to the trigger's nearest surviving ancestor landmark: the canvas for anything opened from the
  HUD or a context menu, the dock panel for a row menu, the dialog's body for a step that closed. Never to `body`.
- **Initial focus:** dialogs focus the first field, or the primary action when there is no field, or **Cancel** when
  the primary is destructive (§2.2). Menus focus the first row (keyboard) or nothing (pointer; the first arrow key
  focuses). Context menus focus the first row only when opened by keyboard.
- **Stacked traps** are released in reverse order; `a11y` ref-counts inertness so a toast surviving a dialog stays
  interactive.

**Code:** `@staticflux/a11y` `createFocusManager().trap` (stack, restore, inert), `messaging/focus.ts`
(`deepActiveElement`, `trapTab`), `kit/roving`. **Missing:** the "trigger gone → ancestor landmark" rule (StaticFlux
kit `<sf-surface-layer>`; Instaflow passes the fallback element per surface).

### 1.4 Escape order and light dismiss

One `Escape` closes exactly one thing, innermost first:

```
tooltip (any key hides it, Escape is not consumed)
→ submenu → menu → popover (inside a dialog: before the dialog)
→ dialog / sheet / takeover (unless a step is mid-commit: then Escape = Cancel of that step)
→ newest toast (only when nothing above is open)
→ the canvas ladder (STUDIO-UX-SPEC §9): text editing → selection → container → tool back to Select
```

Light dismiss (a pointerdown outside) closes layer 3 only:

| Surface | Outside pointerdown | Wheel / scroll outside | Window blur or resize |
|---|---|---|---|
| Menu, context menu, submenu | closes; the pointerdown is **consumed** (a mis-click never runs a canvas gesture) | closes | closes |
| Popover from the HUD or inspector | closes and the pointerdown **passes through** (one click selects the next element, Canva) | closes (the canvas pans, the HUD hides) | closes |
| Popover from chrome (milestone form, View menu's density), command palette | closes; consumed | the popover **follows its anchor** (chrome does not scroll) | closes |
| Coach mark | stays; dismissed by `×`, by the first use of its target, or by its timer | stays | stays |
| Dialog | nothing (backdrop click closes only non-destructive dialogs with no dirty field, §2.4) | nothing; the background does not scroll | stays |
| Toast | n/a | stays | stays (timer paused while hidden) |

Edits made inside a popover are already committed live, so closing it never loses anything.

**Code:** kit overlays `popover="manual"` + `lightDismiss` (identical with and without the Popover API), `a11y`
`onEscape` per trap, Instaflow `src/app/canvas-shortcuts.ts` (the canvas ladder). **Missing:** the pass-through rule
for HUD/inspector popovers and the consumed rule for menus as options on `kit/popover` and `kit/menu` (StaticFlux kit).

### 1.5 Positioning and collision

- **Anchored** (menus, popovers, tooltips, coach marks, the HUD): placed by `anchorFloating` from an anchor rect and a
  preferred side; gap 6 px (menus, tooltips), 8 px (popovers), 12 px (HUD). Collision order: **flip** to the opposite
  side → **shift** along the axis → **clamp** to the viewport with an 8 px margin → **shrink** (menus and lists scroll
  inside, max-height `viewport − 16 px`). Context menus open at the pointer with the top-left corner on it; when they
  would overflow right or bottom they open to the left or up (not shifted) so the pointer never sits inside the menu.
  Submenus open to the right, aligned to their row, flipping left near the edge.
- **Centred** (dialogs): horizontally and vertically centred in the viewport; widths 420 (confirm, destructive), 520
  (form), 640 (wizard, Share, Settings `840 × 600`), takeovers fill the surface minus nothing. Max height `90vh`; the
  header and footer stay fixed and the body scrolls. Dialogs never move when their content changes height between
  steps; they grow downward from the same top edge until `90vh`.
- Anchored surfaces re-position on the anchor's `ResizeObserver` and on viewport resize, in one measure → mutate pass,
  never on every frame of a drag (the HUD hides during drags instead).

**Code:** `@staticflux/kit/position` (`computePosition`, `anchorFloating`, CSS anchor positioning or JS fallback),
`messaging/host.ts` measure→mutate. **Missing:** the shrink step and the context-menu corner rule (StaticFlux kit).

### 1.6 Narrow widths (Home only)

Studio is never narrower than 1024 px (D1, FOUNDATIONS §3.4), so Studio has no bottom sheets. Home, Files and Settings
render at any width: below **720 px** a card's `⋯` menu, the `Move to ▾` menu and the format menu become a **bottom
sheet** (a `<dialog>` pinned to the bottom, 18 px top corners, a drag handle, rows 44 px, swipe down or Escape
closes), and dialogs become full-height sheets. Tooltips are not shown on touch (§4). Nothing else changes.

**Code:** **missing** — a `sheet: 'bottom'` placement on kit `<sf-menu>` and `<sf-dialog>` under a container query
(StaticFlux kit).

### 1.7 One at a time, and what the world does while open

| Rule | Detail |
|---|---|
| One menu, one popover | Opening a second closes the first (120 ms cross-fade, no gap). |
| One modal | Requesting a dialog while one is open is **refused** (`SF-MSG-*`), never queued, except a blocking error, which replaces. |
| One tooltip, one coach mark | A coach mark is suppressed while a modal or an urgent toast shows, and while the person is dragging (`setUserBusy`). |
| Toasts | Up to 3 visible, the rest queued (§3.5). |
| Canvas under a popover or menu | Live: hover outlines and the HUD still react; wheel over the canvas closes the surface (§1.4) and then pans. Keyboard shortcuts of the canvas are **off** while a menu or popover has focus (the registry's field rule), except the tool letters, which are off only while typing. |
| Canvas under a dialog or takeover | Frozen: `inert`, no wheel, no shortcuts, the render loop keeps drawing (the document may change from another tab). Zoom shortcuts (`Mod+=`) are prevented so the browser does not zoom the page. |
| Window resize while open | Anchored surfaces re-position; dialogs re-centre; the HUD re-lays out once. |

### 1.8 Roles and names

| Surface | Role | Name | Live |
|---|---|---|---|
| Dialog | `dialog` `aria-modal=true` | the heading (`aria-labelledby`) | — |
| Destructive confirm | `alertdialog` | the heading; body as `aria-describedby` | — |
| Sheet | `dialog` `aria-modal=false` (or `complementary` when docked) | heading | — |
| Takeover | `dialog` `aria-modal=true` | heading (`Compare milestones`) | — |
| Menu | `menu` / `menuitem`, `menuitemcheckbox`, `menuitemradio`; a submenu row `aria-haspopup=menu aria-expanded` | the trigger's label | — |
| Popover | `dialog` `aria-modal=false` | `aria-label` (`Fill colour`) | — |
| Command palette | `dialog` with a `combobox` + `listbox` inside | `Commands` | — |
| Tooltip | `tooltip`; the anchor gets `aria-describedby` | — | — |
| Coach mark | `dialog` `aria-modal=false` | its one sentence | announced politely once |
| Toast | `status` inside one `aria-live=polite` region | — | polite; the words carry the tone |
| Banner | `status` (`region` with `aria-label` when it has controls) | — | polite |
| Blocking error | `alertdialog` | heading | assertive once |
| HUD | `toolbar` | `Selection actions` | — |

Colour never carries a state alone (tone dots have words; danger toasts start with the message).

## 2. Dialogs and sheets

### 2.1 Types

| Type | Use | Anatomy | Primary | Escape / backdrop |
|---|---|---|---|---|
| **Confirm** | A reversible-but-costly step that cannot be undone from a toast and cannot be inline (leaving with an unfinished upload). Rare: Instaflow M1 has none. | 420 px, heading (Bricolage 20), one sentence, actions `Cancel · <Verb>` | the verb | both close = Cancel |
| **Destructive** | An irreversible action that cannot be confirmed inline (FOUNDATIONS §5.5 prefers inline; this type exists for bulk or cross-surface cases: `Delete 14 designs forever` from Files' bulk bar when the bar is too narrow). | `alertdialog`, the thing named and counted, `Danger` button, focus on **Cancel** | the danger verb | Escape = Cancel; backdrop does nothing |
| **Form** | Fields that commit together (Share link settings, provider setup is **not** one: Settings commits per field). | 520 px, fields, hint and error lines, actions right-aligned, one primary | `Save` / the verb | Escape with a dirty field → inline "Discard changes?" row (§2.4) |
| **Multi-step (wizard)** | A task with ordered steps (Share › Link settings, Export › advanced). Steps live **inside one dialog**: a back chevron in the header, the step title, the body swaps with a 160 ms slide, the footer shows `Back · Next` or the final verb. | 640 px; a step indicator (`2 of 3`) only when ≥ 3 steps | the step's verb | Escape on step 1 closes; on later steps = Back |
| **Full-screen takeover** | A different view of the same document that needs the whole canvas: milestone preview (read-only), Compare, the blocking error. | Fills the Studio region under the top bar; its own one-line banner header with the title and `Back to Latest` / `×`; the inspector and dock are hidden | — | Escape = Back |
| **Sheet** | A side panel that must stay open while the person keeps working: M2 proposal details, the Chat side panel when undocked. Non-modal, 320–420 px, slides from the right 200 ms. | header with title and `×`, body scrolls | none | Escape closes when it has focus |
| **Routable** (any of the above) | A dialog with a URL (`/d/<key>`, `NAVIGATION-DEEPLINKS.md` §2): Export, Share, Settings. Opened in-app it **pushes** history so Back closes it; opened from a link it **replaces** on close. | the header gains `Copy link` | | |

Only these are dialogs in M1 Studio: **Export**, **Settings** (dialog over Studio, page on Home), the **Shortcuts**
view (Settings › Shortcuts), the milestone **preview** and **Compare** takeovers, the **blocking error**. Everything
else is inline, a popover or a toast (FOUNDATIONS §4.11 stands).

**Code:** `@staticflux/messaging` `defineSurface kind: dialog|sheet`, `createRoutableDialogBridge`, `@staticflux/kit`
`<sf-dialog>`, `surface-defs` `defineDialogSurface`, `a11y` traps. **Missing:** the wizard step frame (back chevron,
sliding body, step indicator), the takeover frame and the inline confirm row as kit parts (StaticFlux kit); Export,
Settings and the takeovers as Instaflow surfaces (`src/export/panel`, `src/settings/`, `src/versioning/`).

### 2.2 Buttons and focus in dialogs

Actions right-aligned: `Cancel` (secondary) then the primary; a tertiary ghost action may sit at the left (`Copy link`,
`Reset`). One primary per dialog; `Danger` replaces it in destructive dialogs. Disabled is allowed **only here** (forms
and dialogs): a disabled primary carries a tooltip with the reason (§4) and stays focusable (`aria-disabled`). Enter in
a single-line field runs the primary; `Mod+Enter` runs it from a multi-line field. Loading: the primary shows the inline
spinner and `aria-busy`, the other actions stay enabled (Cancel cancels the work through its `AbortSignal`).

### 2.3 Nested flows, worked end to end

#### Share (the Export dialog's **Share** tab; arrives with accounts, D3 — specified now so the blocks exist)

The Export dialog (routable `/d/export`) has two tabs, `Export · Share`; `/d/share` opens the same dialog on the Share
tab. Share is one dialog with steps; it never opens a second dialog.

| Step | Contents | Behaviour |
|---|---|---|
| **Share (step 1)** | **Link row**: a read-only field with the design's link, `Copy` secondary (→ `Copied` inline for 1.5 s, toast-free since the feedback is next to the gesture), and `Link settings ▸` ghost at its right. **Access**: a row `Anyone with the link ▾ · can view ▾` where both `▾` are **menus** (Anyone with the link / People invited / Only me; can view / can comment / can edit). **People**: a field `Invite by email` with a role menu `can view ▾` and an `Invite` secondary button; below, invited people as 44 px rows (avatar initial, name or email, role menu, `×`). **Publish** (D10): one row `Publish a release ▸` leading to step 3. | Changing access applies immediately with an inline status line (`Saved · Anyone with the link can view`) — no Save button. Removing a person: the row's `×` becomes an inline confirm `Remove? · Remove · Cancel` (§2.4). Invalid email: inline field error `Enter an email address`. The primary action of this step is `Done` (closes). |
| **Link settings (step 2)** | Back chevron, title `Link settings`. Fields: `Link expires` (menu: Never / 7 days / 30 days / Custom date → a date field appears), `Allow download` switch, `Require a password` switch → a password field appears with `Show`. | Fields commit together: footer `Back · Save`. Escape or Back with a dirty field → the inline `Discard changes?` row in the footer. `Save` returns to step 1 and the link row shows a mist tag `Expires in 30 days`. |
| **Publish a release (step 3)** | Title `Publish`. A sentence ("A release is a read-only copy of this design at this moment, with its own link."), format switcher (`Web page · PDF · Video` as built), `Release name` prefilled `Release 1`. | Footer `Back · Publish`. Publishing shows progress inside the dialog (§3.4); on success the step shows the release link with `Copy` and `Open`, the primary becomes `Done`, and a toast `Published 'Release 1' · Open` appears after the dialog closes (non-local result, FOUNDATIONS §5.3). |

Deep links: `/s/:asset/d/share` (step 1), `?step=link-settings` reopens step 2. Not permitted (no accounts yet): the
Share tab is not rendered (FOUNDATIONS §5.6), and `/d/share` falls back to the Export tab with a toast "Sharing isn't
available yet" (`NAVIGATION-DEEPLINKS.md` §4). Gating here is UX, not security: the server owns access (rule 9).

#### Milestones (list · preview · compare · restore · name)

D2 stands: Latest and named milestones, no automatic versions, and **no in-place restore**; "restore" means **New
document from milestone**, labelled for people as `Open as new design` (see Owner questions, Q2).

| Where | Contents | Behaviour |
|---|---|---|
| **Create** (top bar `Milestone`, `Mod+Alt+S`) | A **popover** anchored to the button: `Name` field prefilled `Milestone N` (selected), optional `Note` (one line), `Create` primary. | Enter creates; Escape cancels. Toast `Milestone 'Client v1' created · Rename · View` (8 s): `Rename` focuses the row's inline rename in the dock, `View` opens the Milestones tab. The tab shows a dot badge until opened. Empty name → inline `A name is required`. |
| **List** (dock › Milestones, `?dock=milestones`) | `Latest` first (unpinnable, mist tag `Saved`), then pinned rows, then rows newest first: 44 px, name (600), meta `today 14:02 · 3 pages`, a pin icon, hover-revealed `⋯`. Row menu: `Preview`, `Compare with Latest`, `Open as new design`, ─, `Rename`, `Pin` / `Unpin`, `Copy link`, ─, `Delete milestone`. | Click a row = `Preview`. `Rename` = inline rename (FOUNDATIONS §4.19), one undo step, toast-free. `Delete milestone` is irreversible → inline confirm row in the row (`Delete 'Client v1'? · Delete · Cancel`), never a dialog. Empty state: "No milestones yet. Press Milestone to keep a named version." |
| **Preview** (`/s/:asset/m/:milestone`) | A **takeover**: the canvas shows the milestone read-only; a banner header `Milestone 'Client v1' · today 14:02 · Read-only` with `Compare with Latest`, `Open as new design` (secondary), `Copy link`, and `Back to Latest` (primary) at the right. No handles; the HUD shows `Copy` only; Layers and Pages work read-only; the inspector shows values, every field read-only. | Escape or `Back to Latest` returns (history back when the preview was pushed in-app). Selecting elements and copying works, so people can lift parts of an old version into Latest. |
| **Compare** (`…/m/:milestone?compare=latest` or another milestone id) | A takeover: two canvases side by side with labels (`Client v1 · today 14:02` | `Latest`), one shared camera (pan and zoom both), a `Swap` ghost button, a `Show changes` switch that outlines added (green dot), removed (`#CF3D17`) and changed (sunflower) elements on both sides, a page switcher when the pages differ. | Pure view: nothing can be edited. `Open as new design` and `Back` in the header. Escape = Back. |
| **Open as new design** (row menu, preview header, Compare header) | Immediate, no confirmation (nothing is destroyed): a new design `Client v1 copy` opens in a **new tab** (modified clicks) or the same tab after flushing Latest, title field focused, the Document section shows `From milestone 'Client v1' of 'Night market'`. | Toast in the new design: `New design from 'Client v1' · Back to 'Night market'`. Its own Milestones list has `Latest` only (D2 detached baseline). |

Deep links: `/s/:asset?dock=milestones` (list), `/s/:asset/m/:id` (preview), `…/m/:id?compare=latest` (compare); a
missing milestone falls back to Latest with a toast (`NAVIGATION-DEEPLINKS.md` §4).

### 2.4 Unsaved changes and validation

- **Commit-as-you-go is the default** (D2 spirit): Settings, access rows, the inspector, popovers commit each change
  with a `Saved on this device` status or an undo step. Only Form and Wizard dialogs hold changes until their verb.
- A dialog with held changes closing by Escape, backdrop, Back or the `×` shows an **inline confirm row** in the footer
  replacing the actions: `Discard changes? · Discard · Keep editing` (focus on Keep editing; Escape = Keep editing).
  Never a second dialog, never a browser `beforeunload` prompt (Latest is always saved; the only held state is a dialog
  form, which is re-typeable).
- Validation runs **on blur and on submit**, never on every keystroke, except format masks (hex, email) that show the
  error once the value is complete. The first invalid field gets focus on submit; the error line reads what to enter,
  not what is wrong (`Enter an email address`, not `Invalid input`). A section with an invalid field keeps the primary
  enabled; pressing it focuses the field (disabled-to-explain is forbidden, FOUNDATIONS §4.1).
- Server or store errors on submit are **section errors** (§3.1) above the footer with the `fix` as a button, and the
  fields keep their values.

## 3. Feedback and errors

### 3.1 One hierarchy

| Level | Where it shows | Use when | Lifetime |
|---|---|---|---|
| **Inline field error** | The error line under the field, edge `#CF3D17`, `aria-invalid`, `aria-describedby` | The person typed something the field cannot take | Until the value changes |
| **Section / panel error** | A mist card at the top of the section, panel or dialog body: message, `fix` as a button or link, `Try again`; the rest of the surface keeps working (`<sf-boundary>` per region) | One region failed to load or act (Layers failed, a dialog's submit failed, the export worker died) | Until retried or the region re-renders |
| **Toast** | Bottom-centre stack (§3.5) | The result of a gesture is not visible where the gesture happened, or an action failed and the person can act (`fix`) | 5 / 8 / 10 s, or sticky for urgent |
| **Persistent banner** | A 40 px bar at the top of the region it concerns (Studio: between the top bar and the canvas; Home: above the hero; a dialog: above its body), sunflower-soft for warning, `#FDE8EF`-free (raspberry is the agent's), mist for information, `#FFE9E2` for danger; one sentence + one action + optional `×` | A **condition** that persists and changes what the person can do: offline when something needs network, storage full, read-only (trashed, milestone preview), worker restarting, provider key refused | While the condition holds; dismissable only when informational |
| **Blocking full-surface error** | A takeover with one calm card: heading, one sentence, the primary fix, `Copy diagnostics`, `Reload` | The surface cannot work at all: unsupported browser, both engine workers failed to restart, the workspace store cannot open | Until the fix |

Choose the **lowest** level that the situation allows. A failed gesture in a field is inline; a failed gesture elsewhere
is a toast; a state that stays is a banner; only a dead surface blocks. The same error never shows at two levels at
once (a banner replaces the toast that announced the condition).

### 3.2 `SfError` → UI

Every error is an `SfError` with `code`, `message` and `fix` (rule 6). The mapping is mechanical:

| Field | Shows as |
|---|---|
| `message` | The first line, as written (FOUNDATIONS §5.11: what happened). |
| `fix` | The action: a **button** when the fix is an action the app can run (`Try again`, `Open Storage settings`, `Restart the editor`), a **link** when it is a place, plain text when it is advice (`Allow clipboard access in site settings`). A fix that is a URL opens in a new tab. |
| `code` | **Never shown** in the surface. Available through `Copy diagnostics` (blocking errors, Settings › About) and DevTools (`DEVTOOLS-UX-SPEC.md`). Tests assert the code; people read the message. |
| `details` | DevTools only. |

Level by origin, not by code: an `SfError` returned to a field commit → inline; to a region's load → section; to a
capability run → toast (danger); a condition fact (`storage.quota`, `network.online`, `worker.state`) → banner; a boot
failure → blocking. The codes families map by default: `IF-LIB-*` toasts, `SF-STORE-*` quota → banner, `IF-WRK-*` →
banner then blocking (§3.3), `IF-PLAT-*` → blocking, `SF-NAV-*` → fallback + toast (`NAVIGATION-DEEPLINKS.md` §4),
`SF-AI-*` → the chat turn (`CHAT-UX-SPEC.md` §9).

**Code:** `@staticflux/core` `SfError` (`code`, `message`, `fix`), `kit/surface-defs` `defineToastSurface`,
`shell` `<sf-boundary>` (region fallback with Retry). **Missing:** a `toastForError(error)` / `bannerForFact(fact)`
adapter (Instaflow `src/app/feedback.ts`); a kit `<sf-banner>` and `<sf-blocking-error>` (StaticFlux kit; messaging
already has `banner` and `inline-alert` kinds without an element).

### 3.3 Retry, offline, recovery

- **Automatic retry** for transient failures: CAS conflicts (`IF-HOME-005`) three times with 50/150/400 ms backoff,
  worker requests once; then the error surfaces with `Try again`. Nothing retries silently more than three times.
- **Offline:** Instaflow is local-first, so offline is **not an error**. No banner appears until an action needs the
  network: a font download, a provider call, a release. Then the banner `You're offline. <What> needs a connection;
  editing works.` with no action; it leaves when `online` returns and the pending action resumes by itself (fonts) or
  stays stopped (chat, §`CHAT-UX-SPEC.md` 9).
- **Worker crash** (`IF-WRK-*`): the canvas stops; within 500 ms a **banner** over the canvas region `The editor stopped
  unexpectedly · Restarting…` with a progress dot; Instaflow restarts the workers **once** automatically and reloads the
  document from Latest. On success the banner becomes a toast `Editor restarted` (8 s) and, when the last edits were
  not acknowledged, `Editor restarted · Your last changes from the past 2 s may be lost · Undo history kept`. On a second
  failure within a minute: the **blocking error** `The editor can't start` with `Reload`, `Copy diagnostics`, `Back up
  workspace`. Latest is never older than the last acknowledged commit, and the banner says so.
- **Storage full** (`SF-STORE-*` quota): banner (Studio and Home) + save status `● Not saved · Storage full` as
  `HOME-FILES-UX-SPEC.md` §4; editing continues in memory; the banner says nothing is lost until the tab closes.
- **Read-only** (trashed design, milestone preview): banner with the reason and the way out (`Restore`, `Back to Latest`).

### 3.4 Long-running work and progress

| Duration | Feedback |
|---|---|
| < 300 ms | Nothing (optimistic; the result is the feedback). |
| 300 ms – 2 s | An inline indicator where the gesture was: `aria-busy` on the button with the label dimmed and the small spinner; skeletons for regions. Never a toast for waiting. |
| ≥ 2 s or unknown | A **progress row**: a determinate bar when steps are countable (`Rendering page 2 of 5`), indeterminate otherwise, a `Cancel` secondary that aborts through the job's `AbortSignal`. Inside the dialog that started it (Export, Publish), or the inline row of the panel (Assets import), or the banner when it concerns the whole surface (worker restart). |
| Leaves the dialog | Export may continue in the background: closing the dialog turns the row into a toast `Exporting poster.png… · Cancel` (sticky) that becomes `Exported poster.png · Show in folder` (8 s) or the error. |

Cancel stops within one frame, leaves no partial file and no toast ("nothing happened" needs no feedback). Progress
text names the step, never a percentage alone.

### 3.5 Toasts: queue, stacking, durations, undo

- **Position and look:** bottom-centre, 16 px above the command bar (Studio) or the viewport bottom (Home); ≤ 420 px
  wide (FOUNDATIONS §4.10 said 320; 420 fits an error message and a fix), white, 18 px corners, floating shadow, a tone
  dot at the left (none for neutral), the message (13 px, two lines max), **one** action button (secondary, 28 px) and
  a `×` only on sticky toasts. Rise 160 ms, fade 120 ms.
- **Stacking:** newest at the **bottom** (nearest the bar), older ones shift up; max **3** visible; further toasts wait
  in a queue and show as slots free. A new toast with the same `id` (or `dedupe(props)`) refreshes the existing one's
  timer and adds a count (`Copied ×3`) instead of stacking.
- **Durations:** neutral and success 5 s; with an action 8 s; danger 10 s; **urgent** (storage full, crash) sticky with
  `×`. Timers **pause** while the pointer is over the stack, while a toast has focus, and while the tab is hidden; they
  resume from where they were.
- **Undo in toasts:** the action is `Undo` for reversible non-local actions (trash, move to project, bulk delete, rename
  from Home). Undo runs the inverse capability and the toast becomes `Restored` (3 s). On **Home**, `Mod+Z` while such
  a toast shows triggers its Undo (there is no document undo on Home). In **Studio**, `Mod+Z` is always document undo;
  toast Undo is only its button (`Alt+Enter`-free: toasts are reached by `F6` to the stack, then Tab).
- **Dismissal:** Escape dismisses the newest when nothing above is open (§1.4); `×` on sticky; the action dismisses.
- **Live region:** one polite region for all toasts; a toast announces once when it appears; `×3` updates do not
  re-announce; danger toasts still use polite (the person is mid-gesture; assertive is for blocking errors).

**Code:** `@staticflux/messaging` `SurfaceManager` (toast cap, dedupe, durations, urgent, `exitMs`), `kit/surfaces`
`<sf-toast tone>`, `a11y` live region. **Missing:** pause on hover/focus/hidden and the count badge (StaticFlux
messaging + kit); the `ToastsToken` adapter and the Home `Mod+Z` → toast Undo binding (Instaflow `src/app`,
`src/home`).

### 3.6 Success feedback

Within one frame for local edits (the render and the inspector are the feedback); a toast only for non-local or
invisible results (FOUNDATIONS §5.3 list stands: milestone, template, export, moves, trash, bulk deletes, clipboard to
other apps). Success toasts carry the **next step** rather than a checkmark: `Milestone created · Rename · View`,
`Saved as template · Open Home`, `Exported · Show in folder`. Never "Success!", never an exclamation mark.

### 3.7 Writing rules for error copy

1. **What happened · what to do**, in that order, one sentence each, ≤ 140 characters together.
2. Name the thing: `Couldn't import 'notes.txt'`, not `Import failed`.
3. The fix is a verb phrase and is the button label: `Open Storage settings`, `Allow in site settings`, `Try again`.
4. No codes, ids, stack text, work-package names or vendor jargon in the surface; `Copy diagnostics` carries them.
5. No blame and no apology theatre: no "you", no "oops", no "sorry", no exclamation marks. "Couldn't" is fine.
6. Say what still works when something stopped: `Editing works.` `Nothing is lost until the tab closes.`
7. Danger tone only when something was lost or cannot proceed; a refused permission is warning.
8. One error, one place (§3.1). The same text in the toast and the banner; the banner replaces the toast.
9. British spelling as the codebase (colour, centre). Sentence case. Numbers in Geist Mono when they are values.
10. The forbidden-text test (FOUNDATIONS §5.11) covers toasts, banners and dialogs.

## 4. Tooltips

- **Trigger and delay:** hover or focus; 500 ms delay on the first tooltip, then a **warm period**: moving to a sibling
  control within 300 ms shows its tooltip immediately (toolbars, pills, menus feel instant). 80 ms fade in, 0 out.
  Hidden on pointerdown, on any key, on scroll, and when the anchor leaves the viewport; at most one tooltip.
- **Content:** the control's name, then `kbd` with its shortcut when it has one, at **every** density (principle 4).
  Pro adds a second muted line with the one-line description when the capability declares one. ≤ 60 characters; never
  a sentence that ends with a full stop; never interactive content; never an image.
- **Disabled controls** (dialogs and forms only) keep their tooltip and add the reason after a `·`: `Export · Choose at
  least one page`. They stay focusable (`aria-disabled`) so keyboard and screen-reader users get the reason too.
- **Toggles** show the state the press will produce: `Lock · Mod+Shift+L` becomes `Unlock · Mod+Shift+L` once locked.
- **Touch:** no hover, so a 500 ms long-press shows the tooltip without activating the control; release without moving
  hides it and does not activate. Studio is desktop, so this matters only for touch screens on laptops.
- **Never essential:** anything a tooltip says exists elsewhere as text (a menu row, the Shortcuts list, the inspector
  label). A control whose only name is its tooltip is a bug.
- **Placement:** below the anchor by default (above in the bottom bars), 6 px gap, centred, flipping on collision.
  Tooltips on the HUD go above the pill (the selection is below it).

**Code:** `@staticflux/kit/tooltip` (`<sf-tooltip text shortcut side>`, light-DOM `role=tooltip`, `aria-describedby`),
`messaging` tooltip arbitration (one at a time). **Missing:** the warm period, the disabled-reason composition and the
long-press path (StaticFlux kit).

## 5. Coach marks, first-use hints and empty states

**Decision: Instaflow has no tours and no coach-mark sequences.** It has **first-use hints** (one sentence, tied to a
tool or a region, shown once) and **empty states that teach**. Reason: the surfaces are self-describing (tooltips,
visible actions, the palette); tours are skipped and forgotten, and a hint at the moment of first use is the only kind
that lands (Canva shows hints, not tours). The messaging package's coach-sequence support stays unused by Instaflow.

| Rule | Detail |
|---|---|
| What is a hint | A small white card (12 px corners, floating shadow, 13 px text, a `×`), anchored below the tool picker (tools) or inside the region (panels), one sentence from STUDIO-UX-SPEC §4.1. A hint is a `coach-mark` surface with a `target`. |
| Seen once | Per device, keyed by hint id, stored under `instaflow/ui/hints` (a `SeenStoreToken` adapter over `localStorage`); a hint counts as seen when its target is used, when `×` is pressed, or when its 6 s timer ends. Shown again only after `Reset hints` in Settings › General. |
| Never blocking | Hints never trap focus, never dim anything, never wait for a click; the target works while the hint shows. |
| One at a time, max 2 per session | A session is a tab's life. The third candidate in a session is simply marked seen (the person is clearly exploring). |
| Suppressed | While a modal or urgent toast shows, during drags (`setUserBusy`), in milestone preview, on a design opened from a deep link to a selection (the person came for something specific). |
| Dismiss all | Settings › General `Show first-use hints` switch (default on); `Reset hints` beside it. No per-hint "don't show again": the switch is the whole answer. |
| Keyboard | A hint is not in the tab order; Escape does not dismiss it (it belongs to nothing the person opened); it goes with its timer or the target's use. Screen readers hear it once, politely. |
| M1 set | Frame, Shape, Text, Pen (when it ships), Hand (STUDIO-UX-SPEC §4.1); Layers' first element (`Drag rows to reorder; the eye hides, the lock protects`); the first multi-selection (`Align ▾ lines things up; Group keeps them together`); the first milestone (shown as the toast's next steps, not a hint). Nothing on Home. |

**Empty states as teaching.** Every empty region names the next action as a real control (FOUNDATIONS §4.15): Layers
`Nothing here yet. Draw a shape (R) or add text (T).` with `R` and `T` as links that select the tool; Assets `Drop
images here or press Import.`; Milestones `No milestones yet. Press Milestone to keep a named version.`; Home `Your
designs will appear here.` under the format row; Files search `No results for 'flyer' · Clear`; the empty chat thread
(`CHAT-UX-SPEC.md` §9). One line, 13 px muted, at most one action, no illustration in M1.

**Code:** `@staticflux/messaging` (`defineSurface kind: 'coach-mark'`, `target`, `once`, `seen` store, suppression by
modals and `setUserBusy`), `coachTarget(target)` directive. **Missing:** the hint card element (StaticFlux kit
`<sf-hint>`), the `localStorage` seen-store adapter, the per-session cap, the Settings switch and the hint copy
(Instaflow `src/studio/hints.ts`, `src/settings/`).

## 6. Owner questions

**Answered 2026-10-25: all six recommendations accepted by the owner.** Build them as written below; the alternatives
are recorded for history only.

1. **Toast width 420 px (was 320 in FOUNDATIONS §4.10).** Recommend 420: an error message plus a fix button needs it;
   320 wrapped every danger toast to three lines in the Clean Pop mock. Alternative: keep 320 and drop the fix to a
   second line — rejected (slower to act on).
2. **"Restore" a milestone.** Recommend keeping D2 (no in-place restore) and labelling the existing action `Open as new
   design`; the preview takeover makes lifting parts into Latest easy (select, copy, back, paste). Alternative for M2:
   `Revert Latest to this milestone` implemented as "create milestone 'Before revert', then copy the snapshot into
   Latest" (D2's cost rule holds: it is one snapshot copy). Not recommended for M1; revisit with comments (D11), when
   people start reviewing versions together.
3. **Hints at all.** Recommend the M1 set above (five tools, Layers, multi-select) and no tours. Alternative: none at
   all, tooltips only — acceptable, but the owner's first run showed the Frame tool is not self-explanatory on a white
   page.
4. **HUD popover light dismiss passes the click through** (one click to pick the next element, Canva). Alternative:
   consume the click like menus (Figma) — safer against mis-clicks, one extra click every time. Recommend pass-through
   for popovers from the HUD and inspector, consumed for menus.
5. **Compare as a takeover** (whole canvas, shared camera) rather than the inline side-by-side F-17 implied. Recommend
   the takeover: two full canvases need the width, and it gets a URL (`?compare=`).
6. **Share tab designed now though D3 (no accounts) keeps it unrendered in M1.** Recommend keeping the design so B11a
   builds the wizard step frame, inline confirm row and copy field once; nothing of Share is rendered before accounts.
