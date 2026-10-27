# Instaflow component anatomy (Layer 1, reusable)

> Status: **normative** for how every panel building block is drawn: parts, sizes and spacing per density, type,
> colour tokens, radius, states, alignment, do and don't. Written 2026-10-27 (issues #55, #40, #45, #56) from the
> approved design **Clean Pop · final** (`docs/instaflow/design/Components.dc.html`, `StudioCP.dc.html`, `README.md`)
> and the theme tokens in `apps/instaflow/src/theme/clean-pop.ts`. Surface specs (`INSPECTOR-LAYOUT-SPEC.md`,
> `STUDIO-UX-SPEC.md`, `OVERLAYS-FEEDBACK.md`, …) **map to these blocks and add no visual rules**; a new rule is added
> here first. Behaviour (what a control does, keyboard, undo) stays in `FOUNDATIONS.md` §4; this file is the drawing.
> **Scope:** every visible component in the repo (`UI-INVENTORY.md`): §1–§16 give the anatomy by block, §17 maps each
> of the 74 elements and the render helpers to its block with what is off today and whether that is implementation
> drift or a spec gap.
>
> Conventions: sizes in CSS px; a triple **F / S / P** is Focus / Standard / Pro (one value = all three); the Standard
> value is the design's. Colours are token names from `clean-pop.ts` (`color.*`) with the hex beside them once in §0.
> Every size is on the 4 px grid except 2 px gaps in switchers and the 6 px pivot gap.

## 0. Tokens this file uses

| Token | Value | Use |
|---|---|---|
| `color.surface1` | `#FFFFFF` | panels, fields, cards, menus |
| `color.canvas` | `#F1F4F7` | page and dialog background, panel hover |
| `color.neutral3` (mist) | `#E7ECF2` | switcher track, tags, pressed |
| `color.border` (hairline) | `#DCE3EA` | hairlines, card edges |
| `color.controlEdge` | `#7D8897` | field and secondary-button edges (≥ 3 : 1 on white and mist) |
| `color.neutral7` | `#C3CCD7` | slider track |
| `color.text` (ink) | `#16151A` | text, values |
| `color.textMuted` | `#56606C` | labels, headings, hints (7.1 : 1) |
| `color.textSubtle` | `#7D8897` | placeholders only |
| `color.textDisabled` | `#A3ACB8` | disabled text |
| `color.accent` (tangerine) | `#CF3D17` | primary, focus ring, slider fill, insertion line, chosen dot |
| `color.accentSubtle` / `color.surfaceSelected` | `#FFEDE6` | pressed-on, selected rows (the design draws `#FFE9E2`; the token is the one to use) |
| `color.accentText` | `#B8350F` | text on `accentSubtle` (design: `#B53A17`) |
| `color.agent*` | `#D6265F` · `#FDE8EF` · `#B3174C` | Claude actions and chips |
| `radius.sm` · `radius.md` · `radius.lg` · `radius.control` | 8 · 12 · 18 · 9999 | menu rows and row highlights · fields, previews, menus, popovers · cards · pills |
| `font.family` · `font.familyMono` · `font.familyDisplay` | Geist · Geist Mono · Bricolage Grotesque | UI · read-only values, codes, kbd · titles |
| `shadow.level1` · `level2` · `level3` | `0 1 2 / .14` · `0 6 18 / .10` · `0 16 40 / .18` | selected pill · menus, popovers · dialogs, floating cards |
| **Panel tokens (new)** `--if-panel-pad` · `--if-row` · `--if-row-gap` · `--if-col-gap` · `--if-label-col` · `--if-gutter` · `--if-field` | 16/14/10 · 32/32/28 · 10/8/6 · 8/8/6 · 72/72/64 · 28/28/24 · 32/32/28 | set once on `data-sf-density`; every block below reads them |

