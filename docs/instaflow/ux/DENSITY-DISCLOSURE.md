# Instaflow density modes and progressive disclosure (Layer 1)

> Status: **normative.** Replaces the one-table treatment of density in `FOUNDATIONS.md` §3.2 and `STUDIO-UX-SPEC.md`
> §2.3, which now point here. Written 2026-10-25 from the owner's direction: keep the three modes **Focus · Standard ·
> Pro**, and think each one through per surface, so a mode is a personality, not a different padding. Focus and
> Standard are the **calm pair** (the Claude artifact UI: quiet, things tucked away, one thing in front of you); Pro is
> the **dense one** (Figma, Adobe: everything at once, numbers everywhere). §8 is the **clutter audit**: for every
> panel and dialog, what is visible at rest and what folds into a menu, a `More ▾` row or a disclosure.
>
> Conventions kept and why: Figma's `Mod+\` for panels (muscle memory for the largest group of switchers); Apple's
> disclosure triangle (▸/▾) for collapsed sections (forty years of meaning); Framer's practice of putting rarely used
> options in menus. **Departure:** no leader offers a calm mode and a dense mode of the *same* editor over the *same*
> control model. Adobe's workspaces rearrange panels; Figma UI3 has one density. Instaflow's modes only *reveal*; the
> control model (STUDIO §4.2.1) is identical underneath, so nothing a person learned in Standard is in a different place
> in Pro. That is what makes switching safe.

## 1. The three modes, as personalities

| | **Focus** | **Standard** (default) | **Pro** |
|---|---|---|---|
| One line (shown wherever it is chosen) | Just your work. | Your work, with the panels that explain it. | Everything, with numbers. |
| Who it is for | Someone making one thing; presenting to a client across the desk; reviewing | A first-timer learning the model; most sessions | Someone who lives in Figma or Illustrator; production work |
| What the eye lands on | The page. Chrome is at the edges and mostly white space. | The page, with Layers on the left and the inspector on the right telling the story of the selection. | The grid: rulers, every section open, values in mono. |
| Rule of thumb for any new control | Hide it unless the selection needs it right now. | Show the essentials; fold the rest behind `More ▾` or a disclosure. | Show it. |
| How it must **feel** | Quiet. Panels slide in when summoned and leave when you click away. | Explained. Every section has a heading; every value a label; hints and empty states teach. | Fast. No disclosure to open, no hover to reveal; everything is one click or one key away. |
| Code level | `focus` | `standard` | `pro` (the three `Density` values stay; `minDensity` on panels and `data-sf-density` tokens are unchanged) |

What a mode never does: move a control to a different section; change what a gesture does on the canvas; change
shortcuts; change colour. A control that is visible in two modes is in the same place in both.

## 2. Vocabulary of disclosure (the blocks every surface uses)

