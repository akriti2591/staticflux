# Instaflow UX foundations (Layer 1)

> Status: **normative.** The shared vocabulary and building blocks every surface spec (Layer 2: `STUDIO-UX-SPEC.md`,
> `HOME-FILES-UX-SPEC.md`, `CHAT-UX-SPEC.md`) composes and never redefines, and every flow (Layer 3: `FLOWS.md`)
> exercises. Visual source: the approved **Clean Pop · final** (`docs/instaflow/design/README.md`,
> `Components.dc.html`). Each block ends with **Code**: the `@staticflux/*` piece or Instaflow module that implements it,
> or **missing** with where it belongs (StaticFlux = generic, Instaflow = app-specific). §6 collects that mapping.
> Two sibling Layer-1 files hold the primitives in depth: `OVERLAYS-FEEDBACK.md` (overlay system, dialogs and sheets,
> feedback and errors, tooltips, hints) and `NAVIGATION-DEEPLINKS.md` (the URL scheme, history, fallbacks, copy link).
> §4.8–4.11 and §4.21–4.23 below are their summaries.

## 1. Principles

1. **Nothing visible is inert.** A control that renders works now; otherwise it is not rendered. Unbuilt features get the
   *Coming* pattern (§5.6), never a fake control.
2. **The canvas is the room; the page is a card in it.** Drawing, dropping and pasting work anywhere.
3. **Visible first, hidden second.** Every action has a visible home; shortcuts and gestures accelerate it.
4. **Name everything you press.** Accessible name on every control, tooltip (name + shortcut) on every pointer control.
5. **Contextual beats global.** The selection decides what shows; irrelevant sections are not rendered.
6. **Every commit names itself and can be undone.** One gesture = one labelled undo step; non-local actions confirm with a
   toast carrying Undo or the next step.
7. **Calm by default, dense on demand.** Standard density is the default; regions never jump; floating things never push
   the canvas.
8. **Conventions before invention.** Figma for manipulation and layers, Canva for discoverability, Keynote for rotate,
   Illustrator for repeats and booleans, Framer for menus. Invent only where Instaflow differs and say so.

## 2. Vocabulary

| Term | Means | Not |
|---|---|---|
| **Design** | A document a person makes: pages, elements, a thread, milestones. Library kind `composition`. | "file" in UI copy ("design" everywhere a person reads) |
| **Template** | A design saved with slots to start others from. Kind `template`. | |
| **Asset** | Anything in the library: designs, templates, media (image, video, audio, font). Internal word; UI says the kind. | |
| **Media** | Images, video, audio, fonts in the Assets tab. | |
| **Project** | A folder path grouping designs (one level in M1). | "folder" (reserved for the real disk folder) |
| **Workspace** | Everything in this browser profile (or the disk folder it mirrors). | |
| **Canvas** | The infinite mist surface of Studio (the room). | the page |
| **Page** | A white card on the canvas with a fixed size; export unit; story unit. | a frame |
| **Frame** | An element that holds and clips children. | a page |
| **Element** | Anything on a page or loose on the canvas: shape, text, image, frame, group, repeat, boolean, mask. | "layer" (UI word for a Layers row) |
| **Loose element** | An element on the canvas outside every page. | |
| **Selection** | The set of elements (or a page, a text range, a repeat instance) actions apply to. | focus |
| **Container** | A frame or group the person entered (double-click) so clicks hit its children. | |
| **Lens** | A way of editing the same document (Canvas, Pages; later Pixel, Timeline, Flow). D4/D19. | mode, tab |
| **Tool** | A pointer behaviour in the tool picker (Select, Frame, Shape, Text, Pen, Hand). | |
| **Capability** | A typed, gated action with an id, callable by people, the palette and agents (D18). | |
| **Action** | A capability as a person sees it (a pill item, a menu row). | |
| **Latest** | The continuously saved state (D2). UI: "Saved". | "draft", "autosave" |
| **Milestone** | A named, immutable snapshot (D2). | "version", "save" |
| **Export** | A file rendered from a frozen snapshot (PNG, PDF, SVG, .iflow). | "share", "publish" (Release, D10) |
| **Assistant** | The configured model provider acting in the document (D13). | a vendor name in copy, unless configured |
| **Proposal** | A change set from the assistant awaiting Accept / Reject. | |

Naming rules for UI text: sentence case; verbs for actions (`Move to trash`, not `Trash`); the thing's name in
confirmations (`Deleted 'Night market'`); numbers with a thin space before units (`1 080 × 1 350`); never ids, codes or
work-package names.

## 3. Layout primitives

