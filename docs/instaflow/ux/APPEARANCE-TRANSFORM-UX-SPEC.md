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

## 3. Transforms

### 3.1 Handles and gestures

STUDIO §6.1 stays normative for the look (9 px round handles, `#CF3D17` ring, the rotate handle 24 px below on a stem,
the corner zones, the pivot ring, the size/position/angle pills). This table is the complete gesture set.

| Gesture | Result | Modifiers | Letter |
|---|---|---|---|
| Drag the body | Move; `X, Y` pill; smart guides and equal-spacing labels | Shift locks to the nearer axis; Mod suspends snapping; **Alt duplicates** (the copy moves, the original stays; one step `Duplicate`); Space mid-drag pans (Figma) | (a) move; (b) Alt-duplicate |
| Drag a side handle | Resize that edge; the opposite edge fixed; `W × H` pill | Shift keeps the ratio; Alt resizes about the **pivot** (centre by default); past the opposite edge **flips** (IF-34.2) | (a) |
| Drag a corner handle | Resize two edges | **Default ratio rule:** shapes, frames, groups and text boxes resize **free**, Shift locks the ratio; **images** (and image-filled rects, and groups whose only leaf is an image) keep the ratio **by default**, Shift frees it. **Departure** (Figma: free everywhere; Canva: locked for photos): a stretched photo is the most common beginner mistake, and Figma natives still have Shift. The tooltip on an image's corner says `Drag to scale · Shift for free` | (a) resize; (b) the default rule |
| Drag the rotate handle or a corner zone | Rotate about the pivot; angle pill | Shift snaps 15°; Alt snaps 90°; **Mod snaps to the angle of the nearest sibling edge** (Pro, `±2°`) | (a) rotate; (b) Alt 90°; (c) sibling-angle snap A-6 M2 |
| Mod-drag a side handle | **Skew** the frame about the opposite edge (top/bottom lean horizontally, left/right vertically) | Shift snaps 15°; Alt about the pivot | (a) |
| Drag the pivot | Moves the reference point; snaps to the nine frame points | Mod free; Alt-click resets | (a) |
| Double-click a side handle (text) | Auto-size conversion (TEXT-FONTS §2.2) | | (b) |
| Drag inside an image with Crop mode | §2.4 | | (c) A-3 |
| Drag a radius handle (rects) | A small ring 12 px inside the top-left corner when a single rect/frame/image is selected and its screen size ≥ 48 px; dragging sets the linked radius (pill `24`); **Alt-drag sets only that corner** (unlinks) | Shift snaps 4 px | (b) |
| Drag a star's inner handle / polygon points field | A ring at an inner vertex sets `ratio`; a mono `Points` pill with scrub on the top vertex | | (b) |
| Free transform session (`Mod+Alt+T`, More, ctx) | Thicker frame, pivot ring, all handles; every drag, key and field edit stacks; **Enter** commits one step `Transform`, **Escape** cancels all; a press outside the frame rotates | | (a) |
| Marquee / click / Shift / Mod click / double-click | STUDIO §6.5 | | (a) |

Pills while dragging (STUDIO §6.1) show **decimals when zoomed past 400 %** and units in Pro; the angle pill shows the
delta too (`37° · +12°`) in Pro.

### 3.2 Numeric: the Transform section

Layout as STUDIO §5.2 (two columns, 32 px mono fields, link toggle):

```
X [  120 ]   Y [  244 ]           ← position of the unrotated box's top-left in the parent (Pro: `Relative to ▾ Parent · Page`)
W [  920 ]   H [  346 ]  🔗       ← link keeps the ratio (remembered per element kind: on for images, off for shapes)
∠ [   0° ]   ⟂ [   0° ]           ← angle (−180, 180]; skew ±80° — More ▾ in Standard, open in Pro
[⇋ Flip H] [⇅ Flip V]  pivot ⋮⋮⋮  ← More ▾ in Standard; the pivot picker is a 3 × 3 grid of dots
```

| Field | Behaviour | Letter |
|---|---|---|
| X, Y | Scrub, type, expressions (`+10`, `*2`, `50%` of the parent), units (`2in`); Enter commits; ↑/↓ 1, Shift 10. `Relative to ▾` (Pro) switches to page coordinates for nested elements (display only; the model stays parent-relative) | (a) fields; (b) scrub/expressions; (b) relative view |
| W, H | ≥ 1; the 🔗 keeps the ratio; typing `W` with the link on sets H. `Swap` (`⇄` ghost between W and H on hover, Pro always) swaps them — orientation for a frame | (a) |
| ∠ | Normalised (−180, 180]; `↻ 90` ghost buttons appear on hover (Pro always): `Rotate 90°` cw/ccw; typing `+15` adds | (a) |
| ⟂ Skew | One field: the model's `skewX`. A vertical lean made with the left/right handle is written back as rotation + skewX (IF-34.5), so the fields show that decomposition honestly; the tooltip says `Horizontal lean · drag a side handle with ⌘ for a vertical lean` | (a) |
| Flip H / Flip V | Toggles (`aria-pressed`); `Shift+H` / `Shift+V` | (a) |
| Pivot picker | 3 × 3 dots; the selected one filled; `Alt+click` resets; only shown when a transform session is active or the pivot moved — **and** always in Pro | (a) |
| Mixed | Multi-selection shows the union frame's X Y W H ∠ (page space, ∠ = 0, skew blank); typing W scales every element with the frame; `Mixed` never appears here because the frame is one thing (Figma); **individual** values appear in Pro's per-element list (DENSITY §3.2) | (a) |
| Scale `%` | Pro only: a `Scale` field under W H that scales the selection **including strokes, effects, corners and text size** about the pivot (`200 %` doubles everything); the `K` **Scale tool** is the gesture version | (c) **A-7** M2 (`scale-by` capability applying to styles) |
| Constraints | For children of a frame: a `Constraints ▾` row (`Left · Right · Left and right · Centre · Scale` × `Top · Bottom · …`) with the Figma pin diagram in Pro; applies when the **frame** resizes (and to Resize design, B-5) | (c) **A-8** M2 (model field + resize rule in `transform.ts`) |
| Layout (auto layout) | Frame section `Layout ▾ None · Horizontal · Vertical · Grid` with gap, padding, align (the Frame layout work TEXT-FONTS T-16 also needs) | (c) **A-15** M2 (Frame layout engine in the authoring crate) |

Units follow Document › Units (`px · mm · in · pt`, HOME-FILES Q-B); fields show the unit as a muted suffix.

### 3.3 Rotate, skew, flip and pivot — the rules in one place

- **Rotation** is clockwise, degrees, about the pivot; multi-selection rotates about the union's pivot and each element's
  own rotation changes by the same delta (a). Snap angles: Shift 15°, Alt 90°, `Alt+]`/`Alt+[` 15°, `Alt+Shift+]`/`[` 1°
  (STUDIO §7). `Rotate 90°` cw/ccw in More, ctx and the ∠ field's hover buttons. Rotated text edits in place (TEXT §6).
- **Skew** is a transform, never a style; text keeps its italic meaning (TEXT §6). Range ±80°.
- **Flip** mirrors geometry **and** paints (a gradient flips with the shape; an image flips) — Figma's rule; text glyphs
  mirror too (TEXT §6) which is what "flip" means; `Flip image` inside the fill (A-3) is the non-mirroring alternative.
- **Pivot** lives in the tab's view state (never saved); it resets when the selection changes; it is shown as a 10 px
  ring with a crosshair; Alt-click resets; in Pro it is always visible on a single selection.
- **Undo labels:** `Move`, `Nudge`, `Resize`, `Rotate`, `Skew`, `Flip horizontal`, `Flip vertical`, `Transform` (session),
  `Duplicate`; the Pro top bar shows them (DENSITY §3.1).

### 3.4 Keyboard transforms

