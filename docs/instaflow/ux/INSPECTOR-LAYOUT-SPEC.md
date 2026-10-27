# Instaflow inspector, dock and Settings layout — mapping (Layer 2)

> Status: **normative** for which `COMPONENT-ANATOMY.md` block every inspector section, dock panel and the Settings
> dialog uses, in what order, with which tokens. Written 2026-10-27 for **#55** (inspector disorganised), **#40** (dock
> padding, oversized UI), **#45** (cropped colour popover), **#47** (polygon sides) and **#56** (Settings › Shortcuts).
> **This file adds no visual rules.** Every size, colour, state and alignment is in `COMPONENT-ANATOMY.md` (cited as
> **CA §n**); what a control does is in `STUDIO-UX-SPEC.md` §5, `APPEARANCE-TRANSFORM-UX-SPEC.md`, `TEXT-FONTS-UX-SPEC.md`
> and `DENSITY-DISCLOSURE.md` §3.2 / §8.1 (tiers). Where this mapping and an older layout sketch disagree (STUDIO §5.2,
> APPEARANCE §2.1 ASCII, §3.2 ASCII), this file wins.

Row-type letters (CA §3.1): **L** single value · **P** paired · **H** half pair · **S** slider + value · **W** switcher ·
**T** switch · **G** icon group · **D** grid picker · **V** menu field · **R** paint row · **A** stack with heading action ·
**E** empty stack · **M** More row · **B** button row · **X** text row · **O** read-only value.

## 1. Frames