### 3.1 Surfaces and regions

| Region | Where | Size (Standard) | Notes |
|---|---|---|---|
| Top bar | top of Studio / Home | 56 px (Studio), 64 px (Home) | `#F1F4F7`, hairline bottom; landmark `banner` |
| Dock | left of the canvas | 236 px; rail 44 px in Focus | `#FFFFFF`, hairline right; tabs on top; landmark `complementary` |
| Side panel | left of the dock (Chat, M2) | 288 px | `#F1F4F7` |
| Canvas | centre | flexible | `#E4E9EF` + 20 px `#C3CCD7` dot grid; landmark `main` |
| Inspector | right | 264 px; rail 44 px in Focus | `#FFFFFF`, hairline left; `complementary` |
| Tray | bottom (Timeline, M2) | 200–320 px, resizable | |
| Floating bars | over the canvas | tool picker (top-centre), selection pill (near selection), zoom (bottom-left), command bar (bottom-centre) | white pills with the floating shadow; never push the canvas |
| Page column | Home / Files / Settings | 1180 px centred, 28 px side padding | |

Regions have fixed sizes per density; they resize only by the person (dock splitter) and never because of the
selection. **Code:** `@staticflux/kit/dock` (`<sf-dock>` splitter, rail, collapse), `@staticflux/shell` slots and
`shell/spec` (regions filled from the editor spec), Instaflow `src/studio/studio-element.ts` (the Studio frame).

### 3.2 Density

Three levels, remembered per device, default **Standard**. Each has a one-line explanation wherever it is chosen:

| Density | One line | Effect |
|---|---|---|
| Focus | Just the canvas. Panels open when you need them. | Dock and inspector collapse to rails; a rail click opens a floating 236 px card until the next canvas click. |
| Standard | Canvas with layers and the inspector. | Docked panels; inspector sections with the essentials; no rulers. |
| Pro | Everything at once, with rulers and numbers. | Rulers, every section expanded, shortcut hints in tooltips and menus, split dock. |

Switching animates regions (160 ms) and re-centres the camera so the page stays put on screen. **Code:**
`@staticflux/ui/theme` (`data-sf-density`, per-density tokens), `shell/spec` (`minDensity` collapse), Instaflow `studio.ts`
`setDensity`. The explanation copy and the View-menu placement are **missing** (Instaflow `src/studio`).

### 3.3 Spacing, radius, type

4 px grid; gaps 2 (segments) · 6 · 8 · 10 · 14 (section padding) · 16 · 24 · 36 · 44; radii: pill (`radius.control`) for
anything pressed, 18 px cards (`radius.lg`), 12 px fields and previews (`radius.md`), 22 px composers; type: Bricolage
Grotesque 700–800 for titles, Geist 13–15 for UI, Geist Mono 11–12 for values, codes and tokens; section headings 11 px
uppercase `#56606C` tracking 0.06 em. **Code:** `apps/instaflow/src/theme/clean-pop.ts` over `@staticflux/ui/theme`.

### 3.4 Breakpoints

Studio is desktop Chrome (D1): ≥ 1280 px full layout; 1024–1279 the inspector collapses to a rail by default; < 1024
the dock too (Focus). Home: 4 columns ≥ 1180, 3 ≥ 900, 2 below. No mobile layout. **Code:** CSS in the Instaflow
elements; **missing** for the 1024 rule (Instaflow `studio-element.ts`).

## 4. Controls

Each block: purpose · anatomy · states · behaviour and keyboard · sizes per density · motion · accessibility · do/don't ·
code. States not listed are not applicable. Common to all: focus-visible is a 2 px `#CF3D17` ring at 2 px offset;
motion 80–160 ms on opacity/transform only, 0 under reduced motion; colours only from theme tokens.

### 4.1 Button

Purpose: run one action. Anatomy: pill, label, optional leading icon or lens shape, optional `kbd`. Variants ×
sizes 42 / 34 / 28: **Primary** (`#CF3D17`, white; one per surface), **Agent** (`#D6265F`), **Agent soft**
(`#FDE8EF`/`#B3174C`), **Secondary** (white, control edge), **Ghost** (transparent), **Danger** (dialogs only).
States: rest · hover (secondary/ghost: `#E7ECF2` fill; primary: 8 % darker) · pressed (`#DCE3EA`; primary 14 %
darker) · pressed-on `aria-pressed` (soft tangerine `#FFE9E2` / `#B53A17`) · disabled (60 % opacity, dialogs and forms
only; pills and menus hide instead) · loading (label dimmed, inline spinner, `aria-busy`) · focus. Keyboard: Enter,
Space. Sizes: lg 42 (Home primary), md 34 (top bar), sm 28 (toolbars, pills); same at every density. Motion: 80 ms
background. Do: one primary per surface. Don't: disable to explain; use text glyphs. **Code:** `@staticflux/kit/button`.

