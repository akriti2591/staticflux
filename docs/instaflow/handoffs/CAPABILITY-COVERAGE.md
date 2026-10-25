# Capability → UX coverage checklist (coordinator, 2026-10-25)

Every UX research brief must include this checklist, and the agent must account for every row: either name the
spec section that works it through end to end, or mark it missing. This list is built mechanically from what
exists: `docs/instaflow/REQUIREMENTS.md` sections and `apps/instaflow/src/*` modules. A brief's own topic list is
never the inventory. (Text and Export were missed because briefs listed topics instead of inventorying capabilities.)

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
| Timeline, video, audio (§8) | M2 | none | missing (backlog B-1); owner asks for timeline-based **video editing flows** |
| Motion: animation and transitions (§9) | M2 | two | partial; owner asks for **presets**: animate effects (in/out/emphasis), page transitions, and the Auto Animate equivalent (REQUIREMENTS: M4, match keys) |
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

## Queued UX passes (one Fable at a time)
1. Text and fonts (running, `claude/wip-ux-text`).
2. Appearance (fills, gradients and the gradient editor, strokes, effects, colour picker depth), transforms, groups
   and components, booleans/masks, repeat, snapping, a11y; before B11b.
3. Motion and video: animate effect presets, transitions, Auto Animate, the timeline lens and video editing flows
   (backlog B-1); before the M2 timeline work.
