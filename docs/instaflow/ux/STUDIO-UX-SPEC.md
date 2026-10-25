# Instaflow Studio — UX specification

> Status: **normative for every WP that touches Home or Studio UI** (M1-BRIEF §5). Written 2026-10-25 from the owner's first
> clickable run of `main`, the approved **Clean Pop · final** design (`docs/instaflow/design/`), `UX.md`,
> `EDITOR-AS-PRIMITIVE.md` and D1–D20. Where this file and `UX.md` disagree, this file wins for M1; `UX.md` §2 and §5 keep
> describing the M2 chat and agent model. The companion `STUDIO-FLOWS.md` turns every rule here into observable end-to-end
> flows (F-xx), which are the acceptance tests.
>
> Conventions named in this file: **Figma** (direct manipulation, layers, keyboard), **Canva** (discoverability, rotate
> handle, text toolbar), **Keynote / PowerPoint** (rotate handle, alignment), **Adobe Illustrator / Express** (repeats,
> booleans, pen), **Framer** (context menus). When they disagree the choice is made for Instaflow's audience (first-timers
> and Canva natives first, Figma natives second, keyboard and screen-reader users always) and the reason is stated.

## 0. Principles

1. **Nothing visible is inert.** Every control that renders either works now or is not rendered. Features that arrive
   later have a deliberate pre-launch look (§10.4): one calm sentence, never a fake button. No control may say "arrives
   with B1" or any work-package, milestone or density word; developer text is a bug (§10.5).
2. **The canvas is the room; the page is a card in it.** The whole mist dotted area is the infinite canvas (D19). The page
   is a floating white card with a soft shadow and a label. Drawing, dropping and pasting work anywhere in the room.
3. **Visible first, hidden second.** Every action has a visible home (selection pill, inspector, context menu, layers,
   top bar); shortcuts and gestures are accelerators, never the only way. Figma's invisible rotate zones stay, but a
   visible rotate handle is the primary affordance (§6.1).
4. **Name everything you press.** Every control has an accessible name, and every pointer-operated control shows a
   tooltip with its name and shortcut after 500 ms hover (Figma). Tools additionally carry a one-line first-use hint.
5. **Contextual beats global.** What you selected decides what you see: the selection pill, the inspector sections and
   the context menu show only what applies to that kind of selection. Panels never show "select something to…" copy
   for more than one line; irrelevant sections are not rendered at all.
6. **Every commit names itself and can be undone.** One gesture = one undo step with a label. Every action gives
   feedback within one frame (hover, press, drag, snap) and every non-local action (milestone, template, export,
   delete of many) confirms with a toast carrying the undo or the next step (§9).
7. **Calm by default, dense on demand.** Standard density is the default; Focus and Pro are a choice in the View menu
   and Settings, explained in one line each. Nothing jumps: regions have fixed sizes, floating things never push the
   canvas.
8. **Conventions before invention.** Follow Figma for manipulation and layers, Canva for first-use discoverability,
   Keynote for the rotate handle, Illustrator for repeats and booleans. Invent only where Instaflow is different (the
   agent is optional, the document is local, every action is a capability) and say so.

## 1. Canvas model

| Rule | Decision |
|---|---|
| The room | `<main aria-label="Canvas">` fills the whole region between the dock and the inspector, background `#E4E9EF` with the 20 px `#C3CCD7` dot grid (StudioCP). It is the infinite canvas: pan anywhere, draw anywhere, drop anywhere. There is no inner white box. |
| The page card | Each page is a white (or page-coloured) card at its canvas position, `box-shadow: 0 2px 6px rgba(22,21,26,.10), 0 24px 56px rgba(22,21,26,.18)` (StudioCP). **No border**: the shadow is the edge. Page content is clipped to the card. Nothing of the page ever draws over its content. |
| The page label | A non-printing label 28 px above the card's top-left, 12 px Geist, `#56606C`: `Page 1 · Post · 1080 × 1080` (name · format · size). Clicking it selects the page (inspector shows Page). Double-click renames. |
| Page selection | A selected page shows a 1.5 px `#CF3D17` outline **outside** the card (offset 2 px) and no handles in M1 (page resize is the inspector's Size field). |
| Frames | A frame is an element. Its default look: white fill, no stroke, and a **non-printing** 1 px hairline `#DCE3EA` outline plus a name label (`Frame 1`, 11 px, `#56606C`) 20 px above its top-left, both drawn by the overlay, never exported. So a white frame on a white page is visible. Hover: outline turns `#CF3D17` at 1 px. Frames clip their children by default (`clip: true`); the inspector's Frame section can turn it off. |
| Shapes | Default fill is the brand `@primary` token, resolved to the kit (today bright tangerine `#FF5C39`); when the token cannot resolve the fill is `#FF5C39` literally and the inspector swatch shows the resolved colour (§5.4, the swatch mismatch bug). |
| Drawing anywhere | Shape, Frame, Text and Pen (when it exists) create at the pointer whether it is over a page, a frame or the mist. Over a page: the element's parent is the page. Over a frame: the frame (the frame highlights `#CF3D17` while hovering during the draw, Figma). Over the mist: a **loose element** on the canvas (DOCUMENT-FORMAT loose elements; `structure.loose`). |
| Loose elements | Render at their canvas position on the mist with the page shadow absent. They appear in Layers under a "Canvas" group after the pages. Moving an element across a page edge re-parents it on drop (Figma): fully inside → page child; otherwise loose. The drop target highlights while dragging. |
| Export | Exports render the **page bounds** of the chosen pages only (C1 frozen snapshot). Elements partly outside are clipped at the page edge; loose elements are never exported, except through "Export selection" (C1), which exports the selection's bounds. The Export dialog says this in one line when the document has loose elements: "2 elements outside the pages won't be exported." |
| Pages lens | Shows pages in story order, the camera fitted to one page at a time; loose elements are hidden (they belong to the Canvas lens). The Pages panel says "3 loose elements on the canvas · Show in Canvas" when any exist. |
| Rulers and guides | Pro density only in M1: rulers along the top and left of the canvas region (page origin = 0). Dragging from a ruler creates a guide (M2; not shown before then). |
| Zoom range | 2 %–6400 %, steps 25 · 50 · 100 · 200 · 400. New document opens at **Fit** (whole page with 44/24/84 px padding, StudioCP); reopen restores the last camera per document (view state, local only). |

## 2. Top bar

56 px, `#F1F4F7`, hairline bottom. Left to right, at every density:

| Slot | Content | Behaviour |
|---|---|---|
| Logo | The four-shape logo, 26 px | Link to Home (`/`). Tooltip "Home". Leaving flushes Latest first (C0). |
| Breadcrumb | `Spring campaign /` (muted, M2 projects; **hidden in M1**) then the **design title** in Bricolage 700 15 px | Click the title to rename inline (field 12 px corners; Enter saves, Escape cancels). Untitled designs are named `Untitled design` and the field is pre-selected on first click. |
| Lens switcher | A switcher pill, centred (`margin: 0 auto`). **M1 shows exactly `■ Canvas` and `■ Pages`** (both layout lenses, both built). | See §2.1 for when other lenses appear. Keys `1` (Canvas) and `5` (Pages) keep their ids; `2`–`4` do nothing until their lens exists (they are not listed in Help). |
| Save status | `● Saved` (dot `#00A372`), `● Saving…` (mist dot), `● Not saved · <cause>` (`#CF3D17`, after 2 s stalled) | Clicking it opens the Milestones tab in the dock (that is where "versions" live). Tooltip explains: "Instaflow saves as you work. Create a milestone to keep a named version." |
| Assistant chip | `✦ <provider>` chip (`chipAgent` look). **Not rendered in M1** (no provider runtime). From M2: reads `✦ Set up an assistant` until a provider is configured, then `✦ Claude · Ask` / `✦ Gemini · Accept edits` / `✦ On-device · Ask`. | §2.2. |
| View menu | `View ▾` ghost button (new) | Zoom to fit `Shift+1`, Zoom to selection `Shift+2`, 100 % `Shift+0`, Zoom in/out; ─; Rulers (Pro); Snap to objects; Snap to grid; ─; **Density: Focus / Standard / Pro** as a radio group with one line each (§2.3); ─; Show layers `Mod+Shift+L`... no: Show dock `Mod+\`, Show inspector `Mod+Alt+\`. |
| Milestone | Secondary 34 px | Opens the inline milestone form popover (name prefilled `Milestone N`, note optional, Enter creates). Feedback §9. |
| Overflow | `⋯` icon button | Save as template…, Rename…, Duplicate design, ─, Settings `Mod+,`, Keyboard shortcuts `?`, ─, About. ("Save as template" leaves the top bar: it is rare and had no feedback; it keeps its capability.) |
| Export | **Primary** 34 px, labelled `Export` (replaces `Share` in M1) | Opens the Export dialog (`/d/export`, C1). Sharing returns as a tab of this dialog when it exists (D3: no accounts, so no links in M1). Until C1 lands on `main`, the button is **not rendered**; the first C1 PR adds it. |

### 2.1 Lens model (which lenses show, when)

Decision, consistent with D4 (lenses are modes of one core) and D19 (Studio is canvas-first):

- **Always:** `Canvas` and `Pages`. Every design has a layout and a story, so both lenses always apply. They share the
  tangerine square mark.
- **Contextual (appear when the document can use them):** `Pixel` (sunflower circle) appears once the document contains
  at least one image element; `Timeline` (blue frame) once the document contains motion, a video or audio asset, or a
  second page with a transition; `Flow` (mint pill) once the document contains a flow. The lens joins the switcher
  with the 160 ms slide-in motion, to the right of Pages, in the order Pixel · Timeline · Flow. It never leaves again
  while the document still has that content; it leaves (fade out) when the content is gone and the person is not in
  it.
- **Discovering and adding:** the person never "adds a lens". Lenses follow content: place an image → Pixel appears;
  "Add transition" on the gap between pages → Timeline appears. The command palette lists `Open in Pixel lens` etc. only
  when the lens is present. Help (`?`) lists lens keys.
- **Before an M2 lens exists:** it is not in the switcher, not in the palette and not in Help. The logo keeps all four
  colours (brand), which is the only trace of the future lenses. No "coming soon" pill.
- The switcher's accessible name stays "Lens" (`role=group`, `aria-pressed`), and a lens change is announced ("Pages
  lens").

### 2.2 Assistant entry point (provider-agnostic)

The framework's model port (`packages/ai`) is provider-agnostic: built-in browser AI, on-device, decision and remote
models. Instaflow therefore never hard-codes a vendor in the UI.

- **Naming:** the role is **the assistant**; the UI shows the configured provider's display name (`Claude`, `Gemini`,
  `GPT`, `On-device model`, `Chrome built-in`) after `✦`. Copy says "assistant" when no provider is named ("Set up an
  assistant", "Ask the assistant"). Actions keep their verbs: `✦ Rewrite`, `✦ Remove background`, `✦ Ask`.
- **Colour role:** raspberry `#D6265F` / soft `#FDE8EF` is the **agent role colour** (what hands work to the assistant),
  whichever provider. The design README's "Claude is raspberry" is read as "the assistant is raspberry" (open question
  Q6 confirms). Provider logos are never shown on buttons; the provider name appears as text.