Type scale per density (DENSITY §6, unchanged): UI **14 / 13 / 12**; labels 12 / 12 / 11; mono 12 / 11 / 11; section
headings 11 px uppercase 0.06 em (Pro 10 px, 0.08 em); titles Bricolage 700 15 (panel header), 20 (dialog), 22 (settings
page). Focus ring everywhere: 2 px `accent`, 2 px offset, on `:focus-visible` only (never on mouse focus — #41).

## 1. Panel frame

The one frame for the **inspector**, every **dock panel** (Layers, Pages, Assets, Milestones), the **Chat side panel**
(M2), the **Settings nav column** and the **dialog body** (§13 says how a dialog composes two of these).

**Parts.** `edge hairline` · `header` (fixed) · `body` (the only scroller) · `footer` (fixed, optional).

| Part | F / S / P | Rule |
|---|---|---|
| Width | inspector 264 (288 in Pro ≥ 1600 px) · dock 236 (Pro: dragged to ≤ 320) · chat 288 · settings nav 184 · Focus floating card: the panel's width | fixed per density; never resizes because of content |
| Background · edge | `surface1`; one 1 px `border` hairline on the side facing the canvas (inspector: inline-start; dock, chat, settings nav: inline-end) | the floating card (Focus) has a hairline all round, `radius.lg`, `shadow.level3` |
| Side padding | **16 / 14 / 10** (`--if-panel-pad`) | applied to header, body and footer alike |
| Content width | width − 2 × pad: inspector 236 (Pro 288: 260) · dock 208 · chat 260 | every block below is laid on this width |
| Header | **44 / 40 / 32** tall; hairline below when it holds a title; no hairline when it holds a switcher | contents: §2 (title header) or §10 (tabs header) |
| Body | `overflow-y: auto; overflow-x: clip; scrollbar-width: thin`; sections (§2) separated by full-width hairlines, or a list (§9) | nothing inside the body scrolls on its own; the body's padding-inline is the panel pad; hairlines are the only thing allowed to cross it |
| Footer | **44 / 40 / 32**, hairline above | icon buttons sm + a 12 px muted line (inspector: undo row); dialogs: §13 |
| Scroll | header/footer fixed; opening a section scrolls its heading into view (`nearest`); body scroll closes pass-through popovers and menus | |

**Title header.** Left to right: title (Bricolage 700 15, ink, `flex: 1`, ellipsis; renames in place when editable) ·
8 · kind **tag** (§15, mono, 24 px) · 8 · one icon button sm (lock). Nothing else.

**States.** rest · the floating card enters 160 ms (120 in Pro) with opacity + 8 px translate; leaves on canvas click or
Escape. **Do:** keep the padding sacred; align every row's left edge to it. **Don't:** render a collapse bar, a second
disclosure header ("Inspector ▾"), or nested padding (a panel inside a tab-panel inside a dock each adding its own).

**Code:** kit `<sf-dock>` (needs `chrome="none"`), `<sf-panel>` (needs `headless`), `<sf-tab-panel>` (pads nothing);
Instaflow `studio-element.ts`, `inspector.ts`, `layers-panel.ts` read `--if-panel-pad`.

## 2. Section and its header

A body is a stack of sections; a section is a heading row, its rows, an optional `More ▾` row, and a hairline.

```
                                 pad-top 14 / 12 / 10
▸ TRANSFORM                                     [action]    heading row 28 px
                                 one row gap (10 / 8 / 6)
row · row · row                                              §3 rows
More ▾ · 2                                                   §8.3, 28 px
                                 pad-bottom 16 / 14 / 10
──────────────────────────────────────────────── hairline, full column width (the only thing crossing the pad)
```

| Part | Spec |
|---|---|
| Heading row | 28 px, a full-width `button` (`aria-expanded`), transparent, `radius.sm`; hover: title → ink; no background |
| Chevron | 12 px, `textMuted`, ▸ collapsed / ▾ open, rotates 120 ms; its left edge on the content edge. Omitted when pinned (Pro) |
| Title | 6 px after the chevron; **Geist 11 / 11 / 10, 600, UPPERCASE, tracking 0.06 em (Pro 0.08), `textMuted`** (Clean Pop `ui.section`) |
| Summary (collapsed only) | right-aligned before the action, **Geist Mono 11, `textMuted`**, one line, ellipsis at the start (the end carries the news: `… · Multiply`), hidden when open or empty |
| Action | the last thing in the row, right edge on the content edge: `+ Add ▾` (ghost sm pill, §11), `⊞`/`⋯` (ghost icon button 28/28/24). **Visible when collapsed too** (clicking it opens the section and runs) |
| Rows | start on the **content edge**, not under the title (a title labels the block; indenting rows under an 18 px chevron offset wastes a fifth of the width) |
| Spacing | pad-top 14 / 12 / 10 above the heading; one row gap between heading and first row and between rows; pad-bottom 16 / 14 / 10 after the last row; **no other vertical spacing** (sub-groups are separated by the More row or a stack row's indent, never by extra gaps) |
| Collapsed height | pad + 28 + pad + 1 = **54** at Standard |
| Pinned (Pro) | all open, no chevron, title on the content edge, no summaries, no More rows |
| Section pointer `aria-label` | the title; a section heading appears **once** (nothing inside repeats it) |

**Do:** one action per heading row; put a stack's `+ Add ▾` here. **Don't:** centre anything; put buttons under the
rows; give the heading button inline padding (today 4 px) that offsets it from the rows.

**Code:** kit `<sf-disclosure variant="section">` + an `actions` slot; `heading` 28 px; summary end-aligned.

## 3. Row grid

Every row in a panel body uses one of three column templates on the content width. They share the left and right edges,
so a section can mix them.

```
labelled:  [ label 72 ] gap [ field ────────────── 1fr ]
paired:    [ cell ──── 1fr ] gap [ cell ──── 1fr ] gap [ gutter 28 ]
full:      [ ─────────────────────── 1fr ─────────────────────── ]
```

| Token | F / S / P |
|---|---|
| Row height (`--if-row`; = field height) | 32 / 32 / 28 (exceptions: a full-row switcher is 34 / 34 / 30; the pivot grid row is 36) |
| Row gap (`--if-row-gap`) | 10 / 8 / 6 |
| Column gap (`--if-col-gap`) | 8 / 8 / 6 |
| Label column (`--if-label-col`) | 72 / 72 / 64 |
| Gutter (`--if-gutter`) | 28 / 28 / 24 — **always present in a paired row**, empty or holding one icon button, so field edges align down the section |
| Cell / field widths at Standard, inspector (236) | labelled field 156 · paired cell 96 · row value (§6, §7) 56 |
| at Pro 264 / 288 | labelled 194 / 218 · paired 103 / 115 |
| at Focus card 232 | labelled 150 · paired 92 |
| Dock (208) | labelled 128 · paired 82 (rarely used; the dock is lists) |

**Alignment rules.** Every control is vertically centred on the row. Left edges: the label on the content edge; a field
on the field-column edge or a cell edge; text inside a field after its padding. Right edges: the last cell's field ends
at the gutter gap; the gutter's icon button ends on the content edge; a labelled field ends on the content edge.
Nothing in a row is centred, wrapped or sized ad hoc: **field widths come from the grid, never from the field.**

**Labels.** Word label: Geist 12 / 12 / 11, 400, `textMuted`, left, one line, ellipsis, `title` when truncated, sentence
case, no colon. Glyph label: one glyph (`X Y W H ∠ ⟂ T R B L ◜ ◝ ◟ ◞`), Geist 12 / 12 / 11, **500**, `textMuted`, 12 px
wide, **inside the field** at its left (§4.5), `cursor: ew-resize` when it scrubs.

**Inside vs beside.** A label goes **inside** the field when it is one glyph **and** the row is paired (four aligned edges
per pair, the widest value, the scrub handle under the eye). A word never goes inside; a glyph never sits in the label
column (a 72 px column holding one letter is the "floating label" look). There is no unpaired glyph row: `Radius` and
`Sides` are word rows.

### 3.1 Row types (the complete list)

| Type | Template | Contents left → right | Used for |
|---|---|---|---|
| **Single value** | labelled | word label · field (§4) | Radius, Sides, Points, Count, Size, Indent, Name, Title, Source |
| **Paired value** | paired | glyph field · glyph field · gutter (link / swap / `⊞` / empty) | X·Y, W·H, ∠·⟂, TL·TR, BL·BR, Rows·Cols, Dash·Gap, Line·Letter |
| **Half pair** | paired | glyph field · **icon group (§9.4) or menu field** in the second cell · gutter | ∠ + rotate 90°; ⟂ + flips; Scale + Rotate ▾ |
| **Slider + value** | `72 · 1fr · 56` | word label · slider (§7) · 56 px number field | Opacity, Smooth, Sweep, Inner radius, adjustments |
| **Switcher** | field column (2 options) or full (≥ 3) | word label · segmented (§9.3) / segmented spanning the width | Kind, Operation, Mask mode, Auto-size, platform |
| **Switch** | labelled | word label · 36 × 20 switch (§9.3) | Clip content, Invert, Orientation lock |
| **Icon group** | labelled or full | word label (or hidden, `role=group`) · 28 px ghost icon buttons, 4 px apart, left | Flip, Align, B I U S 🔗, box mode |
| **Grid picker** | labelled, 36 px tall | word label · 3 × 3 dots (§9.5) | Pivot |
| **Menu field** | labelled or cell | word label · select-looking field (§4.3) | Blend, Fit, Position, Dash, Cap, Join, Weight, Style, Units, Presets |
| **Paint row** | full | §6 | Fill, Stroke, Effects rows; text colour; effect colour |
| **Stack** | full | heading action + paint rows (§8) | Fill, Stroke, Effects, Background |
| **Empty stack** | full | one muted line (§8.2) | `No fill` |
| **More row** | full, 28 px | §8.3 | the folded rest of a section |
| **Button row** | full | sm buttons, left, 8 apart; first secondary, rest ghost (§11) | Expand · Release, Replace…, Apply · Cancel |
| **Text row** | full, 20 px | Geist 12 `textMuted` fact | `8 instances`, `Applies to the group as one` |
| **Read-only value** | labelled | word label · value text (Geist 13 ink, or mono 11 for codes) with **no field frame**, left on the field edge | Pages count, Source, Units until editable |

## 4. Fields

### 4.1 The field frame (all field kinds)

| Property | F / S / P |
|---|---|
| Height | **32 / 32 / 28** in panels (`--if-field`); 36 / 34 / 32 in dialogs and Home forms |
| Radius | `radius.md` 12 (never a pill) |
| Padding inline | 10 / 10 / 8 |
| Fill · border | `surface1` · 1 px `controlEdge` |
| Text | Geist 14 / 13 / 12, 400, `text`; **`font-variant-numeric: tabular-nums`** on numbers |
| Placeholder | `textSubtle`; never the only label (an accessible `label` always exists) |
| Hover | border → `text` (80 ms) |
| Focus | ring 2 px `accent` at 2 px offset; border unchanged; the field does not grow or move |
| Active (scrubbing) | the glyph label → `accent`; value updates live |
| Invalid | border `accent`; one error line under the row, Geist 12 `accent`, `role=alert`; `aria-invalid` |
| Disabled | text `textDisabled`, border `border`; used only in dialogs (panels hide instead) |
| Mixed | empty value, placeholder `Mixed` in `textMuted`; a hatched swatch where one exists; typing sets all |
| Loading | `aria-busy`, value dimmed; rare |

### 4.2 Number field

Parts: `[glyph label] value [unit]` inside one frame, optional `▾ presets` button replacing the unit.
Value Geist 13 tabular, **left** after the glyph; unit Geist 12 / 12 / 11 `textMuted`, right, `aria-hidden`, spoken in
`aria-valuetext`. Units: `px` `°` `%` `×` `pt` `mm` `in`. Presets `▾`: a 24 px ghost chevron inside the right padding.
Scrub on the glyph (or on the word label in a labelled row): FOUNDATIONS §4.5. Expressions, steps, clamps: unchanged.
**Not monospace** (amends STUDIO §5.2 and the design's `fieldMono`; owner question in INSPECTOR §9).

### 4.3 Text field and menu field

Text: Geist 13, ellipsis when unfocused, `search` type gets a 14 px magnifier in the left padding. **Menu field**
(a `▾` whose result is a value): the field frame, value left, 14 px chevron `textMuted` right in the padding; open state
keeps the frame and the chevron, the menu (§12) drops start-aligned and at least as wide. A menu that runs an action is
a pill (§11), never a menu field.

### 4.4 Value plus unit, paired fields

Not separate kinds: unit lives inside (§4.2); a pair is two §4.2 fields in a paired row (§3). The pair's toggle
(`🔗` keep ratio, `⇄` swap, `⊞` per-corner) is an icon button sm in the gutter; pressed-on is soft tangerine.

### 4.5 Labels inside vs beside (restated for implementers)

Inside: one glyph, 12 px wide, 500, muted, left inside the frame, part of the scrub target; the accessible name is the
full word (`Width`). Beside: word, label column, 400, muted. Never both; never a word inside; never a glyph beside.

**Do:** let the grid set widths. **Don't:** `inline-size: 64px` on a field; a label above a field inside a panel (above
is for dialogs and Home forms only); a visible colon.

## 5. Swatch

16 px (24 in grids) round for solids; 16 px `radius: 4` square for gradient and image thumbnails; a 16 px kind icon for
effects. Resolved colour on an 8 px checkerboard (`neutral4` / `surface2`), 1 px inset ring `borderStrong`; hatched
(`textMuted` 1.5 px / 4 px, −45°) when unresolved or mixed; 50 % when its row is hidden. Decorative (`aria-hidden`); the
control around it carries the name. In a row it sits centred in a **28 / 28 / 24 ghost icon button** that opens the
colour popover (§12.2). Hover: the button's `canvas` fill. Never a native `<input type=color>`.

## 6. Paint row (fill · stroke · effect · colour)

```
[●] @cream · #FFF4E0                    [ 100   % ] [👁] [×]     fill
[●] #16151A · Inside                    [ 2    px ] [👁] [×]     stroke
[◐] Shadow · Soft                                   [👁] [×]     effect
[●] #16151A                                                      colour (text colour, effect colour): swatch + summary only
 28  ‧4‧ summary (flex ≥ 80)         ‧4‧   56    ‧4‧ 28 ‧4‧ 28
```

| Part | Spec |
|---|---|
| Height | one row (32 / 32 / 28); the second line adds rows at the row gap |
| Swatch cell | §5 in a 28 px ghost icon button |
| Summary | `flex: 1`, one line: **title Geist 13 `text`** · ` · ` · **detail Geist Mono 11 `textMuted`** (`@cream · #FFF4E0`, `Linear · 3 stops · 45°`, `Image · Fill`, `#16151A · Inside`, `Shadow · Soft`); a transparent button (`aria-expanded`) that toggles the second line; hover: detail → ink; ellipsis |
| Row value | 56 px number field: fill opacity `%`, stroke width `px`; effects none |
| Eye | icon button 28, icon 14, pressed when hidden (`eye-off`) |
| × | icon button 28, icon 14; **hover- and focus-revealed** in Standard (`visibility`, width constant), always in Pro |
| Hidden row | all but the eye at 50 % |
| Second line | rows indented to the summary's left edge (28 + 4 = **32**), on the §3 grid at the reduced width (204 at Standard: label 64, cells 84): fill `Blend ▾`; gradient `Angle`, `Reverse`; image `Fit ▾`, `X·Y`, `Scale`; stroke `Position ▾`, `Dash ▾` (Custom → `Dash·Gap`), `Cap ▾`, `Join ▾`, `Opacity`, `⊞` → `T·R`, `B·L`, `Blend ▾`, Pro `Miter`; shadow `X·Y`, `Blur·Spread`, colour row; glow `Blur·Spread` + `Inner` switch; blur `Radius`. Reorder `↑ ↓` icon buttons at the right end of its first row; drag by the swatch cell with a 2 px `accent` insertion line |
| Mixed | hatched swatch, title `Mixed fills`, no value; the stack's action reads `Replace all ▾` |
| Focus | the summary button and each icon button take the ring; Tab order swatch → summary → value → eye → × |

**Do:** one line at rest. **Don't:** a two-line summary at rest; a width field squeezing the summary under 80 px (move
rarer values to the second line); eye and × always visible in Standard.

## 7. Slider and value

Track 4 px `neutral7`, fill `accent`, thumb 18 px `surface3` with a 2 px `accent` ring and `shadow.level1`; hover ring
2.5 px; focus ring on the thumb area (`radius.sm`); disabled fill `textDisabled`. **In panels** the value is a **56 px
number field** (§4.2) to the right, typing and scrubbing the same value — the row is `72 · slider · 56`. **In dialogs,
Components and read-only places** the value is the mist mono pill (24 px, `neutral3`, Geist Mono 12). Keyboard:
FOUNDATIONS §4.7.

## 8. Stack, `+ Add`, empty state, More

### 8.1 Stack
A section whose rows are paint rows (§6), top-most first, with its one action **in the heading row**: `+ Add ▾`, a ghost
**sm pill** (28 / 28 / 24; Geist 12.5, 600; 14 px `plus` and `chevron-down` icons; padding 0 8; right edge on the content
edge). It opens a menu (§12.1) `block-end`, **end-aligned**, so the menu covers the stack's own rows, never the next
heading. Entries: `Colour · Gradient ▸ Linear · Radial · Conic · Image…` (effects: the preset menu); the 17th row shows the
`Up to 16 …` footer. No other add control exists (the image icon button is removed).

### 8.2 Empty stack
One row (32) of **Geist 13 `textMuted`** text on the content edge: `No fill` · `No stroke` · `No effects`. The heading's
`+ Add ▾` is the action. Never centred; never a button in the body.

### 8.3 More row
The last row of a section, 28 px, a ghost button spanning the content width: `More` Geist 12.5 `textMuted` left · 4 ·
14 px chevron (▾ closed, ▴ open) · 6 · when closed and `count > 0` a **count tag** (20 px mist pill, Geist Mono 11,
`textMuted`: `2`). Open: the hidden rows follow at the row gap. Hover: text → ink. Pro: not rendered. Never a popover.

## 9. Lists, switchers and small controls

### 9.1 Tree / list row (Layers, Pages, Milestones, files)
| Part | F / S / P |
|---|---|
| Height | 32 / **30** / 26 (Pages, Milestones 44 / 44 / 36) |
| Width | the content width; **inner padding 8**; highlight `radius.control` pill inside the panel pad |
| Indent | 14 per level, after the row's padding |
| Twisty | 16 px, `textMuted`, rotates −90° when collapsed; reserved (blank) on leaves so names align |
| Kind icon | 16 / 14 / 14, `textMuted`, 4 after the twisty |
| Name | Geist 14 / 13 / 12, `text`, `flex: 1`, ellipsis; renaming swaps in a 24 px field with the `accent` border |
| Trailing tag | §15 mono tag 20 px (`@display`, `3`) |
| Row actions | 24 px ghost icon buttons (icon 14), 2 apart: eye, lock; `visibility` on hover/focus, pinned when on; Pro always |
| Selected | `surfaceSelected` fill, `accentText` text, 600 |
| Hover | `canvas` fill |
| Active (focused) | inset 2 px `accent` ring |
| Hovered-elsewhere | inset 1 px `accent` ring |
| Hidden | 50 % except the trailing actions |
| Drag | insertion line 2 px `accent` across the content width; drop-inside: the container row's `accentSubtle` fill |
| Pro extras | a 56 px right column, Geist Mono 11 `textMuted` (`920 × 346`) |

### 9.2 Tabs header (dock)
Row 1 of the dock header (40): the **switcher** (§9.3) with `width: 100%`, segments `flex: 1`, in the panel pad; no
hairline under it. Row 2 (40, optional): a panel's own header controls — a `search` field spanning the content, or a sm
secondary button at the right (`Import`, `+ Add page`). Tab panels pad nothing.

### 9.3 Switcher and switch
Switcher (segmented): track `neutral3`, padding 3, `radius.control`, 2 px between segments; segments **sm pills 28 / 28 /
24**, Geist 12.5 / 12.5 / 12, 500, `textMuted`; selected: `surface3`, `text`, `shadow.level1`, slides 120 ms; hover:
text → ink; focus ring per segment; disabled: whole group `textDisabled`; icons 16 before labels, never icons alone.
Track height 34 / 34 / 30. Switch (one on/off): 36 × 20 track `neutral7` → `accent` when on, 16 px white knob, 120 ms;
label beside, never inside.

### 9.4 Icon-button group
Ghost icon buttons **28 / 28 / 24** (icon 16 / 16 / 14), 4 px apart, left-aligned in their cell or the field column;
pressed-on `accentSubtle` fill + `accentText` icon; hover `canvas`; sticky adds a 4 px `accent` dot below; every button has
a tooltip name + kbd. ≤ 3 in a paired cell, ≤ 5 in a field column, ≤ 7 in a full row; more go to a `⋯`.

### 9.5 Grid picker (pivot)
3 × 3 dots **8 px**, **6 px** apart (36 × 36), 12 × 12 hit areas, left on the field edge; dots `surface1` with the
`controlEdge` ring; the chosen one `accent` filled; hover ring → ink; keyboard arrows move the chosen dot; focus ring on the
group. The row is 36 px; the word label is vertically centred.

### 9.6 Toolbar (floating pill bars, HUD, text toolbar)
`surface1`, `radius.control`, padding 3 (4 for the tool picker), `shadow.level2` + `0 1 2 / .08`; items ghost sm pills /
icon buttons 28 / 28 / 28 (toolbars never shrink in Pro; FOUNDATIONS §4.21), 2 px apart; separators 1 × 16 `border`,
2 px margins. Height 34 (tool picker 42).

## 10. Buttons (pills)

Variants × sizes from Components.dc: **lg 42 · md 34 · sm 28** (Pro sm 24 in panels only), padding 20 / 14 / 12 (sm in
panels 8), Geist 15 / 13.5 / 12.5, **600**, `radius.control`, gap 7 between icon and label. Primary `accent` + white;
Agent `agent` + white; Agent soft `agentSoft` + `agentInk`; Secondary `surface1` + `text` + 1 px `controlEdge`; Ghost
transparent + `textMuted` (ink on hover) — `ghostInk` in dense toolbars; Danger dialogs only. Hover: secondary/ghost
`neutral3` fill; primary 8 % darker (`accentHover`). Pressed: `border` fill / 14 % darker (`accentActive`). Pressed-on
(`aria-pressed`): `accentSubtle` + `accentText`. Disabled 60 % (dialogs only). Loading: dimmed label + spinner, `aria-busy`.
Icon buttons: round, 34 / 28 / 24, icon 18 / 16 / 14, same variants. **One primary per surface.**

## 11. Button row and section actions

Button row (§3.1): sm buttons left-aligned, 8 apart, first **secondary**, rest **ghost**, one per section. Section actions
(§2) are ghost sm pills or ghost icon buttons at the heading's right. An action that offers choices is a pill with `▾`;
a choice that is a value is a menu field (§4.3). Text on pills is a verb (`Add`, `Replace…`, `Expand`), ellipsis when a
dialog or chooser follows.

## 12. Menus and popovers anchored from panels

### 12.1 Menu
`surface1`, `radius.md`, `shadow.level2`, padding 4; **min width = the trigger's width**, max 280; rows 32 / 30 / 26,
`radius.sm`, padding-inline 8, 16 px icon slot, label Geist 13, right-aligned kbd (§14), check/radio mark 16 in the icon
slot, dividers 1 px `border` with 4 px margins, group headings 11 px uppercase `textMuted` 24 px tall, submenu `▸`.
Hover/active row `canvas` fill; rows that do not apply are **absent**. Placement (OVERLAYS §1.5 + these panel rules):
a **value menu** opens `block-end`, start-aligned to its field, the checked row under the pointer when it fits, flips up
when it would leave the viewport; an **action menu** (`+ Add ▾`, `⋯`) opens `block-end`, **end-aligned** to its trigger
and flips up when needed; submenus open **towards the canvas** (inspector: `inline-start`; dock: `inline-end`). Gap 6.
Max height `viewport − 16`, then scrolls inside. Panel body scroll closes it.

### 12.2 Popover
`surface1`, `radius.md`, `shadow.level2`, **padding 14**, 8 px gap from the anchor; always in the **top layer** (`popover`
attribute / `position: fixed`), **never inside a scroller**, never clipped by a column; no horizontal scrollbar ever (if
content does not fit the width is wrong). Widths: colour popover **264** (content 236: value row `#` field 1fr · 56 ·
28; six 24 px swatches at 8 gaps = 184); font picker 264; alignment 200; milestone form 264; link form 264. Placement
from a panel: **preferred side towards the canvas** (`inline-start` from the inspector, `inline-end` from the dock),
**top-aligned to the anchor's row**; fallback: shift along the panel to fit the viewport (8 px margin); then `block-end`
end-aligned (windows < 1024 only); never over the panel it came from if the canvas side fits. One popover at a time; a
popover never opens a popover (tabs instead); light dismiss passes the click through from panels (`outside="pass"`).
Enters 120 ms opacity + 4 px translate.

### 12.3 Tooltip
`text` fill `#16151A`, white Geist 12, `radius.sm`, padding 4 8, kbd (§14) after the name, 500 ms delay then a 300 ms warm
period, gap 6, never interactive. Pro adds a second line (description, `#C3CCD7`).

## 13. Dialog layout

```
┌ 840 × 600 (settings) · 520 (form) · 420 (confirm) · 640 (wizard) ─── radius.lg (18) · shadow.level3 · surface1 ┐
│ HEADER 56: title Bricolage 600 20 · flex · step indicator mono 11 · × icon button 28     hairline               │
│ ┌ NAV 184 ───┐│ BODY · padding 24 / 20 / 16 · the ONLY scroller                                                  │
│ │ 28 px pills ││   h2 section title (Bricolage 22 on Settings)                                                   │
│ │ 2 px apart  ││   cards radius.lg, hairline, padding 16; rows on the §3 grid (label 160 in dialogs)              │
│ │ selected:   ││   …                                                                                              │
│ │ accentSubtle││                                                                                                  │
│ └────────────┘│                                                                                                  │
│ FOOTER 56: status line left (`Saved on this device`, Geist 12 muted) · actions right, one primary   hairline    │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Part | Spec |
|---|---|
| Frame | centred; width per type (OVERLAYS §1.5); max height 90 vh; `radius.lg` 18 (the design's card radius; OVERLAYS §2 says 22 for composer-like dialogs — use 22 only for the Export preview card); `shadow.level3`; backdrop `rgba(22,21,26,.32)` |
| Header | 56, padding-inline 24 / 20 / 16, hairline below; title Bricolage 600 20; step indicator Geist Mono 11 `textMuted`; close × icon button 28 at the right |
| Nav column (Settings, Export's tabs when vertical) | **184 wide**, `canvas` background, hairline on its inline-end, padding 12; items are **sm ghost pills** full width (28 / 28 / 24, Geist 13 600 `textMuted`, text left, padding 0 12), 2 apart; selected `accentSubtle` + `accentText`; hover `neutral3`; focus ring; `aria-current=page` |
| Body | padding **24 / 20 / 16**; `overflow-y: auto` — the **single scroll area**; no card, list or section inside it scrolls on its own (a long list grows the body); `scrollbar-width: thin`, `scrollbar-gutter: stable` |
| Section title in the body | Bricolage 700 22 (Settings page) / 600 20 (dialog); 16 below |
| Group heading | Geist 11 uppercase 0.06 em `textMuted` (the §2 title) |
| Rows | §3 grid with label column **160** (dialogs are wide); fields 34 tall; row gap 12 |
| Cards | `surface2`, 1 px `border`, `radius.lg`, padding 16, 16 apart; no nested cards |
| Footer | 56, hairline above; status line left; buttons md right, 8 apart, one primary; destructive dialogs focus Cancel |
| Narrow (< 900) | the nav column becomes a switcher row (§9.3) above the body |
| Motion | enter 160 ms opacity + 8 px translate; steps slide 16 px |

**Do:** one scroller. **Don't:** `overflow: auto` on both `.body` and a child; cards in a 3-column auto-fill grid that
force two-line labels — in a 600 px-tall dialog, long lists are **one column of 28 px rows** inside a card, or two
columns only above 1 100 px of body width (`minmax(320px, 1fr)`).

## 14. Key chip (kbd) glyph format

| Rule | Mac | Windows / Linux |
|---|---|---|
| Chip | Geist Mono 11 / 11 / 10, `text`, `surface1`, 1 px `border`, `radius.sm` 6, padding 0 6, height 20, `min-width` 20, centred, 4 apart when several | same |
| Modifier order | **⌃ ⌥ ⇧ ⌘** (Apple's order), no separators, one chip per combo (`⇧⌘→`) | `Ctrl+Shift+→` with `+` separators, one chip |
| Arrows | `← ↑ → ↓` (never `ArrowRight`) | same |
| Special keys | `⏎` Enter · `⌫` Delete/Backspace · `⌦` Forward delete · `⎋` Esc · `⇥` Tab · `␣` Space · `⇞ ⇟` Page · `↖ ↘` Home/End | `Enter` `Backspace` `Del` `Esc` `Tab` `Space` `PgUp` `PgDn` `Home` `End` |
| Letters, digits, symbols | uppercase letter; `,` `.` `/` `\` `[` `]` `-` `=` as typed; `?` not `Shift+/` | same |
| Chords (sequence) | chips joined by ` then ` in Geist 12 `textMuted` (`G then L`) | same |
| Alternatives | chips joined by ` / ` | same |
| Mouse | `Click`, `Drag`, `Scroll` as words in the chip, modifiers before (`⌥ Drag`) | same |
| In menus and tooltips | the same chip without the border (plain mono `textMuted`), right-aligned | same |

Only shortcuts that **work right now** are shown anywhere (tools that are not shipped, lens keys without a lens,
DevTools unless on): the registry snapshot is the source and the sheet filters by availability.

## 15. Tag and chip

Tags are not pressable: 24 px pills, Geist 12 500, padding 0 10, gap 6: **mist** (`neutral3`, `text`) info; **agent**
(`agentSoft`, `agentInk`, 600, `✦`); **lens** solid lens colour (`#16151A` text except blue → white); **mono** (`neutral3`,
`textMuted`, Geist Mono 11, height 20, padding 0 8) for tokens, counts and codes. The More row's count tag and the
collapsed summary are mono tags without the pill (summary) or with it (count).

