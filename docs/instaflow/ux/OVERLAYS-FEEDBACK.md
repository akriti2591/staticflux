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

#### Export (the Export dialog's **Export** tab), worked end to end

The owner's brief: "the download flow needs a share-like design, for customisations." Export is the same dialog as
Share (routable `/d/export`, tab `Export`, wizard type §2.1, 640 px), one main step and one `advanced` step. It runs
C1's engine (`apps/instaflow/src/export/`: `instaflow/export` capability, `ExportService`, the export worker) through
the existing `ExportPanelPort`; the dialog holds no export logic (C1 handoff, next step 1). D10 stands: an export
creates nothing in the design; the dialog says so once, in the footer's muted line `Exports render from a snapshot and
change nothing in the design.`

**Every option below carries a letter.** (a) = C1's engine does it today (`formats.ts`, `job.ts`, `service.ts`);
(b) = UI only, buildable in B11b over the existing port — where a row says *plumbing*, a TypeScript option is threaded
through `service.ts`/`job.ts` (a page subset, a file name, a zip step) and nothing in the renderer or the writers
changes; (c) = new export-engine work (Wasm writers, the renderer, or the job's pipeline), listed under **Export engine
follow-ups** with a milestone. FOUNDATIONS §5.6 applies: **a (c) option is not rendered in M1** — no greyed chip, no
"coming soon" tag; the row simply does not exist until its engine work lands. Nothing here changes the capability's
input for agents; new options are added to `ExportCapability.input` as optional fields when their letter becomes (a).

**Entry points and scope**

| Entry | Opens with | Letter |
|---|---|---|
| Top bar `Export` (primary, STUDIO §2) · `Mod+Shift+E` | The dialog with the **remembered settings** for this design (see Memory); focus on the primary, so `Mod+Shift+E`, Enter is the quick export. Scope stays what was remembered, except `Selection` falls back to `Page` when nothing is selected. | (b) — changes C1's shortcut, which today exports immediately (§6 item 7) |
| Page label menu `Export this page…` · Pages row menu `Export page…` | Scope `Page` locked to **that** page (`?scope=page&page=<id>`), other settings remembered. | (a) scope `page` exports the page shown; (b) *plumbing* to name the page explicitly |
| Context menu `Export selection…` (any element, multi) · HUD `⋯ › Export selection…` | Scope `Selection` (`?scope=selection`); the selection is the current one (never in the URL: selection is hidden state). | (a) |
| Home card `⋯ › Export…` (HOME-FILES §) | Studio on the design with `/d/export`, remembered settings. | (b) |
| Command palette `Export…`, `Export selection…`, `Export all pages…` | As the three above. | (b) |

The main step's first row is **What**: a switcher `Page · Selection · Pages`. `Page` names the page it will export
(`Page 2 · Post · 1 080 × 1 080`, mono); `Selection` reads `3 elements · 640 × 420` and is **disabled with the reason**
in its tooltip (`Selection · Select something on the canvas first`, §2.2 allows this in dialogs) when nothing is
selected; `Pages` expands a **page-range picker** under the row: 72 px thumbnails in a wrapping grid (the Pages panel's
projection thumbnails; a format chip until that projection lands, STUDIO §3.2), each with a checkbox corner and the
page's label, `All · None` ghost links at the right, a mono count `3 of 5 pages`. Default: all pages checked.
Thumbnails render in document order; the export keeps that order. Letters: `Page`, `Selection`, `Pages` = all (a); a
**subset** of pages (b, *plumbing*: `pages` on the run request; `job.ts` already takes `pages` in export order).

**Presets (recommended set)**

A preset is a row of chips above Format (`Preset`), each a named bundle of the settings below; choosing one sets them
and the chip stays selected until a setting is changed by hand (then no chip is selected; nothing is "custom" by name).
A preset **never resizes content**: it only chooses format and scale for the page as it is, so a preset that needs a
size the page does not have is **not rendered** (not greyed) — the row shows only presets that apply. A size preset
compares the page's size to its target with a 1 px tolerance.

| Preset | Sets | Rendered when | Letter / milestone |
|---|---|---|---|
| `Current size` | PNG · 1× · page background | always | (a) M1 |
| `Screen 2×` (the default when nothing is remembered) | PNG · 2× | always | (a) M1 |
| `Slide 16:9` | PDF · all pages | the pages are 16:9 | (a) M1 |
| `Social post · 1 080 × 1 080` | JPG 90 (PNG until JPG exists) · fit the longest side to 1 080 px | the page is 1 080 × 1 080 (1×) in M1; any page once arbitrary scale exists | (a) at 1×, M1; (c) arbitrary scale, M2 |
| `Social story · 1 080 × 1 920` | as above | the page is 1 080 × 1 920 in M1 | (a) at 1×, M1; (c) M2 |
| `Print A4` · `Print Letter` | PDF · print · 3 mm bleed · crop marks | the pages are A4 (794 × 1 123) or Letter (816 × 1 056) at 96 px/in **and** print PDF exists | (c) M2 — not rendered in M1; M1 people pick `PDF` by hand |

**Format and per-format options**

`Format` is a switcher `PNG · JPG · PDF · SVG` (M1 renders `PNG · PDF · SVG`; `.iflow` joins as a fourth chip when C2
lands and takes no options). The rows under it are the chosen format's, re-rendered in place (no slide; this is not a
step). Main-step rows are marked **main**; the rest live in `Advanced`.

| Format | Option | Control and default | Letter |
|---|---|---|---|
| PNG | **Scale** (main) | Chips `1× · 2× · 3×` with the resulting size as a mono tag under the chip row (`2 160 × 2 160 px`). A chip whose output would pass the device ceiling (`MAX_EXPORT_PIXELS`, 16 384 px a side) is disabled with the reason `3× · Too large for this device (max 16 384 px)`. Default 2×. | (a) |
| PNG | **Pixel size** | A `Width` field (`px`, mono) beside the chips; typing a width sets the scale and the chips follow. In M1 the field **snaps** to the nearest of 1×/2×/3× on blur and says so in its hint (`Nearest scale: 2× · 2 160 px`); when arbitrary scale lands it takes any value and the chips become shortcuts. | (b) snapped; (c) arbitrary scale, M2 |
| PNG, SVG, PDF | **Transparent background** | A switch in Advanced, default off. For PDF and SVG it means no white page. On: the preview shows a checkerboard. | (a) |
| JPG | **Quality** | A slider `60–100`, default `90`, value in a mono pill; **no** transparency switch (the row is not rendered). Scale and pixel size as PNG. | (c) M2 (a JPEG encoder beside `encodePng`) |
| PDF | **Kind** (main) | Chips `Standard · Print`. Standard = today's writer. Print adds the rows below. | Standard (a); Print (c) M2 |
| PDF | **Bleed** | Field `3 mm` (default; `0–10 mm`); the page is extended by that much on each side and the content behind the page edge is drawn there (clipping moves out by the bleed). | (c) M2 |
| PDF | **Crop marks** | Switch, default on when Print; hairline marks outside the bleed. | (c) M2 |
| SVG | **Text** | Chips `Outlines · Text` under a one-line hint. `Outlines` = today's writer (glyph outlines labelled with their text, D21). `Text` writes `<text>` runs and needs the font on the reader's machine or embedded. Default `Outlines`. | Outlines (a); Text (c) M2 |
| SVG | **Embed fonts** | Switch, rendered only with `Text`; default on. Embeds the used subset as `@font-face` data URIs. | (c) M2 |

**Custom size (output pixels)**

A **Size** row sits under the format's main option for PNG and JPG: the **size field pair** (the same block as New
design and Page › Size, HOME-FILES §1.3): `W` and `H` mono fields with `px`, a lock (always locked here: the page's
ratio is fixed), a `Presets ▾` menu (`1 080 × 1 080 · Instagram post`, `1 080 × 1 920 · Story`, `1 200 × 628 ·
Link preview`, `1 920 × 1 080 · HD`, `3 840 × 2 160 · 4K`, `A4 at 300 dpi · 2 480 × 3 508`, …; a preset whose ratio
differs from the page is listed with `· fits width` and sets W only), and a muted hint line. Typing W sets H by the
ratio and vice versa; the Scale chips follow (`2.22×`) and deselect when no chip matches. **In M1** the pair snaps on
blur to the nearest of 1× / 2× / 3× and the hint says `Nearest scale: 2× · 2 160 × 2 160 px` (b); when arbitrary scale
lands (c, M2) any value within the device ceiling is accepted and the hint shows the resulting scale. A value past the
ceiling is clamped with the reason (`Max 16 384 px on this device`). The pair never changes the page: a different
*ratio* is **Resize design** (GAP-AUDIT Q-A, Q-B, backlog B-5), reachable from the row's hint link `Different shape?
Resize the design…` once that feature exists; until then the hint link reads `Change the page size…` and opens
Page › Size behind the dialog (closing it). Departure from Canva, which mixes "download size" with "resize design":
one block, one meaning (pixels out), and the shape question lives where the shape is set.

For PDF the row reads as a `Page size` line only (`1 080 × 1 080 pt`, mono, not editable; print sizes come with Print
kind, M2). For SVG there is no size row (vector).

**File name**

| Case | Name | Letter |
|---|---|---|
| One file | `<Title>.<ext>` — the design title cleaned to letters, digits, spaces, `_` and `-`, at most 80 characters, `Design` when empty (`exportFileName`). | (a) |
| One file per page (PNG, SVG, JPG of `Pages`) | `<Title> - 01.png`, `<Title> - 02.png` … zero-padded to the page count's width, in export order. | (a) |
| Selection | `<Title> - selection.<ext>` | (b) *plumbing* (today: `<Title>.<ext>`) |
| Several formats | Each format uses the rows above with its own extension; names never collide because the extension differs. | (b) |
| Custom name | Advanced › `File name` field, default empty, placeholder = the computed name; the pattern above still adds the page suffix. Validation on blur: characters outside the allowed set are replaced and the field shows what it will use (`Uses: Night market v2`). | (b) *plumbing*: `fileName` beside `title` on the run request |

The main step shows the resulting name(s) as one muted line under the options: `poster.png`, `poster - 01…05.png
(5 files)`, `poster.zip (PNG, PDF · 6 files)`.

**Several formats at once**

The Format switcher accepts **more than one** chip (`Mod+click` / `Space` on a focused chip adds; a single click
replaces, so one format stays the simple path). Each chosen format shows its own option rows, stacked, headed by the
format name. Output: **one zip** `<Title>.zip` when the export produces more than one file for any reason (several
formats, or one-per-page output), one plain file otherwise. Reason: the browser's multiple-download prompt and a
folder full of loose files are worse than one archive; the zip is written on main with `@staticflux/blob`'s
`createZipWriter` (stored entries, no recompression) before `deliver`. Advanced › `Zip several files` switch (default
on) turns it off for people who want loose files. Letters: multiple formats = several jobs run **in sequence** by the
dialog over the one-job-at-a-time service, with one progress row (b); zip (b, *plumbing* on main); loose files (a).

**Output size**

A **preview card** sits at the right of the main step (240 px wide, 12 px corners, mist): the chosen scope's thumbnail
from the Pages projection (the selection's bounds for `Selection`, the first checked page for `Pages` with a `+4`
corner tag), on a checkerboard when transparent, else on the page colour. Under it, one mono line: `2 160 × 2 160 px ·
about 1.4 MB` for raster (estimate = pixels × 0.3 bytes for PNG, × 0.12 for JPG 90, labelled `about`, never shown as
exact); `1 080 × 1 080 pt · 5 pages` for PDF; `1 080 × 1 080 · 5 files` for SVG (no size estimate for vector). After the
export, the done toast and the DevTools entry carry the **real** size (`formatBytes`). Letters: preview (b, once the
Pages thumbnail projection lands; until then the card shows the page's format chip and the size line only); estimate
(b); real size (a).

**Main step versus `advanced`**

The main step holds **four decisions** and nothing else: `What` (scope, with the picker when `Pages`), `Preset`
(rendered only when at least one preset applies; when any preset is hidden for size the row ends with the muted link
`Other sizes…` → Page › Size, see §6 item 9), `Format`, and the format's one main option (`Scale` for PNG/JPG with
the **Size** pair under it, `Kind` for PDF; SVG has none). Below them: the file-name line, the loose-elements line (when relevant), the output
size card at the right, and `Advanced ▸` as a ghost row whose right side summarises every non-default advanced setting
in a mist tag (`Transparent · Custom name`). Footer: `Reset to defaults` (ghost, left; see Memory), `Cancel`, primary
`Export PNG` / `Export PDF` / `Export 2 formats`.

`Advanced` is a **step** of the same dialog (`?step=advanced`, back chevron, title `Advanced`, 160 ms slide): the
format-specific extras above (transparent background, JPG quality, PDF bleed and crop marks, SVG text and fonts), `File
name`, `Zip several files`, and `Remember for this design` (switch, default on). Footer: `Back · Done` — Advanced
commits as you go (the settings are the dialog's own state, nothing is destroyed), so there is no Save and no "Discard
changes?" row; Escape = Back. The primary `Export…` is **not** shown on the Advanced step: people export from the main
step, which keeps one primary per dialog (§2.2).

**Memory**

Settings are remembered **per design per device** under `instaflow/ui/export/<asset>` (`localStorage`, like the camera,
STUDIO §12): scope (not the page subset or the selection), formats, every option and the custom name. `Export this
page…` and `Export selection…` override scope for that opening without writing it back. `Reset to defaults` (footer
ghost) restores `Screen 2×` of the page and clears the memory for this design, with an undo-free inline status
`Defaults restored` for 1.5 s. Advanced › `Remember for this design` off = the dialog opens with the defaults every
time. Nothing of this is in the document, a milestone or an export (D10). Letter: (b).

**The loose-elements line, validation and disabled reasons**

| Situation | Where it shows | Text |
|---|---|---|
| The document has elements outside every page and scope is `Page` or `Pages` (STUDIO §1 clipping rule) | A muted line with an info dot under the options | `2 elements outside the pages won't be exported. · Export selection instead` — the link selects those elements and switches scope to `Selection` |
| Scope `Selection`, nothing selected | The `Selection` chip is disabled, reason in its tooltip | `Selection · Select something on the canvas first` |
| Scope `Pages`, no page checked | The primary is disabled (`aria-disabled`, focusable), reason in its tooltip | `Export · Choose at least one page` |
| A scale passes the device ceiling | That chip disabled, reason in its tooltip | `3× · Too large for this device (max 16 384 px)` |
| No format chosen (every chip deselected with `Mod+click`) | Not possible: the last selected chip cannot be deselected | — |
| Custom name empty or only disallowed characters | Not an error: the computed name is used; the hint says `Uses: Night market` | — |
| Selected elements are hidden or the selection's bounds are empty (`IF-EXP-002`) | Section error after pressing Export | `Nothing to export: the selected elements are hidden · Show them` |