- **No provider configured (the only M1 state):** nothing assistant-shaped is rendered in Studio: no chip, no `✦` actions
  in pills, no Chat panel, and the bottom bar is a plain **command bar** (`Type a command`, `Mod+K`, §4.4). The one
  place the assistant is discoverable is **Settings › Assistant** (§2.4), reached from Home and from Studio's overflow.
- **From M2:** the chip `✦ Set up an assistant` (soft) appears in the top bar once a provider can be configured; once
  configured it becomes `✦ <Provider> · <Autonomy>` (D13 modes in its menu). The command bar placeholder becomes "Ask
  <Provider> or type a command". `✦` pill actions and the Chat side panel appear. Autonomy, pause and stop follow UX.md
  §5.
- Keys are stored **on this device only** (§2.4). Client gating is UX, not security (rule 9): a provider's own auth is
  the security boundary.

### 2.3 Density

Density leaves the top bar. It is a **View** setting (View menu and Settings › General), remembered per device, default
**Standard**. Each option has a one-line explanation in the menu and in Settings:

| Density | One line | Shows |
|---|---|---|
| Focus | "Just the canvas. Panels open when you need them." | Top bar, tools, selection pill, command bar, zoom. Dock and inspector collapsed to rails (expand on click, auto-collapse on canvas click). |
| Standard (default) | "Canvas with layers and the inspector." | + dock open on the last tab, inspector open, rulers off. |
| Pro | "Everything at once, with rulers and numbers." | + rulers, Transform section expanded with scrubbable fields, shortcut hints in tooltips and menus, split dock (two tabs). |

The first run opens in Standard. Switching density animates regions (160 ms) and never moves the canvas origin under the
pointer (the camera is re-centred so the page stays where it was on screen).

### 2.4 Settings surface (new; M1 General/Storage/Shortcuts, M2 Assistant)

Route `/settings` from Home (gear icon in the header, `Settings` in the nav) and from Studio (overflow `⋯ › Settings`,
`Mod+,`). It opens as a page in Home's light shell and as a **dialog** over Studio (so the document stays loaded). Left
list of sections, content on the right, Clean Pop cards. Every change applies immediately with a "Saved on this
device" line, no Save button (D2 spirit).

| Section | M1 | Contents |
|---|---|---|
| General | yes | Density (radio, explained), Theme (Light; Dark "coming" line only, DS2), Units (px · mm · in · pt; default px), Nudge (1 / Shift 10, editable), Reduced motion (follows the OS; override), Language. |
| Shortcuts | yes | The full keyboard map (§7) as a searchable table with Mac/Windows columns; read-only in M1. |
| Storage | yes | Space used, persistence state, "Move workspace to a folder" (D8), "Back up workspace (.zip)". |
| Assistant | **M2** | Providers list (Chrome built-in, On-device, Remote: Anthropic / OpenAI / Google / custom endpoint), per provider: key field (password, "stored only on this device, never in documents, milestones or exports, never synced"), Test call, default provider per task (write, edit image, decide), default autonomy (D13). In M1 the section shows the pre-launch look (§10.4): one card, "The assistant arrives in the next release. Keys will be stored only on this device." and nothing else. |
| About | yes | Version, licences (fonts, icons), diagnostics copy button. |

Key storage: an `instaflow/settings` document in the workspace store (IndexedDB), excluded from milestones, exports,
templates and the Home index, never sent anywhere but the provider's own endpoint from the user's device. Keys are
masked after entry and can be removed. (Plumbing §11.)

## 3. Left dock

236 px, white, hairline right. A switcher of tabs at the top (`Layers · Pages · Assets · Milestones`; `Brand` joins
when brand kits have a panel, M2). In Focus the dock is a 44 px rail of icons with tooltips; clicking a rail icon opens
the dock over the canvas as a floating 236 px card (Figma UI3 behaviour) until the next canvas click. In Standard and
Pro it is docked. `Mod+\` toggles it. The **Chat side panel is not rendered in M1** (§2.2).

### 3.1 Layers (a real list)

Replaces today's placeholder. Figma conventions with Canva's clarity:

- **Filter field** (`Filter layers`, 34 px, 12 px corners) at the top; typing filters by name and kind (`text:`,
  `image:` prefixes accepted). Escape clears.
- **Rows:** 30 px, pill highlight on selection (`#FFE9E2` background, `#B53A17` text, StudioCP). Left to right: a 14 px
  kind icon (§10.2: frame, group, rectangle, ellipse, polygon, star, line, path, image, text, repeat, boolean, mask);
  the name (ellipsis); a mono tag for a brand token or repeat count when present; then two hover-revealed icon buttons
  **Hide** (eye) and **Lock** (lock), which stay visible while active. Hidden rows are 50 % opacity; locked rows show
  the lock permanently.