STUDIO §7 Transform group is complete; two additions: `Alt+drag` duplicate (pointer), and **`Mod+Shift+arrows`** are
**not** used for resize-from-centre (Figma has none; the pivot covers it). Every gesture's numeric path is §3.2; the
cheat sheet's Transform card lists the modifiers (`Shift ratio · Alt centre · Mod skew / no snap`).

### 3.5 Multiple and mixed selections

| Case | Frame | Handles | Fields | Pill |
|---|---|---|---|---|
| Several shapes | Union, rotation 0 | All eight + rotate; corner drag scales all | Union X Y W H; ∠ applies a delta | STUDIO §4.2.4 Multi |
| Mixed kinds (text + image + shape) | Union | Same | Same | Fill swatch only when every element has a fill (hatched when they differ) |
| A locked element in the set | Union of the **unlocked** (locked ones are drawn with a dashed outline and do not move) | Same | Same | `Locked · Unlock` chip when **every** element is locked; otherwise normal |
| A repeat and other elements | Union of the repeat's **source** and the others | Same | Same | Multi |
| Elements in different containers | Union in page space; each writes in its own parent's space (IF-24.7) | Same | Same | Multi |
| Everything on the page | `Mod+A` in the entered container | Same | Same | Multi |

### 3.6 Transform control table (normative)

| Control | Kind | HUD rank | Section · tier | Shortcut | Letter |
|---|---|---|---|---|---|
| X, Y | number | — | Transform · essential | arrows nudge | (a)+(b) scrub |
| W, H, link, swap | number + toggle | — | Transform · essential | `Mod+Alt+arrows` | (a) |
| Angle, rotate 90° buttons | number + actions | More (`Rotate 90°`) | Transform · essential (angle), more (buttons; Pro always) | `Alt+]/[`, `Alt+Shift+]/[` | (a) |
| Skew | number | — | Transform · more | Mod-drag side handle | (a) |
| Flip H / V | toggles | More | Transform · more | `Shift+H/V` | (a) |
| Pivot picker | grid | — | Transform · more (Pro always) | Alt-click resets | (a) |
| Relative to (Parent / Page) | menu | — | Transform · pro | — | (b) |
| Scale % and Scale tool | number + tool | — | Transform · pro; tool `K` | `K` | (c) A-7 M2 |
| Constraints | menu pair | — | Transform · more (children of frames) | — | (c) A-8 M2 |
| Free transform | action | More | — | `Mod+Alt+T` | (a) |
| Alt-duplicate drag | gesture | — | — | Alt+drag | (b) |
| Radius handle, star inner handle, Points pill | handles | — | canvas | Alt per-corner | (b) |
| Image ratio-by-default | rule | — | — | Shift frees | (b) |

## 4. Structure

### 4.1 Groups and frames

| Topic | Rule | Letter |
|---|---|---|
| **Group** `Mod+G` (multi pill `Group`, ctx, More) | Wraps the selection in a `group` at the top-most element's position in paint order, named `Group`; bounds follow the children; one step `Group`. `Ungroup` `Mod+Shift+G` puts the children back in the group's place (position and paint order kept) — the same op as boolean release | (b) over the stage ops (`ungroupOps` exists for booleans) |
| **Frame selection** `Mod+Alt+G` (ctx, More) | Wraps in a `frame` sized to the union with 0 padding (Pro: a `Padding` field in the confirm pill), white fill **off** (a frame made around content has no fill, so nothing changes visually), clip on, named `Frame`; `Unframe` = ungroup for frames (children kept, clip gone) | (b) |
| **Group ↔ frame** | Frame section `Convert to group`; group pill More `Convert to frame` (keeps bounds, adds clip off). The Frame section opens with the one line that explains the difference in Standard: `A frame has its own size and clips its content; a group just holds things.` (dismissable hint, OVERLAYS §5) | (b) |
| **Enter / exit** | Double-click or Enter enters; inside, the container has a dashed outline and the inspector header a breadcrumb (STUDIO §6.3); Escape or Shift+Enter leaves; clicking empty canvas leaves. Frames are **transparent** to clicks (children select directly), groups are **opaque** (IF-24.4) — Figma's rule, kept: a group is "one thing" until you go in; a frame is a surface | (a) |
| **Select through** | `Mod+click` selects the leaf under the pointer at any depth; `Mod+marquee` marquees leaves | (a) |
| **Group with a mask / boolean / repeat** | These are groups with a component; ungrouping a boolean releases it; ungrouping a repeat releases it (confirm row in the pill `Release the repeat too? · Release · Keep as group`) | (b) |
| **Empty group** | Removing the last child removes the group (one step) | (b) |
| **Frame clip toggle** | Frame section `Clip content`; off = content shows outside with the frame's hairline still drawn | (a) |
| **Frame fill, stroke, effects, corners** | A frame has the full appearance stacks (§2); its corners clip its content | (a) |
| **Frame layout grids** | §4.7 | (a) |
| **Auto layout** | §3.2 Layout (c) A-15 M2 | (c) |
| **Layers** | Groups and frames are tree rows with chevrons; `Alt+click` the chevron expands all (F-11); a frame's row shows its size as a mono tag in Pro | (b) |
| **Rename** | Inline in Layers (F-11), `Mod+Shift+R`, inspector header click | (b) |
| **Flatten** | A group → one vector path (destructive, confirm row); booleans too | (a) |

### 4.2 Components and instances (decision: M2)