## 16. Further blocks (everything else that is visible)

Compact anatomy for the blocks §1–§15 do not cover. Same conventions; F / S / P only where a block changes with density
(overlays, dialogs and Home do not, except their padding token).

| Block | Parts · sizes · type · colour · radius | States | Do / don't |
|---|---|---|---|
| **Card** (Home design, template, project, quick action; `sf-card`) | `surface1`, 1 px `border`, `radius.lg` 18, `shadow 0 1 2 / .04`; padding 18 (quick action, min-height 136) or none (design card: thumbnail 158 tall `radius.lg` with a lens tag at 10 / 10, then 10 gap, title Geist 600 14, meta Geist 13 `textMuted`); lens shape 30 px (`radius 8` square / circle / 42 × 26 `radius 9` / 44 × 26 pill); leading checkbox and `⋯` at 8 / 8 | hover: border → `controlEdge`; active: 1 px inset; selected: `accent` border + 1 px ring + `accentSubtle`; drop-target: 2 px `accent` outline; dragging 50 % | one title size per grid; 4 columns ≥ 1180, 3 ≥ 900, 2 below (FOUNDATIONS §3.4) |
| **Page column** (Home, Settings page) | max 1180 centred, padding 40 28 64; sections 44 apart; header 64 (`padding 0 28`, logo 28 + wordmark Bricolage 800 21, nav switcher, primary md at the right); h1 Bricolage 800 72 (Pro: gone), h2 Bricolage 800 24 | — | never a hero in Pro |
| **Composer** (Home hero, Chat) | card `radius 22`, padding 16, textarea Geist 16 borderless, bottom row: secondary sm chips, agent chip, `✦ Start making` agent lg at the right | focus ring on the card | |
| **Chat bubble** | `neutral3`, `radius 20 20 6 20`, padding 10 16, max 540 (Studio side panel: 230, padding 8 13, `radius 18 18 6 18`), `align-self: end` | — | the agent's reply is plain text, never a bubble |
| **Thread row** (Chat rail 256) | md pill 34, full width, text left; selected `surface1` + `shadow.level1`; group heading §2 title style with padding 12 8 2 | hover `neutral3` | |
| **Mini-editor card** (Chat) | card, head 52: lens shape 14 · title Bricolage 700 16 · mono code tag · switcher · `✦ Rewrite` soft sm · right: secondary sm; body `#E4E9EF` padding 16, `radius 0 0 18 18` | — | |
| **Status dot** (`sf-status`, `if-save-status`) | 7 px dot + Geist 12 / 13 `textMuted`; `success` `#00A372`, warning, danger; busy pulses | — | text uses `successText`, never the dot colour |
| **Banner** (`sf-banner`) | 40 tall in-flow, padding-inline 20, `infoSubtle` / `warningSubtle` / `dangerSubtle`, hairline below; 16 icon · message Geist 13 · ghost sm action · × icon button 28 | — | one per region |
| **Toast** (`sf-toast`) | bottom-centre above the command bar, ≤ 420 wide, `surface1`, `radius.lg` 18, `shadow.level2`, padding 12 16; message Geist 13 · one action (secondary sm or ghost) · × 28; newest at the bottom, 8 apart, max 3 | enter 160 ms rise 8; dismiss 80 ms | one action |
| **Progress row** (`sf-progress-row`) | label Geist 13 · value mono 11 right · 4 px track `neutral4` with `accent` fill (indeterminate: 40 % sweep) | — | |
| **Blocking error** (`sf-blocking-error`) | full-surface `canvas`; one card max 420, `radius 22`, padding 24, `shadow.level3`: heading Bricolage 600 20, message Geist 14, `fix` primary md, `Copy diagnostics` ghost, `Reload` secondary | — | the only screen with 22 px corners besides the composer |
| **Boundary error** (`sf-boundary`) | a §13 card inside the region it guards: 16 padding, `radius.lg`, heading Geist 600 13, message Geist 13 `textMuted`, `Retry` secondary sm; never mono body text | — | |
| **Hint / coach mark** (`sf-hint`, `studio/hints.ts`) | `surface1`, `radius.md` 12, `shadow.level2`, padding 8 8 8 12, max 280, Geist 13; × 24 ghost; arrow-less, anchored 8 from its target | auto-expire | one at a time (OVERLAYS §5) |
| **Skeleton** (`sf-skeleton`) | lines 14 px tall, `radius 4`, `color.skeleton`, last line 60 %; row/cards keep their real sizes | shimmer off under reduced motion | |
| **Skip links** (`sf-skip-links`) | on focus: a `accent` pill 34, white Geist 13 600, 8 from the top-left | — | |
| **Command palette** (`sf-capability-palette`, `sf-command-palette`) | 560 wide (≤ 90 vw) card `radius.lg`, `shadow.level3`; search row 56: `✦` or magnifier 16 · Geist 15 input; list max 60 vh, padding 4, rows 40 `radius.md`: title Geist 13 (matches 600 underlined `accent`) · description Geist 12 `textMuted` · kbd §14 right; selected `surfaceSelected` | — | one palette implementation (the shell's is a duplicate, see §18) |
| **Command bar** (`if-command-bar`, canvas bottom-centre) | pill 44 tall, min 520 (`min(520px, 100% − 48)`), `surface1`, 1 px `border`, `shadow 0 1 2 / .06 + 0 12 32 / .10`, padding 0 6 0 16: `✦` `agentInk` · Geist 13.5 placeholder · kbd §14 (mono tag) | focus ring; opens the filterable menu above it | |
| **Zoom pill** | 34 tall pill, `surface1`, 1 px `border`, padding 3: icon ghost 26 · mono 12 value · icon ghost 26 | value opens a menu | |
| **Find bar** (`if-find-bar`) | 420 wide card `radius.lg`, `shadow.level2`, padding 12, top-right 16 / 16: row 1 field 32 flex + match count mono 12 (min 52) + `↑ ↓ ×` icon buttons 28; row 2 (Replace open): kind menu field, scope menu field, replace field, `Replace` secondary sm, `Replace all` primary sm | — | |
| **HUD pill** (`if-hud`, STUDIO §4.2) | pill 34, `surface1`, padding 3, gap 2, `shadow 0 1 2 / .08 + 0 10 28 / .18`; items ghost sm 28 (swatch button, value menus as ghost pills **here**, numbers 72 wide mono-free field 28, font name max 140); separators 1 × 16; `⋯` last | — | ≤ 6 items + `⋯` |
| **Context menu** (`studio/context-menu.ts`) | §12.1 menu at the pointer, ≤ 18 rows, submenus `▸` | | |
| **Size field** (`sf-size-field`) | a §3 paired row `W·H` with `🔗` in the gutter, then a §9.3 two-option switcher `Portrait · Landscape` and a units **menu field** (§4.3) — not a native `select` pill | error line under the row | |
| **Colour field** (`sf-color-field`) | 34 field: 16 round swatch (§5) in the left padding · hex Geist 13 (not mono) · opens the §12.2 popover | invalid border `accent` | never the native picker as the UI |
| **Copy field** (`sf-copy-field`) | 34 field, value Geist Mono 12 (a code: mono is right), `Copy` secondary sm at the right inside the row; copied: `✓ Copied` 1.5 s | | |
| **Inline edit** (`sf-inline-edit`) | viewing: the text with 4 px inline padding and `radius.sm` hover; editing: a 24–28 field with `accent` border, `radius.md`, text selected | invalid: `danger` border + error line | |
| **Confirm row** (`sf-confirm-row`) | 30 row: message Geist 13 600 · `Cancel` ghost sm · verb danger sm (destructive) or primary sm | Escape cancels | inline, never a dialog over a dialog |
| **Font picker** (`sf-font-picker`) | 264 wide (content 236), 332 tall: search field 32, group headings §2 title style, rows 32 with the family in its own face at 15 px, `aria-selected` `accentSubtle`, download icon for uncached | | |
| **Align popover** (`sf-align-popover`) | 200 wide: 3 × 3 grid of icon buttons 28 (icon 18), hairline, `Align to` two-option switcher | | |
| **Takeover** (`sf-takeover`) | full surface `canvas`; header 48 `surface1` hairline below: back ghost sm · title Geist 600 13.5 · meta Geist 12 `textMuted` · actions md right; body scrolls | | |
| **Tabs with underline** (`sf-tab` default look) | **not used in Instaflow**: every tab set is a §9.3 switcher; the kit's underline variant stays for StaticFlux consumers | | |
| **DevTools** (`sf-devtools`) | its own dark theme (`--sf-devtools-*`), monospace 12, 3–4 px radii: **deliberately not Clean Pop** (DEVTOOLS §2 — a developer surface, never seen by normal users) | | left as is |

## 17. Every component in the repo: block, what is off, correction, kind

Checklist = `UI-INVENTORY.md` (74 elements + render helpers). **Skipped (render nothing visible):** `sf-anonymous`,
`sf-scope`, `sf-island`, `sf-surface-host`, `sf-surface-outlet`, `sf-surface-layer` (a positioning host; its toast and
banner children are covered), `sf-shell` (slots only). **Kind:** *drift* = the build departs from Clean Pop or a rule the
docs had; *gap* = nothing defined it; *ok* = matches.

| Element | Block (§) | Off today | Correction | Kind |
|---|---|---|---|---|
| `sf-button` | §10 | `font-weight: weightMedium` (= 600 in Clean Pop, ok); secondary hover `surfaceHover` = `canvas` (design: `neutral3`); sm pad 12 everywhere (panels want 8) | hover `neutral3`; `--if-pill-pad-sm` 8 inside panels | drift (hover) · gap (pad) |
| `sf-icon-button` | §10 | round, `inline-size: var(--kit-height)` → 34 md / 28 sm / 24 Pro sm, ok; shortcut kbd in tooltip prints raw key names | §14 glyph map in `comboLabel` | drift |
| `sf-icon` | §9.4 | sizes 16 / 18 / 24 only | add 14 (Pro rows, paint-row eye/×, which today pass `size="14"` and get 16) | gap |
| `sf-tag` | §15 | 24 tall, pad 10, `sizeSm` 12.5 (design 12), `mono` keeps 24 (design code tag 20, pad 8, 11 px) | `mono`: 20 / 8 / 11 | drift |
| `sf-card` | §16 | padding `space.lg` 20 (design 18), `surface2` ok, shadow missing (`0 1 2 / .04`), hover `controlEdge` ok | padding 18 via `--kit-card-padding`; add the shadow | drift |
| `sf-tabs` / `sf-tab` / `sf-tab-panel` | §9.2 | underline tabs 34 tall with a 2 px `accent` bar and a hairline under the list — Clean Pop has **no underline tabs**; `sf-tab-panel` pads 0 (fine) but the dock relied on it | Studio dock uses `sf-segmented` as the tabs header (§9.2); keep `sf-tabs` for StaticFlux | drift |
| `sf-segmented` | §9.3 | ok (track 3, gap 2, pills); default `size="md"` → 34 pills (design: sm 28 inside a 34 track) | panels pass `size="sm"`; full-row mode (`stretch`) | drift (size) · gap (stretch) |
| `sf-toolbar` | §9.6 | `size.toolbar` 48 tall, pad 8; Instaflow panels use it for button rows (Pages, Assets, Milestones) | toolbars only float (HUD, tool picker); panel actions are §11 button rows or §9.2 header controls | drift |
| `sf-tooltip` | §12.3 | `neutral12` on `neutral1`, `radius.sm`, pad 4 8, `sizeSm` — ok; kbd mono ok but raw key names | §14 glyphs | drift (glyphs) |
| `sf-menu` / `sf-menu-item` / `sf-menu-group` | §12.1 | rows `size.row` 30 ok, `radius.sm` ok, floating pad 4 ok, `floating` border + `shadow.level1` (spec `level2`); `min-inline-size` not tied to the trigger; action menus not end-aligned | `shadow.level2`; `min-width = trigger`; `align="end"` for action menus; submenus towards the canvas | drift · gap |
| `sf-popover` | §12.2 | pad 14 ok; `radius.lg` 18 (spec `radius.md` 12 — FOUNDATIONS §4.9 says 12); `max-inline-size: min(360, …)` ok; side default `block-end`; panel popovers do not pass `inline-start` | `radius.md`; inspector/dock pass side towards the canvas, `align="start"` to the row | drift (radius) · gap (side) |
| `sf-color-popover` | §12.2 | 236 wide host inside a 14-pad popover = 264 total, but the value row (`.hex` + opacity 72 + eyedropper 28 + gaps) overflows → crop + scrollbar (#45); grid 6 × 24 ok | value row `1fr · 56 · 28`, `min-inline-size: 0` on `.hex`; `overflow-x: clip` | drift |
| `sf-color-field` | §16 | swatch square `radius.sm` inside; hex mono lowercase; native `<input type=color>` over the swatch | round §5 swatch opening the §12.2 popover; Geist hex | drift |
| `sf-copy-field` | §16 | ok (mono is right for codes) | — | ok |
| `sf-confirm-row` | §16 | row 30, message 600 ok; buttons `sm` ok | tone `danger` verb must be the kit danger variant | ok |
| `sf-disclosure` | §2, §8.3 | heading `min-block-size: size.row` 30 (spec 28); inline pad 4 (spec 0); chevron 16 (spec 12); no `actions` slot; `.summary` mono 11 end-aligned ok; `more` count tag ok | 28 heading, pad 0, chevron 12, `actions` slot | gap |
| `sf-dock` | §1 | renders a `.bar` with a collapse chevron above the content; rail 48 (`size.railWidth`; spec 44); `size` 320 default; body no padding | `chrome="none"`; rail 44; padding `--if-panel-pad` on the body | drift |
| `sf-panel` | §1, §2 | own disclosure header (`Inspector ▾`, 30 tall, `textMuted`), body pad 8, `overflow: auto` on the body (a second scroller inside the dock) | `headless` mode; no body padding; one scroller | drift |
| `sf-inspector-group` / `sf-inspector-row` | §2, §3 | legacy: group toggle 30 with chevron 16 and pad 8; row `minmax(64px, 36%) 1fr` label column, stacks under 240 px; used only by the legacy panels below | retire in favour of §2/§3 helpers; the legacy panels (`if-paint-inspector`, `if-repeat-inspector`, `if-typography-panel`, `if-transform-bar`, `if-export-panel`) either adopt `<if-inspector>` sections or are deleted | drift (superseded by B11b) |
| `sf-number-field` | §4.2 | mono input; label outside; unit inside ok; `size` md 34 default | UI font + tabular; glyph-inside mode; height from `--if-field` | gap · drift (height) |
| `sf-text-field` | §4.3 | label above (right for dialogs), `label-hidden` for rows ok; height 34 default | `--if-field` 32 inside panels; `type=search` magnifier | ok · gap |
| `sf-size-field` | §16 | inputs `7.5rem` mono, units as a native `<select>` styled as a **pill**, orientation segmented | §3 paired row, §4.3 menu field for units | drift |
| `sf-slider` | §7 | pill value, `min-inline-size: 120` | `value="field"` mode in panels | gap |
| `sf-swatch` | §5 | ok (16 / 24, checkerboard, hatch) | — | ok |
| `sf-tree` | §9.1 | row pad end 8 only, no start pad → highlight touches the panel edge; badge `sizeXs` ok; text inherits 13.5 | start pad 8; highlight `radius.control`; text 13 | drift |
| `sf-inline-edit` | §16 | ok; input `radius.md` fine | — | ok |
| `sf-hint` | §16 | ok (12 radius, 280, 13 px) | — | ok |
| `sf-status` | §16 | dot 7 ok; `sizeSm` 12.5 (design 12 / 13) | — | ok |
| `sf-banner` | §16 | 40 tall, pad 20 ok | — | ok |
| `sf-blocking-error` | §16 | card 420, 22 radius, `surface3` ok | — | ok |
| `sf-progress-row` | §16 | 4 px track, `neutral4` (design slider track `neutral7`) | track `neutral7` | drift |
| `sf-toast` | §16 | 420 wide ok; toast card styles not inspected beyond width | verify `radius.lg` 18, padding 12 16, `shadow.level2` | gap |
| `sf-dialog` | §13 | `grid auto 1fr auto`, pad 24 everywhere, `.body overflow: auto` **and** content scrollers → two bars (#56); modal frame `radius 22` (spec 18), `surface3`; header h2 Bricolage 20 600 ok | one scroller rule; frame `radius.lg`; nav column variant for Settings | drift |
| `sf-takeover` | §16 | header 48, pad 20 ok | — | ok |
| `sf-shortcut-sheet` | §13, §14 | input `radius.sm` (fields are 12), platform switch is a bordered box (should be a §9.3 switcher), cards `auto-fill minmax(15rem)` → wrapped labels, `kbd` border `radius.sm` 8 (spec 6) with raw key names | one-column 28 px rows; switcher; §14 chips | drift · gap |
| `sf-capability-palette` | §16 | 480 min (design 560), rows `radius.md`, search `sizeLg` 15 ok | 560; kbd glyphs | drift |
| `sf-command-palette` (shell) | §16 | legacy: hard-coded indigo `#4f46e5` selected rows, 4 px radii, `0.85em` meta — not themed | delete or re-skin on `sf-capability-palette` | drift |
| `sf-font-picker` | §16 | 236 wide (+14 pad = 264 ok), rows 15 px in-face ok, filter `size.control` 34 (panels: 32) | — | ok |
| `sf-align-popover` | §16 | grid of 34 icon buttons (default size) with 18 icons; spec 28 | `size="sm"` | drift |
| `sf-skeleton` | §16 | `--sf-radius-small 4`, 14 px lines ok | — | ok |
| `sf-skip-links` | §16 | hard-coded indigo `#4f46e5`, 4 px radius | `accent` pill | drift |
| `sf-boundary` | §16 | mono body text, 8 px radius, `--sf-*` fallbacks | §13 card look | gap |
| `sf-devtools` | §16 | own dark skin | leave | ok by design |
| `if-studio` | §1, §9.6 | header 56 pad 14 ok; tool picker pad 4 ok; zoom pill ok; `.proposal` card 240 wide `radius.lg` ok; renders `<sf-dock>`/`<sf-panel>`/`<sf-tabs>` chrome around panels | headless panels; dock tabs = switcher | drift |
| `if-inspector` | §1–§8 | see INSPECTOR §5 (padding, grid, fields, stacks, popovers) | INSPECTOR §2 | drift · gap |
| `if-layers-panel` | §1, §9.1 | no padding (from the dock); filter 34; tree text 13.5; empty line 13 ok | §9.2 header rows; 32 field; row text 13 | drift |
| `if-pages-panel` | §1, §9.1 | legacy frame: Bricolage `sizeLg` heading inside the panel, pad 16, tree 240 tall fixed, `sf-toolbar` of five sm buttons at the bottom | §9.2 header (`+ Add page` right); rows 44 with thumbnails; `⋯` per row; drop the toolbar | drift |
| `if-library-panel` (Assets) | §1 | legacy frame as Pages: heading, 160 px drop zone `neutral3`, filter switcher, tree, toolbar | §9.2 header (`Import` right); 3-column grid; drop zone = the whole panel outline | drift |
| `if-milestones-panel` | §1, §9.1 | legacy frame: heading, name field + `Create` primary **md**, tree, toolbar of six buttons | §9.2 header only; rows 44; row `⋯` menu; creation from the top bar (STUDIO §3.4) | drift |
| `if-paint-inspector` | §6, §8 | legacy B6 panel on `sf-inspector-group`: text fields for colours, `−` text glyph buttons, `+ Add fill` ghost under rows | superseded by `inspector-paint.ts`; delete | drift |
| `if-repeat-inspector` | §3 | legacy: text fields for numbers, segmented md | superseded by `inspector.ts` `repeatSection`; delete | drift |
| `if-typography-panel` | §3 | legacy: sliders for size and line height, `B I U` text pills, secondary `Font` trigger | superseded by `inspector-text.ts`; delete | drift |
| `if-transform-bar` | §3 | legacy: text fields in a `1fr 1fr` grid, `⛓` glyph, text `Flip` buttons | superseded by `transformSection`; delete | drift |
| `if-export-panel` | §13 | legacy B? panel on `sf-inspector-group` with three segmented controls and a `Transparent background` toggle pill; the real Export is a dialog (OVERLAYS §2.3) | delete or route to the Export dialog | drift |
| `if-hud` | §16 | pill pad 3, gap 2, shadow ok; numbers 72 wide mono; `size="sm"` items ok; value menus are ghost pills (correct **in a pill**) | number fields Geist tabular 28 tall | drift (mono) |
| `if-command-bar` | §16 | `min-block-size: 36` / `min-inline-size: 280` (design 44 / 520), `border` hairline ok, kbd mono 11 as a bordered tag (design: mist code tag) | 44 tall, `min(520px, 100% − 48)`, kbd §15 mono tag | drift |
| `if-find-bar` | §16 | 420, `radius.lg`, pad 8 (spec 12), match count mono 12 ok, 16 px square colour swatch | pad 12; §5 round swatch | drift |
| `if-settings` | §13 | nav 184 ok, links 8 12 pill (≈ 32; spec 28 sm pill), `aria-current` `accentSubtle` ok; `gap: space.xl` 24 between nav and body; sections `flex gap 20`; h2 Bricolage 22 ok; density cards `radius.lg` pad 16 ok; its body scrolls separately from `sf-dialog .body` | nav as a column with its own `canvas` background and hairline; one scroller (the dialog body) | drift |
| `if-home` | §16 | uses `sf-card`, `sf-tag`, `sf-segmented`, `sf-menu` correctly; header `＋ New design` primary with a **separate** primary chevron icon button (design: one pill); `Project ▾` / `Sort ▾` as secondary sm with a text `▾` (should be the chevron icon); bulk bar buttons ok; not inspected line by line (1 695 lines) | one split pill or a single `＋ New design ▾`; chevron icons; a follow-up pass on Home against HomeCP | drift (minor) · gap (audit) |
| `if-new-design` | §13 | dialog 520, `radius 18`, pad 24, h2 Bricolage 22 ok; format chips are 32 px **pills with a border** (design: secondary sm 28); size field mono; units a native select | chips = secondary sm 28 (pressed-on `accentSubtle`); §16 size field | drift |
| `if-missing-design` | §16 | header 64 pad 24 (design 28); h1 Bricolage 32; body max 420; primary md | pad 28 | ok (minor) |
| `if-save-status` | §16 | `sf-status` | — | ok |
| `studio/context-menu.ts` | §12.1 | `sf-menu` at the pointer, ok | — | ok |
| `studio/hints.ts` | §16 | `sf-hint` ok | — | ok |
| `studio/shortcuts-sheet.ts` | §13 | wires `sf-shortcut-sheet` into the Settings dialog; lists unbuilt tools | availability filter (§14) | drift |
| `inspector-paint.ts`, `inspector-text.ts`, `inspector.ts` sections | §3–§8 | INSPECTOR §5 | INSPECTOR §2 | drift · gap |

## 18. Where the build departs (anatomy level, 2026-10-27)

| Block | Build | This file |
|---|---|---|
| Panel frame | `<sf-dock>` collapse bar + `<sf-panel>` header render above the inspector; `<sf-panel .body>` pads 8; tab panels pad 0 → Layers content on the edge (#40); inspector `header` 12 × 14, `section` 6 / 12 | §1: pad 14, header 40, no kit chrome |
| Section | `<sf-disclosure>` button has 4 px inline padding and `min-block-size: row` (30); chevron 16; summary mono 11 (ok); no `actions` slot | §2 |
| Row grid | `.grid2` `1fr 1fr` 8 and `.row` flex-wrap; no label column, no gutter; `.label` `min-inline-size: 72px` but inline-flex | §3 |
| Number field | mono input; label outside (`grid auto 1fr`); unit inside (ok); per-use `inline-size` 64 / 52 / 5.75rem | §4.2 |
| Menu triggers | ghost sm pills for Blend, Fit, Position, Weight, Style | §4.3 menu field |
| Paint row | `.line` min-height 34; two-line summary (`display: grid`); 64 px opacity; eye and × always; `+ Add ▾` + image icon button under the rows, wrapping | §6, §8 |
| Slider | mist pill value (`.value`), `min-inline-size: 120px` | §7 |
| Switcher | `size="md"` 34 px segments in panels; dock tabs `sf-tabs` with underline style (`block-size: 2px` indicator) instead of the mist track | §9.2–9.3 |
| Tree row | `padding-inline-end: 8`, no start padding; `--sf-size-row` 30 (ok); icon 14 (ok); text 13.5 (`sizeMd`) | §9.1 |
| Pivot | 14 px dots, 4 apart; label far left | §9.5 |
| Colour popover | `inline-size: 236px` with the value row overflowing → cropped and a horizontal scrollbar (#45) | §12.2 264 |
| Dialog | `<sf-dialog>` `.body overflow: auto` **and** settings `section`/sheet scroll → two bars; sheet cards `auto-fill minmax(15rem)` → wrapped labels; `kbd` prints `ArrowRight` (`comboLabel` passes `p.key` raw); nav links 8 × 12 (ok, ~32 tall); Tools card lists Pen, Brush, Heal, Crop, Split, Connect (#56) | §13, §14 |

**Code homes.** Tokens: `apps/instaflow/src/theme/clean-pop.ts` (`--if-*` under `data-sf-density`). Kit: `disclosure`
(actions slot, 28 heading), `number-field` (glyph prefix, UI font), `slider` (`value="field"`), `menu`/`button`
(`variant="field"` trigger), `dock`/`tabs` (headless, no padding), `tree` (row padding), `color-popover` (264),
`shortcut-sheet` (one column, glyphs), `a11y/shortcuts` `comboLabel` (key glyph map). Instaflow: `studio/inspector*.ts`,
`studio/layers-panel.ts`, `studio/studio-element.ts`, `settings/settings-element.ts`. The per-element list is §17.

## 19. Sources consulted

Web access from this session failed for every design reference tried (DNS refused `figma.com`, `help.figma.com`,
`linear.app`, `uxplanet.org`; Apple's HIG pages return only a title to a fetch because they render client-side). The
only web results were search snippets about Figma's UI3 panel reorganisation ([Figma: Inside the redesigned Figma](https://www.figma.com/blog/behind-our-redesign-ui3/),
[Figma Help: Navigating UI3](https://help.figma.com/hc/articles/23954856027159), [Figma forum: UI3 properties panel gripes](https://forum.figma.com/archive-21/ui3-properties-panel-gripes-8217)),
which confirm two choices here — position above size, fixed places for controls — and the user complaint that
inconsistent input placement makes a panel "hard to scan". Everything else is from the repository's own design source and
the general conventions already named in the UX docs (Figma's gutter for the link toggle and `+` in section headers,
Apple's ⌃⌥⇧⌘ modifier order and disclosure triangle, Linear's one-column settings with a left nav); those are stated
from working knowledge, **not** from pages read in this session. Treat them as conventions to verify, not citations.
