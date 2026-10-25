# UX-APPEARANCE handoff — 2026-10-25
**Branch:** `claude/wip-ux-appearance`  ·  **State:** **in progress** (docs only; no PR). Sections land in this order and
each is committed as it finishes: handoff → spec §0–§2 (appearance) → §3 (transforms) → §4 (structure) → §5–§11 →
Appendix A/B → STUDIO, DENSITY, GAP-AUDIT, README, FLOWS updates. If a usage limit cuts the session, whatever is
committed is consistent on its own; the missing parts are listed under **Still to do**.

## Scope (coordinator brief + owner requests in `CAPABILITY-COVERAGE.md`)
Appearance (fill stack, gradient editor, colour picker depth, image fills, strokes, effects incl. bevel, layer
opacity/blend, page background, copy/paste style, styles and tokens), transforms (move, resize, rotate, skew, flip,
pivot, constraints, lock, numeric, multi), structure (groups, frames, components/instances M1/M2 decision, booleans,
masks, corners, repeat, snapping, smart guides, rulers, grids, align/distribute, layer order, lock/hide, a11y).

## Files touched
- `docs/instaflow/ux/APPEARANCE-TRANSFORM-UX-SPEC.md` (new, Layer 2) — see its §0.2 reading map.
- `STUDIO-UX-SPEC.md` §4.2.3–4.2.5, §5.1–5.2, §6.1, §6.4, §7, §8.2 (pointers + the new shortcuts).
- `DENSITY-DISCLOSURE.md` §3.2, §8.1, §8.3 (inspector rows per kind, colour popover row).
- `GAP-AUDIT.md` inventory row, gap #15, backlog B-16/B-17, pointer to the appearance questions. `ux/README.md` row.
- `FLOWS.md` section H, F-65…F-72; coverage matrix rows.

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

## Still to do
(updated as sections land; empty when done)
- everything after the handoff

## Owner questions
In the spec §11 (recommendation first).