Validation runs on blur and on submit (§2.4); the only field is the width and the name, both masked.

**Progress, background export and toasts** (reuse §3.4 and §3.5 as written)

Pressing the primary turns the footer into the **progress row**: a determinate bar (the job reports `fraction` per page
and per rendered chunk), text `Rendering page 2 of 5` → `Writing PDF` → (several formats) `Exporting PNG · 2 of 3
formats`, and `Cancel` (secondary) wired to the job's `AbortSignal`. The options above the row are **inert** while it
runs (dimmed, not disabled). Under 300 ms the row never appears (the result is the feedback). Closing the dialog
(Escape, `×`, backdrop, Back) while it runs **does not cancel**: the row becomes the sticky toast `Exporting
poster.png… · Cancel`, which becomes `Exported poster.png · Show in folder` (8 s; `Show in folder` only when the
folder mirror is on, else no action and 5 s) or the danger toast with the error and its fix. On success inside the
dialog, the dialog **closes** (`history.back()` when pushed) and the same success toast shows: the result is a download,
not visible where the gesture happened (FOUNDATIONS §5.3). Cancel leaves no file and no toast. Letters: progress,
cancel (a); the background toast (b: the service's `status` is already reactive and the job outlives the panel).

**Errors** (levels per §3.1: a failed gesture inside a dialog is a **section error** above the footer; after the dialog
closed, the same text is a danger toast — never both)

| Cause (`code`, never shown) | Text (`message · fix`) | Fix action | Letter |
|---|---|---|---|
| The export worker died or never answered (`IF-EXP-007`, F-50 step 6) | `Couldn't export 'poster.png' · Try again` | `Try again` re-runs with the same settings (one automatic retry already happened, §3.3). The editor is fine: **no banner**. | (a) |
| The render ran out of memory or the output was too large (`IF-EXP-005` over `SF-SURF-013`) | `Couldn't render at 3× · Export at 2×` | The fix button sets the scale one step down and re-runs; at 1× it reads `Couldn't render this page · Export a selection instead`. | (a) detection; (b) the step-down fix |
| A font used in the design is not available to the export (`IF-EXP-009`, new) | After a successful export: `Exported poster.png · 1 font missing, text uses the fallback · Details`; `Details` opens the dialog's done state listing `Inter Display → Geist`. The export is **not** refused. | (c) M2: the job reports `missingFonts` like `missingImages`; until then text falls back silently |
| An image could not be drawn (`missingImages`) | `Exported poster.png · 2 images missing · Show` — `Show` selects them on the canvas | (a) report; (b) the selection action |
| The snapshot could not be read (`IF-EXP-003`) | `Couldn't read the design to export it · Try again` | `Try again` | (a) |
| The writers rejected the scene (`IF-EXP-006`, an invariant) | `Couldn't write the PDF · Copy diagnostics` | Copies the `SfError` JSON; this is a bug, not a condition | (a) |
| The browser refused the download (`IF-EXP-008`) | `Couldn't save 'poster.png' · Allow downloads for this site` | Plain text (advice), plus `Try again` | (a) |
| The export Wasm failed to load (`IF-EXP-004`, offline on first PDF/SVG) | `PDF export needs a one-time download · Try again when online` — and the offline banner rule of §3.3 applies (`You're offline. PDF and SVG export need a connection; PNG works.`) | `Try again` | (a) |

**Deep link params** (`NAVIGATION-DEEPLINKS.md` §2.2 and §7 gain the three keys marked new)

| State | URL | Kind |
|---|---|---|
| The dialog, main step, remembered settings | `/s/:asset/d/export` (`?tab=export` is implied) | — |
| Advanced step | `…/d/export?step=advanced` | `step`, view (exists) |
| Scope | `…/d/export?scope=page` · `selection` · `pages` | `scope`, view, **new** |
| The page for `scope=page` | `…/d/export?scope=page&page=<id>` | `page`, view (exists) |
| The checked pages for `scope=pages` | `…/d/export?scope=pages&pages=<id>,<id>` (≤ 50 ids; absent = all) | `pages`, view, **new** |
| Format(s) | `…/d/export?format=png` · `png,pdf` | `format`, view, **new** |
| Scale, name, advanced options | nowhere (remembered per device; a link is "export this", not "my settings") | — |

`Copy link` in the header produces the dialog's current scope, pages and format (§5 of NAVIGATION-DEEPLINKS). A
deep-linked `pages=` with unknown ids keeps the known ones; all unknown → all pages, toast `Those pages are no longer
in this design` (neutral, 5 s; §4 fallback rules). `scope=selection` from a link opens with `Page` (there is no
selection on arrival) and no toast.

**Keyboard and a11y**

- The dialog is `dialog` `aria-modal=true` named `Export` (the tab list `Export · Share` is `tablist` when Share is
  rendered; in M1 the tab strip is not rendered and the heading is `Export`). Initial focus: the **primary** (there is
  no required field), so Enter exports at once with the remembered settings.
- Tab order: What → (page picker) → Preset → Format → the format's main option → Advanced ▸ → Reset to defaults →
  Cancel → Export. Every switcher is a `radiogroup` (arrows move, Space/Enter select); the multi-format switcher is a
  group of `checkbox`es styled as chips (Space toggles, the last one cannot be unchecked, announced as `PNG, checked, 1
  of 3`). Chips disabled with a reason are `aria-disabled` and keep their tooltip and focus.
- The page picker is a `listbox` `aria-multiselectable` of `option`s named `Page 2 of 5 · Post · 1 080 × 1 080`,
  `aria-selected` for checked; arrows move, Space toggles, `Shift+arrows` extend, `Mod+A` selects all; the count line is
  `aria-live=polite`.
- The width field and JPG slider follow the scrubbable-number and slider rules (STUDIO §5.3, FOUNDATIONS §4.5).
- Progress: the bar is `progressbar` with `aria-valuetext` = the row's text; the polite live region announces at **page
  boundaries** and on done or failure, never per chunk. The disabled-while-running options are `aria-busy` on the body.
- Shortcuts inside the dialog: Enter = the primary from any chip or field; `Mod+Enter` from the name field;
  `Mod+Shift+E` while open re-runs the primary; `Alt+←` = Back on the Advanced step; Escape per §1.4.
- The preview card is `img` named `Preview of Page 2`, `aria-hidden` when it only repeats the size line.

**Export engine follow-ups (every (c) above, none rendered in M1)**

| Follow-up | Where | Milestone |
|---|---|---|
| Arbitrary scale (`scale` any number > 0 within `MAX_EXPORT_PIXELS`, from a target width), unlocking Social presets on any page and the free `Width` field | `formats.ts` `EXPORT_SCALES` → a range; `job.ts` already multiplies by `scale`; `ExportCapability.input.scale` | M2 (C1 follow-up, small) |
| JPG with quality (an encoder beside `encodePng` in `@staticflux/surface/image`; `EXPORT_FORMATS.jpg` row) | surface image, `formats.ts` | M2 |
| Print PDF: bleed and crop marks (`pdf_page` takes a bleed box; marks drawn by the writer; MediaBox/TrimBox) | `engine/crates/export` pdf writer, `job.ts` | M2 |
| SVG text as `<text>` with optional embedded font subsets | `engine/crates/export` svg writer (needs glyph → text run mapping, already carried by IR v4) | M2 |
| `missingFonts` in `ExportResult` and `IF-EXP-009` (a warning, not a failure) | `job.ts`, `scene.ts`, `errors.ts`, the capability's output | M2 |
| Colour glyphs (emoji) export only outlines today (C1 handoff next step 3) | render crate | M2 |

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

**Added 2026-10-25 with the Export tab (§2.3 Export). Items 7 and 8 answered (accepted by the owner, 2026-10-25);
item 9 rewritten, then answered with GAP-AUDIT Q-A (recommendation accepted, 2026-10-25).**

7. **Answered — accepted.** `Mod+Shift+E` opens the dialog with the remembered settings and focus on the primary;
   `Mod+Shift+E`, Enter is the two-key quick export (F-53 variant). C1's `ExportShortcut` changes accordingly.
8. **Answered — accepted.** Several files are zipped by default (`<Title>.zip`), Advanced › `Zip several files` turns
   it off.
9. **Open — presets that do not fit the page: hide them, or show them and resize?** In plain words: a preset such as
   `Social story · 1 080 × 1 920` only picks a file type and a scale; it never changes the design. Suppose the page is
   a **square post (1 080 × 1 080)**. The story preset is a **tall rectangle**. If it were shown and pressed, the only
   honest result would be to **change the design's shape** (crop, stretch or re-lay-out the square into a tall page),
   which the engine cannot do today and which would surprise ("where did my layout go?"). **Recommendation:** hide
   presets that do not fit the page's shape (today's rule), **and** end the preset row with a muted link `Other
   sizes…` that opens Page › Size, so a person who wants a story first makes the page a story, then exports. When
   **Resize design** exists (backlog B-5), the link becomes `Resize design…` and the hidden presets return labelled
   `Social story · resize to 1 080 × 1 920`. Alternative: always show every preset and resize on export — not
   recommended for M1 (no engine support; a guess about the extra 840 px of height). **Question for the owner:** is
   "hide + `Other sizes…` link" right for M1, or should Resize design be pulled forward? Worked example in
   GAP-AUDIT Q-A.
