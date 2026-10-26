# UX-APPEARANCE handoff — 2026-10-25
**Branch:** `claude/wip-ux-appearance`  ·  **State:** **done** (docs only; no PR; owner questions open in the spec §11).
Sections landed in this order, each committed as it finished: handoff → spec §0–§2 → §3 → §4 → §5–§11 → Appendix A/B →
STUDIO, DENSITY, GAP-AUDIT, README, FLOWS updates.

## Scope (coordinator brief + owner requests in `CAPABILITY-COVERAGE.md`)
Appearance (fill stack, gradient editor, colour picker depth, image fills, strokes, effects incl. bevel, layer
opacity/blend, page background, copy/paste style, styles and tokens), transforms (move, resize, rotate, skew, flip,
pivot, constraints, lock, numeric, multi), structure (groups, frames, components/instances M1/M2 decision, booleans,
masks, corners, repeat, snapping, smart guides, rulers, grids, align/distribute, layer order, lock/hide, a11y).

## Files touched
- `docs/instaflow/ux/APPEARANCE-TRANSFORM-UX-SPEC.md` (new, Layer 2, ~1 260 lines): §0 engine inventory and letters ·
  §1 principles and market departures · §2 appearance (fill stack, colour popover depth, gradient editor in popover and on
  canvas, image fills and crop, strokes, effects with presets and the bevel decision, layer, page background decision,
  copy/paste style and styles, control table) · §3 transforms (every gesture and modifier, numeric fields, rules, multi,
  control table) · §4 structure (groups vs frames, components M2 with full outlets, booleans, masks, corners, repeat,
  snapping/rulers/guides/grids, align, layer order/lock/hide/rename, control table) · §5 per density · §6 fidelity ·
  §7 errors · §8 a11y · §9 plumbing · **§10.1 outlet + flow + follow-up for every feature, deferred included** · §10.2 (c)
  schedule A-1…A-19 · §11 owner questions Q1–Q11 · Appendix A checklist (Figma · Canva · Illustrator · Photoshop ·
  Sketch; include/defer/reject, 15 tables) · Appendix B capability rows.
- `STUDIO-UX-SPEC.md` §4.2.3 colour row, §4.2.4 Shape and Page rows, §4.2.5 pointer, §5.1 Nothing/Shape rows, §5.2 stack
  anatomy, §6.1 gesture pointer, §7 new shortcuts (Frame selection, Copy/Paste style, Flatten, Outline stroke, Opacity,
  Rulers/Grids; **Copy link moved to ⌘⌥L**), §8.2 context menu rows.
- `DENSITY-DISCLOSURE.md` §3.2 (Page, Shape, Image, Frame, Group, Repeat, Boolean/Mask, Instance, Multi rows), §3.4,
  §8.1 (Transform, stacks, Corners, Effects, Layer, Image, Mask/Combine, Page, View menu), §8.3 colour popover row.
- `GAP-AUDIT.md` inventory row, gap #15, backlog B-16/B-17, pointer to the appearance questions. `ux/README.md` rows.
- `FLOWS.md` header pointer; F-04/F-09/F-13 pointers; **F-12 mask rule corrected**; section H, F-65…F-72; coverage matrix rows.

## Decisions taken (reasoning in the spec §1 and §11)
- Letters as in OVERLAYS §2.3 / TEXT §0: (a) engine today · (b) UI only, B11b · (c) engine or editor-worker work with a
  milestone; a (c) control is **not rendered** before it lands (FOUNDATIONS §5.6), its outlet is reserved (§10.1).
- **One colour popover with three tabs** `Solid · Gradient · Image`; the gradient editor lives inside it and on the
  canvas (handles); the same popover serves fills, strokes, text colour, effects colours and the page background.
- **Page background = the same fill stack on the page node** (engine work, (c) A-1, M1 follow-up). The UI is
  `Page › Background` either way; the locked-bottom-layer approach is the fallback only if A-1 slips past B11b.
- **Bevel**: a `Bevel` preset in `+ Add effect ▾` built from inner shadow + inner glow **now** (b); a real
  `bevel-emboss` effect kind is (c) M2 (A-9) with the same outlet (the preset row becomes the kind).
- **Components and instances are M2** (c, A-12) on the stage's existing `reference` arc; M1 ships groups, frames,
  repeats (Instaflow's live instances) and copy/paste style. Outlets and flows are designed now (§4.2, §10.1).
- Corner handles **keep ratio by default for images** (Shift frees), free for shapes (Shift locks) — a departure
  from Figma, kept from Canva, because a distorted photo is almost never wanted.
- Copy style / Paste style take Figma's `Mod+Alt+C` / `Mod+Alt+V`; **Copy link moves to `Mod+Alt+L`** (STUDIO §7 had
  `Mod+Alt+C`; owner question Q6).
- Eyedropper works **without** the `EyeDropper` API by sampling our own rendered tiles (b): Firefox and Safari get it.

## Findings about the engine worth the coordinator's eye (full list in the spec §10.2 and §11)
- The page has **no `style` component**: its background is one RGBA handed to `render_tile` / `begin_region`; Export's
  `transparent` flag drops it. Gradient or image page backgrounds need A-1.
- Image paints carry only `asset` + `fit`; there is no crop, offset, scale or rotation on an image fill (A-3).
- `spatial.skewX` is the only skew; a vertical lean is written back as rotation + skewX (IF-34.5), so the inspector
  can show only one skew field honestly.
- No `hidden` on elements (Layers' eye needs a prop + the projection skipping it, A-2); `group` / `ungroup` /
  `reorder` / `rename` / `frameSelection` actions are missing (STUDIO §12 already lists them).
- `useAsMask` makes the **bottom-most** selected element the mask (Figma rule); FLOWS F-12 step 1 said "ellipse on
  top" — corrected to "ellipse below the image".
- Conic gradients export as pixel patterns in SVG and PDF (`Feature::SweepGradient` fallback); effects in PDF are
  raster patches. Honest in the Export preview; noted in the spec §6.
- The appearance panel labels a gradient fill `Linear gradient` and offers no editing (`panel.ts` line ~130).

## What a later pass should know
- B11b builds every (b) row against today's `appearanceModel` / `appearanceEditOps`, the transform capabilities and the
  element actions; the M1 (c) items A-1 (page fill stack), A-2 (hidden) and A-3 (image crop) should be scheduled before
  F-66, F-67 and F-70 run as acceptance tests.
- The Motion/video pass (next in the queue) owns: animating stack items by `id` (IF-20.3), video fills, Auto Animate's
  use of match keys on repeats and components.
- The Pen WP owns vector point editing, per-vertex radii UI and arrowheads (A-5) if it touches stroke outlines.
- The Brand panel (B-4) hosts named styles (A-13), components library (M3) and palette import.

## Owner questions
In the spec §11 (recommendation first).
