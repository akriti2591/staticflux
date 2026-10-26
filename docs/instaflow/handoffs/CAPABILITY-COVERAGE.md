# Capability → UX coverage checklist (coordinator, 2026-10-25)

Every UX research brief must include this checklist, and the agent must account for every row: either name the
spec section that works it through end to end, or mark it missing. This list is built mechanically from what
exists: `docs/instaflow/REQUIREMENTS.md` sections and `apps/instaflow/src/*` modules. A brief's own topic list is
never the inventory. (Text and Export were missed because briefs listed topics instead of inventorying capabilities.)

**Outlets and flows for everything (owner, 2026-10-25):** the coordinator sequences *when* features are built,
but UX designs *every* feature now, deferred ones included: its **outlet** (where it lives in the UI: which panel,
HUD slot, menu, dialog step, per density) and its **flows to completion and follow-up** (what happens after: undo,
edit again, reuse, share or export, the next likely action). Deferred features keep their outlet reserved and are
not rendered until built (FOUNDATIONS §5.6), so building them later never needs a redesign.

**Method for each facet (owner, 2026-10-25):** a feature checklist of every control the best tools offer for that facet
(e.g. text: Google Docs, Notion, Figma, Canva, InDesign, Pages), each row marked include (where, per density) / defer
(milestone) / reject (why), kept as an appendix of the facet's spec. Basics are never left implicit (the owner found
text missing headings, list presets, sub/superscript, bold/italic/underline).

Status was measured against the UX docs on `claude/wip-ux-research` (#28): "headings" = a dedicated section.

| Capability (REQUIREMENTS § / module) | Milestone | Dedicated UX section | Status |
|---|---|---|---|
| Text and fonts (§21, `src/text`) | M1 | none | **in progress**: TEXT-FONTS-UX-SPEC (`claude/wip-ux-text`) |
| Appearance: fills, gradients, strokes, effects (§20 B1, `src/elements`) | M1 | none (HUD/inspector rows only) | **missing**; owner asked for gradients (engine renders linear/radial/conic fills and strokes; no editor: the panel only shows "Linear gradient"). Needs a full gradient editor: type, stops, on-canvas handles, presets, document gradients, in the colour popover, gradient text if the engine allows |
| Transforms: rotate, skew, flip, pivot (§34 B10a, `src/tools`) | M1 | none (HUD rows only) | **missing** |
| Groups, components and instances (§20) | M1/M2 | none | **missing** |
| Boolean operations, masks, corners (§20) | M1 | one each | partial |
| Repeat (§26, `src/repeat`) | M1 | one | partial |
| Snapping, smart guides, rulers, grids (§24) | M1 | one | partial |
| Layers, Pages, Library, lenses (§23, `src/lenses`, `src/library`) | M1 | yes | worked |
| Versioning, milestones (§22, `src/versioning`) | M1 | yes | worked |
| Export (§29, `src/export`) | M1 | yes | worked |
| Import (`src/workspace`) | M1 | yes | worked |
| Home, files, storage (§28, §3, `src/home`, `src/workspace`) | M1 | yes | worked |
| Accessibility (§25, `src/a11y`) | M1 | one | partial |
| Brand kit (§10?) | M1/M2 | none (colour popover row) | missing (backlog B-4) |
| Resize design | M2 | none | missing (backlog B-5) |
| Timeline, video, audio (§8) | M3 per PLAN §2 (the table said M2; see MOTION spec Q1) | yes | **worked**: MOTION-TIMELINE-UX-SPEC (`claude/wip-ux-motion`, 2026-10-26) §2–§3, §8–§10, F-76, F-78…F-80; build = V-1…V-9, V-19 |
| Motion: animation and transitions (§9) | M4 per PLAN §2 | yes | **worked**: MOTION-TIMELINE-UX-SPEC §4–§7, §11 (presets, keyframes, Smart move, transitions, presentation), F-73…F-75, F-77; build = V-10…V-18, V-20 |
| Generative features (§10) | M2 | none | **missing** |
| Flows (§11) | M2 | yes | partial (backlog B-3) |
| Agent views and change sets (§6, §12) | M2 | two | partial |
| Identity and gating, sharing (§13, §14) | M2+ | two | partial |
| Comments and annotations (§18) | later | none | missing (backlog B-8) |
| Extensibility and plugins (§17) | later | none | missing |
| Pixel lens (image editing) | M2 | none | missing (backlog B-2) |

## Colour picker (owner asked, 2026-10-25)
Specified as one shared colour popover (STUDIO §4.2.5): hex + opacity + eyedropper, document colours, brand tokens,
palette, recent, inline custom square + hue. B11a2 builds it (today's kit `sf-color-field` uses the native
`input[type=color]`). The appearance pass must checklist it against Figma/Canva/Adobe: colour models (HEX/RGB/HSB/
HSL/OKLCH), alpha slider, gradient mode in the same popover, contrast check, colour names, saved palettes.

## Backgrounds and bevels (owner asked, 2026-10-25)
- Shapes: colour, linear/radial/conic gradients and images (cover/contain/stretch/tile) as a stack with per-fill
  opacity and blend all render today; the fill-stack UI is missing (appearance pass).
- **Page background** is a single colour in the spec and a solid colour in the renderer. The owner wants image,
  gradient and colour like shapes. Appearance pass decides: the same fill stack on pages (engine work) or a locked
  bottom "Background" layer presented as the page's background, and specs it.
- **Bevel/emboss**: not an effect today (effects: drop/inner shadow, outer/inner glow, layer/background blur; stroke
  `join: bevel` is the corner join, not a 3D edge). Appearance pass decides: a `Bevel` preset from inner shadow +
  inner glow now, and/or a real bevel-and-emboss effect (engine work, milestone).

## Queued UX passes (one Fable at a time)
1. Text and fonts (running, `claude/wip-ux-text`).
2. Appearance (fills, gradients and the gradient editor, strokes, effects, colour picker depth), transforms, groups
   and components, booleans/masks, repeat, snapping, a11y; before B11b.
3. Motion and video: animate effect presets, transitions, Auto Animate, the timeline lens and video editing flows
   (backlog B-1); before the M2 timeline work.