### 4.2 Icon button

Purpose: an action shown by its icon only. Anatomy: round, 34 px (tool picker, top bar) or 28 px (pills, rows), a
16–18 px icon, tooltip. States as Button; **selected/active** is the soft tangerine pill (the owner's kept pattern);
sticky adds a 4 px `#CF3D17` dot below. Keyboard: as Button; arrows inside toolbars. Accessibility: `aria-label` =
tooltip text, `aria-keyshortcuts`, `aria-pressed` for toggles. Don't: ever ship without a tooltip. **Code:**
`@staticflux/kit/icon-button` (+ `tooltip`). The icon itself: §5.9.

### 4.3 Switcher (segmented)

Purpose: choose one of 2–6 options (lens, dock tabs, nav, density, mask mode). Anatomy: mist track `#E7ECF2`, 3 px
padding, options as sm pills; the selected one white with the raised shadow; options may carry a lens shape. States:
rest · hover (option text to ink) · selected · disabled (whole group) · focus. Keyboard: arrows move, Home/End; APG
radio group (`aria-pressed` for the lens group, tabs role for dock tabs). Motion: the white pill slides 120 ms. Do:
labels on every option. Don't: icons only. **Code:** `@staticflux/kit/segmented`, `kit/tabs`.

### 4.4 Field

Purpose: type a value. Anatomy: 34–36 px (32 px in the inspector), 12 px corners, white, control edge, label above
or hidden (`label-hidden` with an accessible label), optional hint and error line, unit suffix muted inside. States:
rest · hover (edge to ink) · focus (ring) · invalid (edge `#CF3D17`, error line below, `aria-invalid`) · disabled ·
loading (`aria-busy`). Keyboard: Enter commits, Escape restores, Tab commits and moves. Don't: placeholder as the only
label. **Code:** `@staticflux/kit/text-field`.

### 4.5 Scrubbable number

Purpose: numbers you can type or drag (X Y W H, angle, size, radius, count, opacity). Anatomy: a Field in Geist Mono
with a unit suffix (`px` `°` `%`), a label that is also a drag handle (cursor `ew-resize`), optional link toggle for
pairs. Behaviour: drag on the label ±1 per 2 px, Shift ×10, Alt ×0.1, live preview, one commit on release; typing
accepts expressions (`+10`, `*2`, `50%`) and units (`2in`); ↑/↓ step 1, Shift ×10; double-click selects all;
`Mixed` placeholder when a multi-selection disagrees (typing sets all, scrubbing adds the delta to each). Values clamp
(W/H ≥ 1, angle to (−180, 180]). Do: show units in the field, not in the label. **Code:** **missing** — belongs in
**StaticFlux `@staticflux/kit`** as `<sf-number-field>` (generic: units, expressions, scrub, mixed). Instaflow's
`src/tools/transform-bar.ts` has typed fields only (`parseNumber`, `formatNumber`).

### 4.6 Colour field and swatch

Purpose: pick a colour or brand token. Anatomy: a 16 px round swatch (hatched when unresolved), the value as a mono
token tag (`@cream`) and hex, an opacity number; the popover: hex field, eyedropper (when the browser has
`EyeDropper`), brand tokens row, recent colours, opacity slider, `Detach from token`. States: rest · hover · open ·
invalid hex · unresolved token (hatched swatch + "Token @primary is not in this brand kit · Replace with #FF5C39").
Keyboard: Enter opens, arrows in the token row, Escape closes. Do: show the resolved colour. Don't: native
`<input type=color>` as the UI. **Code:** `@staticflux/kit/color-field` (hex + native picker only) — the popover with
tokens, recents and opacity is **missing**: generic parts (popover, recents, eyedropper) in **StaticFlux kit**; the
brand-token row in **Instaflow** `src/elements/panel.ts`.

### 4.7 Slider

Purpose: a bounded value with feel (opacity, warmth, smooth corners). Anatomy: 4 px `#C3CCD7` track, `#CF3D17` fill,
18 px white thumb with a 2 px tangerine ring, value in a mist mono pill. States: rest · hover (thumb ring 2.5 px) ·
dragging · disabled · focus. Keyboard: arrows 1 step, Shift 10, Home/End. **Code:** `@staticflux/kit/slider`.

### 4.8 Menu and context menu

Purpose: a list of actions. Anatomy: white card 12 px corners, floating shadow, 32 px rows with a 16 px icon, label,
right-aligned `kbd`, dividers, group headings (11 px uppercase), one level of submenu (`▸`), checkbox / radio rows; a
**searchable** variant adds a filter field on top (the More menu). Rows that do not apply are **not shown** (never
disabled). Opens on click / Enter / Space / `Shift+F10` / right-click (context) at the pointer; typeahead; Escape closes
and restores focus; an outside click closes **and is consumed**. Layer 3 of the overlay system. Full rules (nesting,
Escape order, light dismiss, positioning, roles): `OVERLAYS-FEEDBACK.md` §1. **Code:** `@staticflux/kit/menu`,
`kit/position`. **Missing:** submenus, group headings, the filter field, the consumed-click option (StaticFlux kit); the
canvas context-menu trigger (Instaflow `src/app/studio-canvas.ts`).

### 4.9 Popover and tooltip

Popover: a non-modal anchored card (colour popover, font picker, alignment, milestone form, access menus), 12 px
corners, 14 px padding, focus moves in when it has a field and returns on close; it may open one menu and **never**
another popover (it expands or swaps in place); a popover from the HUD or inspector closes on an outside click **and
lets the click through** (Canva). Tooltip: `role=tooltip`, 500 ms then a 300 ms warm period, name + `kbd` at every
density, the reason when disabled, never essential, never interactive, one at a time. Full rules: `OVERLAYS-FEEDBACK.md`
§1 and §4; the colour popover and font picker: `STUDIO-UX-SPEC.md` §4.2.5–4.2.7. **Code:** `@staticflux/kit/popover`,
`kit/tooltip`, `messaging` arbitration. **Missing:** pass-through dismiss, warm period, disabled-reason composition
(StaticFlux kit); `<sf-color-popover>`, `<sf-font-picker>`, `<sf-align-popover>` (StaticFlux kit, data from Instaflow).

### 4.10 Feedback: toast, banner, inline, blocking

One hierarchy: inline field error → section / panel error → **toast** → persistent **banner** → blocking full-surface
error; the lowest level the situation allows, and one place per error. Toast: bottom-centre above the command bar, ≤ 420
px, 18 px corners, newest at the bottom, max 3, 5 / 8 / 10 s or sticky, paused on hover, one action (`Undo`, `Open`,
`View`, the `fix`), polite live region. Banner: a 40 px in-flow bar at the top of the region for a lasting condition
(offline when needed, storage full, read-only, worker restarting). Blocking: one calm card with the fix, `Copy
diagnostics`, `Reload`. `SfError` maps mechanically: `message` is the line, `fix` the button or link, `code` never shown.
Inline feedback: a status line, an inline confirm row, `<sf-status>`. Every non-local action gets a toast (§5.3). Full
rules, progress, retry, offline, crash recovery and the error-copy rules: `OVERLAYS-FEEDBACK.md` §3. **Code:**
`@staticflux/messaging` + `kit/surfaces` (`<sf-toast>`), `kit/status`, `shell` `<sf-boundary>`, `core` `SfError`.
**Missing:** `<sf-banner>`, `<sf-blocking-error>`, toast pause and count (StaticFlux); the error → level adapter,
`ToastsToken` wiring and recovery (Instaflow `src/app/feedback.ts`, `src/app/recovery.ts`).

### 4.11 Dialog, sheet and takeover

Types: confirm (rare), destructive (`alertdialog`, focus on Cancel), form (holds changes until its verb), multi-step
wizard (steps inside one dialog, back chevron, sliding body), full-screen takeover (milestone preview, Compare, the
blocking error), sheet (non-modal side panel, M2). Native `<dialog>`, 22 px corners, heading (Bricolage 20), actions
right-aligned with one primary, focus trap and return, Escape closes (or steps back), backdrop click only for
non-destructive dialogs with nothing held. **One modal at a time; a dialog never opens over a dialog**: confirmations
are inline rows, sub-tasks are steps. Routable dialogs (`/d/export`, `/d/share`, `/d/settings`) push history when opened
in-app and replace when deep-linked. Only Export, Settings, the two takeovers and the blocking error are dialogs in M1
Studio. Full rules and the worked Share and Milestones flows: `OVERLAYS-FEEDBACK.md` §2. **Code:** `@staticflux/messaging`
(`defineSurface kind: dialog|sheet`, routable bridge), `@staticflux/kit/surfaces` (`<sf-dialog>`), `@staticflux/a11y`
traps. **Missing:** the wizard step frame, takeover frame and inline confirm row (StaticFlux kit); Export, Settings,
preview and Compare (Instaflow).

### 4.12 Tabs and dock panels

Dock tabs are a Switcher; each tab panel is a `<sf-panel>` with its own header actions; the dock has a splitter and a
rail state with icons + tooltips. **Code:** `@staticflux/kit/tabs`, `kit/dock`.

### 4.13 Tree and list (Layers, Pages, files list)

Purpose: hierarchical or flat rows you select, rename, reorder. Anatomy: 30 px rows (44 px in file lists), 14 px
indent per level, chevron, 16 px kind icon, name (ellipsis), trailing mono tag, hover-revealed row actions
(Hide, Lock, `⋯`), selection as the soft tangerine pill, insertion line 2 px `#CF3D17` and container highlight while
dragging. States per row: rest · hover · selected · multi-selected · hidden (50 %) · locked (lock icon) · dragging ·
drop-target · renaming · focus. Keyboard: ↑/↓, Home/End, ←/→ collapse/expand, Alt+click expands all, Enter activates
or renames (Layers), Space toggles selection, Shift/Mod extend, Alt+↑/↓ reorders, Delete, typeahead. Virtualised
beyond 200 rows. **Code:** `@staticflux/kit/tree` (virtualised APG tree with reorder, drag hooks, `canDrop`).
**Missing:** row actions slot and inline rename in the tree (StaticFlux kit); the Layers data (Instaflow
`src/workers/mirrors.ts` + a layers panel).

### 4.14 Card (design, template, project, quick action)

Anatomy: 18 px corners, white, hairline, raised hover shadow, thumbnail 158 px (12 px corners inside), tag top-left
(lens or `Template`), title 600, meta line, a `⋯` icon button revealed on hover/focus top-right, optional star.
Whole card is one link (`href`), modified clicks stay the browser's. States: rest · hover (shadow + `⋯`) · pressed ·
selected (checkbox, soft tangerine edge) · dragging (90 % scale, 80 % opacity) · drop-target (project cards) · focus ·
loading (skeleton) · error (muted "Couldn't load · Try again"). **Code:** `@staticflux/kit/card`. **Missing:** the
menu button slot, selection checkbox and drag states (StaticFlux kit); the design card itself (Instaflow `src/home`).

### 4.15 Empty, loading and error states

Empty: one line (13 px muted) and at most one action, inside the region, no illustration in M1. Loading: skeleton
lines (`<sf-skeleton>`) for ≥ 300 ms waits, never a spinner for local data. Error: the error's `message` + `fix`
(as a link or button) + `Try again`; regions are error boundaries. **Code:** `@staticflux/ui` `<sf-skeleton>`,
`@staticflux/shell` `<sf-boundary>`, `core` `SfError.fix`.

### 4.16 Command palette

Purpose: find and run any capability by name. Anatomy: the bottom-centre pill (Studio) or a dialog (Home), filter
field, grouped results with icon, title, shortcut; recents first when empty; Enter runs the top result on the
selection; results that cannot run now are hidden. **Code:** `@staticflux/kit/command-palette` (`<sf-capability-palette>`
over `CapabilityRegistryToken`, `Mod+K`). **Missing:** Instaflow wiring from the command bar (`if-command` → palette).

### 4.17 Drag and drop

Slop 4 px (canvas) / 6 px (lists); the dragged thing follows at 100 % (canvas) or as a ghost (lists, cards); drop
targets highlight `#CF3D17` (container outline, insertion line, project card edge); Escape cancels and restores;
one undo step on drop. External files dropped on the canvas or Assets import then place. **Code:** `kit/tree` drag
hooks and `treeDragMachine`; canvas gestures Instaflow `src/tools/gesture.ts`. **Missing:** file drop on the canvas
(Instaflow `src/app/studio-canvas.ts`), card drag to projects (Instaflow `src/home`).

### 4.18 Selection models

Single (click), multi (Shift toggles, Mod deep-selects, Mod+A all in the container), range (Shift in lists; text
ranges), marquee (drag on empty canvas, `touch` mode; Alt for contain). The selection is announced politely
("Rectangle, 1 of 4 selected"). Containers: double-click enters, Escape leaves. **Code:** Instaflow `src/tools`
(`view-state.ts`, `hit-test.ts`, `gesture.ts`), `src/a11y` announcer.

### 4.19 Inline rename

A field appears over the name with the text pre-selected; Enter saves, Escape cancels, blur saves; empty is refused
inline ("A name is required"); one undo step; toast with Undo for files. Triggers: double-click the name, Enter on a
focused row (Layers) / `F2` on Windows, `Mod+Shift+R`, menu `Rename`. **Code:** **missing** — a generic
`<sf-inline-edit>` belongs in **StaticFlux kit**; the rename capabilities in **Instaflow** (`elements/actions.ts`,
`home/capabilities.ts`).

### 4.20 Tag and chip

Tags are 24 px non-pressable pills: mist (info), raspberry-soft (agent), solid lens colour (kind), mono (tokens,
codes). Pressable suggestions are small secondary buttons, never tags. **Code:** `@staticflux/kit/tag`.

### 4.21 Contextual HUD (the selection pill)

A floating `toolbar` near the selection showing the **top six controls of the selection kind** plus `⋯`; the inspector
shows all of them. Both are projections of **one control model** (a control declares its fact, capability, label, icon,
shortcut, inspector section and HUD rank once), share the colour popover, font picker and alignment popover, and never
hold logic of their own. Hidden during gestures, frozen while one of its popovers is open, hidden when the selection is
off-screen. Layer 1 of the overlay system. Contents per selection kind and the popovers: `STUDIO-UX-SPEC.md` §4.2.
**Code:** `kit/toolbar` (roving, overflow), `kit/position`. **Missing:** the control model and HUD projection
(Instaflow `src/spec/controls.ts`); pill placement from the selection's screen bounds (Instaflow
`src/studio/studio-element.ts`).

