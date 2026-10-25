# apps/instaflow/src/theme — AGENTS.md

**Work package:** Instaflow design track **DS1** (the Clean Pop theme in code). **Layer:** app.
**Depends on:** `@staticflux/kit/icon` + `/icons/*` (data only, `icons.ts`), `@staticflux/ui/theme` (contract, `extendTheme`, `themeContribution`), `@staticflux/ui/default-theme`;
tests also use `@staticflux/kit` (render check) and `@staticflux/testkit` (`runThemeContract`).
**Design source:** `docs/instaflow/design/README.md` (rules) and `Components.dc.html` (`renderVals()` recipes; source of truth).
**Budget:** data only (no element code). The compiled theme CSS replaces the default theme's in Instaflow's boot; the app
build budget lands with C0/C4.

## Purpose
Clean Pop as a theme over the StaticFlux contract, so every kit component (buttons, switchers, fields, tags, slider)
renders the approved design without app CSS; and the **lens palette**, an Instaflow concept kept out of the framework.

## Public API (by file)
- `clean-pop.ts` — `cleanPopTheme` (`instaflow/clean-pop`, `extendTheme(defaultTheme, …)`): mist neutrals, deep tangerine
  accent + focus ring, raspberry agent tokens, pill `radius.control`, 18 px `radius.lg`, 12 px `radius.md` (fields,
  previews), Bricolage Grotesque / Geist / Geist Mono, buttons 42 / 34 / 28 px; `prefers-contrast: more` variant; Focus /
  Pro densities; button text 15 / 13.5 / 12.5 px and padding 20 / 14 / 12 px. `cleanPopThemeContribution` (order 0, above the default's −100). `cleanPopPalette` (design colour names,
  incl. `stage` `#E4E9EF` for the editor canvas, which is not a surface for controls).
- `lenses.ts` — `LENS_IDS`, `LensId`, `LensShape`, `Lens { id, color, onColor, shape, mark }`, `lensPalette`, `lensOf(id)`,
  `lenses()`, `lensMarkStyle(lens, scale)` (decorative mark), `lensTag(lens)` (`<sf-tag .color .ink>` props).
- `icons.ts` — the icon tables (B11a): `LAYER_KINDS` / `layerKindIcon(kind)` (Layers rows, inspector header), `TOOL_ICON_IDS` /
  `toolIcon(tool)` (tool picker), `REPEAT_ICONS`, `BOOLEAN_ICONS`; data over `@staticflux/kit/icons/*` (type-only imports of the
  repeat and boolean kinds).
- `palette.ts` (B11a2) — `CLEAN_POP_COLOR_PALETTE`: the colour popover's fixed 24-colour default palette (6 × 4).
- `index.ts` — re-exports the theme, lenses and icons (import `palette.ts` directly).
- Density (B11a2, DENSITY-DISCLOSURE §6): rows 32 / 30 / 26 px and UI text 14 / 13.5 / 12 px in Focus / Standard / Pro; spacing stays on the
  4 px grid (Pro gaps 4 / 8 where §6 asks 6 / 10).

## Mapping notes (design → contract)
- page → `canvas`; white → `surface1..3` and `surfaceSunken` (fields are white); tint → `neutral3` (switcher tracks, tags,
  slider value); hairline → `border`; control edge → `controlEdge` / `borderStrong`; slider track → `neutral7`.
- Primary → `accent`; Claude → `agent` / `onAgent`; Claude soft → `agentSoft` / `agentInk`.
- **Dark is deferred** — `TODO(DS2 · Clean Pop dark)`: the dark variant repeats the light palette until then.

## Rules
- Never put Instaflow colours in framework packages; new needs go into the contract as generic tokens (as DS1 did:
  `radius.control`, `color.controlEdge`, `color.agent*`, `font.familyDisplay`, `font.weightDisplay`, `type.control*`, `size.controlPad*`).
- Lens colours are for shapes and tags; primary actions use `accent` (deep tangerine).
- Every change keeps `clean-pop.test.ts` green: the shared theme contract plus every README contrast pair.

## Test
`npx vitest run apps/instaflow/src/theme` (contract suite, README pairs, lens palette, happy-dom render check of the kit).