- **Order:** pages first in story order, each a collapsible group; then `Canvas` (loose elements). Inside, paint order
  top-most first (Figma). Frames and groups collapse with a chevron; **Alt+click** a chevron expands everything inside.
- **Selection sync:** selecting on the canvas scrolls the row into view and highlights it; selecting a row selects on
  the canvas (and enters the container if needed). Shift+click selects a range, Mod+click toggles.
- **Rename:** double-click the name or press `Enter` on a focused row (Windows also `F2`): inline field, Enter saves,
  Escape cancels. One undo step "Rename".
- **Reorder:** drag a row (6 px slop) with a 2 px tangerine insertion line and a container highlight when dropping into
  a frame or group; `Alt+↑/↓` moves the focused row; z-order shortcuts (§7) apply too. One undo step "Reorder".
- **Hover:** hovering a row outlines the element on the canvas (1 px `#CF3D17`); hovering the canvas highlights the row.
- **Context menu** on a row = the canvas context menu for that element (§8).
- **Empty state:** "Nothing here yet. Draw a shape (R) or add text (T)." with both tool names as links that select the
  tool.

### 3.2 Pages

As built by B4 with these additions: rows get a 48 px thumbnail (follow-up with the A7 projection; until then a format
chip), `+ Add page` button at the bottom (duplicates the current page's size, M1 plumbing §11), context menu (Duplicate
page, Rename, Delete page, Move up/down), and the loose-elements line from §1.

### 3.3 Assets

As built by B4: `Import` secondary button, drop zone over the whole panel, grid of 12 px-cornered thumbnails with the
lens mark, click to **Place** at the canvas centre (selects the new image; one undo step "Place image"), drag onto the
canvas to place at the drop point. Context menu: Place, Rename, Trash.

### 3.4 Milestones

As built by B5. Add: the top entry "Latest" (unpinnable), the `Milestone` top-bar button focuses this tab's name field
after creating, and every row's menu has Open (read-only), Compare with Latest, New document from milestone, Rename,
Pin.

## 4. Canvas chrome

### 4.1 Tool picker

A floating white pill, top-centre of the canvas region, 16 px below the top edge, shadow `0 1px 2px rgba(22,21,26,.08),
0 10px 28px rgba(22,21,26,.18)`. Items are 34 px round icon buttons with the selected one on a `#FFE9E2` pill. Order
and keys for the Canvas lens:

| Tool | Icon (Lucide) | Key | Tooltip | First-use hint (shown once per device below the pill for 6 s, or until the first use) |
|---|---|---|---|---|
| Select | `mouse-pointer-2` | V | Select · V | — |
| Frame | `frame` | F | Frame · F | "Drag to draw a frame. Frames hold other things and clip them." |
| Shape | `square` with a ▾ | R | Rectangle · R (menu: Ellipse O, Polygon, Star, Line L) | "Drag to draw. Shift keeps it square, Alt draws from the centre." |
| Text | `type` | T | Text · T | "Click to start typing, or drag for a fixed width." |
| Pen | `pen-tool` | P | Pen · P | "Click to add points, drag to curve them. Click the first point or press Enter to close." |
| Hand | `hand` | H | Hand · H | "Drag to pan. Hold Space to pan with any tool." |

- **Pen is not built** (`instaflow/pen` is a placeholder id with no controller: `apps/instaflow/src/app/creation.ts`
  covers Shape, Frame and Text; `src/tools/gesture.ts` covers Select and Hand). Until a pen controller lands the Pen
  button is **not rendered** (principle 1). Its key `P` does nothing. The hint above is the spec for when it ships.
- The Pages lens shows Select · Shape · Text · Hand.
- Tooltips use `<sf-tooltip>` from the kit, 500 ms delay, name + `kbd`. Hints are a small white card with a close ×,
  stored in `localStorage` per device.
- Choosing a creation tool changes the cursor to a crosshair; after one creation the picker returns to Select (Figma),
  unless the tool was double-clicked (sticky, shown with a small dot under the icon).

### 4.2 Selection pill (the HUD)

A small floating contextual pill (StudioCP: `Fraunces ▾ · 120 · Fit to box · ✦ Rewrite · ⋯`), **not** the current
three-row action bar. Rules:

- **Placement:** centred above the selection's screen bounds with a 12 px gap; below it when there is no room above;
  clamped to the canvas region with 8 px margins; snapped to the selection's top edge when the selection is taller than
  the viewport. Hidden while dragging, resizing, rotating or marquee-selecting; reappears 120 ms after the gesture.
  Never moves the canvas, never overlaps the tool picker (it moves below the selection instead).
- **Capacity:** at most **6** visible items plus `⋯`. Items are ghost-small buttons (28 px) with an icon and, when the
  item is a value, text. Dividers between groups. The `⋯` opens the **More** menu: a searchable menu (`sf-menu` with a
  filter field, same as the command palette filtered to the selection), grouped by Arrange · Transform · Combine ·
  Style · Repeat · Describe, each item with its shortcut; actions the selection cannot run are **not listed** (never
  disabled rows).
- **Stability:** the first three slots are fixed per selection kind; the pill re-lays out only when the selection kind
  changes, never while open.
- **Contents per selection kind** (Standard density; Pro adds shortcut hints in tooltips; Focus is identical):

| Selection | Visible items (max 6) | Always in More |
|---|---|---|
| Nothing | No pill. | — |
| Shape (rect / ellipse / polygon / star / line / path) | Fill swatch · Stroke swatch · Corner radius field (rect only; polygon/star show Points) · Duplicate · Delete · ⋯ | Rotate 90°, Flip H/V, Free transform, Bring forward/backward, Group with…, Use as mask, Radial/Grid/Mirror repeat, Outline stroke, Flatten, Describe |
| Text | Font ▾ · Size field · Bold · Align ▾ · Fill swatch · ⋯ (`✦ Rewrite` joins as 6th from M2, Fit to box moves to More) | Fit to box, Italic/Underline, Letter spacing, Line height, Rotate 90°, Flip, Duplicate, Delete, Repeat…, Describe |
| Image | Crop · Fit ▾ (Fill/Fit/Stretch) · Replace… · Use as mask ▾ · Duplicate · Delete · ⋯ (`✦ Remove background` from M2) | Rotate, Flip, Bring/Send, Repeat…, Describe |
| Group | Ungroup · Align ▾ · Duplicate · Delete · ⋯ | Rotate, Flip, Tidy up, Use as mask, Repeat…, Flatten, Describe |
| Frame | Fill swatch · Clip toggle · Rename · Duplicate · Delete · ⋯ | Align children, Tidy up, Layout grid…, Rotate, Repeat…, Describe |
| Multi-selection | Align ▾ · Distribute ▾ · Group · Combine ▾ (Union/Subtract/Intersect/Exclude) · Delete · ⋯ | Tidy up, Centre in container, Use as mask, Radial/Grid/Mirror repeat, Flip, Rotate, Describe |
| Repeat | Kind chip (`Radial · 8`) · Count field · Edit · Expand · Release · ⋯ | Duplicate, Delete, Align, Flip, Describe |
| Boolean group | Operation ▾ (Union…) · Release · Flatten · Duplicate · Delete · ⋯ | Align, Rotate, Flip, Describe |
| Masked group | Mask mode ▾ (Clip/Alpha/Luminance) · Invert · Release · Duplicate · Delete · ⋯ | Align, Rotate, Describe |
| Page (label clicked) | Rename · Size ▾ · Duplicate page · Delete page · ⋯ | Fit, Export this page… |