### 4.22 First-use hint and coach mark

Instaflow uses **first-use hints** only (one sentence, anchored to a tool or region, seen once per device, never
blocking, at most two per session, suppressed during drags, modals and deep-linked arrivals; `Show first-use hints` and
`Reset hints` in Settings › General) and **no tours**. Empty states carry the teaching otherwise (§4.15). Full rules:
`OVERLAYS-FEEDBACK.md` §5. **Code:** `@staticflux/messaging` coach-mark surfaces (`target`, `once`, seen store).
**Missing:** `<sf-hint>` card (StaticFlux kit); the seen-store adapter, session cap, Settings switch and copy
(Instaflow `src/studio/hints.ts`).

### 4.23 Deep links and copy link

Every addressable state has one URL: paths for resources (surface, design, milestone, dialog), query for the place
within (lens, page, dock, selection and inspector intents, dialog step), nothing for the camera. Escape dismisses, Back
navigates; routable dialogs push in-app and replace from a link; missing targets fall back one level with a neutral
toast. `Copy link to this` on the design, the selection, a page, a milestone, a dialog, a thread. The scheme, history
and fallback rules: `NAVIGATION-DEEPLINKS.md`. **Code:** `@staticflux/router` routes and dialogs, `@staticflux/urlstate`
view bindings, intents and `/d/<key>`, `messaging` routable bridge. **Missing:** the rest of the routes, the URL contract,
intents, copy-link capability and the not-found page (Instaflow `src/home/routes.ts`, `src/app/url*.ts`, `src/app/links.ts`).

