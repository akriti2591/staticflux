# Capability → UX coverage checklist (coordinator, 2026-10-25)

Every UX research brief must include this checklist, and the agent must account for every row: either name the
spec section that works it through end to end, or mark it missing. This list is built mechanically from what
exists: `docs/instaflow/REQUIREMENTS.md` sections and `apps/instaflow/src/*` modules. A brief's own topic list is
never the inventory. (Text and Export were missed because briefs listed topics instead of inventorying capabilities.)

Status was measured against the UX docs on `claude/wip-ux-research` (#28): "headings" = a dedicated section.

| Capability (REQUIREMENTS § / module) | Milestone | Dedicated UX section | Status |
|---|---|---|---|
| Text and fonts (§21, `src/text`) | M1 | none | **in progress**: TEXT-FONTS-UX-SPEC (`claude/wip-ux-text`) |
| Appearance: fills, gradients, strokes, effects (§20 B1, `src/elements`) | M1 | none (HUD/inspector rows only) | **missing** |
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
| Timeline, video, audio (§8) | M2 | none | missing (backlog B-1) |
| Motion: animation and transitions (§9) | M2 | two | partial |
| Generative features (§10) | M2 | none | **missing** |
| Flows (§11) | M2 | yes | partial (backlog B-3) |
| Agent views and change sets (§6, §12) | M2 | two | partial |
| Identity and gating, sharing (§13, §14) | M2+ | two | partial |
| Comments and annotations (§18) | later | none | missing (backlog B-8) |
| Extensibility and plugins (§17) | later | none | missing |
| Pixel lens (image editing) | M2 | none | missing (backlog B-2) |