- `Delete` is always visible on a non-text pill (the owner could not find it) with the tooltip "Delete · ⌫".
- Swatches open the colour popover (kit `color-field`): hex field, brand tokens row, recent colours, opacity slider.
- Value fields in the pill (Size, Radius, Count) are scrubbable numbers (§5.3).
- `Alt+Enter` focuses the pill's first item; arrows move; `Escape` returns to the canvas.

### 4.3 Zoom control

Bottom-left pill as StudioCP: `−` · `43%` · `+`. Clicking the value opens a menu: Zoom to fit, Zoom to selection,
50 / 100 / 200 %, and "Zoom to 100 % on open" toggle. Keys as §7.

### 4.4 Command bar

Bottom-centre pill (StudioCP). **M1:** a real **command palette** over the capability registry (`Mod+K`), placeholder
`Type a command`, with `⌘K` / `Ctrl K` kbd on the right. Typing filters capability titles and tool names, Enter runs the
top result on the selection, results show shortcut hints, and results the selection cannot run are hidden. Recent
commands show first when empty. **From M2** the same bar accepts natural language when a provider is configured (§2.2).
Today the bar emits `if-command` that nothing listens to (plumbing §11).

## 5. Inspector

264 px, white, hairline left. Header: the selection's name (Bricolage 700 15 px), a kind tag (`Text`, `Rectangle`,
`3 selected`), and a lock state at the right (`Unlocked` muted, or a lock icon button). Sections are `h2` in the
StudioCP style (11 px uppercase muted), 14 px padding, hairline between. **Each section heading appears once** (today
"Transform › Transform" nests a panel title inside a section; the panel renders without its own title when placed in a
section).

### 5.1 Section order per selection kind

Sections not listed for a kind are **not rendered** (no "Select a text element to edit its typography" panels when a
rectangle is selected; no Repeat panel unless the selection is or can become a repeat).