## 5. Patterns

### 5.1 Progressive disclosure

Standard shows the essentials; `More ▾` rows, collapsed sections (▸) and the `⋯` menu hold the rest; Pro expands.
Nothing hidden is unreachable by keyboard. Sections remember their collapsed state per device.

### 5.2 Contextual vs global actions

Contextual actions (on *this* selection) live in the selection pill, the context menu and the inspector; global actions
(document, view, app) live in the top bar, View menu, overflow and palette. An action never appears in both as a
different thing; the palette lists everything.

### 5.3 Feedback for every action

Within one frame: hover, press, drag, snap, value change. On commit: the render and the inspector update, the undo
label changes (`Undo: Resize headline` in the overflow). Non-local or invisible results get a toast: milestone,
template, export, moves between projects, trash, bulk deletes, clipboard to other apps, errors. Silent: ordinary edits,
selection, internal copy, favourites.

### 5.4 Undo everywhere

Every change is an undo step with a label; 200 steps per actor, persisted (D9). `Mod+Z` is the person's undo;
assistant steps undo from their chip. Destructive file operations use **Undo in a toast** instead of confirmation when
reversible within 30 days (trash); only irreversible ones (Delete forever, Empty trash) confirm inline.

### 5.5 Destructive actions

Reversible → do it, toast with Undo. Irreversible → inline confirm row in place (`Delete forever? · Delete ·
Cancel`), danger button, never a modal. Never a browser `confirm()`.