**Recommend: M2 (c) A-12.** The stage already has the `reference` arc (`instance` nodes showing a referenced asset's
children with overrides as local opinions), so components are real work but not a redesign of the model; M1 ships groups,
frames, **repeats** (live instances of one source, Instaflow's own answer for the row-of-cards case), duplicate, and copy/
paste style. Rationale: in social and marketing design, 90 % of "I need this three times" is a repeat, and repeats stay
live without the component ceremony. Owner question Q3. The outlets and flows are designed now so M2 builds, not redesigns:

| Feature | Outlet | Flow to completion | Follow-up |
|---|---|---|---|
| **Create component** `Mod+Alt+K` (multi/single pill More, ctx, palette) | The selection becomes a **main component**: a **mint** outline and a ◈ icon in Layers (mint is the Flow lens colour; a component is a reusable unit, which is what Flows are about); its row in Assets › **Components** tab with a thumbnail; the inspector header reads `Component · Card` with `Description…`. One step `Create component` | Drag from Assets to place an **instance**; `Mod+D` on the main makes an instance (not a copy) — Figma's rule, stated in the first-use hint |
| **Instance** | Pill chip `Instance of Card` · `Go to main` · `Detach` · `Reset ▾` · Duplicate · Delete; Layers ◇ icon; inspector header `Instance of Card`; every field editable | Editing a field creates an **override** (a dot on the label, `Reset` in its tooltip, `Reset ▾` lists them); children can be edited (text, fills) but **not added, removed or reordered** (Figma's structural rule; the pill says `Edit the main component to change its structure · Go to main`) |
| **Edit main** | `Go to main` zooms to it (or opens the Assets page where it lives); edits propagate live to every instance; a 1.5 s toast `12 instances updated` on the first edit of a session | Undo propagates |
| **Detach** `Mod+Alt+B` | The instance becomes a plain group with its current values; one step `Detach instance` | Re-link: `Swap ▾` picks a component |
| **Swap** | Pill `Swap ▾` / Assets drag onto an instance: replaces the component, keeps overrides that match by name (Figma) | |
| **Nested instances** | Allowed; the pill's chip names the innermost | |
| **Variants** | A `Variants` row in the main's inspector (`Add variant`) and a `Variant ▾` menu on instances | M3 |
| **Library across designs** | Components live in the design; sharing through the Brand kit / a Library asset is M3 (D14) | |
| **Repeats vs components** | A repeat's per-instance overrides (text spec §3.4) use the **same override mechanism** (local opinions on derived nodes): one model | M2 with A-12 |

### 4.3 Booleans

| Topic | Rule | Letter |
|---|---|---|
| **Combine ▾** (multi pill, ctx, More; palette `Union`…) | `Union · Subtract · Intersect · Exclude` on ≥ 2 shapes/vectors/groups → a **live boolean group** (Layers: group row with the operation glyph); the result's fill comes from the **top** operand (Figma) and the group's own appearance stacks replace the children's (children keep theirs for when released); one step named after the operation | (a) |
| **Operation ▾** (boolean pill slot 1) | Changes the op live | (a) |
| **Release** | Children back, their own appearance restored | (a) |
| **Flatten** `Mod+E` | Bakes one vector path | (a) |
| **Edit operands** | Double-click enters the boolean group; operands are selectable and movable; the result follows live | (a) |
| **Shortcuts** | None for the four operations in M1 (Figma's `Mod+Alt+U/S/X/E` collide with Milestone `Mod+Alt+S` and Export); palette and menus; `Mod+E` flatten | — |
| **Outline stroke** `Mod+Shift+O` | §2.5 | (a) |
| **Text as operand** | Convert to outlines first (TEXT T-17, M2); until then text is not offered in Combine ▾ (hidden row rule) | (c) M2 |

### 4.4 Masks

| Topic | Rule | Letter |
|---|---|---|
| **Use as mask ▾** (multi pill, ctx, More) | `Clip · Alpha · Luminance`; the **bottom-most** selected element becomes the mask of the others; all are wrapped in a `Mask group` (Layers: group row with the mask glyph, the mask row with a ◐ and indented siblings — Figma's picture). The mask keeps its fills for Alpha/Luminance (they define the mask) and **hides them** for Clip (the shape is the stencil) with the summary line `Clip · the shape's outline` | (a) |
| **Mask mode ▾ · Invert · Release** | Mask group pill | (a) |
| **Which one is the mask** | Standard: the pill chip reads `Mask · Alpha`; the first-use hint says `The bottom layer is the mask`; the Layers row of the mask has the glyph. **Pro departure**: `Swap mask` in the mask group's More makes the top-most the mask instead (reorders) | (a); swap (b) |
| **Matte image** (`mask.asset`, S9) | `Mask › Matte ▾ None · Image…`: picks an alpha image as the mask's alpha (the person-cutout path of `✦ Remove background`) | (a) model; (b) UI |
| **Edit the mask** | Double-click enters the mask group; the mask is selectable, movable, resizable; its own appearance (for alpha/luminance) editable | (a) |
| **Text and image as masks** | Allowed (a text knocked out of a photo) | (a) |
| **Export** | SVG `<mask>`, PDF soft masks (a) | (a) |

### 4.5 Corners

The Corners section (rects, frames, images, polygons, stars, vectors; **not** ellipses, lines or text) is ▸ with the summary
`Radius 24` / `24 · 0 · 24 · 0` / `Smooth 60 %`. Rows: `Radius` (linked, scrub) · per-corner toggle `⊞` → four fields
in the TL TR BR BL order with a tiny corner glyph each (Pro: always four) · `Smooth` slider 0–100 % (`60 %` is the iOS
squircle; the tooltip says so) · for stars `Inner radius`, for polygons/stars `Points` (3–1 000) · for vectors `Per-vertex`
radii edit in the Pen WP (not here). Radii clamp to half the shortest side and the field shows the clamped value with a
muted `max` hint. The on-canvas radius handle is §3.1. HUD rank 3 on rects (`Radius`). Letters (a) + (b) handle.

### 4.6 Repeat

The engine is complete (IF-26); this section fixes the UI already sketched in STUDIO §4.2.4 and DENSITY §3.2.

| Topic | Rule | Letter |
|---|---|---|
| **Make repeat ▾** (shape/multi pill More, ctx) | `Radial · Grid · Mirror`; defaults radial 8 at radius = 1.5 × the source's larger side; grid 3 × 3 with gap 24; mirror vertical offset 0 | (a) |
| **Pill** | chip `Radial · 8` · `Count` (or `Rows × Cols` as two 48 px numbers for grid, `Offset` for mirror) · `Edit` · `Expand` · `Release` | (a) |
| **Edit** (handles) | Radial: radius handle at the centre, count handle on instance 2 (drag along the arc), start-angle by dragging the source; Grid: columns/rows handles past the last column/row, gap by Alt-drag; Mirror: axis offset handle; Shift snaps counts to multiples of 2 / angles to 15°. Escape exits handles | (a) |
| **Inspector Repeat section** | Kind switcher; Standard shows the kind's two main numbers; `More ▾`: Start angle, Sweep (slider), Rotate copies (toggle), Gap X/Y, Row/Column offset, Brick ▾ (`None · Rows · Columns`) + shift slider, mirror `Axis ▾ Vertical · Horizontal · Angle` + angle; then the **source's** sections (Transform · Fill · …) under a hairline labelled `Source` | (a) |
| **Instances** | Clicking one selects the source, highlights the instance, pill chip `Instance 3 of 8`; `Go to source` in More; edits apply to the source with the once-per-session toast (TEXT §3.4). Per-instance overrides: **M2 with A-12** (the same override mechanism as components) — the instance pill then gains `Reset ▾` | (a); overrides (c) |
| **Expand** | Real elements in a group, one step; match keys stable | (a) |
| **Release** | The source alone | (a) |
| **Nested repeats, repeat as boolean operand, masks per instance** | Work; the Layers row shows `Radial · 8 ▸ Grid · 3 × 3` | (a) |
| **Limits** | > 1 000 instances: the Count field clamps with a hint `Up to 1 000 copies` (IF-REP-002) | (a) |
| **Repeat along a path, scatter / random** | `Make repeat ▾ › Along path…` (pick a path) with `Count`, `Spacing ▾ Even · Fixed`, `Align to path`; `Scatter` with a seed | (c) M3 |

### 4.7 Snapping, smart guides, rulers, guides and grids

| Feature | Rule | Letter |
|---|---|---|
| **Snapping** | Edges and centres of siblings, container edges and centre lines, layout grid lines, equal spacing; 6 px screen threshold; Mod suspends while dragging; Shift locks an axis (IF-24.8–24.12) | (a) |
| **Smart guides** | Tangerine `#FF5C39` 1 px lines, fade 80/120 ms; distance labels as mono mist tags; equal-spacing ticks (STUDIO §6.4). Pro shows distance tags **on hover** of an aligned neighbour too (DENSITY §3.1) | (a) |
| **Snap settings** | `View ▾ › Snapping ▸`: `Snap to elements` ✓ · `Snap to grids` ✓ · `Smart guides` ✓ · `Snap to pixels` (M2) · `Snap to guides` (M2); one submenu, remembered per device; the cheat sheet says `Hold ⌘ to move freely` | (b) |
| **Rulers** | Pro: on (DENSITY §3.1); Standard/Focus: `View ▾ › Rulers` `Shift+R`; 20 px, mono 10 px ticks in document units, origin at the page's top-left, the selection's extent highlighted on both rulers; right-click a ruler → `Units ▾` | (b) over the camera |
| **Guides** | Drag out of a ruler → a guide (page-space, non-printing, stored in the page's `layout.guides`); drag back to remove; double-click → position field; `View ▾ › Lock guides`; snapping to guides | (c) **A-16** M2 (model field + snap target); until then dragging from a ruler does nothing (no half gesture) |
| **Layout grids** | Frame / Page section `Layout grid ▸`: rows of `Columns · Rows · Grid` with count, gutter, margin, align (`Stretch · Left · Centre · Right`), size, colour, eye; `+ Add ▾`; the overlay toggle `Ctrl+G` (Mac) / `Ctrl+Alt+G`; grids snap (a) and never export | (a) model, snap, overlay; (b) UI |
| **Pixel grid** | `View ▾ › Pixel grid` at ≥ 800 % zoom; `Snap to pixels` rounds positions and sizes on commit | (c) M2 (snap rule); the overlay (b) |
| **Nudge** | 1 / Shift 10, Settings edits both | (a) |

### 4.8 Align and distribute

The alignment popover (STUDIO §4.2.7) over B1's actions: 3 × 2 grid, distribute `H · V · Tidy up`, `Align to:
Selection · Page` (+ `Parent` when inside a frame, `Key object` in Pro). **Key object** (Illustrator): with ≥ 2 selected,
`Alt+click` one of them → it gets a double outline and `Align to` reads `Key object`; aligning moves the others to it;
Escape or a new selection clears. Single element: `Align to Page`/`Parent` only. Keys as STUDIO §7 (`Alt+A/H/D/W/V/S`,
`Ctrl+Alt+H/V`, `Ctrl+Alt+T`). `Tidy up` snaps a rough grid even; **smart spacing handles** (Figma's pink gap handles
after Tidy up: drag the gap to change all gaps) are (c) **A-17** M2 (an editor gesture). Distribute `by centres` lives in
the popover's `⋯` (Pro: a second row). Position-locked elements stay and count as anchors (IF-20.9). Letters (a) + (b) popover.

### 4.9 Layer order, lock, hide, rename

| Feature | Outlet | Rule | Letter |
|---|---|---|---|
| **Bring forward / Send backward** `Mod+]` / `Mod+[` | ctx, More, Layers drag, `Alt+↑/↓` in Layers | Within the parent; one step `Reorder`; a 2 px insertion line while dragging; dropping onto a frame re-parents (F-11) | (b) over the document order |
| **Bring to front / Send to back** `Mod+Alt+]` / `Mod+Alt+[` | same | | (b) |
| **Lock** `Mod+Shift+L` | Layers lock (hover; Pro always), pill `Lock`/`Unlock`, inspector header, ctx | Default scope `all` (position + content): dashed `#7D8897` frame, no handles, clicks pass through, pill `Locked · Unlock`. **Pro `Lock ▾`**: `Everything · Position only` — position-only keeps the element recolourable and editable (a locked background photo you can still swap) and selectable with a dashed frame but no move; Layers shows a half-lock glyph. **Departure**: Figma and Canva have one lock | (a) model scopes; (b) UI |
| **Hide** `Mod+Shift+H` | Layers eye, ctx `Hide`, More | Hidden elements vanish from canvas, export and hit tests; the Layers row is 50 % with the eye crossed; `Show all` in the Layers `⋯`; selecting a hidden element in Layers shows a ghost outline on the canvas | (c) **A-2** M1 follow-up (a `hidden` prop + the projection skipping it + export); the control is not rendered before |
| **Rename** `Mod+Shift+R` / F2 | Layers inline, inspector header, ctx | Empty refused inline; names show in Layers, header, announcer, exports' layer names (SVG ids) | (b) |
| **Select same ▾** | ctx | §2.9 | (b) |
| **Layers filter** | `Kind ▾` chips (`Text · Image · Shape · Frame · Hidden · Locked`) beside the filter field in Pro; typing filters names | (b) |
| **Isolation** | Double-click a Layers row → enters the container (same as canvas) | (a) |
| **Delete** | `⌫`, pill, ctx; deleting a mask releases the siblings; deleting a boolean operand updates the result | (a) |

### 4.10 Structure control table (normative)

| Control | Kind | HUD rank | Section · tier / place | Shortcut | Letter |
|---|---|---|---|---|---|
| Group / Ungroup | actions | Multi 4 / Group 1 | ctx, More | `Mod+G` / `Mod+Shift+G` | (b) |
| Frame selection / Unframe | actions | More | ctx | `Mod+Alt+G` | (b) |
| Convert to frame / group | action | More | Frame section | — | (b) |
| Clip content | toggle | Frame 2 | Frame · essential | — | (a) |
| Enter / exit, select through | gestures | — | canvas | Enter, Esc, Mod+click | (a) |
| Create component / Detach / Swap / Reset overrides / Go to main | actions | Instance pill 1–4 | ctx, More, Assets › Components | `Mod+Alt+K`, `Mod+Alt+B` | (c) A-12 M2 |
| Combine ▾, Operation ▾, Release, Flatten | menu + actions | Multi More; Boolean 1, 3, 4 | ctx | `Mod+E` flatten | (a) |
| Use as mask ▾, Mask mode ▾, Invert, Release, Matte ▾, Swap mask | menu + actions | Multi More; Mask 1–3 | Mask section | — | (a) + (b) |
| Radius, per-corner, smooth, points, inner radius | numbers + slider | Rect 3 | Corners | — | (a) |
| Make repeat ▾, Count/Rows/Cols/Offset, Edit, Expand, Release, parameters | menu + numbers + actions | Repeat 2–5 | Repeat section | — | (a) |
| Per-instance overrides, Reset ▾ | chip + menu | Instance | — | — | (c) A-12 M2 |
| Snapping submenu, Rulers, Pixel grid, Layout grid overlay | toggles | — | `View ▾` | `Shift+R`, `Ctrl+G` | (a) snap, (b) UI; pixel snap (c) |
| Guides | gesture + field | — | rulers | — | (c) A-16 M2 |
| Layout grids rows | stack | — | Frame / Page `Layout grid ▸` | — | (a) + (b) |
| Align grid, distribute, tidy up, Align to, key object | popover | Multi 3 (`Align ▾`) | ctx `Align ▾` | `Alt+A…`, `Ctrl+Alt+H/V/T` | (a) + (b) |
| Smart spacing handles | gesture | — | canvas after Tidy up | — | (c) A-17 M2 |
| Z-order | actions | More | ctx, Layers | `Mod+]/[`, `Mod+Alt+]/[` | (b) |
| Lock ▾ (Everything / Position only) | toggle + menu | Locked 2 | header, Layers | `Mod+Shift+L` | (a) + (b) |
| Hide / Show | toggle | More | Layers, ctx | `Mod+Shift+H` | (c) A-2 M1 |
| Rename | inline | — | Layers, header | `Mod+Shift+R` / F2 | (b) |
| Layers kind filter | chips | — | Layers (Pro) | — | (b) |

## 5. Per density

DENSITY §3.2 and §8.1 hold the normative tier rows; this is the summary for the kinds this file owns.

| | Focus | Standard | Pro |
|---|---|---|---|
| Pill | the six per kind (STUDIO §4.2.4) | same | same, units on numbers, second tooltip line |
| Inspector at rest (shape) | rail: Transform · Fill · Stroke · Corners · Effects · Layer icons; a click opens one section as a floating card | Transform (X Y W H ∠, link) · Fill stack · Stroke stack (swatch, width) · ▸ Corners (summary) · ▸ Effects (summary) · ▸ Layer (summary) | everything open: Transform with ⟂, flips, pivot, Relative to, Scale; stacks with second lines open; Corners as one row of four + Smooth; Effects fields inline; Layer slider + number |
| Behind `More ▾` (Standard) | — | Transform: skew, flips, pivot · Stroke: position, sides, dash, cap, join · Image: position, scale, adjustments, source · Page: apply to all, use for new | no `More` |
| Colour popover | as Standard | tabs, value row (HEX default), contrast tag, rows, `Custom ▸` collapsed | `Custom ▸` open; hex captions on every swatch; the last model remembered; gradient handle tags in `%` |
| Canvas HUD | handles, pills while dragging | same; radius handle on hover of the corner | same; pivot always; distance tags on hover; gradient handles show positions |
| Layers | floating card | eye/lock on hover; kind icons | eye/lock always; `Kind ▾` filter; W × H column; mask/boolean/repeat glyphs with a mono summary |
| View menu | Rulers, Snapping ▸ | same | Rulers on by default; Pixel grid; Lock guides |

## 6. Fidelity and export

| Concern | Rule | Letter |
|---|---|---|
| **What you see is what exports** | One scene IR renders the canvas, the thumbnails, the Export preview and the PNG; SVG and PDF are writers over the same recorded scene (D21). The Export preview *is* the renderer, so any fallback below is visible before pressing Export | (a) |
| **Conic gradients** in SVG/PDF | Rasterised to a pixel pattern at the export scale (`Feature::SweepGradient`); Pro's result line: `1 conic gradient rasterised` | (a) |
| **Effects** in PDF | Shadows, glows and blurs are raster patches (vector elsewhere); SVG uses filters. Pro result line counts them | (a) |
| **Background blur** | Needs what is behind at export time: PNG exact; SVG approximates with `backdrop-filter`-free raster patch; PDF raster patch | (a) |
| **Masks** | SVG `<mask>`; PDF soft masks; luminance in both | (a) |
| **Image fills** | Embedded at the asset's pixels (never upscaled); `Tile` as patterns in SVG/PDF | (a) |
| **Per-side strokes, dashes** | SVG: the stroke ring as a filled path when sides differ; PDF the same | (a) |
| **Gradient and image strokes** | The stroke's outline filled with the paint (SVG and PDF) | (a) |
| **Page background** | Included unless Export › Advanced `Transparent`; with A-1 the page's whole stack | (a) solid; (c) A-1 |
| **Hidden and locked** | Hidden elements never export (A-2); locked ones do (lock is editing, not visibility) | (c) A-2 |
| **Smart guides, grids, rulers, handles, pivot** | Overlay batches; never in the document, a thumbnail or an export | (a) |
| **Repeats** | Instances render identically live and expanded (IF-26.19) | (a) |
| **Pixel parity** | GPU = CPU goldens; the owner's eye check is the Export preview | (a) |

## 7. Errors and edge states

| Situation | Code | What the person sees | Fix offered |
|---|---|---|---|
| Invalid paint / stack value (a bad hex typed) | `IF-EL-001` | The field shows an invalid state (STUDIO field rules) and keeps the last value; nothing is written | Correct it; Escape restores |
| Unknown brand token | `IF-EL-002` | Hatched swatch, `Token @primary is not in this brand kit · Replace with #FF5C39` | Replace, or open Brand (M2) |
| Brand rule blocks a write (`CTAs use @primary`) | `IF-EL-003` | The popover's value row shows a sunflower line `Brand rule: buttons use @primary · Use it · Override…`; `Override…` is rendered only for a `warn` rule (a `block` rule never offers it) | Use the token |
| Action does not apply (Combine on one shape) | `IF-EL-004` | Never shown: the row is absent from menus and the pill | — |
| Geometry rejected (a degenerate boolean) | `IF-EL-005` | Toast `Couldn't combine these shapes · Try Flatten first` | Flatten |
| Authoring Wasm missing | `IF-EL-006` | Banner `Shapes can't be edited right now · Retry` (OVERLAYS §3.4), handles hidden | Retry |
| Repeat over 1 000 instances | `IF-REP-002` | The Count field clamps with the hint `Up to 1 000 copies` | — |
| Write targets a repeat instance | `IF-REP-004` | Never shown: clicking an instance selects the source | — |
| Nothing movable (all position-locked) | `IF-TOOL-002` | The pill reads `Locked · Unlock`; arrows do nothing; a 1.5 s mist toast `Locked · press ⌘⇧L to unlock` on the first arrow press | Unlock |
| Transform value out of range (W 0, skew 90) | `IF-XF-001` | Field clamps and hints (`min 1`, `max 80°`) | — |
| Image asset missing (pasted from another workspace) | `IF-LIB-*` | The fill row shows a hatched image swatch and `Image not available on this device · Replace…`; the canvas draws a mist box with the asset name | Replace |
| Eyedropper API refused / unavailable | — | Falls back to tile sampling silently; nothing to tell | — |
| Contrast below AA on text | — | Sunflower-bordered tag `× 2.1 : 1`, click → nearest passing colour | Use it |
| 17th fill / stroke / effect | — | `+ Add ▾` footer `Up to 16 fills` | Remove one |
| A gradient with one stop | — | Not possible: Delete on the second-to-last stop is a no-op with the hint `A gradient needs two stops · switch to Solid instead` | Solid tab |
| Rotating a locked or multi-locked selection | `IF-TOOL-002` | As above | — |
| Mask with nothing to mask (single element) | `IF-EL-004` | `Use as mask` absent on a single element | Select two |
| Element outside every page (loose) and page background edits | — | Loose elements are unaffected by the page background; the Pages lens says `1 loose element` (F-02) | — |

## 8. Accessibility

- Every control in §2.10, §3.6 and §4.10 has a label, a tooltip with its key and `aria-keyshortcuts`; toggles use
  `aria-pressed` (with `mixed`); stacks are `list`s of `listitem`s with the row's summary as the name (`Fill 1 · Linear ·
  3 stops`); the eye is `Show fill` / `Hide fill`; reorder has the `Alt+↑/↓` keyboard path and announces `Fill 2 moved up`.
- The colour popover: `dialog` named `Colour`; tabs a `tablist`; grids `grid` with hex names; the model menu is a `menu`;
  the eyedropper has a keyboard loupe (arrows, Enter) and announces the hex under it; the contrast tag is a polite live
  region (`Contrast 4.9 to 1, AA`).
- Gradient stops are `slider`s named `Stop 2 of 3, 52 %, #FF5C39`; `Delete` removes; the strip announces `Stop added at 60 %`.
- Transform fields are standard fields; every handle gesture has a field; the pivot picker is a `radiogroup` of nine.
- Structure: group/enter/exit announce the breadcrumb (`Entered Frame 1, 3 elements`); masks announce `Mask group, clip`;
  booleans `Union of 2 shapes`; repeats `Radial repeat, 8 instances` (B6 messages); lock announces the scope.
- Snapping is visual; the result is always readable in the X Y fields, so no snap announcements (noise). Alignment
  actions announce `Aligned 3 elements left`.
- Reduced motion: no guide fades, no zoom glide to the main component, no pill slide.
- Focus: 2 px deep tangerine outline on every control, including stack rows and gradient stops; colour is never the only
  signal (the hidden row is 50 % **and** has a crossed eye; the mixed hatch **and** the word `Mixed`).
- Touch targets stay ≥ 24 px (row controls are 28 px; stops 12 px visual with a 24 px hit area).

## 9. Plumbing (where each piece lives)

| Piece | Code | Status |
|---|---|---|
| Controls table (§2.10, §3.6, §4.10) with `tier` and HUD rank | `src/spec/controls.ts` (STUDIO §12) | missing |
| Fill / Stroke / Effects stacks with summaries, second lines, `+ Add ▾` menus, reorder | `src/elements/panel.ts` over `appearanceModel` / `appearanceEditOps` (exist); kit `<sf-stack-row>` (new) | partly (panel exists, flat) |
| Colour popover with tabs, models, alpha, eyedropper, save, contrast, rows | kit `<sf-color-popover>` (UX-PRIMITIVES; today `sf-color-field` is native); OKLCH via `@staticflux/ui/theme` colour maths; tile sampling via the canvas's `readback` (render module) | missing |
| Gradient tab and on-canvas handles | kit `<sf-gradient-strip>`; handles in `src/tools/overlay.ts` + a gesture in `src/tools/gesture.ts` (`gradient-handle`); fields ↔ paint in `src/elements/inspector.ts` | missing |
| Document colours and gradients | `ColorsMirror` in `src/workers/mirrors.ts` (STUDIO §12), extended with gradients and effect colours | missing |
| Saved palette, recent, model memory, snap settings, rulers | `src/settings/ui-state.ts` (per device) | missing |
| Effect presets and the Bevel preset rows | `src/elements/presets.ts` (new): tables of `EffectValue[]` | missing |
| Page background stack | A-1: `page` gets `Style` (fills) in `components.ts`; projection emits the page rect; `job.ts` `transparent` skips it | (c) |
| Image crop mode | A-3: `PaintValue.image` gains `offset`, `scale`, `rotation`; `src/tools/gesture.ts` `crop` gesture; `src/elements/resolve.ts` maps to the IR image transform | (c) |
| Group, ungroup, frame selection, reorder, rename, hide | `src/elements/actions.ts` + capabilities (STUDIO §12); hide needs A-2 (`hidden` prop, projection, export) | missing / (c) |
| Lock scope UI | `Lock` component scopes exist; the pill and Layers read `lock.scope` | missing |
| Alt-duplicate drag, radius handle, star handle, key object, Swap mask, Relative to | `src/tools/gesture.ts`, `overlay.ts`, `actions.ts` (`align` already takes `key`) | missing |
| Copy / paste style | `src/elements/styles.ts` (`copyStyle`, `pasteStyle` over `localValues`), capabilities, clipboard mime `application/x-instaflow-style+json` | missing |
| Select same, Find Kind Colour | STUDIO §9.1 mirrors | missing |
| Rulers, pixel grid overlay, snapping submenu | `src/tools/overlay.ts` (rulers batch), `view-state.ts` settings, View menu | missing |
| Components | A-12: `instance` node kind over the stage's `reference` arc; Assets › Components tab; override UI | (c) |

## 10. Every feature: its outlet, its flow to completion and follow-up, and the (c) schedule

Standing rule (owner, 2026-10-25, `CAPABILITY-COVERAGE.md`): UX designs **every** feature now, deferred ones included — its
**outlet** (exactly where it lives, per density) and its **flow** (how the person finishes, and what comes next). A deferred
feature's outlet is **reserved** and not rendered until built (FOUNDATIONS §5.6). Vocabulary: `HUD n` = pill slot, `More` =
the pill's `⋯`, `Fill · S / M / P` = the section at rest in Standard / behind `More ▾` or the row's second line / Pro only,
`pop` = the colour popover, `ctx` = context menu, `pal` = palette, `View` = the View menu. Every row's undo is one step
named after the control unless it says otherwise.

### 10.1 Outlets and flows

| Feature (letter · milestone) | Outlet | Flow to completion | Follow-up and what comes next |
|---|---|---|---|
| **Solid fill** (a) | HUD 1 swatch; Fill · S row; pop Solid tab | Click the swatch, pick a document colour or type a hex, Enter. | `☆` saves it; `Select same ▾ Fill` recolours siblings; Find Kind Colour replaces everywhere; `Mod+Alt+C` copies the style |
| **Several fills, reorder, hide, opacity, blend** (a model · b UI) | Fill · S rows; `+ Add ▾`; grip / `Alt+↑↓`; eye; `%`; `Blend ▾` M | `+ Add ▾ Colour` → a new top row; drag below; set 60 %. | Collapse the section → summary `2 fills`; paste style carries the stack |
| **Gradient fill, edit in the popover** (a model · b UI) | `+ Add ▾ Gradient ▸ Linear`; pop Gradient tab; HUD swatch | Pick a preset or click the strip to add stops, drag them, set Angle, Reverse. Enter closes. | Document gradients row offers it on the next shape; `☆` saves; the row's second line edits Angle without the popover |
| **Gradient on canvas** (b) | Handles while the Gradient tab or the row is active | Drag an end (Shift 15°), drag a stop ring, click the line to add. | Fields follow; Escape closes; undo one step `Gradient` |
| **Radial aspect / ellipse** (c · M2, A-4) | Pop Gradient tab `Aspect` field (Pro) + a second radius handle | Drag the second handle → an elliptical gradient. | Export vector (SVG `gradientTransform`) |
| **Gradient text** (c · M2, A-11) | Text's Fill `+ Add ▾ Gradient` (hidden until A-11) | Add → glyphs painted with one brush. | Same editor; export PDF/SVG as paths with the paint |
| **Colour models, alpha** (b) | pop `HEX ▾` menu; alpha field | Pick `OKLCH`, scrub L. | Remembered per device; copy as CSS |
| **Eyedropper** (b) | pop `⌖`; `I` in the popover | Click → loupe → click a pixel. | Recent gets it; `☆` saves |
| **Contrast check** (b) | pop tag under the value row | Read `AA 4.9 : 1`; click → `Nearest passing colour · Use it`. | The tag follows every change live |
| **Saved palette** (b) | pop `☆`; `Saved` row; Pro right-click rows | Star a colour or gradient. | Appears in every design on this device; M2 Brand kit import (B-4) |
| **Brand tokens on fills, strokes, effects, radii** (a) | pop Brand row; `From brand ▸` in Effects; `@` tag in fields | Click `@cream` → bound. | `Detach`; unresolved → hatched + Replace; Brand panel (B-4) edits the kit |
| **Style classes, overrides, reset** (a model · b UI) | Pro header `Class · Card`; dot on overridden labels; `Reset overrides ▾` | Change a fill → dot; `Reset` returns the class value. | Brand panel (B-4) applies classes; agents see provenance |
| **Named document colour / effect styles** (c · M2, A-13) | pop `Styles` row; Effects `⋯ › Save as style…`; Brand panel `Styles` | `Save as style…` → name → every use linked; edit the style → all update. | `Detach`; Find Kind `Style`; brand kits import styles |
| **Image fill: fit, replace** (a) | Image · S `Fit ▾`, `Replace…`; HUD 2–3; `+ Add ▾ Image…` on any shape | Pick `Fit`; `Replace…` → Assets. | Crop (A-3); mask; opacity wash |
| **Image crop, position, scale, rotate inside** (c · M1 follow-up, A-3) | HUD `Crop`, double-click, Enter; Image · M fields | Double-click → crop mode → drag the image, scale by its handles, Enter. | `Reset crop` in M; replace keeps the crop when ratios match |
| **Image adjustments** (c · M2, A-10) | Image · M sliders (Pro open) | Scrub `Exposure`. | `Reset` per slider; Pixel lens (B-2) for destructive work |
| **✦ Remove background** (M2 assistant) | HUD 6 on images | Proposal → Accept → alpha PNG asset. | Mask matte path; undo |
| **Stroke: width, colour, position** (a) | HUD 2 swatch (3 width on lines); Stroke · S | `+ Add` → 1 px inside; set width. | Outline stroke; paste style |
| **Per-side strokes** (a model · b UI) | Stroke · M `⊞` toggle → T R B L | Toggle, set `B` to 2 and the rest 0 → an underline card. | Link toggle returns to one width |
| **Dash, caps, joins** (a · b presets) | Stroke · M `Dash ▾ Cap ▾ Join ▾`; Pro mono pattern | Pick `Dotted`. | Custom pattern; Outline stroke bakes it |
| **Arrowheads** (c · M2, A-5) | Lines' HUD 3 `End ▾`; Stroke · S `Start ▾ End ▾` on lines/open paths | Pick `Arrow`. | Size in Pro; Flatten bakes |
| **Gradient / image stroke** (a) | Stroke swatch → pop tabs | Pick the Gradient tab. | Same handles |
| **Outline stroke** (a) | More, ctx, `Mod+Shift+O` | One click → a filled vector. | Combine with others |
| **Shadows, glows, blurs** (a) | Effects ▸ `+ Add ▾` presets; rows' second line | `+ Add ▾ Shadow ▸ Soft`. | Tune X Y Blur; `From brand ▸`; summary in the collapsed header |
| **Bevel preset** (b) | Effects `+ Add ▾ Bevel ▸ Soft · Hard · Pillow` | Pick → two grouped rows tagged `Bevel`. | Edit either row; remove one → tag goes |
| **Bevel & emboss kind** (c · M2, A-9) | Same `Bevel ▸` entry; row fields (Style, Depth, Size, Soften, Angle, Altitude, colours) | Pick `Soft bevel` → one row of the kind. | Presets of the kind; export raster patch |
| **Noise / texture** (c · M3) | Effects · P `+ Add ▾ Noise` | Amount, size. | Export raster |
| **Layer opacity and blend** (a) | Layer ▸ slider + `Blend ▾`; `Alt+Shift+↑/↓` | Scrub to 50 %. | Summary `50 % · Multiply`; pass-through (A-14) |
| **Pass-through blend for groups** (c · M2, A-14) | Layer `Blend ▾ Pass through` on groups (default) | Default; pick `Normal` to isolate. | — |
| **Page background colour** (a) | Page · S Background stack; page label HUD 1; New design `More ▾` | Click the swatch, pick. | `Apply to all pages`; `Use for new pages`; Export `Transparent` |
| **Page background gradient / image / several rows** (c · M1 follow-up, A-1) | Same stack `+ Add ▾ Gradient · Image…`; `Crop background` in the page label menu; ctx on an element `Use as page background` | `+ Add ▾ Image…` → pick → `Fit ▾ Fill`; add a colour row under it at 40 % for a wash. | Crop (A-3); thumbnails and milestones show it; Export includes it unless Transparent |
| **Copy / paste style** (b) | More, ctx, `Mod+Alt+C` / `Mod+Alt+V`; ctx `Paste style ▸` | Copy from one card, select five, paste. | `Fill only` etc.; Select same; linked styles (A-13) are the repeatable version |
| **Select same ▾ / Find Kind Colour** (b) | ctx; `Mod+F` | `Select same ▾ Fill` → pick a colour → all change. | Undo one step |
| **Move, resize, rotate** (a) | handles, fields, arrows | Drag; `W × H` pill. | Smart guides; undo labels |
| **Rotate handle** (b) | Below the frame on a stem | Drag (Shift 15°, Alt 90°). | Angle field; `Rotate 90°` buttons |
| **Skew** (a) | Mod-drag side handles; Transform · M ⟂ | Mod-drag the top handle (Shift 15°). | Field shows the decomposition |
| **Flip** (a) | More, ctx, `Shift+H/V`, Transform · M toggles | Press. | Twice = identity |
| **Pivot** (a) | Ring in a session or when moved; Transform · M picker; Pro always | Drag to a corner, rotate. | Alt-click resets; resets on new selection |
| **Free transform session** (a) | More, ctx, `Mod+Alt+T` | Several edits, Enter. | One step `Transform`; Escape cancels all |
| **Numeric transform, expressions, link, swap, relative to** (a · b) | Transform · S fields | Type `+10`, Enter. | Tab to the next field |
| **Image ratio by default** (b) | Corner handles on images | Drag → scaled. | Shift frees |
| **Alt-duplicate drag** (b) | Alt+drag | Drop → a copy. | `Mod+D` repeats the offset (STUDIO §9) |
| **Radius handle** (b) | Ring inside the top-left corner | Drag; Alt for one corner. | Corners section |
| **Scale tool / Scale %** (c · M2, A-7) | Tool `K`; Transform · P `Scale %` | `K`, drag a corner → strokes, text and effects scale too. | `V` returns |
| **Constraints** (c · M2, A-8) | Transform · M `Constraints ▾` for frame children; Pro pin diagram | Set `Right · Bottom` → resize the frame → the child follows. | Resize design (B-5) uses them |
| **Auto layout** (c · M2, A-15) | Frame section `Layout ▾`, gap, padding | Pick `Horizontal` → children flow. | Text bound to shapes (TEXT T-16) |
| **Sibling-angle rotation snap** (c · M2, A-6) | Mod while rotating (Pro) | Snaps to a neighbour's edge angle. | — |
| **Group / ungroup** (b) | Multi pill `Group`; ctx; `Mod+G` / `Mod+Shift+G` | Select three, `Mod+G`. | Rename; Enter to edit inside; Convert to frame |
| **Frame selection / unframe / convert** (b) | ctx, More, `Mod+Alt+G`; Frame section | `Mod+Alt+G` → a clipping frame around the content. | Clip toggle; layout grid; auto layout (A-15) |
| **Enter, exit, select through** (a) | double-click, Enter, Esc, Shift+Enter, Mod+click | Double-click a group → the child under the pointer is selected. | Breadcrumb; Escape ladder |
| **Components: create, instance, override, reset, detach, swap, go to main** (c · M2, A-12) | §4.2 outlets: `Mod+Alt+K`, Assets › Components, instance pill, `Mod+Alt+B` | `Mod+Alt+K` → component; drag from Assets → instance; change its text → override dot; edit main → all update. | Detach; Swap ▾; variants M3 |
| **Booleans** (a) | Multi pill `Combine ▾`; boolean pill `Operation ▾ · Release · Flatten`; ctx; `Mod+E` | `Combine ▾ Subtract`. | Enter to move operands; Flatten to bake |
| **Masks** (a) | Multi pill `Use as mask ▾`; mask pill `Mask mode ▾ · Invert · Release`; Mask section `Matte ▾` | Image over an ellipse (ellipse at the bottom) → `Use as mask ▾ Clip`. | Enter to move the image inside; Invert; Release |
| **Swap mask** (b) | Mask group More | Makes the top-most the mask. | — |
| **Corners** (a · b handle) | HUD 3 `Radius` (rects); Corners ▸ section; the handle | Scrub to 24; toggle per-corner; Smooth 60 %. | Paste style carries corners |
| **Repeat** (a) | More `Make repeat ▾`; repeat pill; Repeat section; handles | `Make repeat ▾ Radial` → 8; drag the radius handle. | Expand; Release; nested |
| **Per-instance overrides on repeats** (c · M2, A-12) | Instance pill `Reset ▾`; any field while an instance is highlighted | Edit an instance's text → only that instance changes, with a dot. | `Reset ▾`; Expand bakes |
| **Repeat along a path / scatter** (c · M3) | `Make repeat ▾ Along path…` | Pick a path → copies follow it. | — |
| **Snapping and smart guides** (a) | automatic; `View › Snapping ▸` | Drag → guides and labels. | Mod suspends; Shift locks an axis |
| **Rulers** (b) | `View › Rulers` `Shift+R`; Pro default | Toggle → rulers with the selection's extent. | Units menu; guides (A-16) |
| **Guides** (c · M2, A-16) | Drag from a ruler; double-click for a value; `View › Lock guides` | Drag out → a tangerine hairline; elements snap to it. | Drag back removes; never exports |
| **Layout grids** (a · b UI) | Frame / Page `Layout grid ▸`; `Ctrl+G` overlay | `+ Add ▾ Columns 12 · gutter 24`. | Snapping to grid lines; eye per grid |
| **Pixel grid / snap to pixels** (c · M2) | `View › Pixel grid`, `Snapping ▸ Snap to pixels` | Toggle at ≥ 800 %. | — |
| **Align, distribute, tidy up, key object** (a · b popover) | Multi pill `Align ▾`; ctx; keys | Open the popover, click `Left`, `Distribute H`. | Stays open for a second click; key object by Alt-click (Pro) |
| **Smart spacing handles** (c · M2, A-17) | Pink-free tangerine gap handles after Tidy up | Drag a gap → all gaps change. | — |
| **Z-order** (b) | ctx; More; Layers drag; `Mod+]/[`, `Mod+Alt+]/[` | `Mod+]`. | Layers shows the new order |
| **Lock, lock scope** (a · b) | Layers lock; pill; header; `Mod+Shift+L`; Pro `Lock ▾` | Lock → dashed frame, clicks pass through. | Unlock from the pill or Layers; Position-only for a recolourable background |
| **Hide / show** (c · M1 follow-up, A-2) | Layers eye; ctx; `Mod+Shift+H`; Layers `⋯ › Show all` | Click the eye → gone from canvas and export. | Ghost outline when selected in Layers |
| **Rename** (b) | Layers inline; header; `Mod+Shift+R` | Type, Enter. | Names in exports' layer ids |
| **Layers kind filter** (b) | Layers header chips (Pro) | Click `Hidden`. | — |
| **Vector point editing, pen, arrowheads on paths** | The Pen WP (not this file) | | |

### 10.2 Follow-ups — every (c), with a milestone (never rendered before it lands)

| # | Item | Where | Milestone |
|---|---|---|---|
| A-1 | **Page fill stack**: `page` gets `Style` (fills only); projection emits the page rect node; Export `transparent` skips it; thumbnails and milestones render it | `components.ts`, `projection.ts`, `job.ts`, `plan.rs` | **M1 follow-up** (owner request) |
| A-2 | **Hidden elements**: a `hidden` prop; projection, hit test, export and a11y skip it; `Show all` | `components.ts`, `projection.ts`, `hit-test.ts`, export plan | M1 follow-up |
| A-3 | **Image fill crop**: `offset`, `scale`, `rotation` on image paints; crop gesture; IR image transform | `values.ts`, `resolve.ts`, `scene-ir.ts`, `ir.rs`, `gesture.ts` | M1 follow-up (owner's "images like shapes" needs it for backgrounds) |
| A-4 | Radial gradient aspect (`radiusY`) | `values.ts`, `ir.rs`, export writers | M2 |
| A-5 | **Arrowheads** on lines and open paths | authoring crate stroke outlines, `values.ts` | M2 (pull to M1 if the Pen WP touches stroke outlines) |
| A-6 | Rotation snap to a sibling's edge angle (Mod) | `transform.ts` | M2 |
| A-7 | **Scale tool / Scale %** (`scale-by` applies to strokes, effects, corners, text) | `transform.ts`, capabilities | M2 |
| A-8 | **Constraints** for frame children | `components.ts`, `transform.ts` resize rule | M2 (with Resize design B-5) |
| A-9 | **Bevel & emboss** effect kind | `values.ts`, `ir.rs`, render crate edge-lighting pass, export raster patch | M2 |
| A-10 | **Image adjustments** (non-destructive filters on image paints) | `values.ts`, render filters, export raster | M2 (with the Pixel lens B-2) |
| A-11 | **Gradient / image text fill** | text projection per element brush | M2 (TEXT A.2) |
| A-12 | **Components and instances** (+ per-instance overrides on repeats) on the stage `reference` arc | stage, `components.ts`, Assets › Components, override UI | M2 |
| A-13 | **Named document styles** (colour, effect) over D14 shared styles; Brand panel lists them | D14, Brand panel (B-4) | M2 |
| A-14 | **Pass-through** blend for groups | `components.ts`, `ir.rs` | M2 |
| A-15 | **Auto layout** (Frame layout engine) | authoring crate, `components.ts` | M2 (shared with TEXT T-16) |
| A-16 | **Guides** (page `layout.guides`, snap target, ruler drag) | `components.ts`, `snapping.ts`, `overlay.ts` | M2 |
| A-17 | **Smart spacing handles** after Tidy up | `gesture.ts`, `overlay.ts` | M2 |
| A-18 | **Pixel grid snapping** | `transform.ts` commit rounding | M2 |
| A-19 | Noise / texture effects; repeat along a path; scatter | render, repeat generators | M3 |

## 11. Owner questions (recommendation first)

**Q1. Page background: a property of the page, or a locked layer?** *Recommend:* make the page's background the **same
fill stack a shape has** (colour, gradient, image, several rows with opacity) as a property of the page — engine work,
A-1, scheduled as an M1 follow-up. The alternative, which Canva uses, is a special locked rectangle at the bottom of the
Layers list that the UI pretends is the background. It works at once but you fight it later: people select it by
accident, drag a photo under it and lose the photo, align to it instead of to the page, and agents see an element where
you see a page. *Example:* you want a soft photo wash behind a poster: Page › Background `+ Add ▾ Image…`, pick the photo,
`Fit ▾ Fill`, then `+ Add ▾ Colour` white at 60 % under it — two rows, nothing to select on the canvas. *Question:*
agreed to spend the engine work (A-1), and to ship the locked-layer version **only** if A-1 cannot land before the
inspector is built?

**Q2. Bevel.** *Recommend:* ship a `Bevel ▸` preset menu **now** (Soft, Hard, Pillow — two inner-shadow/glow rows the
person can still edit, honestly tagged `Bevel`), and build a real bevel-and-emboss effect (Photoshop's: style, depth,
size, soften, angle, highlight and shadow colours) in M2 behind the **same** menu entry. *Example:* a badge gets a soft
3D edge today in one click; in M2 the same click gives one row with a `Depth` slider instead of two shadow rows.
*Question:* is the preset enough for M1, or is the real effect needed sooner (it is render-crate work: an edge-lighting
pass; roughly two weeks)?

**Q3. Components: M1 or M2?** *Recommend:* **M2.** M1 has groups, frames and **repeats** (eight cards in a row that stay
linked, edit one → all change), plus Copy/Paste style. Components (a main, instances with overrides, detach, swap) are
M2 on the stage's existing `reference` arc, and the same override mechanism then gives repeats per-instance overrides
(different text in each card). *Example:* M1: a pricing row is a grid repeat of one card; changing the card's corner
radius changes all three; the three prices must be three separate texts on top. M2: each card can have its own price
inside the repeat, or the card is a component with instances. *Question:* agreed? The alternative (components in M1)
delays the inspector work by roughly an M1 work package.

**Q4. Images keep their ratio by default.** *Recommend:* dragging a corner of a photo scales it (no distortion); Shift
frees it. Shapes stay free (Shift locks), as in Figma. *Example:* a first-timer drags a corner of a portrait to make it
bigger and it simply gets bigger; a designer who wants a stretch holds Shift. *Question:* agreed? Figma natives will
feel the inversion on images only.

**Q5. One colour popover with three tabs.** *Recommend:* `Solid · Gradient · Image` as tabs at the top of the one colour
popover; switching tabs converts the paint (a colour becomes the first stop of a gradient). Canva puts gradients in a
separate panel and Figma hides the kind in a dropdown inside the picker. *Example:* a button is tangerine; click the
swatch, tab `Gradient`, pick the `Tangerine → Sunflower` preset, drag the angle handle on the canvas. *Question:* agreed?

**Q6. Shortcut collision: copy style vs copy link.** *Recommend:* `⌘⌥C` / `⌘⌥V` = Copy style / Paste style (Figma,
Sketch and Illustrator all use these; muscle memory), and **Copy link** moves from `⌘⌥C` to `⌘⌥L`. *Example:* copy a
card's look onto four others: select the card, `⌘⌥C`, select the four, `⌘⌥V`. *Question:* agreed to move Copy link?

**Q7. Eyedropper everywhere.** *Recommend:* when the browser has no `EyeDropper` API (Firefox, Safari), the eyedropper
samples **our own rendered canvas** instead of being hidden; it then cannot pick colours from outside the canvas (the
browser chrome, another window), and the loupe says `Canvas only`. *Example:* on Safari you pick a colour out of a
placed photo and it works. *Question:* agreed, or hide the eyedropper where the API is missing (FOUNDATIONS §4.6 today)?

**Q8. Lock has two scopes in Pro.** *Recommend:* the default lock locks everything (one click, as everyone expects); Pro
gets `Lock ▾ Position only` so a background photo cannot be nudged but can still be swapped or recoloured. *Example:*
a locked brand bar at the top of every page: position-locked, the copywriter still edits its text. *Question:* worth the
extra menu, or one lock only?

**Q9. Where to stop with effects.** *Recommend:* shadows (drop, inner), glows, blurs (layer, background) and bevel; **no**
Photoshop-style colour/gradient/pattern overlays or satin (an extra fill row with a blend mode does each, and the fill
stack is where people already look); noise and texture (Figma 2025) as M3 Pro-only. *Question:* agreed?

**Q10. Opacity keys.** *Recommend:* **no** Figma-style `1…0` opacity keys, because `1` and `5` switch lenses (Canvas ·
Pages) and `2–4` are reserved for the other lenses; `Alt+Shift+↑/↓` changes opacity by 10 % instead. *Example:* press `5`
→ Pages lens; press `Alt+Shift+↓` → the shape is 90 %. *Question:* agreed, or should the lens keys move to make room?

**Q11. Rulers in Standard.** *Recommend:* rulers are off in Standard and Focus (one key or menu away, `Shift+R`) and on in
Pro; draggable guides arrive in M2 with rulers as their home. *Question:* agreed?