| Selection | Sections, in order (▸ collapsed by default) |
|---|---|
| Nothing | **Page** (Name, Size preset ▾ with W × H fields, Background swatch, Orientation) · **Document** (Title, Pages count, Units) |
| Shape | Transform · Fill · Stroke · ▸ Corners (rect; per-corner toggle and smooth slider) · ▸ Effects · ▸ Layer (opacity, blend) |
| Text | Transform · **Text** (Font family ▾ with preview, Weight ▾, Size, Line height, Letter spacing, Align row, Vertical align, Auto-size: Auto width / Auto height / Fixed) · Fill · ▸ Stroke · ▸ Effects · ▸ Layer |
| Image | Transform · **Image** (Fit ▾, Replace…, Source name, Size in px) · ▸ Effects · ▸ Layer |
| Frame | Transform · **Frame** (Clip content, Name) · Fill · ▸ Stroke · ▸ Layout grid · ▸ Effects · ▸ Layer |
| Group | Transform · ▸ Layer |
| Multi-selection | Transform (mixed values) · Fill · Stroke · ▸ Effects · ▸ Layer — fields show `Mixed` (§5.3) |
| Repeat | Transform · **Repeat** (Kind switcher Radial / Grid / Mirror, then the kind's parameters; Expand, Release buttons) · the source's sections after it |
| Boolean / masked group | Transform · **Combine** or **Mask** (operation / mode, Invert) · Fill · Stroke · ▸ Effects · ▸ Layer |
| Page | Page · ▸ Layout grid |

In Focus density the inspector is a rail; in Standard, Transform shows X Y W H and angle only (flip, skew and pivot are
under a `More ▾` row); in Pro everything is expanded, including the pivot picker.

### 5.2 Field layout at 264 px

Content width 236 px. Two columns of `label(12 px) + field(1fr)` with 8 px gaps (StudioCP geometry grid):

```
X [  120 ]   Y [  244 ]
W [  920 ]   H [  346 ]  🔗
∠ [   0° ]   ⟂ [   0° ]        (Pro / More ▾)
[Flip H] [Flip V]  pivot ⋮⋮⋮  (Pro / More ▾)
```

Fields are 32 px, 12 px corners, Geist Mono 12 px, control edge. Units live inside the field as a muted suffix (`px`,
`°`, `%`) and are not typed. Fill, Stroke and Effects are **stacks**: each row is a 34 px pill-field with a 16 px round
swatch, the value (`@cream` mono tag, then `#FFF4E0`), an opacity field, a visibility eye and a × on hover; `+ Add` at
the bottom of each stack. Stroke rows add Width and Position ▾ (Inside / Centre / Outside). Effect rows add a Kind ▾
(Shadow / Glow / Blur / Background blur) and the kind's fields on a second line.

### 5.3 Numbers, units and mixed values

- Every numeric field is **scrubbable**: dragging on its label (cursor `ew-resize`) changes the value by 1 per 2 px,
  Shift ×10, Alt ×0.1; the change previews live and commits once on release (one undo step).
- Typing accepts expressions (`+10`, `*2`, `50%` where meaningful) and units (`2in`), converted to the document unit.
  Enter commits, Tab commits and moves, Escape restores. ↑/↓ step 1, Shift ×10.
- `Mixed` appears as the placeholder when a multi-selection disagrees; typing sets all; scrubbing adds the same delta to
  each.
- Angle fields normalise to (−180, 180]; W/H never go below 1; the link toggle keeps proportion.

### 5.4 Swatches and colour

The inspector swatch shows the **resolved** colour (token → kit → hex); hovering a token shows `@primary = #FF5C39`. A
swatch that cannot resolve shows a hatched pattern and a "Token @primary not in this document's brand kit" line with
"Replace with #FF5C39". Clicking a swatch opens the colour popover anchored to it (not a native `<input type=color>`).

### 5.5 Empty states

One line, muted, 13 px, no heading: Layers "Nothing here yet…" (§3.1), Assets "Drop images here or press Import.",
Milestones "No milestones yet. Press Milestone to keep a named version.", Pages never empty (one page minimum).
The inspector with nothing selected shows the Page sections (§5.1), never a "select something" message.

## 6. Direct manipulation

### 6.1 Handles

Clean Pop: handles are **round**, 9 px white with a 1.5 px `#CF3D17` ring (StudioCP), 14 px hit radius; the frame is
1.5 px `#CF3D17`. Eight resize handles. Additions:

- **Rotate handle (decision, Q1):** a visible round handle **24 px below the bottom-centre** of the selection frame on a
  1 px stem, icon `rotate-cw` inside (Canva / Keynote / PowerPoint). Dragging it rotates about the pivot with the
  rotate cursor and a mono angle pill (`37°`) near the pointer; Shift snaps 15°. The four invisible **corner zones** (12
  px outside each corner, cursor `rotate`) stay for Figma natives. Reason: Canva natives and first-timers never found
  the zones; a handle costs nothing for Figma users.
- **Skew:** in Pro, or during Free transform, the side handles with `Mod` held show the skew cursor (`⇔` slanted);
  elsewhere skew is numeric (inspector).
- **Pivot:** shown only during Free transform or once moved (B10a). A 10 px ring with a crosshair; Alt+click resets.
- **Size pill:** while resizing, a mono pill `920 × 346` (`#CF3D17` background, white text) 28 px below the frame
  (StudioCP). While moving, a `X, Y` pill. While rotating, the angle pill.
- **Multi-selection:** one frame around the union, rotation 0, no individual frames; individual outlines appear on
  hover.
- **Locked element:** the frame is dashed `#7D8897`, no handles, and the pill shows `Unlock` only.

### 6.2 Cursors

| Context | Cursor |
|---|---|
| Select over empty canvas | default arrow |
| Over an element | arrow with a small move glyph after 150 ms hover (Figma: plain arrow; Canva: move cursor). Decision: plain arrow + hover outline, move cursor only while dragging. |
| Resize handle | `nwse-resize` etc. rotated with the frame |
| Rotate handle / zone | custom rotate cursor (SVG, 24 px) |
| Creation tool | `crosshair` |
| Hand, Space held | `grab` / `grabbing` |
| Text tool over text | `text`; over empty canvas `text` with a + badge |
| Pen | `crosshair` with a small pen glyph (when Pen exists) |

### 6.3 Hover and selection states

Hover: 1 px `#CF3D17` outline on the element under the pointer (and its container's name label turns tangerine).
Selection: the frame and handles. Entered container (double-click): a 1 px dashed `#7D8897` outline around the
container while inside; breadcrumb in the inspector header (`Frame 1 › Rectangle`). Text editing: no handles, a 1 px
tangerine outline, caret and selection (`#CF3D17` at 25 % behind glyphs).

### 6.4 Snapping and guides

Smart guides as B3: 1 px `#D6265F`... no: guides are **raspberry-free**; they use `#FF5C39` (bright tangerine, the
"shapes and tags" colour) so they read as canvas, not as agent. Distance labels are mono mist tags (kit). Snap
threshold 6 px screen. Guides fade in 80 ms, out 120 ms. Hold `Mod` to disable snapping during a drag (Figma). Equal
spacing shows the pink-free tangerine ticks between elements.

### 6.5 Marquee, nudge, click behaviour

- Marquee: drag on empty canvas from 4 px slop; 1 px `#CF3D17` border with 8 % fill; `touch` mode (Figma) selects
  anything intersected; Alt marquee requires containment.
- Click selects the top-most element at that point inside the current container; click through into groups needs a
  double-click (Figma) or `Mod+click` for deep select.
- Shift+click toggles into the selection; Alt+drag duplicates (§9); Space+drag pans.
- Nudge 1, Shift 10 (Settings § 2.4 edits these). Arrow keys with Mod+Alt resize (existing).
- Double-click: text → edit text at the clicked caret; group / frame → enter it and select the child under the pointer;
  image → crop mode (M1 plumbing); repeat → edit the repeat (handles); page label → rename; empty canvas → nothing.
- Text editing exit: `Escape` (keeps the text, selects the element), click outside (commits), `Mod+Enter` (commits
  and selects). An empty new text element is removed on exit (one undo step collapses).

## 7. Keyboard map

`Mod` = ⌘ on Mac, `Ctrl` on Windows and Linux. Everything in the table is registered through the shortcut registry so
Help (`?`), tooltips and the palette show the same keys. Browser-reserved combos that Chrome never hands to the page:
`Mod+T` (new tab), `Mod+W` (close tab), `Mod+N` (new window), `Mod+Shift+T/N/W`, `Mod+Shift+]/[` (switch tab, Mac),
`Mod+R` (reload), `Mod+L` (address bar). Instaflow never binds those; fallbacks are listed.

| Action | Mac | Windows | Notes |
|---|---|---|---|
| **Tools** | | | |
| Select / Frame / Rectangle / Ellipse / Line / Text / Pen / Hand | V / F / R / O / L / T / P / H | same | Pen only when it exists |
| Pan temporarily | hold Space | same | |
| **Selection** | | | |
| Select all in container | ⌘A | Ctrl+A | |
| Next / previous element | Tab / Shift+Tab | same | paint order |
| Add next / previous | ⌘⇧→ / ⌘⇧← | Ctrl+Shift+→/← | |
| Enter group / select parent | Enter / ⇧Enter | same | |
| Deselect / leave container / cancel | Esc | same | |
| Select same fill / same font | ⌘⇧A (menu) | Ctrl+Shift+A | via context menu "Select same ▾" |
| **Edit** | | | |
| Undo / Redo | ⌘Z / ⌘⇧Z | Ctrl+Z / Ctrl+Y and Ctrl+Shift+Z | |
| Cut / Copy / Paste | ⌘X / ⌘C / ⌘V | Ctrl+X/C/V | §8 |
| Paste in place | ⌘⇧V | Ctrl+Shift+V | |
| Duplicate | ⌘D | Ctrl+D | offset 24, 24 or smart spacing (§9) |
| Delete | ⌫ / ⌦ | Backspace / Delete | works whenever a selection exists and focus is not in a text field (§11) |
| Rename | Enter in Layers, or ⌘⇧R | F2, or Ctrl+Shift+R | ⌘R is reload |
| Group / Ungroup | ⌘G / ⌘⇧G | Ctrl+G / Ctrl+Shift+G | new (§11) |
| Lock / unlock, Hide / show | ⌘⇧L / ⌘⇧H | Ctrl+Shift+L / Ctrl+Shift+H | new; Hide shadows Figma's; Shift+H stays flip (below) |
| **Arrange** | | | |
| Bring forward / Send backward | ⌘] / ⌘[ | Ctrl+] / Ctrl+[ | new |
| Bring to front / Send to back | ⌘⌥] / ⌘⌥[ | Ctrl+Alt+] / Ctrl+Alt+[ | new; the existing 1° rotate keys move (below) |
| Align left / centre / right | ⌥A / ⌥H / ⌥D | Alt+A / Alt+H / Alt+D | Figma |
| Align top / middle / bottom | ⌥W / ⌥V / ⌥S | Alt+W / Alt+V / Alt+S | |
| Distribute horizontally / vertically | ⌃⌥H / ⌃⌥V | Ctrl+Alt+Shift+H / V | |
| Tidy up | ⌃⌥T | Ctrl+Alt+Shift+T | |
| **Transform** | | | |
| Nudge 1 / 10 | arrows / ⇧arrows | same | |
| Resize 1 / 10 | ⌘⌥arrows / ⌘⌥⇧arrows | Ctrl+Alt(+Shift)+arrows | existing |
| Rotate 15° / −15° | ⌥] / ⌥[ | Alt+] / Alt+[ | existing |
| Rotate 1° / −1° | ⌥⇧] / ⌥⇧[ | Alt+Shift+] / [ | **moved** from ⌘⌥] (now z-order) |
| Flip horizontal / vertical | ⇧H / ⇧V | same | existing |
| Free transform | ⌘⌥T, also the pill's More | Ctrl+Alt+T | **fallback for ⌘T** (reserved); Enter applies, Esc cancels |
| **View** | | | |
| Zoom in / out | ⌘= / ⌘− (and ⌘ wheel) | Ctrl+= / Ctrl+− | prevented default |
| Zoom 100 % / fit / selection | ⇧0 / ⇧1 / ⇧2 | same | |
| Toggle dock / inspector | ⌘\ / ⌘⌥\ | Ctrl+\ / Ctrl+Alt+\ | new |
| Canvas / Pages lens | 1 / 5 | same | 2–4 reserved for their lenses |
| Previous / next page | PageUp / PageDown | same | existing |
| **Studio** | | | |
| Command palette | ⌘K | Ctrl+K | |
| Focus selection pill / canvas | ⌥Enter / Esc | Alt+Enter / Esc | |
| Milestone | ⌘⌥S | Ctrl+Alt+S | ⌘S shows the "saves automatically" toast with "Create milestone" |
| Export | ⌘⇧E | Ctrl+Shift+E | when C1 lands |
| Settings | ⌘, | Ctrl+, | |
| Shortcuts help | ? | ? | opens Settings › Shortcuts as a dialog |
| **Text editing** (inside a text element) | | | |
| Bold / Italic / Underline | ⌘B / ⌘I / ⌘U | Ctrl+B/I/U | |
| Align left / centre / right | ⌘⇧L / ⌘⇧E / ⌘⇧R | Ctrl+Shift+L/E/R | shadows Lock/Rename only while editing text |
| Size up / down | ⌘⇧> / ⌘⇧< | Ctrl+Shift+> / < | |
| Commit / Exit | ⌘Enter / Esc | Ctrl+Enter / Esc | |

Letter tools never fire while typing in any field (the registry checks the composed origin). Every shortcut has a menu
or pill home; the Shortcuts section lists them all.

## 8. Clipboard and context menu

### 8.1 Clipboard

| Case | Behaviour |
|---|---|
| Copy within Studio | Writes `application/x-instaflow+json` (the subtree ops, rich text, repeat params, referenced asset hashes and inline bytes ≤ 2 MB), plus `image/svg+xml` and `text/plain` (the text content, or the names) so other apps get something. Cut = copy + delete (one undo step "Cut"). |
| Paste in the same page, source still visible | At **+24, +24** from the source, like Duplicate; the pasted elements are selected. Paste again: +48, +48 (Figma stacking). |
| Paste in another page or document | At the **same page coordinates**; if outside that page, centred in the viewport. Missing assets are re-imported from the inline bytes or, when too large, show a "Image not available on this device" placeholder with Replace. Brand tokens that do not exist in the target become literal values (the Fill shows the resolved hex). |
| Paste in place | `Mod+Shift+V`: same coordinates, always, even on the same page. |
| Paste into an entered frame or group | The pasted elements become children of the entered container. |
| From other apps: image (`image/png`, `image/jpeg`, files) | Imported into the library (dedupe), then placed centred in the viewport at its pixel size (max 80 % of the viewport, keeping ratio). One undo step "Paste image". |
| From other apps: `image/svg+xml` or `.svg` file | **M1 before C2:** pasted as an image. From C2: imported as vector elements (usvg), grouped. |
| From other apps: plain text | A new auto-width text element at the viewport centre with the document's text defaults; when editing text, inserted at the caret. |
| From other apps: HTML (rich text) | Bold / italic / underline / links / line breaks kept, fonts and colours dropped (Canva behaviour, predictable). |
| Copy text selection | `text/plain` and `text/html` of the selected range. |
| Copy to other apps | SVG of the selection (C1 writer; before C1, PNG at 2× is not possible without a raster → plain text only, and the pill shows "Copy as SVG" only when C1 exists). |
| Permissions | Uses the async Clipboard API on a user gesture; if the browser refuses, a toast "Clipboard blocked by the browser · Allow in site settings". Internal copy always works through an in-memory fallback within the same tab. |

### 8.2 Context menu (right-click, `Shift+F10`, Menu key)

A `sf-menu` at the pointer, kit styling, items with icons and shortcuts; only applicable items are listed.

| Target | Items |
|---|---|
| Empty canvas (nothing selected) | Paste · Paste in place · ─ · Select all · ─ · Zoom to fit · 100 % · ─ · Add page · ─ · Show rulers (Pro) |
| Element (any) | Cut · Copy · Paste · Duplicate · Delete · ─ · Bring to front · Bring forward · Send backward · Send to back · ─ · Group / Ungroup · Lock / Unlock · Hide · Rename · ─ · Select same ▾ (Fill, Stroke, Font, Kind) · ─ · (kind items) |
| + Shape | Use as mask · Outline stroke · Flatten · Make repeat ▾ |
| + Text | Edit text · Fit to box · Convert to outlines (M2) |
| + Image | Crop · Replace image… · Use as mask · Fit ▾ |
| + Group / Frame | Enter · Ungroup / Unframe · Tidy up · Align children ▾ |
| + Multi | Align ▾ · Distribute ▾ · Combine ▾ · Group · Frame selection · Make repeat ▾ · Use as mask |
| + Repeat / Boolean / Mask | Edit · Expand / Release · Flatten |
| Page label | Rename · Duplicate page · Delete page · Set size ▾ · Export this page… |
| Layers row | Same as the element, plus Expand all / Collapse all |

## 9. Conveniences and feedback

| Convenience | Behaviour |
|---|---|
| Alt+drag | Duplicates the selection and drags the copy (Figma, Canva); the original stays; one undo step "Duplicate". |
| Smart duplicate spacing | After a Duplicate that was then moved, the next `Mod+D` repeats the same offset (Figma's smart duplicate); a short `+Δ` label shows for 400 ms. |
| Select same | Context menu › Select same ▾ (Fill, Stroke, Font, Kind) selects every match on the page. |
| Zoom to selection | `Shift+2`, the zoom menu, the pill's More. |
| Frame selection | `Mod+Alt+G` wraps the selection in a frame sized to it (Figma). |
| Double-click a value | Selects its content for typing. |
| Shift+scroll / wheel | Horizontal pan; `Mod+wheel` zoom about the pointer; trackpad pinch zooms. |
| Space+drag | Pan with any tool. |
| Escape ladder | Text editing → element selected → container left → nothing selected → tool back to Select. |

**Feedback for every action** (kit `status` toasts: bottom-centre above the command bar, 320 px max, 5 s, one action,
Escape dismisses, polite live region; stacked newest on top, max 3):

| Action | Feedback |
|---|---|
| Any canvas edit | Immediate render; the inspector updates; undo label visible in the overflow (`Undo: Resize headline`). No toast. |
| Delete of ≥ 5 elements, or a page | Toast "Deleted 12 elements · Undo". |
| Milestone | Toast "Milestone 'Milestone 2' created · Rename · View"; the Milestones tab shows a dot badge until opened; the save status flashes "● Milestone". |
| Save as template | Toast "Saved as template 'Night market' · Open Home"; Home lists it under Templates. |
| Export | Progress inside the dialog, then the file download and toast "Exported poster.png · Show in folder" (when the folder mirror is on). |
| Place / paste image | The image appears selected; no toast. Failures: toast with the `IF-LIB-*` fix text. |
| Clipboard copy | Toast "Copied" (1.5 s) only for Copy as SVG/text; internal copy is silent. |
| Template used / document created | Studio opens; the title field is focused for naming. |
| Errors (any `SfError`) | Toast with the error's `message` and `fix` as a link where it is a URL or action; never a bare code. |
| `Mod+S` | Toast "Instaflow saves automatically · Create milestone". |

## 10. Polish rules

### 10.1 Spacing and density tokens

Clean Pop sizes: toolbar 56, dock 236, inspector 264, pill items 28/34, fields 32–36, radius pill/18/12, gaps 8/10/14,
section padding 14. Focus removes the dock and inspector (rails 44); Pro adds rulers (20 px) and expands sections. No
region changes size on selection change; the selection pill and menus float.

### 10.2 Icon set

Clean Pop has no icons; today the UI shows glyph characters (`↖ # ▢ T ✒ ✋ ⋯`). Decision: **Lucide** (ISC licence,
`lucide.dev`, 1,500+ icons, 24 px grid, 2 px stroke, matches Geist's geometry; static SVG, tree-shakeable). Render at
16 px in rows and menus, 18 px in the tool picker, stroke 1.75. Alternatives considered: Phosphor (MIT, heavier set),
Tabler (MIT, 1.5 px stroke feels thin at 16 px). Use glyph text only for `✦` (the agent mark) and `⋯` is Lucide
`ellipsis`. Kind icons: frame → `frame`, group → `group`, rectangle → `square`, ellipse → `circle`, polygon →
`pentagon`, star → `star`, line → `minus`, path → `pen-tool`, image → `image`, text → `type`, repeat → `copy`,
boolean → `combine`, mask → `scissors`... use `layers` for mask. Licence text ships in Settings › About.

### 10.3 Motion

120–200 ms, `cubic-bezier(.2,.8,.2,1)`; pills and menus fade+rise 6 px in 120 ms; regions slide 160 ms; toasts 160 ms;
tooltips 80 ms fade after the 500 ms delay. Under `prefers-reduced-motion` (or the Settings override) everything is an
instant opacity change. Nothing animates during a drag.

### 10.4 Pre-launch look for M2 features

A feature that is not built is **not shown**, with three deliberate exceptions, each a single calm card with one
sentence and no controls: Settings › Assistant (§2.4), Home's "Chats" nav item (hidden; instead Home's hero says "Open
a blank canvas, or start from a template." and the assistant composer arrives with M2), and the Export dialog's
"Share" tab (hidden until it exists). No "coming soon" badges in Studio. Lenses follow §2.1.

### 10.5 No developer text

Forbidden anywhere a person can see: work-package ids (B1, C1, M2), density words as placeholders (`· pro`), capability
ids, error codes alone, "arrives with", "TODO", lorem ipsum. A test (`chrome.test.ts` style) greps rendered Studio and
Home text for `/\b(B\d{1,2}|C\d|M\d)\b|arrives with|TODO/`.

## 11. Accessibility

- Focus order: top bar → dock tabs → dock content → tool picker → canvas (one tab stop, roving inside) → selection pill
  → inspector → command bar → zoom. `Alt+Enter` jumps to the pill, `Escape` back to the canvas.
- Every control has a name; icon buttons use `aria-label` = tooltip text; shortcuts in `aria-keyshortcuts`.
- The canvas accessibility tree (B6) names elements by their Layers name and kind ("Headline, text"), announces
  selection changes politely, holds during drags, and announces commits by their undo label ("Resize headline").
- Menus and the pill are `toolbar` / `menu` with arrow navigation; dialogs trap focus and return it.
- Colour never carries meaning alone: hidden rows are also labelled "hidden", locks have icons, lens pills have
  shapes.
- Focus ring: 2 px `#CF3D17`, 2 px offset, on everything (README). The canvas focus ring sits on the canvas region.

## 12. Plumbing needed (where each piece lives)

| Need | Where | Notes |
|---|---|---|
| Canvas as the room: remove the inner white box, draw page cards with shadow and label, frame hairline + label in the overlay | `src/app/canvas-pipeline.ts` (overlay section), `src/tools/overlay.ts`, `src/studio/studio-element.ts` (canvas region CSS), `src/lenses/canvas-lens.ts` | Page card is render-side (projection), labels are overlay |
| Loose elements and re-parenting on drop | `src/tools/gesture.ts` (drop target), `src/elements/layout.ts` (`containerOf`), `src/lenses/structure.ts` | `structure.loose` exists |
| Export clipping rule and "outside the pages" line | C1 export dialog | |
| Delete / shortcuts active with a selection even when focus is on chrome | `src/app/studio-canvas.ts` (activate `CanvasToolsShortcutScope` while `if-studio` has focus and no text field is active, not only while the surface has focus) | Likely why Delete "didn't work" |
| Visible Delete, Duplicate, swatches in the pill; pill per kind; More menu with search | `src/spec/studio-spec.ts` (per-kind HUD tables keyed by `selectionFacts`), `src/studio/studio-element.ts` (pill placement near the selection, needs the selection's screen bounds from the view projection) | Replace the two-row bar |
| Rotate handle | `src/tools/transform.ts` (`ROTATE_HANDLE` below bottom-centre), `src/tools/overlay.ts`, `gesture.ts` | Keep corner zones |
| Clipboard | new `src/tools/clipboard.ts` (editor side: serialise subtree, paste ops with offsets) + `src/app/studio-canvas.ts` (DOM `copy`/`paste` events, async Clipboard API) + library ingest for images | capabilities `instaflow/copy`, `instaflow/paste`, `instaflow/paste-in-place` |
| Group / Ungroup / Frame selection | `src/elements/actions.ts` (`group`, `ungroup`, `frameSelection`) + capabilities + HUD/context entries | |
| Z-order | `src/elements/actions.ts` (`reorder`: forward / backward / front / back) + capabilities | document `order` exists |
| Lock / hide | `src/elements/actions.ts` (`setLock`, `setHidden`) over the `Lock` component and a `hidden` prop; render projection skips hidden | |
| Rename | `src/elements/actions.ts` (`rename`) + Layers inline field | `name` prop exists |
| Layers panel | new `src/elements/layers-panel.ts` (main, over a `LayersMirror` in `src/workers/mirrors.ts`) replacing the placeholder id `instaflow/layers` | tree from the kit (`tree.ts`) |
| Add page, duplicate page, delete page, page size | `src/lenses/story.ts` + capabilities | |
| Command palette | `src/studio/studio-element.ts` → kit `command-palette` over the capability registry; wire `if-command` in `src/app/studio-app.ts` | |
| Toasts | kit `status` + a `ToastsToken` in `src/app/studio-app.ts`; every `say()` that is a result becomes a toast | |
| Settings | new `src/settings/` (model, `<if-settings>`, route `/settings`, store doc `instaflow/settings`), opened from Home and Studio | M1: General, Shortcuts, Storage, About |
| View menu, density move, Export button, title rename, overflow menu | `src/studio/studio-element.ts` | |
| Contextual lenses | `src/studio/studio.ts` (lens availability from `structure` facts: images, motion, flows) | |
| Pen tool | new controller in `src/app/creation.ts` or `src/tools/pen.ts` | Hidden until then |
| Icons | `packages/kit` `icon` component wrapping Lucide SVGs; theme-coloured | |
| First-use hints, remembered tool stickiness, camera per document | `localStorage` keys under `instaflow/ui/*` | per device |
| No-developer-text test | `src/a11y/chrome.test.ts` sibling | |

## 13. Gap table (rule → today)

Status: **exists** · **partly** · **missing** · **visible but does nothing (VBDN)**.

| Rule | Status | Evidence |
|---|---|---|
| Whole dotted area is the canvas; page is a card | missing | `studio-element.ts` canvas region: opaque surface inside the dotted well; page drawn as an outline in the projection |
| Frames visible on white | missing | `creation.ts` frame fill `#ffffff`, no overlay outline or label |
| Draw anywhere (loose elements) | partly | `structure.loose` exists; creation parents to the page only (`creation.ts` `parent()`) |
| Tool picker labels and tooltips | missing | `studio-element.ts` renders `glyph` only; `shortcut` attr set but no tooltip component used |
| Pen tool | VBDN | `studio-contributions.ts` `T.pen` placeholder; no controller |
| Hand tool with Space | partly | `gesture.ts` hand exists; Space-pan missing |
| Selection pill near the selection, ≤ 6 items | missing | `studio-element.ts` `.hud` is a two-row toolbar at the top of the canvas region |
| Visible Delete / Duplicate | missing | only shortcuts (`canvas-shortcuts.ts`) |
| Delete works with focus on chrome | partly | `studio-canvas.ts` activates the canvas scope only while the surface has focus |
| Rotate handle | missing | `transform.ts` four invisible zones only |
| Skew / pivot visible affordance | partly | B10a: pivot only in transform mode |
| Clipboard | missing | no `copy`/`paste` anywhere in `apps/instaflow/src` |
| Context menu | missing | none |
| Z-order, group/ungroup, lock/hide, rename commands | missing | `elements/actions.ts` has none |
| Layers list | VBDN | `studio-contributions.ts` placeholder "Arrives with B1 · pro" |
| Chat panel | VBDN | placeholder "Arrives with M2 (Chat)" |
| Lens switcher shows only built lenses | VBDN | all five rendered; Pixel/Timeline/Flow specs mount with placeholder tools (`brush`, `heal`, …) |
| Assistant chip, ✦ Rewrite, ✦ Ask, Animate | VBDN | `studio-app.ts` `runHudAction`: no capability → speaks "arrives in a later milestone" |
| Command bar | VBDN | `studio-element.ts` emits `if-command`; `studio-app.ts` has no listener |
| Share | VBDN | `studio-app.ts` intents: `share` → `say('Sharing arrives with export (C1).')` |
| Milestone feedback | partly | runs, `say()` to the live region only, no toast; Milestones tab refreshes |
| Save as template feedback | partly | runs, live region only |
| Density switch explained | VBDN-ish | `sf-segmented` Focus/Standard/Pro, unlabelled; works |
| Inspector: sections per kind, no duplicate headings | missing | `studio-spec.ts` `STUDIO_SCOPE_PANELS` adds Transform/Appearance/Repeat for every selection; Typography is a lens panel; panel titles nest under section titles |
| Fill swatch resolved | partly | `inspector.ts` `swatchOf` resolves tokens through the kit; the shape's `@primary` resolves to black when the kit lacks it (`STUDIO_BRAND`) |
| Scrubbable numbers, units, mixed | partly | `transform-bar.ts` typed fields; no scrub, no units, no Mixed |
| Icons | missing | glyph characters everywhere |
| Toasts | missing | only the polite live region (`say`) |
| Settings | missing | none |
| View menu | missing | none |
| First-use hints | missing | none |
| Keyboard map in Help | partly | registry has descriptions; no Help surface |
| Pages: add / duplicate / delete page | missing | `story.ts` moves only |
| Accessibility tree, focus path, announcements | exists | B6 |
| Snapping, smart guides, nudge, marquee, Shift/Mod select | exists | B3 |
| Flip / skew / numeric bar / free transform | exists | B10a |
| Repeats, booleans, masks, align, distribute, tidy | exists | B1, B7 (reachable only from the two-row bar) |
| Milestones, compare, new document, templates | exists | B5, C0 |
| Export | in progress | C1 |

## 14. Open questions for the owner (with recommendations)

1. **Rotate affordance style.** Recommend a visible handle 24 px below the selection on a stem (Canva/Keynote) **plus**
   Figma's corner zones; angle pill while rotating. Alternative: zones only with a hover cursor (Figma) — rejected for
   first-timers.
2. **Do CI end-to-end tests run both worker topologies on every PR?** Today `.github/workflows/ci.yml` runs no Playwright
   smoke at all; the smoke scripts exist (`test/smoke/`, both topologies) but only locally. Recommend: run the Studio
   and Home smoke on every PR in **both** topologies (colo and split) on SwiftShader, and the F-xx flows marked M1
   must-pass as that suite. Cost ≈ 6–8 min; worth it, since D15 makes topology a boot setting that only e2e exercises.
3. **Default density.** Recommend Standard (layers + inspector visible). UX.md said Focus for new users; the owner's run
   shows people need to see the layers and the inspector to understand the model.
4. **Where density lives.** Recommend the View menu + Settings, not the top bar.
5. **Share → Export.** Recommend renaming the primary button to Export when C1 lands and hiding it until then; Share
   returns as a tab in the Export dialog with Releases (D10).
6. **Assistant colour.** Recommend keeping raspberry as the *agent role* colour for any provider, with the provider's
   name as text. Alternative: a neutral role colour and vendor marks — rejected (brand noise, and "no purple anywhere"
   shows the owner wants one accent).
7. **Lens visibility.** Recommend Canvas + Pages always, Pixel / Timeline / Flow appearing with content (§2.1). The
   alternative (all five always, greyed) violates principle 1.
8. **Frame default look.** Recommend white fill + non-printing hairline and label. Alternative: a mist default fill —
   rejected because exports would carry it.
9. **Default shape fill.** Recommend bright tangerine `#FF5C39` (the lens/shape colour) resolved from `@primary`, with
   the inspector showing the resolved hex. Alternative: a neutral grey like Figma — fine for designers, dull for
   first-timers.
10. **Icon set licence.** Recommend Lucide (ISC). Confirm that ISC attribution in Settings › About is acceptable.

## Appendix A. Live vs placeholder inventory (today's `main`)

Status: **works** · **works, silent** (runs with no visible feedback) · **does nothing** · **not built** (placeholder
text). Action = what this spec does with it in M1.

### Home (`/`)

| Control | Status | Action |
|---|---|---|
| Logo / wordmark | works (link) | keep |
| Nav: Home | works | keep |
| Nav: Chats | not built | hide until M2 |
| Nav: Files | works (lists designs) | keep |
| Nav: Brand kits | not built | hide until M2 |
| + New design | works | keep |
| Hero composer (prompt, Attach, Brand, Claude chip, Start making) | not built (design only; C0 shows formats) | M1 hero: "What are you making?" format cards; composer returns in M2 |
| Quick actions (one per format) | works | keep; M2 adds capability quick actions |
| Jump back in (recents) | works | keep; add thumbnails when the projection cover lands |
| Templates | works (after Save as template) | keep |
| Settings gear | missing | add (§2.4) |

### Studio (`/s/:asset`)

| Control | Status | Action |
|---|---|---|
| Logo → Home | works | keep (flushes Latest) |
| Breadcrumb project | design only | hide in M1 |
| Design title | works (text only) | make it rename inline |
| Lens: Canvas, Pages | works | keep |
| Lens: Pixel, Timeline, Flow | does nothing useful (mounts placeholder tools) | hide until the lens exists (§2.1) |
| Save status | works | add tooltip + click → Milestones |
| Claude · Ask chip | does nothing | hide in M1 (§2.2) |
| Density Focus / Standard / Pro | works, unexplained | move to View menu + Settings |
| Milestone | works, silent | toast + badge + name field focus |
| Save as template | works, silent | move to overflow; toast |
| Share | does nothing (speaks "arrives with export") | hide; becomes Export with C1 |
| Chat side panel | not built | hide in M1 |
| Dock: Layers | not built | build (§3.1) |
| Dock: Pages | works (show, reorder) | add add/duplicate/delete |
| Dock: Assets | works (import, place) | keep; add drag to canvas |
| Dock: Milestones | works | keep |
| Tool: Select | works | keep + tooltip |
| Tool: Frame | works (white, invisible on page) | keep + overlay outline/label |
| Tool: Shape | works (rectangle only) | keep + shape menu (ellipse, polygon, star, line) |
| Tool: Text | works | keep + tooltip |
| Tool: Pen | does nothing | hide until built |
| Tool: Hand | works | keep + Space-pan |
| HUD: ✦ Rewrite | does nothing | hide in M1 |
| HUD: Animate | does nothing | hide in M1 |
| HUD: ✦ Ask | does nothing | hide in M1 |
| HUD: Radial / Grid / Mirror repeat | works | pill More / Repeat group |
| HUD: Align ×6, Centre in container, Distribute ×4, Tidy up | works | pill Align ▾ / Distribute ▾ |
| HUD: Union / Subtract / Intersect / Exclude | works (multi) | pill Combine ▾ |
| HUD: Use as mask, mask modes, invert, release | works | pill / More |
| HUD: Font, Size, Fit to box | works for text only; shown for shapes | text pill only |
| HUD: Flip H/V, Rotate 90°, Free transform (More) | works | More |
| HUD: Apply token | works (needs a kit) | More › Style |
| HUD: Describe | works (speaks) | More › Describe |
| Inspector: Typography | works for text; shown always | text only |
| Inspector: Transform (X Y W H angle skew flip) | works; duplicate heading | fix heading; scrub; units |
| Inspector: Fill / Stroke / Effects / Opacity | works; swatch wrong for `@primary` | resolve tokens |
| Inspector: Repeat | works for repeats; shown always | repeats only |
| Zoom − / value / + | works | add menu |
| Command bar | does nothing | command palette in M1 |
| Delete / Backspace | works only with canvas focus | fix scope |
| Mod+D, Mod+Z, Mod+Shift+Z | works (same caveat) | keep |
| Copy / Paste / Cut | missing | build |
| Right-click | browser menu | build |