| Surface | CA block | Tokens |
|---|---|---|
| Inspector | CA §1 panel frame: title header (name · kind tag · lock) · body of CA §2 sections · footer (undo `↶ ↷` + label) in Standard and Pro | width 264 (Pro ≥ 1600: 288); `--if-panel-pad` 16/14/10 |
| Dock (Layers · Pages · Assets · Milestones) | CA §1 frame with a CA §9.2 tabs header (switcher row; optional second row for the panel's own control) · body = the list (CA §9.1) or grid | width 236 (Pro ≤ 320) |
| Focus | both as rails; a rail click opens the CA §1 floating card with one section (inspector) or the panel (dock) | |
| Pro dock | two stacked CA §1 frames (Layers above, the last other tab below), each with a 32 px header row; splitter between | |
| Settings | CA §13 dialog (840 × 600 over Studio; a page in Home's shell with the same body) | nav 184 |

Popovers and menus from any of these: CA §12 (top layer, towards the canvas, 264 wide colour popover — resolves #45).

## 2. Inspector sections → blocks

Order per selection kind is STUDIO §5.1 with two changes: **Background** is its own section after **Page**; the
**Corners** slot is headed **Shape** for polygons and stars (#47). Collapsed-by-default sections (▸) and `More ▾` tiers
are DENSITY §3.2; Pro pins everything (CA §2).

| Section | Rows in order (Standard) | Behind `More ▾` (Standard) / Pro additions |
|---|---|---|
| **Page** (nothing selected) | **L** `Name` · **V** `Size` presets · **P** `W·H` with `⇄` swap in the gutter | **M**: **T** `Orientation lock` · **B** `Apply background to all pages` (when > 1 page) / Pro: **P** margins, **P** bleed (Print) |
| **Background** | **A** heading `BACKGROUND · + Add ▾` · **R** rows (fill anatomy) · **E** `No background` | second line per CA §6 |
| **Document** | **L** `Title` · **O** `Pages` · **O** `Units` (becomes **V** when Units lands) | Pro: **O** provenance line |
| **Transform** | **P** `X·Y` · **P** `W·H` + `🔗` gutter · **H** `∠` + **G** rotate 90° `[↺][↻]` · **X** locked note (when any) · **B** `Apply · Cancel` (during a transform session only) | **M**: **H** `⟂` skew + **G** flips `[⇋][⇅]` · **D** `Pivot` / Pro: **P** `∠·⟂`, **G** `Flip` row, **D** always, **V** `Relative to` |
| **Fill** | **A** heading `FILL · + Add ▾` · **R** rows: swatch · `@cream · #FFF4E0` · opacity 56 · eye · × · **E** `No fill` | second line: **V** `Blend`; gradient + **L** `Angle`, **G** `Reverse`; image + **V** `Fit`, **P** `X·Y`, **L** `Scale` |
| **Stroke** | **A** heading `STROKE · + Add ▾` · **R** rows: swatch · `#16151A · Inside` · **width 56** · eye · × · **E** `No stroke` | second line: **V** `Position` · **V** `Dash` (Custom → **P** `Dash·Gap`) · **V** `Cap` · **V** `Join` · **L** `Opacity` · **T** `Sides` (rect, frame, image) → **P** `T·R`, **P** `B·L` · **V** `Blend` / Pro: **L** `Miter limit` |
| **Effects** ▸ | **A** heading `EFFECTS · + Add ▾` (preset menu) · **R** rows: kind icon · `Shadow · Soft` · eye · × · **E** `No effects` | second line: shadow **P** `X·Y`, **P** `Blur·Spread`, **R** colour (swatch · hex); glow **P** `Blur·Spread` + **T** `Inner`; blur **L** `Radius`; a `Bevel` preset shows as a mono tag in the detail |
| **Layer** ▸ | **S** `Opacity` (56 px `%` field) · **V** `Blend` | Pro: same; groups (M2) + **X** `Applies to the group as one` |
| **Text** | **V** `Style` · **V** `Font` (family shown in its face) · **P**-shaped row: **V** `Weight` in cell 1 · **L**-field `Size` with presets `▾` inside in cell 2 · **R** `Colour` (swatch · hex only) · **G** `B I U S 🔗` (full, label hidden) · **G** `Align` + `List ▾` pill at the group's end | **M**: **P** `Line·Letter` · **P** `Before·After` · **L** `Indent` · **W** `Auto-size` (3, full row) · **W** `Vertical` (fixed boxes) · **G** `Case ▾ · x₂ · x² · ⌫` · **B** `Fit to box` (overflowing fixed boxes) / Pro: TEXT §4.4 rows as **L**/**P** |
| **Image** | **V** `Fit` · **O** `Source` · **B** `Replace…` | **M**: **P** `X·Y` (crop `%`) · **H** `Scale` + **V** `Rotate` · **B** `Reset crop` (when cropped) / Pro: adjustments as **S** rows (A-10) |
| **Frame** | **T** `Clip content` · **X** one-line group/frame explanation · **B** `Convert to group` | ▸ Layout grid section when it lands |
| **Shape / Corners** (one section id; heading `SHAPE` for polygon and star, `CORNERS` for rect, frame, image) ▸ | heading action `⊞` per-corner · polygon: **L** `Sides` (3–1000; HUD rank 3) · star: **L** `Points`, **S** `Inner radius` · **L** `Radius` (or, with `⊞` on, **P** `◜·◝`, **P** `◟·◞` corner-glyph fields) · **S** `Smooth` | Pro: always the four corner fields |
| **Repeat** | **W** `Radial · Grid · Mirror` (full) · radial **P** `Count·Radius` / grid **P** `Rows·Columns` / mirror **V** `Axis` + **L** `Offset` · **X** `8 instances` · **B** `Expand · Release` | **M**: radial **P** `Start·Sweep`, **T** `Rotate copies`; grid **P** `Gap X·Gap Y`, **P** `Offset X·Offset Y`, **V** `Brick`, **S** `Shift`; mirror **L** `Angle` · then a hairline and the source's sections |
| **Combine** | **W** `Union · Subtract · Intersect · Exclude` (full, icon + label) · **B** `Release · Flatten` | — |
| **Mask** | **W** `Clip · Alpha · Luminance` (full) · **T** `Invert` · **B** `Release` | Pro: **B** adds `Swap mask` |
| **Locked** (only section) | **X** `This selection is locked…` · **B** `Unlock` | — |
| **Multi-selection** Fill / Stroke | **A** heading with `Replace all ▾` as the action · one **R** mixed row (hatched swatch, `Mixed fills`) | — |

The HUD (STUDIO §4.2) is unchanged by this file except that `Sides` / `Points` ranks 3 for polygons and stars.

## 3. Dock panels → blocks

| Panel | Header rows (CA §9.2) | Body |
|---|---|---|
| Layers | switcher · `Filter layers` search field (spans the content) | CA §9.1 tree rows 32/30/26; page row at level 0; empty: **X** with the two tool links; Pro: eye/lock pinned, W × H column, `Expand all / Collapse all` icon buttons in row 2 |
| Pages | switcher · `+ Add page` sm secondary at the right | CA §9.1 rows 44: 48 × 36 thumbnail (12 px corners) · name · size mono tag · `⋯` hover; Pro 36, two-column thumbnails 32 |
| Assets | switcher · `Import` sm secondary at the right | 3-column grid (Pro 4), 8 gaps, 12 px thumbnails with the lens mark; empty: **X** `Drop images here or press Import.` |
| Milestones | switcher only | CA §9.1 rows 44 (Pro 36): name · time mono; note on line 2 in Standard; `⋯` hover (Pro always) |

## 4. Settings dialog → blocks (#56)

| Part | CA block |
|---|---|
| Frame | CA §13: 840 × 600 (90 vh max), header 56 with `Settings` and ×, **nav column 184** (General · Keyboard shortcuts · Storage · Assistant (M2) · About as sm ghost pills, selected `accentSubtle`), **body = the single scroll area**, footer 56 with `Saved on this device` at the left and no buttons (nothing to save) |
| General | section title · groups: `Density` as a 3-card radio row (cards CA §13, each with the one-liner) · **W** `Theme` · **V** `Units` · **L** `Nudge` + **L** `Shift nudge` (paired as **P**) · **T** `Reduced motion` · **V** `Language` · **M**: hints toggles and `Reset hints` **B** |
| Keyboard shortcuts | row 1 (in the body, not the header): `Search shortcuts` field (CA §4.3, 34 tall, `flex: 1`) · `Mac · Windows` **W** at the right (hidden in Pro, which shows both columns) · then **one card per group** in the STUDIO §2.3.1 order, each a CA §13 card with a CA §2 group heading and **28 px rows** `label … kbd`: label Geist 13 `text` left, ellipsis (never wraps); keys as CA §14 chips right (`⇧⌘→`, `⌥ Drag`, `G then L`). Cards in **one column** below 1 100 px of body width, two above. Rows for shortcuts that do not work now are **absent** (unbuilt tools, lens keys without a lens, DevTools unless on). A ghost `Print` sm pill at the body's end. The sheet itself never scrolls; the body does |
| Storage | `Space used` bar (4 px track, `accent` fill) with a mono caption · **O** persistence state · **B** `Move workspace to a folder…` · **M**: **B** `Back up (.zip)`, `Open folder…`, `GC now`; **O** mirror status |
| About | **O** version · **B** `Copy diagnostics` · **M**: licences list (28 px rows), **T** `Developer tools` (per DEVTOOLS §2) |

What was wrong in the build, by block: two scrollers (`<sf-dialog .body>` + the settings/sheet container) → CA §13 one
scroller; `kbd` showing `ArrowRight` → CA §14 (`comboLabel` must map keys to glyphs); three-column auto-fill cards wrapping
labels → one column of 28 px rows; a mouse-opened field showing the focus ring → `:focus-visible` only (CA §0); Tools card
listing Pen, Brush, Heal, Crop, Split, Connect → availability filter (CA §14).

## 5. Before → after (evidence; build B11c vs this mapping)

**Implementation drift** = the build departs from a rule the docs already had. **Spec gap** = the docs were silent or
sketched it loosely, so the build invented. Both are fixed by the CA blocks named.

| Place | Build (B11c) | After | Kind |
|---|---|---|---|
| Panel padding (dock) | Layers filter, empty line and `Page 1` row on the panel edge; `<sf-panel .body>` 8, tab panels 0 | CA §1 pad 14 on header, body, footer | drift (DENSITY §6 "section padding 14", StudioCP `padding: 0 10px`) |
| Panel chrome | kit collapse bar + `Inspector ▾` header above the content; two headers | CA §1 title header only | drift (STUDIO §5 "each heading appears once") |
| Dock sizes | tabs 34 px with 13.5 text; filter 34; row text 13.5 | CA §9.2–9.3: 28 px pills in a 34 track; field 32; row text 13 | drift (DENSITY §6, Components "Small · 28") |
| Section indents | heading button padded 4 + 16 px chevron; rows at 0; `section` 6 / 12 | CA §2: rows on the content edge, chevron 12 hanging in the heading; 12 / 14 | **gap** (no indent rule existed) |
| Vertical rhythm | `.rows` gap 4 (space.xs), `.line` min 34, `.row` wraps | CA §3: 8 gap, 32 rows, no wrap | drift (DENSITY §6 "gap between fields 8") + gap (no row-type list) |
| X Y W H | labels outside, mono, 2-up `1fr 1fr` | CA §3 **P** rows, glyph inside, Geist tabular, gutter | gap (STUDIO §5.2 sketched outside labels; amended) |
| Angle, Skew | full-width labelled fields; link toggle floating after Angle | **H** `∠` + rotate group; `🔗` in the W·H gutter; **H** `⟂` + flips | drift (STUDIO §5.2 `∠ · ⟂` side by side) + gap (where the link lives) |
| Flip, Pivot | flips after Skew on a wrapping row; 14 px dots far from a 72 px label | **H** second cell; **D** `Pivot` 8 px dots in the field column | gap |
| Fields | mono values; widths 64 / 52 / 5.75rem per use | CA §4: Geist tabular; widths from the grid | gap (FOUNDATIONS §4.5 said mono; amended, owner Q1) + drift (no widths rule → invented) |
| Opacity (Layer) | slider + mist `100%` pill | **S** with a 56 px field | gap (FOUNDATIONS §4.7 pill is for read-only places) |
| Menu triggers | ghost pills (`Normal ▾`, `Fill ▾`) in rows | **V** menu fields | gap |
| `+ Add ▾` | ghost pill **and** an image icon button under the rows, centred/wrapping | **A** heading action; image button removed | drift (APPEARANCE §2.1 had one `+ Add ▾`; its position moved to the heading here) + gap (image button was invented) |
| Paint row | two-line summary, 64 opacity, eye and × always, 34 min-height | CA §6 one line, 56, × on hover | drift (APPEARANCE §2.1 "× hover-revealed", "48 px opacity") + change (one line) |
| Stroke row | width 64 between summary and opacity → summary ~40 px | width 56; opacity to line 2 | gap |
| Empty stacks | `No fill` paragraph + the add controls below | **E** one line; action in the heading | drift (APPEARANCE §2.1 "the section shows `+ Add ▾` and the muted line") → one place |
| Menus overlapping the next section | trigger at the stack's bottom, menu drops over the next heading | CA §8.1 end-aligned from the heading; CA §12.1 flip rule | gap |
| Colour popover (#45) | 236 wide, value row overflows, horizontal scrollbar, cropped by the column | CA §12.2 264, top layer, towards the canvas | drift (STUDIO §4.2.5 "264 px") |
| Shape / Corners (#47) | no section for polygon/star; `Points` control defined, rendered nowhere | `SHAPE` section, **L** `Sides` / `Points`, rank 3 | drift (APPEARANCE §4.5 lists Points / Inner radius in Corners) |
| Text section | pills for Style/Font/Weight; wrapping Weight + Size + presets + swatch row; five full-width More fields | CA §3 **V**, **P**, **G** rows as §2 | gap (TEXT §4.2 gives tiers, not shapes) |
| Image section | Fit pill + Replace on one row; crop as a 2-up grid with word labels | **V**, **O**, **B**; **P** crop pair | gap |
| Repeat / Combine / Mask | segmented `md` in a flex row; buttons as toggle pills (`Invert`) | **W** full-row switchers; **T** switch; **B** rows | gap |
| Pivot dots | 14 px, 4 gap | CA §9.5 8 px, 6 gap, 12 hit | gap |
| Inspector footer | none | CA §1 footer (undo row) | drift (StudioCP draws it) |
| Settings (#56) | two scrollbars; `⇧⌘ArrowRight`; 3-column cards with wrapped labels; unbuilt tools listed; ring on mouse focus | CA §13, §14 | drift (STUDIO §2.3.1 "rows not available are absent", OVERLAYS §1.5 "the body scrolls") + gap (glyph map, one column) |

## 6. Where this improves on Clean Pop · final (and why)

| Design shows | Here | Why |
|---|---|---|
| `X Y W H` labels **outside** a mono field | glyph inside, Geist tabular | four aligned edges per pair, wider value, scrub handle under the eye; the outside labels are what read as floating |
| Geist Mono values | Geist tabular in editable fields; mono for read-only tokens, hex, summaries, kbd | mono in a 13 px UI reads as code and makes fields look like different controls — **owner Q1** |
| Sections without chevrons (always open) | CA §2 chevron + summary + action | Standard collapses sections (DENSITY §2); the page shows one state |
| Dock padding 10, inspector 14 | 14 for both | one frame; pills then sit 6 px from the edge as the design's row recipe implies |
| Slider value pill | 56 px field in panels | you type opacity; the pill stays where values are read |
| Text rows as `label … right-aligned value` | fields on the grid | the design's Text block was a read-only summary; the inspector edits |
| Undo footer drawn, never built | kept | it is in the approved design |

## 7. Density (what changes; tokens in CA §0)

Focus: rails + floating cards, pad 16, rows 32, gap 10, UI 14, one section per card, no summaries. Standard: docked, pad
14, rows 32, gap 8, UI 13, collapsed sections with summaries, `More ▾` rows. Pro: docked (288 ≥ 1600), pad 10, rows 28,
gap 6, UI 12, all open and pinned, no More rows, second lines open, × and row actions always visible, inspector shows
`∠·⟂`, Flip row, Pivot, `Relative to`; Layers 26 px rows with the W × H column. A mode never moves a control.

## 8. Implementer's order (what to build first)

1. Tokens `--if-panel-pad --if-row --if-row-gap --if-col-gap --if-label-col --if-gutter --if-field` on `data-sf-density`.
2. Frame (CA §1): headless dock/panel, padding, header 40, footer; tab panels pad nothing. **Closes #40.**
3. Row grid + row types (CA §3) as small Lit helpers in `inspector.ts`; glyph-inside number field; UI font with tabular nums.
4. Section (CA §2) in `<sf-disclosure>`: 28 heading, actions slot, rows on the edge.
5. Stacks (CA §6, §8): heading `+ Add ▾`, one-line rows, 56 values, hover ×; remove the image icon button.
6. Menu field, slider field mode, switch, pivot sizes.
7. Popover placement and width (CA §12). **Closes #45.**
8. Shape section with `Sides` / `Points`. **Closes #47.**
9. Settings: one scroller, nav pills, one-column shortcut cards, glyph map, availability filter, `:focus-visible`. **Closes #56.**
10. Then every section of §2 in order. **Closes #55.**

Acceptance (layout tests): all field left edges in a section equal the content edge or the paired-cell edge; every
heading action's right edge equals the content's right edge; no element's box leaves the panel padding except hairlines
and row highlights; `scrollWidth === clientWidth` on every popover; exactly one scrolling ancestor inside a dialog.

## 9. Owner questions (recommendation first)

**Q1 — Geist, not Geist Mono, in editable fields.** Recommendation **yes** (CA §4.2): tabular figures keep alignment;
mono stays for tokens, hex, summaries, tags, kbd. The design README's "Geist Mono for values" is read as *displayed*
values. If no, CA §4.2 changes one line and nothing moves.

**Q2 — Value menus drawn as fields.** Recommendation **yes** (CA §4.3): `Blend`, `Fit`, `Weight` align with fields; action
menus stay pills. The README's "anything you press is a pill" would put pills in the field column, which cannot align.

**Q3 — Background as its own section** (`PAGE · BACKGROUND · DOCUMENT`). Recommendation **yes**: the stack gets a real
heading with `+ Add ▾`; the alternative (a label inside Page) is today's look.

**Q4 — Rotate 90° buttons beside the angle at rest.** Recommendation **yes**: they fill the half pair and are the most used
rotation after dragging; DENSITY §8.1 had them hover-only. If no, the second cell shows `⟂` skew (leaving More).

**Q5 — `SHAPE` heading for polygons and stars on the Corners slot.** Recommendation **yes**: one section id, two headings by
kind, so `Sides` sits where a rectangle shows `Radius`. The alternative adds a one-row section.