### 5.6 Coming (unbuilt features)

Not rendered, with exactly three allowed exceptions, each a single calm card with one sentence and no controls:
Settings › Assistant, the Export dialog's Share tab (hidden until it exists), and Home's hero line before the composer
exists. No "coming soon" pills, badges or greyed buttons. Lenses appear with content (Studio §2.1).

### 5.7 Keyboard map conventions

`Mod` = ⌘ / Ctrl. Single letters select tools, never while typing. Browser-reserved combos are never bound: `Mod+T`,
`Mod+W`, `Mod+N`, `Mod+Shift+T/N/W`, `Mod+Shift+]/[` (Mac tab switch), `Mod+R`, `Mod+L`; fallbacks are chosen with
`Mod+Alt`. Every shortcut has a visible home (menu row or tooltip) and appears in Help (`?`) and Settings › Shortcuts.
Conflicts are a CI error (`checkShortcuts`). **Code:** `@staticflux/a11y` shortcuts (`RESERVED_COMBOS`, scopes,
`checkShortcuts`), Instaflow `src/tools/keyboard.ts`, `src/app/canvas-shortcuts.ts`. **Missing:** a Help surface.

### 5.8 Clipboard conventions

Internal format plus SVG and plain text on copy; paste offsets +24/+24 on the same page, same coordinates elsewhere,
`Mod+Shift+V` in place; images from other apps import then place; text pastes as a text element or at the caret.
Permission refusals toast with the fix. **Code:** **missing** (Instaflow `src/tools/clipboard.ts` + the DOM bridge).

