# Instaflow appearance, transforms and structure — UX specification (Layer 2)

> Status: **normative** for everything marked (a) or (b); **planned** for (c). Written 2026-10-25 from the coordinator's
> capability table (`handoffs/CAPABILITY-COVERAGE.md`: appearance, transforms, groups/components, booleans/masks/corners,
> repeat, snapping/guides/rulers/grids, accessibility) and the owner's requests (gradients and a gradient editor; colour
> picker depth; page backgrounds as image, gradient or colour like shapes; bevels). Before this file these areas had
> STUDIO §4.2.4 (pill rows), §5.1–5.2 (sections and stacks), §6 (handles), F-04, F-09, F-12, F-13 and the DENSITY tier
> rows. Those now point here. The engine is `apps/instaflow/src/elements` (B1), `src/tools` (B3, B10a), `src/repeat`
> (B7), the authoring and render crates (REQUIREMENTS §20, §24, §26, §34); this file never redefines the model, it says
> what a person sees and does.
>
> **Letters** (the Export and Text convention): **(a)** the engine does it today · **(b)** UI only, buildable in B11b over
> the existing services (`appearanceModel` / `appearanceEditOps`, `commitEdit`, the transform capabilities, the repeat
> model, `useAsMask`, `booleanGroup`…) · **(c)** needs engine or editor-worker work (a model field, the projection, the
> Wasm, the export writers, or a new tool gesture in the editor worker). FOUNDATIONS §5.6 applies: **a (c) control is
> not rendered before it lands** — no greyed row, no "soon" tag. Every (c) has a milestone in §10.2 and, by the owner's
> standing rule, every feature — deferred or not — has its **outlet and its flow to completion and follow-up** in §10.1,
> so building it later never needs a redesign.
>
> Conventions kept and why: Figma's inspector stacks (fill, stroke, effects as rows with eye and ×), `Mod+G` / `Mod+Shift+G`,
> `Mod+D`, `Mod+]` / `Mod+[`, Shift = constrain, Alt = from the centre / duplicate, double-click = enter, Escape = out,
> `Mod+Alt+C/V` = copy/paste style — the muscle memory of the largest group of switchers. Departures are marked
> **Departure** inline and gathered in §1.2.

## 0. Reading map and the engine today

### 0.1 What exists (so nobody re-specifies it)

| Piece | Today | Letter |
|---|---|---|
| Fill stack: solid colour or `@token`; linear (`from`, `to`), radial (`center`, `radius`), conic (`center`, `angle`) gradients with ≤ 32 stops (stop colours may be tokens); image paint (`asset`, `fit` cover · contain · stretch · tile); per-item `opacity`, `blend` (16 modes), `visible`, `id`; ≤ 16 items | model (`values.ts`), resolve, projection, render (Vello GPU = CPU golden), export (SVG, PDF; **conic → pixel pattern** in both) | (a); **no editor**: the panel prints `Linear gradient` as text (`panel.ts`); image paints have no crop/offset/scale (c) |
| Stroke stack: paint (colour, gradient or image), `width` or per-side `sides` (rects, frames, images), `align` inside · center · outside, `dash` ≤ 16 + `dashOffset`, `cap`, `join`, `miter`, opacity, blend | model, authoring crate (`strokeRing`, dashes), render, export (gradient strokes = outline filled) | (a); arrowheads do not exist (c) |
| Effects: drop and inner shadow (`x y blur spread color`), outer and inner glow (`blur spread color`), layer blur, background blur; several per element; or an `@preset` token holding one or a list | model, render (ink bounds include effects), export (SVG filters; PDF raster patches) | (a); **no bevel/emboss**; no noise/texture (c) |
| Corners: `radius` linked, `radiusTL/TR/BR/BL`, `smoothing` 0…1, star `radiusInner`, vector `vertexRadii`; radii clamp to half the shortest side | model, geometry Wasm | (a); no on-canvas radius handle (b) |
| Layer: `spatial.opacity`, `spatial.blend` | model, render, export | (a) |
| Page background | **one RGBA** handed to `render_tile` / `begin_region` / `svg` / `pdf_page`; Export's `transparent` drops it; the page node has **no `style` component** | (a) solid; gradient / image (c) A-1 |
| Brand tokens: `@colour`, `@size`, `@font`, `@effect` (one or a list); style classes `style.inherit` with overrides and reset; `apply-token` capability for fill, stroke, radii, effects; unresolved tokens draw nothing and are reported | model, stage (`inherit` arc), `brand-kit.ts`, `styles.ts` | (a); no Brand panel (B-4), no document-level named styles (c) |
| Transforms: `x y w h rotation scaleX scaleY anchorX anchorY flipX flipY skewX`; move, resize (Shift ratio, Alt centre, past-the-edge flips), rotate (15° with Shift, four corner zones), skew by Mod-drag of side handles (±80°, 15° steps with Shift), pivot in view state with nine snap points, Alt-click reset, Free transform session (`Mod+Alt+T`: Enter one step, Escape cancels), numeric bar (X Y W H ∠ skew, linked W/H), keyboard nudge / resize / rotate, capabilities `move-by resize-by rotate-by rotate-90-* flip-* skew-by set-transform` | tools (editor worker), overlay batch | (a); rotate handle below the frame (b); constraints, scale tool, skewY (c) |
| Structure: `frame` (clips, `clip` toggle, layout grids), `group`, `shape`, `vector`, `image`; live booleans on groups (union · subtract · intersect · exclude; release, flatten, outline stroke); masks (clip · alpha · luminance, invert; `useAsMask` groups and makes the **bottom-most** the mask; `mask.asset` matte); repeats (radial · grid · mirror, handles, expand, release, ≤ 1 000 instances); align (selection · container · page · key object), centre in container, distribute (gaps · centres), tidy up; locks (`position` · `content` · `all`); `lineage.key` match keys | elements, repeat, stage | (a); **missing actions**: group, ungroup, frame selection, reorder (z-order), rename, hide (STUDIO §12) (b, hide needs a prop (c) A-2); components and instances (c) A-12 on the stage's `reference` arc |
| Snapping and guides: siblings' edges and centres, container edges and centre lines, layout grid lines, equal spacing with distance labels, 6 px threshold, Mod disables, Shift locks an axis; smart guides as a non-printing overlay batch | tools | (a); rulers, draggable guides, pixel grid (b / c) |
| Hit testing: rbush broad phase → exact geometry; frames transparent, groups opaque, Mod+click deep, double-click enters, Shift+Enter parent; marquee touched / Alt contained; locked elements let the click through | tools | (a) |
| Accessibility: a11y tree names elements, repeats as "instance k of n", every action is a capability with a shortcut | a11y (B6) | (a); colour-picker a11y and contrast tag (b) |

