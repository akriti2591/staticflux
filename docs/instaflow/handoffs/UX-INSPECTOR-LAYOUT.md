# UX-INSPECTOR-LAYOUT handoff — 2026-10-27
**Branch:** `claude/ux-inspector-layout` · **State:** **done** (docs only; no PR; owner questions open in
`INSPECTOR-LAYOUT-SPEC.md` §9). Issues: #55 (inspector disorganised), #40 (dock padding, oversized UI), #45 (cropped colour
popover), #47 (polygon sides), #56 (Settings › Shortcuts).

## Files
- `docs/instaflow/ux/COMPONENT-ANATOMY.md` (new, Layer 1, reusable): tokens (§0, incl. the new `--if-*` panel tokens) ·
  panel frame (§1) · section and header (§2) · row grid and all 16 row types (§3) · fields: frame, number, text, menu
  field, unit, paired, labels inside vs beside (§4) · swatch (§5) · paint row (§6) · slider + value (§7) · stack, `+ Add`,
  empty state, More row (§8) · lists, tabs header, switcher/switch, icon group, grid picker, toolbar (§9) · buttons (§10) ·
  button rows and section actions (§11) · menus, popovers, tooltips from panels (§12) · dialog layout (§13) · key-chip
  glyph format (§14) · tags (§15) · **further blocks** (card, page column, composer, bubbles, status, banner, toast,
  progress, blocking/boundary errors, hint, skeleton, skip links, palettes, command bar, zoom, find bar, HUD, size/colour/
  copy fields, inline edit, confirm row, font and align popovers, takeover, DevTools) (§16) · **every element in
  `UI-INVENTORY.md` → block · what is off · correction · drift or gap** (§17; six render-nothing elements skipped and
  named) · drift summary (§18) · sources (§19).
- `UI-INVENTORY.md` is the coordinator's (branch `claude/affectionate-ramanujan-wbyz2g`); it is referenced, not copied.
- `docs/instaflow/ux/INSPECTOR-LAYOUT-SPEC.md` (rewritten, thin, Layer 2): frames (§1), every inspector section → blocks
  (§2), dock panels (§3), Settings dialog incl. Shortcuts (§4), before → after with drift vs gap (§5), improvements over
  Clean Pop (§6), density (§7), implementer's order (§8), owner questions Q1–Q5 (§9).
- `docs/instaflow/ux/README.md` (two rows), `STUDIO-UX-SPEC.md` §5.2 and `DENSITY-DISCLOSURE.md` §6 (pointers).

## Direction followed (coordinator, owner)
Token-efficient: plain Markdown, no mockups beyond small ASCII anatomy lines; exhaustive on sizes and spacing per
density; reusable blocks first, surfaces map to them; grounded in Clean Pop (`docs/instaflow/design/*.dc.html` recipes
and `apps/instaflow/src/theme/clean-pop.ts` tokens).

## Research
**Web access failed in this session**: DNS refused `figma.com`, `help.figma.com`, `linear.app`, `uxplanet.org`; Apple's
HIG pages (`layout`, `macos`, `keyboards`) returned only their title to a fetch (client-rendered). Search snippets about
Figma UI3's panel reorganisation were the only external material and are cited in CA §17. Conventions attributed to
Figma, Linear, Framer and Apple elsewhere in the two files are from working knowledge and are labelled as such, not as
pages read. If the coordinator wants citations, run the fetches from a session with web access against the URLs in CA §17.

## Five biggest corrections versus the build
1. **One frame with real padding and no kit chrome** (CA §1): 14 px side padding on inspector and dock alike; the kit dock
   collapse bar and `<sf-panel>` header must not render in Studio; tab panels pad nothing. Closes #40 with the size fix
   (28 px pills, 32 px field, 13 px text).
2. **One row grid** (CA §3): label column 72, paired cells, a reserved 28 px gutter for the link toggle; glyph labels
   (`X Y W H ∠ ⟂`) **inside** the field; word labels beside; field widths come from the grid, never per field.
3. **Fields in Geist with tabular figures, 32 px** (CA §4), menu triggers drawn as **menu fields**, the slider's value as a
   **56 px field** in panels: one field look instead of mono inputs, ghost pills and mist tags side by side.
4. **Stack actions move into the section heading** (`+ Add ▾`, CA §8) with one-line paint rows, a 56 px value and a
   hover-revealed ×; the stray image icon button goes; empty state is one muted line.
5. **Overlays never live in the column** (CA §12): colour popover 264 px in the top layer, opening towards the canvas,
   top-aligned to its row; action menus end-aligned from the heading. Closes #45. Plus the **Shape** section (`Sides` /
   `Points`, CA mapping §2) for #47 and the **one-scroller Settings dialog** with CA §14 key glyphs for #56.

## Implementation drift vs spec gap (summary of INSPECTOR §5)
- **Drift** (docs already said so): dock/section padding (DENSITY §6, StudioCP), single heading (STUDIO §5), 264 px
  popover (STUDIO §4.2.5), hover-revealed × and 48 px opacity (APPEARANCE §2.1), `∠ · ⟂` side by side (STUDIO §5.2),
  Points in Corners (APPEARANCE §4.5), "unavailable shortcuts absent" (STUDIO §2.3.1), undo footer (StudioCP).
- **Gap** (docs were silent, the build invented): section indents and heading padding, a row-type list, where the link
  toggle lives, flip and pivot placement, field widths, menu-trigger shape, where `+ Add ▾` sits relative to the next
  section, the image add button, key-glyph map, one- vs three-column shortcut cards. All now have a CA block.

## Repo-wide findings worth the coordinator's eye (CA §17)
- Five **legacy panels** are superseded by B11b's `<if-inspector>` and should be deleted, not restyled:
  `if-paint-inspector`, `if-repeat-inspector`, `if-typography-panel`, `if-transform-bar`, `if-export-panel` (with
  `sf-inspector-group/row`). Two shell pieces are unthemed (indigo `#4f46e5`): `sf-command-palette`, `sf-skip-links`.
- `sf-tabs` underline tabs are not in Clean Pop; the dock header should be a switcher. `sf-toolbar` (48 tall) is used as
  a button row in Pages, Assets and Milestones; those panels still have the pre-B11b frame (heading, 240 px tree, toolbar).
- Home (`if-home`, 1 695 lines) was checked for kit usage only; it needs its own pass against HomeCP.

## Owner questions (recommendation first; INSPECTOR §9)
Q1 Geist tabular (not mono) in editable fields — yes. Q2 value menus as fields, not pills — yes. Q3 Background as its own
section — yes. Q4 rotate-90° buttons beside the angle at rest — yes. Q5 `SHAPE` heading on the Corners slot for
polygons and stars — yes.