### 5.9 Icons (one set)

One set, one outline style everywhere: **Lucide** (ISC), 24 px grid, 2 px stroke, round caps. No emoji, no text
glyphs (`✦` as text beside a label is the only typographic mark). Custom icons for gaps (booleans, masks, skew, pivot,
repeat kinds, shadow, corner, text box modes) are drawn on the same grid in `packages/kit/src/icons/custom/`. Packaged
as per-icon modules rendered inline by `<sf-icon name>` with `currentColor`, tree-shaken; sizes 16 (rows, menus,
inspector), 18 (icon buttons), 24 (cards, empty states); Pro adds shortcut text, never bigger icons. Lens colours and
shapes stay accents on tags and the lens switcher. Full rules: `STUDIO-UX-SPEC.md` §10.2. **Code:** **missing** —
`<sf-icon>` and the icon modules belong in **StaticFlux kit**; the kind → icon table in **Instaflow**.

### 5.10 Motion and reduced motion

120–200 ms, `cubic-bezier(.2,.8,.2,1)`, compositor properties only; pills and menus fade + rise 6 px in 120 ms;
regions 160 ms; toasts 160 ms; tooltips 80 ms after 500 ms; nothing animates during a drag. Reduced motion (OS or
Settings): instant opacity changes only; `busy` pulses stop. **Code:** `@staticflux/ui/theme` `motion.*` tokens,
`@staticflux/a11y` preference facts, `shell` `withViewTransition`.

### 5.11 Writing style for UI text

Sentence case; short verbs; the object named; no jargon from the codebase; "assistant" or the provider's name; errors
as "what happened · what to do"; numbers in Geist Mono where they are values; British spelling as the codebase uses
(colour, centre, favourite); never exclamation marks. Developer text (work-package ids, density words as placeholders,
"arrives with", capability ids, TODO) is a bug caught by a chrome text test. **Code:** `@staticflux/i18n` messages per
feature (`kitMessages`, `studioMessages`, `homeMessages`); the forbidden-text test is **missing** (Instaflow `src/a11y`).

## 6. Block → code map