| Block | Looks like | Use when | Memory |
|---|---|---|---|
| **Section ▸** | An inspector or settings section whose heading carries a chevron; collapsed shows the heading and a one-line **summary** of its non-default state in mono (`Shadow · Multiply 50 %`) | A group of controls a person needs sometimes | Per section, per device (`instaflow/ui/sections`); Pro ignores it (all open); Focus ignores it (rail) |
| **`More ▾` row** | The last row of a section: a ghost row `More ▾` that expands the rest of the section in place (never a popover) | Secondary fields of an essential section (Transform's skew, flip, pivot) | Per section, per device; Pro shows them expanded with no `More` row at all |
| **Menu `▾`** | A label with a chevron that opens a one-level menu | A choice with ≤ 8 options that is set once in a while (Position Inside/Centre/Outside, Blend mode, Sort by) | None (it is a value) |
| **`⋯` overflow** | An icon button opening a menu of actions | Actions a person runs rarely from this spot | None |
| **`Advanced ▸` step** | In a dialog: a ghost row whose right side summarises non-default settings in a mist tag; opens a **step** of the same dialog | Options that most exports/shares never touch | Per dialog, per design (Export memory) |
| **Hover-revealed** | Row actions (eye, lock, `⋯`) that appear on hover or focus | Row actions in lists | Pro shows them always (no hover needed) |
| **Rail** | A 44 px strip of icons with tooltips standing in for a panel | Focus: dock and inspector | Which panel was open last |
| **Presets row** | Chips that stay visible in every mode (Format, Scale, Size presets) | A choice people make every time | Last choice per design |

Rules: a disclosure never hides the *only* way to do something (keyboard and palette reach everything); a collapsed
section always shows its **summary**, so hidden ≠ unknown; disclosure state is restored on reopen; nothing hidden by
disclosure is hidden by gating too (gating removes, disclosure folds). Code: a kit `<sf-disclosure>` (heading,
chevron, summary slot, `open`, persisted key) is **missing** (StaticFlux kit); the per-device store is Instaflow
(`src/settings/ui-state.ts`).

## 3. Studio, per mode

### 3.1 Regions and chrome

| Region | Focus | Standard | Pro |
|---|---|---|---|
| Top bar (56 px) | Logo · title · `● Saved` · `View ▾` · `⋯` · `Export`. **Lens switcher hidden** when only Canvas + Pages exist (`1`/`5` still work; it returns when a third lens exists or on hover of the title area for 2 s). `Milestone` folds into `⋯`. | Everything in STUDIO §2. | Everything, plus the **undo label** (`Undo: Resize headline`, ghost, 12 px mono) left of `● Saved`, and the zoom value as text in the bar (the zoom pill stays on the canvas too). |
| Dock (left) | **Rail** 44 px: Layers · Pages · Assets · Milestones icons. A click opens the panel as a floating 236 px card over the canvas; it leaves on the next canvas click or Escape. | Docked 236 px, one tab at a time, tab switcher on top. | Docked **split**: two panels stacked (Layers above, the last other tab below), each with its own header; splitter between. Width remembered up to 320 px. |
| Inspector (right) | **Rail** 44 px with one icon per section of the current selection kind (Transform, Fill, Stroke, Effects…). A click opens **that section only** as a floating 264 px card; Escape or canvas click closes. | Docked 264 px; sections per STUDIO §5.1, collapsed ones with summaries (§2 above). | Docked 264 px (288 px when the window is ≥ 1600 px); **every section open**, no `More ▾` rows, no summaries; Transform shows X Y W H ∠ ⟂ flips pivot in one block. |
| Rulers | off | off | **on** (20 px, mono 10 px ticks; dragging out makes a guide, M2) |
| Tool picker | Visible; **same** in all modes (a tool must never move). | same | same, plus the tool's one-line description under the tooltip name |
| Selection pill (HUD) | Visible; ≤ 6 items. | same | same, with a second tooltip line (description); values show units |
| Command bar / zoom pill | Visible, bottom. | same | same; the command bar also shows the last run command's name as a ghost prefix (`Tidy up ·`) for repeat by Enter |
| Canvas HUD (handles, size pills, guides) | same everywhere; distance tags only while dragging | same | distance tags **also on hover** of an aligned neighbour; the size pill shows decimals when zoomed in past 400 % |
| Toasts, banners, dialogs | identical in every mode (OVERLAYS); only their **spacing token set** follows the mode (§6) | | |

### 3.2 Inspector, per mode, per selection kind

The control model (STUDIO §4.2.1) declares every control's `section`, its `tier` (**essential** or **more**) and
its HUD rank. Standard renders essential controls open and `more` controls behind `More ▾`; Pro renders all open;
Focus renders the rail. Tier assignments (the clutter audit, §8.1) are the normative part.

| Kind | Standard shows at rest | Behind `More ▾` / ▸ in Standard | Pro adds (beyond opening everything) |
|---|---|---|---|
| Nothing (Page) | Page: Name, Size (size field pair with `Presets ▾`), Background. Document: Title. | Page: Orientation lock, Layout grid ▸. Document: Pages count, Units, Provenance line. | Page margins and bleed fields (used by Print export), page position X Y on the canvas |
| Shape | Transform (X Y W H ∠), Fill stack, Stroke stack (width + colour) | Transform `More ▾` (⟂ skew, flips, pivot), Stroke `More ▾` (Position, Cap, Join, Dash), Corners ▸, Effects ▸, Layer ▸ (opacity, blend) | Per-corner radii in one row of four; stroke dash pattern as a mono field; Effects shows each effect's fields inline |
| Text | Transform, Text (Style ▾ preset, Font, Weight, Size, Colour, `B I U S 🔗` row, Align row with List ▾), Fill | Text `More ▾` (Line height, Letter spacing, Paragraph spacing, Vertical align for fixed boxes, Auto-size, Case ▾, Sub/superscript, Fit to box), Stroke ▸, Effects ▸, Layer ▸ | OpenType features row, variable axes, baseline offset, line-height unit, direction, hyphenation, truncate, word count — **tiers per control: `TEXT-FONTS-UX-SPEC.md` §4.2 and §4.4** |
| Image | Transform, Image (Fit ▾, Replace…) | Image `More ▾` (Source name, pixel size, Crop reset, Adjustments: exposure, warmth, saturation sliders), Effects ▸, Layer ▸ | Adjustments open; a `Reset` per slider; source path as mono |
| Frame | Transform, Frame (Clip toggle, Name), Fill | Stroke ▸, Layout grid ▸, Effects ▸, Layer ▸ | Layout grid open with the overlay toggle |
| Group | Transform | Layer ▸ | Child count, bounds mode |
| Repeat | Transform, Repeat (Kind switcher, the kind's two main numbers: Count + Radius / Rows + Columns / Axis) | Repeat `More ▾` (Start angle, Sweep, Rotate copies, Spacing, Offsets, Brick/Hex) then the source's sections | All parameters open, the source's sections open |
| Boolean / Mask | Transform, Combine or Mask (operation / mode), Fill | Invert, Stroke ▸, Effects ▸, Layer ▸ | — |
| Multi | Transform (Mixed), Fill, Stroke | Effects ▸, Layer ▸ | Per-element list (names) at the top with a click-to-isolate |

Collapsed sections show a summary line; `More ▾` rows show nothing until opened except a mist count tag when a
hidden field is non-default (`More ▾ · 2`), so a skewed shape does not look un-skewed in Standard.

### 3.3 Dock panels, per mode

| Panel | Focus (floating card) | Standard | Pro |
|---|---|---|---|
| Layers | Rows 30 px; no filter field until typing starts (`/` while the card is open shows it) | Filter field on top; rows 30 px; hover-revealed eye and lock | Rows 26 px; eye and lock **always visible**; a mono column at the right with the element's W × H; kind icons 14 px; `Expand all / Collapse all` buttons in the header |
| Pages | Thumbnails 48 px, `+ Add page` | same | Thumbnails 32 px in a two-column grid; page size as a mono tag; page menu `⋯` always visible |
| Assets | Grid 3 columns, `Import` | same | Grid 4 columns, file name and pixel size under each; `Sort ▾` and `Kind ▾` filters in the header |
| Milestones | Rows 44 px: name, time | same, plus the note on a second line | Rows 36 px; `⋯` always visible; a `Compare` icon per row |

### 3.4 HUD and canvas popovers

The pill is the same six in all modes (people learn it once). Pro changes only tooltips (second line) and adds units
to the inline numbers (`120 px` instead of `120`). The colour popover, font picker and alignment popover do not change
by mode except: Pro's colour popover opens with `Custom ▸` **already expanded** and shows the hex of every document
colour as a mono caption; Focus's colour popover is identical to Standard's.

## 4. Home, per mode

Home has no canvas, so **Focus and Standard look the same** on Home (the setting still says three; see GAP-AUDIT
Q-D). Pro turns Home into a working file manager.

| Part | Focus / Standard | Pro |
|---|---|---|
| Hero | Bricolage 72 px headline, the formats row | Hero collapsed to one 44 px row: `＋ New design ▾` and the formats as **chips** (28 px) on one line; the headline is gone |
| Jump back in | 8 cards, 4 columns, 158 px thumbnails, meta line | 12 cards at 3 : 2, 112 px thumbnails, meta includes size and project; or **list view** by default when the person chose it in Files |
| Templates, Projects | Card sections | Compact rows (44 px) with counts |
| Files | Grid by default; toolbar `All · Designs · Templates · Media · Favourites`, `Project ▾`, `Sort ▾`, Grid/List, search | List by default; checkboxes **always visible**; columns Title · Kind · Project · Edited · Size · Pages; column headers sortable by click; the bulk bar is docked under the toolbar instead of floating |
| Footer | `1.2 GB used on this device · Settings` | plus `Workspace: ~/Designs/instaflow · Mirror: up to date` |

## 5. Chat (M2), per mode

| Part | Focus | Standard | Pro |
|---|---|---|---|
| Threads rail (256 px) | **Hidden**; a `☰` icon button top-left opens it as a floating card | Docked | Docked, 224 px, rows 32 px, thread meta (asset, provider) as mono |
| Header | Title only | Title, asset chip, `Open in Studio` | plus autonomy and provider chips inline (not only in the composer) |
| Mini editor card | Preview + `Edit here` only; tools appear after `Edit here` | as CHAT §4 | Tools switcher **always shown** in the card header; the spec's inspector fields open beside the preview without clicking |
| Proposal card | Sentence + Accept / Reject | plus `3 changes · one undo step` | plus a change list (one row per change, `Show diff`) open by default |
| Composer | Textarea + Send; `＋ Attach` and chips behind a `⋯` | as CHAT §3 | as Standard, plus a token/cost estimate line under the textarea when the provider reports it |
| Docked in Studio (288 px) | Panel hidden in Focus unless opened from the chip; opens floating | Docked | Docked; transcript rows 13 px |

## 6. Spacing and type per mode

One token set per mode on `data-sf-density`; components read tokens, never the mode.

| Token | Focus | Standard | Pro |
|---|---|---|---|
| Row height (lists, menus) | 32 | 30 | 26 |
| Inspector field height | 32 | 32 | 28 |
| Section padding | 16 | 14 | 10 |
| Gap between fields | 10 | 8 | 6 |
| Panel header height | 44 | 40 | 32 |
| UI text | Geist 14 | Geist 13 | Geist 12 |
| Mono values | Geist Mono 12 | 12 | 11 |
| Section headings | 11 px uppercase, tracking 0.06 em | same | 10 px uppercase, tracking 0.08 em |
| Icons (rows, inspector) | 16 | 16 | 14 (16 in the tool picker and pills everywhere) |
| Tooltip | name + `kbd` | name + `kbd` | name + `kbd` + description line |
| Dialog body padding | 24 | 20 | 16 |
| Motion | as FOUNDATIONS §5.10 | same | same but panel reveal 120 ms (not 160) |

Pro never goes below 12 px UI text or 11 px mono (WCAG and the owner's eyesight both matter); it gets density from
height and padding, not from illegible type. Focus gets calm from padding and from **absence**, not from bigger type.

## 7. Settings and dialogs, per mode

Dialogs keep their anatomy (OVERLAYS §2) in every mode; only the spacing tokens change (§6). Two exceptions, both in
Pro: the Export dialog's `Advanced ▸` step is rendered **inline** under the main step (no step, no slide; everything on
one scrolling body, 720 px wide), and Settings › Shortcuts shows both platform columns. Settings sections follow the
tiers in §8.3; in Pro all `More ▾` rows are open.

### 7.1 Moving between modes, and what is remembered

| Way | Where | Behaviour |
|---|---|---|
| View menu › Density | Studio `View ▾` | Radio group with the three one-liners; applies at once; the canvas camera is re-centred so the page does not move on screen (160 ms) |
| Settings › General › Density | Home and Studio | Same radio group with a 3-frame **preview strip** (a 160 × 100 px line-drawing of Studio per mode) above the options |
| `Mod+\` / `Mod+Alt+\` | Studio | Toggle the dock / inspector **within** the mode (a temporary override, remembered per device per mode until the mode changes); the View menu shows `Show dock` checked/unchecked accordingly |
| `Mod+.` | Studio | Cycles Focus → Standard → Pro → Focus; a 1.5 s mist toast names the mode (`Standard · Your work, with the panels that explain it.`) so a stray press is understood (departs from Figma, which has no cycle key; one key to try all three teaches the modes) |
| Rail click (Focus) | Studio | Opens one floating panel; it does not change the mode |
| Command palette `Density: Pro` | anywhere | Same as the menu |

Remembered **per device** (`instaflow/ui/density`): the mode; per mode: dock/inspector overrides, dock width, split
panel choice (Pro), section disclosure state (Standard), Home list/grid (Pro), Chat rail state (Focus). Never
remembered in the document, a milestone, an export or a URL (NAV §2.3). Switching modes never loses a selection, an
open popover's edit (committed live) or the camera's page.

First run opens in **Standard** (STUDIO §14.3). Nothing suggests switching; the View menu's one-liners are the
discovery. When the window is < 1280 px the inspector collapses to a rail *within* Standard (FOUNDATIONS §3.4), which
is an override, not a mode change.

## 8. Clutter audit: what folds, per panel and dialog

Rule: at Standard, a panel or dialog shows **what most people change most of the time**; everything else folds behind
exactly one of the blocks in §2. Presets stay visible. "Folds to" names the block.

### 8.1 Studio inspector and HUD

| Place | Visible at rest (Standard) | Folds to | Hidden until relevant (gating, not disclosure) |
|---|---|---|---|
| Transform | X Y W H ∠ · link toggle | `More ▾`: skew, Flip H/V, pivot picker | — |
| Fill / Stroke stacks | Each row: swatch · value · opacity · eye · × (hover) · `+ Add` | Stroke `More ▾`: Position, Cap, Join, Dash | Stroke section itself is ▸ for Text and Frame |
| Corners | ▸ with summary `Radius 24` | Section ▸: Radius, per-corner toggle, Smooth slider | not rendered for ellipse, line, text |
| Effects | ▸ with summary `Shadow` | Section ▸: effect rows; each row's Kind ▾ and fields | — |
| Layer | ▸ with summary `50 % · Multiply` | Section ▸: Opacity slider, Blend ▾ | — |
| Text | Style ▾ · Font ▾ · Weight ▾ · Size · Colour · `B I U S 🔗` · Align row (`⟵ ≡ ⟶ ☰` · List ▾) | `More ▾`: Line height, Letter spacing, Paragraph spacing, Vertical align, Auto-size, Case ▾, Sub/superscript, Fit to box (`TEXT-FONTS-UX-SPEC.md` §4.2) | Vertical align only for fixed boxes; Fit to box only when overflowing; OpenType, axes, baseline, direction, hyphenation, truncate (Pro only) |
| Image | Fit ▾ · Replace… | `More ▾`: source, pixel size, Crop reset, Adjustments sliders | — |
| Repeat | Kind switcher · two main numbers · Expand · Release | `More ▾`: the rest of the parameters | — |
| Page | Name · Size pair with `Presets ▾` · Background | `More ▾`: Orientation lock; Layout grid ▸ | Margins/bleed (Pro only) |
| HUD `⋯` More menu | the searchable menu, grouped | n/a (it *is* the fold) | rows the selection cannot run are absent |
| Context menu | ≤ 18 rows with dividers (STUDIO §8.2) | `Select same ▾`, `Make repeat ▾`, `Align ▾`, `Combine ▾`, `Fit ▾` are submenus | — |

### 8.2 Studio chrome and dock

| Place | Visible at rest | Folds to |
|---|---|---|
| Top bar | Logo · title · lenses · save · `View ▾` · `Milestone` · `⋯` · `Export` | `⋯`: Save as template, Rename, Duplicate, Copy link, Settings, Shortcuts, About. `View ▾`: zoom, snapping, rulers, density, panels |
| Zoom pill | `−` · value · `+` | Menu on the value: fit, selection, 50/100/200 %, open-at-100 % toggle |
| Layers header | Filter field | `⋯` (Pro: buttons): Expand all, Collapse all, Show hidden only |
| Pages header | `+ Add page` | Row `⋯`: Duplicate, Rename, Delete, Move, Export page…, Copy link |
| Assets header | `Import` | `⋯`: Sort ▾, Kind ▾, Show unused |
| Milestones header | (none; the top bar's `Milestone` creates) | Row `⋯` per OVERLAYS §2.3 |

### 8.3 Dialogs and Settings

| Dialog / section | Main (visible) | Folds to |
|---|---|---|
| Export (OVERLAYS §2.3) | What · Preset · Format · the format's one main option · **Size** (custom pixel size, §2.3 Export) · name line · preview card | `Advanced ▸` step: transparent, JPG quality, PDF kind extras, SVG text, file name, zip, remember |
| Share (M2) | Link row · Access row · Invite · `Publish a release ▸` | Steps: Link settings, Publish |
| Milestone popover | Name · Create | `Note` field appears via a ghost `+ Note` link (departs from always showing it: most milestones have no note) |
| Settings › General | Density (with preview strip) · Theme · Language | `More ▾`: Units, Nudge, Reduced motion, Show first-use hints + Reset hints |
| Settings › Shortcuts | Search · the cheat sheet groups | per-row rebinding (backlog B-10) |
| Settings › Storage | Space used (bar) · Persistence state · `Move workspace to a folder` | `More ▾`: Back up (.zip), Open folder…, GC now, Mirror status |
| Settings › Assistant (M2) | Provider cards (one expanded) · Default provider | per card `More ▾`: model list, custom endpoint fields; Defaults `More ▾`: per-task defaults, Autopilot limits |
| Settings › About | Version · `Copy diagnostics` | `More ▾`: licences, Developer tools switch (shown only per DEVTOOLS §2) |
| New design (HOME-FILES §1.3) | Formats row · Size pair · `Start from ▾` template · `Create` | `More ▾`: orientation lock, units, page count, background |
| Command palette | Field · recents · results | n/a |
| Colour popover | Value row · Document colours · Brand · Palette · Recent | `Custom ▸` inline |
| Font picker | Search · category chips · Recent · In this design · Brand · Your fonts · Library · On this computer | Weight is a separate menu (never in the list); `+ Add fonts ▾` footer holds Upload, Use fonts on this computer, Browse Google Fonts (M2) (`TEXT-FONTS-UX-SPEC.md` §5.1) |
| Missing fonts dialog | One row per family: Add from this computer · Replace with ▾ · Upload… | `Replace all with the fallback` ghost in the footer (`TEXT-FONTS-UX-SPEC.md` §5.6) |

### 8.4 Home

| Place | Visible at rest | Folds to |
|---|---|---|
| Header | Logo · nav · search · settings · `＋ New design ▾` | The `▾` half: formats and `Custom size…` |
| Card | Thumbnail · tag · title · meta · star (hover) · `⋯` (hover) | `⋯`: Open, Rename, Duplicate, Move to ▾, Favourite, Export…, Copy link, Move to trash |
| Files toolbar | Filter switcher · `Project ▾` · `Sort ▾` · Grid/List · search | `Sort ▾` carries direction; `Project ▾` carries `New project…` |
| Bulk bar | count · `Move to ▾` · Duplicate · Move to trash · × | — |
| Footer | storage line · Settings | — |

**Code:** `@staticflux/ui/theme` density tokens (add the §6 rows), `shell/spec` `minDensity`, Instaflow
`src/studio/studio.ts` `setDensity`; **missing:** `<sf-disclosure>` with summary and persisted key (StaticFlux kit),
the `tier` field on controls (`src/spec/controls.ts`), Pro split dock and rail-click floating panels
(`src/studio/studio-element.ts`), `Mod+.` cycle and its toast, Settings preview strip, Home Pro layout
(`src/home`), per-mode memory store (`src/settings/ui-state.ts`).