### 0.2 Reading rules

Implementers of the inspector and HUD read §2.10, §3.6 and §4.10 (the control tables are the normative part), §5 (per
density) and §10.1 (every feature's outlet and flow, deferred ones included); the colour popover and gradient editor
read §2.2–2.4; tools read §3 and §4.7; Layers reads §4.9; export reads §6; errors §7; a11y §8. FLOWS F-04, F-09, F-12,
F-13 and F-65…F-72 are the acceptance tests. Appendix A is the exhaustive checklist (every control Figma, Canva,
Illustrator, Photoshop and Sketch offer: include · defer · reject); Appendix B maps the coordinator's capability rows.

## 1. Principles, market analysis and departures

### 1.1 Principles

1. **One paint, everywhere.** A fill, a stroke, a text colour, a shadow colour and the page background open the *same*
   popover; a gradient edited there is the gradient edited on the canvas. No second picker, no "gradient tool".
2. **Stacks are honest lists.** What the renderer composites is the list the inspector shows, bottom-first, each row
   with its own eye, opacity and blend. Nothing is implied.
3. **Direct first, numeric always.** Every gesture has a field; every field has a gesture or a key. Nothing needs the
   mouse; nothing needs the keyboard.
4. **Presets before properties.** `Shadow ▾ Soft`, `Bevel`, gradient presets, document gradients: one click gives a
   finished look; the fields are for tuning.
5. **Structure is visible.** A mask, a boolean, a repeat, a group each has a chip in the pill, an icon in Layers and
   a one-line summary in the inspector, so a person never wonders why an element behaves oddly.
6. **The same six in the pill**; density only reveals (STUDIO §4.2.1, DENSITY §1).

### 1.2 Market analysis: where to match, where to be better

| Area | Leaders | Instaflow: the best version | Convention kept, why | **Departure, why better** |
|---|---|---|---|---|
| Fill stack | Figma: rows with eye/×, type menu inside the picker; Canva: one colour, gradients in a separate "Gradient" tab; Illustrator: Appearance panel | Figma's rows; `+ Add ▾` offers `Colour · Gradient · Image` so the kind is chosen at creation, not hunted for in the picker | Figma's row anatomy | Each row shows a **2-line summary** (`Linear · 3 stops · 45°`, `Image · Cover`) and a thumbnail swatch of the actual paint, not a flat colour |
| Colour picker | Figma: hex + model menu, eyedropper, styles; Canva: document colours, palette, photo colours; Photoshop: HSB wheel | Three tabs (`Solid · Gradient · Image`); model menu `HEX RGB HSB HSL OKLCH`; alpha; document colours **and** document gradients; saved palette; contrast tag | Figma's model menu, Canva's document colours | **Eyedropper without the browser API** (we sample our own tiles); a **contrast tag** inline; OKLCH for people who care about perceptual steps |
| Gradient editor | Figma: stops on an on-canvas line, picker shows a strip; Canva: fixed two-colour gradients + angle; Illustrator: Gradient panel with angle, aspect, reverse | Strip in the popover with stops you add by clicking, drag to move, Delete to remove; on-canvas handles for position; `Angle` field with 45° steps; `Reverse`; `Presets`; the stops' own colours use the same Solid tab | Figma's canvas handles | Gradients are **document assets**: a `Document gradients` row like document colours, so a brand gradient is one click on the next shape (nobody does this) |
| Image fills | Figma: fill-type Image with crop by double-click, filters; Canva: crop mode with a frame | `Fit ▾`, double-click = crop mode with the image's own handles, offset/scale (c) | Figma's crop by double-click | Crop mode is the **same gesture for an image element and an image fill**, and the Pixel lens (B-2) is never required for a crop |
| Strokes | Figma: per-side (rects), dash, caps; Illustrator: everything; Canva: width + style | Figma's set plus `Dash ▾` presets and arrowheads for lines (c) | Figma | Dash presets (`Dashed · Dotted · Custom`) so nobody types `4 4` |
| Effects | Figma: shadow/blur rows; Photoshop: Layer Styles dialog with bevel, satin, overlays | Rows with presets; a `Bevel` preset now, a real bevel-and-emboss later; Photoshop's overlays are rejected (the fill stack does them) | Figma's rows | Effects have a **preset menu** at `+ Add`; and per-row summaries, so a collapsed Effects section still says `Shadow · Soft` |
| Page background | Figma: page colour; Canva: colour, gradient or photo background (a locked "background" layer) | The page gets the **same fill stack** as a shape (c A-1); UI identical to a shape's Fill | Canva's result | Canva's background is a special element you fight with; ours is a property of the page: nothing to select by accident, nothing to reorder |
| Transforms | Figma: invisible rotate zones, K scale tool, constraints; Canva: visible rotate handle; Keynote: rotate handle | Visible rotate handle + Figma's zones (STUDIO §14.1), skew by Mod-drag (today), pivot, Free transform session, `Scale` tool (c) | Figma's modifiers | Images keep their ratio on corner handles **by default**; a `Transform › More ▾` with flips and pivot stays in one place in every density |
| Groups and frames | Figma: frames with auto layout vs groups; Canva: groups only; Sketch: groups + artboards | Both, with one line that explains the difference in the Frame section (`Clips its content · has a size`); `Convert to frame` / `Convert to group` | Figma | A group's inspector says what a group is for; Figma's is blank |
| Components | Figma: components, variants, overrides; Canva: none; Sketch: symbols | M2: components on the stage's reference arc; **repeats are M1's instances** | Figma's words (component, instance, detach) | Repeats first: 90 % of what people use components for in social design (a row of cards) is a repeat, and repeats already stay live |
| Booleans / masks | Figma: boolean groups; masks by "Use as mask" (bottom layer); Illustrator: Pathfinder | Live booleans, Figma's mask rule, mask modes `Clip · Alpha · Luminance` with `Invert` | Figma | The pill's chip names the structure (`Mask · Alpha`, `Union`) so a person knows why the fill behaves as it does |
| Snapping and guides | Figma: red smart guides, rulers with guides, layout grids; Canva: snapping + rulers | The same, in tangerine, equal-spacing labels; rulers in Pro; draggable guides M2 | Figma | Snap settings live in one `View ▾ › Snapping ▸` submenu, not three menus |
| Layers | Figma: eye/lock on hover, nesting; Canva: a "Position" panel | Figma's list, Pro shows eye/lock always, masks and booleans shown as groups with glyphs | Figma | Lock has **two scopes** (`Position only · Everything`) because a locked background photo should still be recolourable |

## 2. Appearance

### 2.1 The fill stack

The Fill section (and the Stroke and Effects sections, which share the row anatomy) is a **stack**: rows bottom-first in
the inspector, top row = painted last (Figma, Illustrator). Row anatomy at 236 px content width (STUDIO §5.2):

```
[◉] Linear · 3 stops · 45°        [ 80 % ] [👁] [×]      ← gradient row: thumbnail swatch, 2-line summary, opacity, eye, remove
[●] @cream  #FFF4E0               [100 % ] [👁] [×]      ← solid row: round swatch, token tag + hex
[▦] Image · Cover                 [100 % ] [👁] [×]      ← image row
+ Add ▾                                                  ← Colour · Gradient ▸ (Linear · Radial · Conic) · Image…
```

| Part | Behaviour | Letter |
|---|---|---|
| **Swatch** (16 px round for solids; 16 px rounded square showing the gradient or image thumbnail) | Click opens the colour popover (§2.2) on the tab matching the paint; hatched when a token cannot resolve (STUDIO §5.4) | (b) |
| **Summary** | Solid: token tag (mono) then hex; Gradient: `Linear · 3 stops · 45°` / `Radial · 2 stops` / `Conic · 4 stops · 90°`; Image: `Image · Cover` then the asset name on hover | (b) |
| **Opacity** | 48 px scrubbable number `%`, 0–100; the item's own `opacity` | (a) |
| **Eye** | Toggles `visible`; a hidden row is 50 % with the eye crossed; the swatch still shows the paint | (a) |
| **×** | Removes the row; one undo step `Remove fill`; hover-revealed in Standard, always in Pro | (a) |
| **Blend** | `Blend ▾` for the row appears in the row's **second line** when the row is expanded (click the summary) or in Pro always: 16 modes grouped Normal · Darken (Darken, Multiply, Colour burn) · Lighten (Lighten, Screen, Colour dodge) · Contrast (Overlay, Soft light, Hard light) · Inversion (Difference, Exclusion) · Component (Hue, Saturation, Colour, Luminosity) | (a) |
| **Reorder** | Drag the row by its grip (appears on hover at the left edge) or `Alt+↑ / Alt+↓` with the row focused; a 2 px tangerine insertion line; one undo step `Reorder fills` | (a) model; (b) UI |
| **Expand** | Click the summary → the row opens a second line with the paint's fields (gradient: `Angle`, `Reverse`, stop count; image: `Fit ▾`, `Replace…`, `Crop`) — a mini-inspector so common tweaks do not need the popover | (b) |
| **`+ Add ▾`** | Menu `Colour · Gradient ▸ Linear · Radial · Conic · Image…`; `Colour` adds the last committed colour (or `#D9D9D9` on a shape that already has a fill, so the new row is visible); `Gradient` adds a two-stop gradient from the current top colour to transparent at 0° (never black→white: it should look like the shape); `Image…` opens the Assets picker (HOME-FILES §3.1) or a file dialog. Up to 16 rows; the 17th shows `Up to 16 fills` in the menu's footer | (a) model; (b) UI |
| **Mixed** (multi-selection) | Rows show only when every element has the same number of rows with the same kinds; otherwise the section shows one hatched row `Mixed fills` with `Replace all ▾` (Colour · Gradient · Image): picking replaces every element's stack with one row. **Departure** (Figma shows nothing editable): a brand recolour of twenty shapes is one click | (b) |
| **No fill** | The stack is empty: the section shows `+ Add ▾` and the muted line `No fill`; the HUD swatch is a hatched-empty circle (a diagonal hairline), never white | (a) |

**HUD.** The pill's Fill swatch (STUDIO §4.2.4) shows the **top visible** fill's paint (gradient thumbnail for a gradient,
the image for an image); click opens the popover on that row. With several fills, the popover's header shows a row
switcher (`1 of 3 ▾`). Stroke swatch likewise for the top stroke.

**Undo labels:** `Fill`, `Add fill`, `Remove fill`, `Reorder fills`, `Fill opacity`, `Fill blend`, `Hide fill`; strokes
and effects say `Stroke…`, `Effect…` (`Shadow`, `Glow`, `Blur` when one kind).

### 2.2 The colour popover, extended

Extends STUDIO §4.2.5 (which stays normative for anchor, size, light dismiss, keyboard). 264 px wide; one instance for
the pill, the inspector, the Page section, effect colours and dialogs (New design › background). Anatomy, top to bottom:

```
 Solid · Gradient · Image                      ← tab switcher (mist track, white pill); Image only for fills and strokes
 ─────────────────────────────────────────
 [■] #FF5C39   HEX ▾   [100 %]   ⌖   ☆           ← value row: swatch · fields per model · model menu · alpha · eyedropper · save
 AA 4.9 : 1 on #FFFFFF                           ← contrast tag (only when the paint is a solid over a solid background)
 Document colours   ●●●●●●  ●●●●●●
 Brand              ●●●●  (@cream @ink …)        ← when a kit exists
 Saved              ●●●●●  +                      ← the workspace palette (your own)
 Palette            ●●●●●●  ●●●●●●  ●●●●●●  ●●●●●●
 Recent             ●●●●●●●●
 Custom ▸  (inline: saturation/brightness square + hue slider + alpha slider; or the OKLCH triplet sliders)
```

| Part | Behaviour | Letter |
|---|---|---|
| **Tabs** | `Solid · Gradient · Image`. Switching tabs **converts** the paint (solid → gradient keeps the colour as stop 1 and adds a transparent stop; gradient → solid takes the first stop's colour; → image opens the asset picker, cancel returns to the previous tab); one undo step `Fill kind`. `Image` is not rendered for text colour, effect colours or the page (until A-1). **Departure** (Canva separates Gradient into another panel; Figma hides the type in a dropdown): tabs make the three kinds discoverable in one glance | (a) model; (b) UI |
| **Model menu** `HEX ▾` | `HEX · RGB · HSB · HSL · OKLCH`; the fields re-render in place: HEX = one mono field (`#` fixed, 3/6/8 digits accepted, pasting `rgb(…)`, `hsl(…)` or `oklch(…)` strings parses them); RGB/HSB/HSL = three 48 px scrubbable numbers; OKLCH = `L %`, `C` (0–0.4, 3 decimals), `H °`. Remembered per device. Pro's default is whatever was last chosen; Standard starts on HEX | (b) |
| **Alpha** | The `100 %` number is the colour's own alpha (8-digit hex / the `a` channel), **not** the fill row's opacity; the tooltip says `Colour alpha · the fill's opacity is in its row`. Scrub, type, ↑/↓ | (a) |
| **Eyedropper** `⌖` | Click or `I` while the popover is open → a pick mode: the popover hides, the cursor is a loupe (a 7 × 7 px magnified ring with the centre hex as a mono tag), click commits, Escape cancels. **Source:** the browser's `EyeDropper` API when present (whole screen); otherwise the **canvas's own rendered tiles** (anything on the canvas, page and chrome excluded) — so Firefox and Safari have an eyedropper too. **Departure**: nobody falls back to their own renderer. Keyboard path: arrows move the loupe 1 px (Shift 10), Enter picks | (b) |
| **Save** `☆` | Adds the colour to **Saved** (the workspace palette, per device, up to 48); a filled star means it is there; click again removes. Pro: right-click a Saved swatch → `Rename…`, `Remove`, `Move left/right` | (b) |
| **Contrast tag** | Shown when the popover edits a **solid** paint and the background behind the element's centre is a solid (the page's background or the parent frame's top solid fill): `AAA 7.2 : 1` / `AA 4.9 : 1` / `AA large 3.1 : 1` / `× 1.8 : 1` as a mist mono tag, sunflower-bordered when below AA for text. For a **text colour** it compares against what is behind the text; for a **fill** it compares against the element's **own text children** when any (the button case), else against the background. Click the tag → a one-line hint `Nearest passing colour: #B3174C · Use it` (searches along lightness in OKLCH). Reduced to a tooltip in Focus | (b) |
| **Document colours** | STUDIO §4.2.5; now also includes gradient stop colours and effect colours; a `Gradient` tab has its own `Document gradients` row (§2.3) | (b) |
| **Brand** | STUDIO §4.2.5 (token binding, `Detach from token`); the `@name` tag appears in the value row while bound; typing in the hex field while bound asks nothing: it **detaches and sets** (one step `Fill`, the toast-free rule) | (a) |
| **Palette** | the 24 Clean Pop colours (6 × 4) | (b) |
| **Recent** | last 8 on this device | (b) |
| **`Custom ▸`** | Inline (never a second popover): for HEX/RGB/HSB/HSL a 200 px saturation-brightness square, a hue slider and an **alpha slider** (checkerboard track); for OKLCH three sliders (L, C, H) with the gamut-clipped region of each track hatched. Pro opens with Custom expanded (DENSITY §3.4) | (b) |
| **Colour names** | **Rejected** as a field (Canva shows "Coral"); a hex is the name designers use and names are untranslatable. Pro shows the nearest CSS named colour as the tooltip of the swatch (`≈ tomato`) — zero cost, a little joy | — |
| **Multi-selection** | `Mixed` hatch and empty fields; typing sets all (STUDIO §4.2.5) | (b) |
| **Escape / Enter** | Escape restores the opening value and closes; Enter commits and closes; clicking away commits (light dismiss passes the click) | (b) |

Keyboard: `Tab` across rows, arrows within a grid, Enter picks, `Mod+C` / `Mod+V` on a swatch copy and paste a value
(hex, or a gradient as a CSS `linear-gradient(...)` string — pasting a CSS gradient string onto a fill **creates** a
gradient fill from it: the one import path for gradients from the web). A11y: `role=dialog` named `Colour`; tabs are
`tablist`; grids are `grid` with the hex as each cell's name; the contrast tag is a polite live region.

### 2.3 The gradient editor

One editor, two places: the **Gradient tab** of the colour popover (values) and **on-canvas handles** (position). They
are the same state; dragging a handle moves the field, typing in a field moves the handle.

#### 2.3.1 Gradient tab

```
 Linear · Radial · Conic                      ← type switcher (mist track)
 ┌────────────────────────────────────┐
 │ ░░░░░░░░░ gradient strip ░░░░░░░░░ │  ← 236 × 24 px, checkerboard under, stops as 12 px round handles on the bottom edge
 └─▲─────────────▲──────────────────▲─┘
   0 %           52 %             100 %
 Stop  [■] #FF5C39  HEX ▾  [100 %]  ⌖  ☆        ← the selected stop's colour: the Solid row, exactly
 Position [ 52 % ]     Angle [ 45° ] ↻  ⇄         ← Position of the stop · Angle (linear/conic) with +45° button · Reverse
 Presets    ▭▭▭▭▭▭▭▭  (8 chips)                   ← curated gradients in Clean Pop
 Document gradients   ▭▭▭▭                         ← gradients used in this design, most used first
 Document colours · Brand · Saved · Palette · Recent   ← for the selected stop, as the Solid tab
```

| Part | Behaviour | Letter |
|---|---|---|
| **Type switcher** | `Linear · Radial · Conic`; switching keeps the stops and maps geometry (linear `from`/`to` → radial centre at the midpoint with radius half the length → conic centre same, angle = the linear angle). One step `Gradient type` | (a) model; (b) UI |
| **Strip** | Shows the gradient straight (ignores type) under a checkerboard. **Click** on the strip adds a stop at that position with the interpolated colour (Figma, Illustrator). **Drag** a stop to move it (clamped 0–100 %, stops may pass each other); `Alt+drag` duplicates; **Delete / ⌫** removes the selected stop (never below 2); double-click a stop → focuses the hex field. Stops are `role=slider` each, arrows move 1 % (Shift 10 %) | (a) model (≤ 32 stops); (b) UI |
| **Stop colour** | The selected stop (tangerine ring) edits through the Solid row above; stop colours may be **brand tokens** (`@cream`); alpha per stop | (a) |
| **Position** | The selected stop's offset, scrubbable `%` | (a) |
| **Angle** (linear, conic) | 0–360°, 0° = left→right, clockwise (CSS and Figma agree); `↻` adds 45°; the linear `from`/`to` are recomputed to span the box at that angle (the CSS "corner-to-corner" length rule) unless the person has dragged the handles off the box, in which case Angle rotates about the midpoint and keeps the length. Radial: the field is `Radius` (`%` of the shorter side) with `Aspect` in Pro (c: radial paint has one radius today; an ellipse needs `radiusY` — A-4) | (a) linear/conic angle; (c) radial aspect |
| **Reverse** `⇄` | Mirrors stop offsets; one step `Reverse gradient` | (b) |
| **Presets** | 8 chips (36 × 24 px): Clean Pop pairs (`Tangerine → Sunflower`, `Mist → White`, `Blue → Mint`, `Ink fade`, `Sunset`, `Dusk`, `Mono soft`, `Transparent fade`), each applied as linear 90° keeping the current type if not linear. Hover shows the name | (b) |
| **Document gradients** | Every distinct gradient (stops + type, geometry ignored) used in the design, most used first, ≤ 8; click applies stops and type, keeps this element's geometry. **Departure**: a brand gradient becomes one click, the way document colours already are | (b) over a `ColorsMirror` extension |
| **Save** `☆` on the whole gradient | Saved gradients join the **Saved** row (workspace), distinguished by a square thumbnail | (b) |
| **Copy / paste** | `Mod+C` with the strip focused copies the gradient as CSS; `Mod+V` over the strip pastes CSS or a hex (hex = sets the selected stop) | (b) |

#### 2.3.2 On-canvas handles

Rendered in the HUD overlay layer while the popover's Gradient tab is open **or** while a gradient fill row is selected
in the inspector (click the row), and hidden while dragging the element. Transformed with the element (rotation, skew).

| Type | Handles | Gesture |
|---|---|---|
| Linear | Two 10 px round handles at `from` and `to` on a 1.5 px tangerine line; the stops drawn on the line as 8 px rings | Drag an end → moves `from`/`to` (Shift snaps the angle to 15°, Alt moves both ends keeping the length); drag a ring → moves that stop; click on the line → adds a stop; the Angle field follows |
| Radial | Centre handle; a radius handle on the right of the ring; the ring drawn | Drag centre → moves; drag radius → scales; Shift keeps the radius on the box's shorter side |
| Conic | Centre handle; an angle handle on a 1 px spoke | Drag the spoke → Angle (Shift 15°) |
| Any | Double-click the element with the Gradient tab open → nothing (never enters crop or text); `Escape` closes the popover (the handles go) | |

All handle drags preview live and commit on release as one step `Gradient`. Keyboard path: the fields. Pro: a mono tag at
each end shows its position in `%` of the box.

#### 2.3.3 Gradients on strokes, text and the page

- **Stroke gradients**: (a) in the model and renderer; the Stroke row's swatch opens the same popover with the Gradient
  tab; the handles are the element's (the gradient spans the box, as in Figma). Export: SVG `<linearGradient>` on the
  stroke, PDF outlines the stroke and fills it (a).
- **Gradient text**: (c) **M2, A-11** (TEXT-FONTS A.2): the text element's Fill stack gets a gradient row and every glyph is
  painted with one brush across the element; until then the Fill section on text accepts solids only and `+ Add ▾`
  lists `Colour` only (the Gradient entry is not rendered; FOUNDATIONS §5.6).
- **Page gradient**: with A-1 (§2.8).
- **Conic gradients in export**: SVG and PDF rasterise them (`Feature::SweepGradient` → pixel pattern, (a)). The Export
  dialog's preview is the renderer, so the result is visible; in Pro the result line adds `1 conic gradient rasterised`.

### 2.4 Image fills

An image fill is a row in **any** element's Fill stack (a rectangle with a photo, a text with a photo in M2) and the
**image element's** own paint (an `image` element is a box whose first fill is its asset; the Image section is a view of
that row — one model, one UI).

| Control | Where | Behaviour | Letter |
|---|---|---|---|
| **Fit ▾** | Image section (S), row second line, HUD `Fit ▾` | `Fill` (cover) · `Fit` (contain) · `Stretch` · `Tile`; icons from the one set; `Fill` default | (a) |
| **Replace…** | Image section (S), HUD, ctx | Assets picker (recent first) or a file; keeps fit and crop when the ratio matches, resets crop otherwise with a 1.5 s toast `Crop reset · new image ratio` | (a) asset swap; (b) UI |
| **Crop** | HUD `Crop`, double-click an image element, Image section ghost button, `Enter` on an image | **Crop mode**: the element's box stays as the frame; the **image** shows at 40 % outside the box; eight handles on the **image** scale it (Shift = free ratio for the image; corners keep ratio by default), dragging inside moves it; a mono pill `1 920 × 1 080 · 142 %`; `Fit ▾` and `Reset` in a small bar above; Enter or click away commits (one step `Crop`), Escape cancels. Keyboard: arrows move 1 / 10 px, `Mod+Alt+arrows` scale | (c) **A-3**: image paint needs `offset`, `scale`, `rotation` (or a crop rect). Until A-3, double-click does nothing on an image (never a half mode) |
| **Position** (numeric) | Image section `More ▾` | `X % · Y %` of the overflow (50 50 = centred), `Scale %`, `Rotate ▾ 0 · 90 · 180 · 270`; mirrors `Flip` on the fill | (c) A-3 |
| **Tile scale** | Row second line when `Tile` | `Scale %` of the tile; `Spacing` M3 | (c) A-3 |
| **Rotate / flip the image inside** | `More ▾`, ctx `Rotate image 90°`, `Flip image` | Independent of the element's transform | (c) A-3 |
| **Adjustments** (exposure, contrast, saturation, temperature, tint, highlights, shadows, blur) | Image section `More ▾` sliders; Pro open | Non-destructive on the fill (`filters`); `Reset` per slider | (c) **A-10** M2 (render filters), the Pixel lens (B-2) adds the destructive tools |
| **Remove background** | HUD `✦ Remove background` (M2, provider) | CHAT proposal; the result replaces the asset with an alpha PNG and keeps the crop | M2 assistant (S9 matte path) |
| **Opacity, blend, eye** | the row | As any fill: a 60 % image over a solid colour is the Canva "colour wash" without a second element | (a) |
| **Source info** | Image section `More ▾`: name, pixel size, `Reveal in Assets` | mono | (b) |
| **Image as mask / masked by a shape** | §4.4 | | (a) |

### 2.5 Strokes

The Stroke section is a stack like Fill (§2.1) with extra fields. Row: swatch · summary (`#16151A · 2 px · Inside`) ·
`Width` 48 px number · opacity · eye · ×. Second line (expand, or Pro always): `Position ▾ Inside · Centre · Outside`,
`Dash ▾`, `Cap ▾`, `Join ▾`, `Sides` toggle (rects, frames, images), `Blend ▾`.

| Control | Behaviour | Letter |
|---|---|---|
| **Width** | 0.5–1 000 px, scrub; `0` is refused (remove the row instead; the field clamps to 0.5 and hints `Remove the stroke with ×`) | (a) |
| **Position ▾** | `Centre` default for shapes drawn with the Line tool; `Inside` default for rectangles, frames and images (Figma) — stated in the tooltip | (a) |
| **Sides** | A `⊞` toggle turns `Width` into four fields `T R B L` with a link; a hairline-only card is two clicks | (a) model (rects, frames, images only; not rendered for others) |
| **Dash ▾** | `Solid · Dashed (width × 3, gap × 2) · Dotted (0 length, round caps, gap × 2) · Custom…` — Custom shows `Dash` and `Gap` fields (and a mono pattern field in Pro, e.g. `8 4 2 4`), `Offset` | (a) model; (b) UI with presets |
| **Cap ▾** | `Butt · Round · Square` (icons) | (a) |
| **Join ▾** | `Miter · Round · Bevel`; `Miter limit` in Pro | (a) |
| **Arrowheads** (lines and open paths) | `Start ▾ · End ▾`: `None · Arrow · Triangle · Circle · Square · Bar`, `Size` in Pro; the HUD on a line gets `End ▾` | (c) **A-5** M2: stroke outlines in the authoring crate gain markers |
| **Gradient / image stroke** | Via the swatch's tabs | (a) |
| **Per-row opacity and blend** | As fills | (a) |
| **Outline stroke** | HUD More, ctx: the stroke becomes a filled vector (destructive, one step) | (a) |
| **Stroke on text** | TEXT-FONTS T-18 (c M2) | (c) |
| **Mixed** | As fills: `Mixed strokes` hatched row with `Replace all ▾` | (b) |

Undo labels: `Stroke`, `Stroke width`, `Stroke position`, `Dash`, `Add stroke`, `Remove stroke`.

### 2.6 Effects

The Effects section is a stack; each row: a kind icon · summary (`Shadow · 0 4 12 · 25 %`, `Glow · 8`, `Blur · 4`,
`Background blur · 20`) · eye · ×; second line (expand, or Pro): the kind's fields. `+ Add ▾` is a **preset menu**:

```
+ Add ▾
  Shadow ▸      Soft (0 4 16 0 · ink 16 %) · Medium (0 8 24 0 · 24 %) · Hard (4 4 0 0 · 100 %) · Long (12 12 0 0 · 12 %) · Custom…
  Inner shadow ▸ Soft · Inset edge · Custom…
  Glow ▸        Outer · Inner · Custom…
  Bevel ▸       Soft bevel · Hard bevel · Pillow                        ← preset rows (b); the kind (c) replaces them
  Blur ▸        Layer blur · Background blur
  ──
  From brand ▸  @shadow-md · @glass …                                   ← effect tokens, when a kit has them
```

| Kind | Fields (second line) | Letter |
|---|---|---|
| **Drop shadow** | `X Y` (scrub, −500…500), `Blur` (0…250), `Spread` (−100…100), colour swatch (popover, Solid only, alpha = the shadow's strength), `Blend ▾` **rejected** (no blend on effects in the model; the colour alpha suffices) | (a) |
| **Inner shadow** | Same fields | (a) |
| **Outer glow / Inner glow** | `Blur`, `Spread`, colour; shown as `Glow` with an `Inner` toggle in the row rather than two kinds (one row kind, one toggle: fewer menu entries) | (a) |
| **Layer blur** | `Radius` (0…250); the row summary warns in Pro when > 50 (`slow on large elements`) | (a) |
| **Background blur** | `Radius`; the section's one-line hint on first add: `Blurs what is behind this element · needs a semi-transparent fill to see it` (OVERLAYS §5 hint rules) | (a) |
| **Bevel (preset, now)** | `Soft bevel` = inner shadow (−2 −2 4 0 white 60 %) + inner shadow (2 2 4 0 ink 30 %); `Hard bevel` = the same with blur 0; `Pillow` = inner glow (white 40 %, blur 6) + inner shadow (0 2 4 0 ink 25 %). Applied as **grouped rows** tagged `Bevel` in the summary (the rows stay editable; removing one removes the tag). An honest preset, not a fake kind | (b) over existing kinds |
| **Bevel & emboss (real)** | A `bevel` effect kind: `Style ▾ Inner · Outer · Emboss · Pillow`, `Depth` (%), `Size` (px), `Soften` (px), `Angle` with a `Use global light` toggle, `Altitude`, highlight colour + mode, shadow colour + mode. The `Bevel ▸` preset rows become presets of this kind; the outlet (the `+ Add ▾` entry, the row, the fields) is the same | (c) **A-9** M2: render crate (a normal-map style edge lighting pass over the SDF of the outline), export as raster patch |
| **Noise / grain, texture** | Pro-only effect kinds `Noise` (amount, size, mono/colour) | (c) M3 (Appendix A, Figma 2025 has them) — not rendered |
| **Colour overlay, gradient overlay, satin, pattern overlay** (Photoshop) | **Rejected**: an extra fill row with a blend mode does each; the Fill stack is the overlay | — |
| **Effect tokens / presets** | `From brand ▸` lists `@effect` tokens; applying binds the whole stack to the token (`effects = @shadow-md`), the section header shows the token tag, `Detach` returns the values | (a) |
| **Document effect styles** (named, update all) | `Save as style…` in the section's `⋯`; `Styles` list in the Brand panel (B-4) | (c) **A-13** M2 with D14 shared styles (same mechanism as text's T-14) |
| **Reorder / eye / ×** | As fills; effects' order matters only among shadows (drawn in order) and is stated in the tooltip | (a) |
| **Mixed** | `Mixed effects` row + `Replace all ▸` (the preset menu) | (b) |

The HUD never shows effects (rank > 6); the Effects section is ▸ collapsed with its summary (`Shadow · Soft`, `2 effects`).
Export: SVG filters for shadows and blurs (a); PDF raster patches (a) — the Export preview shows exactly that.

### 2.7 Layer opacity and blend

The **Layer** section (▸, summary `50 % · Multiply`): an `Opacity` slider (FOUNDATIONS §4.7, value pill `50 %`,
scrubbable number beside it in Pro) and `Blend ▾` (the 16 modes, grouped as §2.1). Keys for opacity (Figma's `1…0`) are
**rejected**: `1` and `5` switch lenses (STUDIO §7) and `2–4` are reserved; instead `Alt+Shift+↑ / ↓` change opacity by 10 %
when no text is being edited (while editing they are line height — the registry scopes them). Multi-selection: Mixed;
the slider sets all. A group's opacity is the group's (children composite first, as in every tool); the section's hint
says so once: `Applies to the group as one`. Pass-through blend for groups (Figma's `Pass through`): the model has
`normal` only; **M2 (c) A-14** adds `pass-through` as the group default so blends inside a group reach the page.

### 2.8 Page background

**Decision (recommend): the page gets the same fill stack as a shape, as engine work (c) A-1, M1 follow-up.** Today the
page background is one RGBA passed to the renderer and dropped by Export's `transparent`. A-1 gives the page node a
`style` component (fills only; strokes and effects **not rendered** on a page) and the projection emits a page rect
node under the children; `transparent` means "skip the page's fills". The locked-bottom-"Background"-layer alternative
is **rejected** as the model (a special element people select, delete, drag above a child, miss in alignment and have to
explain to agents) and kept only as the **fallback build** if A-1 cannot land before B11b — in which case `Page ›
Background` writes a locked, role `background`, full-page rect that Layers hides and the Page section presents; the
**UI below is identical in both cases**, which is the point of deciding the UI now. Owner question Q1.

| Where | What | Letter |
|---|---|---|
| **Page section › Background** (nothing selected, or the page label clicked) | The same **fill stack** as §2.1 (rows, `+ Add ▾ Colour · Gradient · Image…`, opacity, eye, reorder). Default one row `#FFFFFF`. The HUD on the page label shows the Background swatch (STUDIO §4.2.4 Page row) opening the popover with all three tabs. The section's Pro line shows `Export: background included · Transparent in Export › Advanced` | (a) solid, one row; (c) A-1 for gradient, image and several rows |
| **Image background** | `+ Add ▾ Image…` → Assets or a file; `Fit ▾` (Fill default), `Crop` as §2.4 (double-click the page's empty area with **nothing** selected and an image background present enters the page's crop mode; the page label's menu has `Crop background`), opacity for a wash, a solid row **under** it for the wash colour | (c) A-1 + A-3 |
| **Apply to all pages** | A ghost row under the stack `Apply to all pages` (Pages ≥ 2); one step `Page background · 5 pages`; toast with Undo | (b) |
| **Set as default for new pages** | In the row's `⋯`: `Use for new pages`; stored in Document › Page defaults | (b) |
| **From an element** | Context menu on any shape or image: `Use as page background` → copies its fills into the page's stack and deletes the element (confirm row in the pill `Replace the background and remove this image · Replace`); undo restores both | (b) UI; needs A-1 for non-solid |
| **New design** (HOME-FILES §1.3 `More ▾`) | The `Background` swatch there is the same popover (Solid and Gradient tabs; Image once A-1) | (b) |
| **Transparent export** | Export › Advanced `Transparent` (OVERLAYS §2.3) skips the page's fills; the Page section's Pro line names it | (a) |
| **Milestones, Pages thumbnails, templates** | All render the page's stack (one projection) | (a)/(c) with A-1 |

### 2.9 Copy and paste style; styles and brand tokens

| Feature | Behaviour | Letter |
|---|---|---|
| **Copy style** `Mod+Alt+C` · ctx · HUD More | Copies the selection's **appearance**: fills, strokes, effects, corners (radius, per-corner, smoothing), layer opacity and blend — never the transform, never text content; on text also the first run's character marks (TEXT-FONTS §10 M2 copies ranges). Toast-free; the paste row reads `Paste style · from Rectangle` | (b) over `localValues` + ops |
| **Paste style** `Mod+Alt+V` · ctx | Applies the whole set to every selected element as one step `Paste style`; per-kind rules: corners only to elements that have corners, strokes' `sides` only to rects; **`Paste style ▸` submenu** (ctx, More): `Fill only · Stroke only · Effects only · Corners only` | (b) |
| **Shortcut move** | STUDIO §7 had `Mod+Alt+C` = Copy link; it moves to **`Mod+Alt+L`** (L for link; unbound; not browser-reserved). Figma, Sketch and Illustrator all use `Mod+Alt+C/V` for styles — muscle memory wins. Owner question Q6 | — |
| **Select same ▾** (ctx) | `Fill · Stroke · Effects · Kind` select every element with the same value (resolved) in the page; `+ All pages` in Pro | (b) |
| **Find and replace Kind `Colour`** | STUDIO §9.1: replaces a colour everywhere (fills, strokes, effects, gradient stops, text) | (b) |
| **Brand tokens** | Colour, size (radius, stroke width) and effect tokens bind through the popover's Brand row / `From brand ▸`; the field shows the `@name` tag; `Detach`; unresolved = hatched + `Replace with #…` (STUDIO §5.4) | (a) |
| **Style classes** (`style.inherit`) | The Pro inspector header shows `Class · Card` with `Reset overrides ▾` listing overridden paths (from `overridesOf`); Standard shows a dot on an overridden field's label with the tooltip `Overrides Card · Reset`. Applying a class: Brand panel (B-4) | (a) model; (b) UI |
| **Document colour styles** (named, update everywhere) | `☆` saves to the workspace palette (M1, local); **named document styles** (`Create style from fill`, `Update style`, `Detach`) are M2 (c) **A-13** with D14, listed in the Brand panel (B-4) and in the popover under a `Styles` row | (c) M2 |
| **Swap colours across the design** | `Find › Colour` (b); the Brand panel's "Replace palette" (M2) | (b) |

### 2.10 Appearance control table (normative)

Every row is one declared control (`src/spec/controls.ts`, STUDIO §4.2.1) with its section, **tier** (DENSITY §3.2:
*essential* shows at rest in Standard, *more* folds behind `More ▾` or the row's second line, *pro* renders only in Pro),
HUD rank and letter. Sections in order: Fill · Stroke · ▸ Corners · ▸ Effects · ▸ Layer (STUDIO §5.1).

| Control | Kind | HUD rank | Section · tier | Shortcut | Notes | Letter |
|---|---|---|---|---|---|---|
| Fill swatch (top fill) | swatch | 1 (shapes, frames) | Fill · essential | — | opens the popover on the matching tab | (a)+(b) |
| Fill rows: opacity, eye, remove, reorder | stack | — | Fill · essential | `Alt+↑/↓` reorder | | (a)+(b) |
| Fill blend | menu | — | Fill · more (row line 2) | — | 16 modes grouped | (a) |
| `+ Add ▾` fill (Colour · Gradient ▸ · Image…) | menu | — | Fill · essential | — | ≤ 16 | (a)+(b) |
| Colour model menu (HEX RGB HSB HSL OKLCH) | menu | — | popover | — | remembered per device | (b) |
| Alpha | number | — | popover | — | | (a) |
| Eyedropper | action | — | popover | `I` in popover | API or tile sampling | (b) |
| Save colour / gradient | toggle | — | popover | — | workspace palette | (b) |
| Contrast tag | chip | — | popover | — | solid over solid | (b) |
| Gradient type | switcher | — | popover Gradient tab | — | | (a)+(b) |
| Gradient stops (add, move, delete, colour, position) | custom | — | popover + canvas | `⌫` | ≤ 32 | (a)+(b) |
| Gradient angle / radius / reverse | number · action | — | popover; row line 2 | — | radial aspect (c) A-4 | (a)+(b) |
| Gradient presets, document gradients, saved | chips | — | popover | — | | (b) |
| Image fit | menu | 2 (images) | Image · essential | — | | (a) |
| Replace image | action | 3 (images) | Image · essential | — | | (a)+(b) |
| Crop (mode) | action | 1 (images) | Image · essential | `Enter` / double-click | | (c) A-3 |
| Image position, scale, rotate, flip inside | numbers | — | Image · more | — | | (c) A-3 |
| Image adjustments | sliders | — | Image · more (Pro open) | — | | (c) A-10 M2 |
| Stroke swatch (top stroke) | swatch | 2 (shapes) | Stroke · essential | — | | (a)+(b) |
| Stroke width | number | 3 (lines) | Stroke · essential | — | | (a) |
| Stroke position | menu | — | Stroke · more | — | | (a) |
| Stroke sides toggle + T R B L | toggle + numbers | — | Stroke · more | — | rects, frames, images | (a) |
| Dash, cap, join, miter | menus | — | Stroke · more (miter pro) | — | presets | (a)+(b) |
| Arrowheads | menus | 3 (lines) | Stroke · essential (lines) | — | | (c) A-5 M2 |
| Outline stroke | action | More | — | — | | (a) |
| Radius (linked) | number | 3 (rects) | Corners · essential | — | §4.5 | (a) |
| Per-corner toggle + four radii | toggle + numbers | — | Corners · more (Pro: one row) | — | | (a) |
| Smooth | slider | — | Corners · more | — | 0–100 % (`60 %` ≈ iOS) | (a) |
| Effect rows (add ▾ presets, eye, ×, reorder) | stack | — | Effects · essential (section ▸) | — | | (a)+(b) |
| Shadow fields (X Y Blur Spread colour) | numbers + swatch | — | Effects · more (row line 2) | — | | (a) |
| Glow fields, Inner toggle | numbers | — | Effects · more | — | | (a) |
| Blur radius, Background blur radius | number | — | Effects · more | — | | (a) |
| Bevel preset | menu rows | — | Effects `+ Add ▾ Bevel ▸` | — | grouped inner rows | (b) |
| Bevel & emboss kind | fields | — | Effects · more | — | | (c) A-9 M2 |
| Noise / texture | fields | — | Effects · pro | — | | (c) M3 |
| From brand (effect token) | menu | — | Effects `+ Add ▾` | — | | (a) |
| Save as effect style / colour style | action | — | section `⋯` | — | | (c) A-13 M2 |
| Layer opacity | slider + number | — | Layer · essential (section ▸) | `Alt+Shift+↑/↓` | | (a) |
| Layer blend | menu | — | Layer · essential | — | pass-through (c) A-14 | (a) |
| Page background stack | stack | 1 (page) | Page · essential | — | §2.8 | (a) solid; (c) A-1 |
| Apply background to all pages / use for new pages | actions | — | Page · more | — | | (b) |
| Copy style / Paste style / Paste style ▸ | actions | More | — | `Mod+Alt+C` / `Mod+Alt+V` | | (b) |
| Select same ▾ | menu | — | ctx | — | | (b) |
| Class overrides (dot, Reset) | chip | — | header (Pro: list) | — | | (a)+(b) |