| Block | StaticFlux piece | Instaflow piece | Missing (where) |
|---|---|---|---|
| Regions, docks, rails | `kit/dock`, `shell` slots, `shell/spec` | `src/studio/studio-element.ts` | 1024 px rule (Instaflow) |
| Density | `ui/theme` density tokens, `shell/spec minDensity` | `src/studio/studio.ts` | explanations + View menu (Instaflow) |
| Button | `kit/button` | — | — |
| Icon button | `kit/icon-button` + `kit/tooltip` | — | `<sf-icon>` (StaticFlux kit) |
| Switcher / tabs | `kit/segmented`, `kit/tabs` | — | — |
| Field | `kit/text-field` | — | — |
| Scrubbable number | — | `src/tools/transform-bar.ts` (typed only) | `<sf-number-field>` (StaticFlux kit) |
| Colour field | `kit/color-field` | `src/elements/panel.ts` | token/recents/opacity popover (StaticFlux kit), brand row (Instaflow) |
| Slider | `kit/slider` | — | — |
| **Overlay layering** (6 layers, top-layer order, inert, one modal) | `kit/surfaces` `<sf-surface-layer>`, `messaging` `SurfaceManager`, `ui/theme` `z.*`, `a11y` inert | — | close layer 3 before layer 4, re-assert toasts above modals, trigger-gone focus fallback (StaticFlux kit) |
| Menu / context menu | `kit/menu`, `kit/position` | — | submenus, headings, filter, consumed outside click, context-menu corner rule, shrink step (StaticFlux kit); canvas right-click (Instaflow) |
| Popover / tooltip | `kit/popover`, `kit/tooltip`, `messaging` | — | pass-through dismiss, warm period, disabled reason, long-press (StaticFlux kit) |
| Colour popover / font picker / alignment popover | — | `src/elements/panel.ts` (swatch), `src/app/fonts.ts` (font list) | `<sf-color-popover>`, `<sf-font-picker>`, `<sf-align-popover>` (StaticFlux kit); document colours mirror, brand row, hover-preview wiring (Instaflow) |
| Toast | `messaging` toast arbitration + `kit/surfaces` `<sf-toast>` | — | pause on hover/focus/hidden, count badge (StaticFlux); `ToastsToken` adapter, Home `Mod+Z` → toast Undo (Instaflow `src/app`, `src/home`) |
| Banner / blocking error / progress row | `messaging` `banner` kind, `shell` `<sf-boundary>`, `core` `SfError` | — | `<sf-banner>`, `<sf-blocking-error>`, `<sf-progress-row>` (StaticFlux kit); error → level adapter `src/app/feedback.ts`, recovery `src/app/recovery.ts` (Instaflow) |
| Dialog / sheet / takeover | `messaging` dialogs + routable bridge, `kit/surfaces` `<sf-dialog>`, `a11y` traps | — | wizard step frame, takeover frame, inline confirm row, bottom sheet at < 720 px (StaticFlux kit); Export, Settings, milestone preview, Compare (Instaflow) |
| Contextual HUD (control model) | `kit/toolbar`, `kit/position` | `src/spec/studio-spec.ts` (per-WP HUD lists today) | `src/spec/controls.ts` control model + ranked projection, pill placement from selection bounds (Instaflow) |
| Deep links / copy link | `router` routes + dialogs, `urlstate` view/intent/sticky + `/d/<key>`, `messaging` routable bridge | `src/home/routes.ts` (3 routes) | remaining routes, `url-contract.ts`, intents, `links.ts`, not-found page (Instaflow) |
| DevTools surface | `devtools` collector, views, `<sf-devtools>` panel, `gate.explain()` | — | Instaflow tabs (Explain, Document, Workers, Perf, Errors), tray slot, About switch (Instaflow `src/app/devtools*.ts`) |
| Tree / list | `kit/tree` | — | row actions + inline rename (StaticFlux kit); Layers mirror + panel (Instaflow) |
| Card | `kit/card` | `src/home/home-element.ts` | menu slot, checkbox, drag (StaticFlux kit); design card (Instaflow) |
| Empty / loading / error | `ui` skeleton, `shell` boundary, `core` errors | — | copy per region (Instaflow) |
| Command palette | `kit/command-palette` | — | wiring from the command bar (Instaflow) |
| Drag and drop | `kit/tree` drag | `src/tools/gesture.ts` | file drop, card drag (Instaflow) |
| Selection models | — | `src/tools`, `src/a11y` | — |
| Inline rename | — | — | `<sf-inline-edit>` (StaticFlux kit); rename capabilities (Instaflow) |
| Tag / chip | `kit/tag` | `src/theme/lenses.ts` | — |
| Shortcuts / Help | `a11y` shortcuts, `shell` command shortcuts | `src/tools/keyboard.ts`, `src/app/canvas-shortcuts.ts` | Help surface (Instaflow), scope-with-selection rule (Instaflow) |
| Clipboard | — | — | `src/tools/clipboard.ts` + DOM bridge (Instaflow) |
| Icons | — | — | `<sf-icon>` + Lucide modules + custom set (StaticFlux kit); kind table (Instaflow) |
| Motion | `ui/theme` motion, `a11y` preferences, `shell` transitions | — | — |
| UI text | `i18n` | `*Messages` per feature | forbidden-text test (Instaflow) |
| First-use hints (no tours) | `messaging` coach-mark surfaces, targets, seen-once | — | `<sf-hint>` (StaticFlux kit); seen-store adapter, session cap, Settings switch, copy (Instaflow `src/studio/hints.ts`) |
| Settings store | `storage` AsyncStore | — | `src/settings/` (Instaflow) |
