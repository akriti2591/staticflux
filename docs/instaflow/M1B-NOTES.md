# M1b conventions (authoring)

Read with [M1-BRIEF.md](M1-BRIEF.md). These rules keep parallel M1b work packages composable and their merges clean.

## How features plug in (D16)
- **B0 owns the editor spec runtime** and the contribution tokens: `LensContribution`, `ToolContribution`,
  `PanelContribution`, `HudActionContribution`, `EditorSpec`. Every other M1b package delivers its features as
  **headless services plus contributions**. It never builds its own screen layout.
- Until B0 lands on the branch, define your contribution objects against a local interface named after B0's, in a
  `contributions.ts` file. The coordinator reconciles them at merge.
- Studio is a spec, not a screen. It must be fully usable by hand: every feature has a non-agent path.

## UI
- Build UI only from `@staticflux/kit` components under `cleanPopTheme` (`apps/instaflow/src/theme`). The design source
  of truth is `docs/instaflow/design/` (README rules + `Components.dc.html`). No one-off styles. Lens colour and shape
  come from the typed lens palette.
- If a needed component is missing from the kit, add it generically to `@staticflux/kit` with tests. Never style
  around a gap.
- Accessibility: keyboard paths for everything, WAI-ARIA patterns, and AA contrast through the theme. Never hard-code
  colours.

## Engine
- Rust work goes in `apps/instaflow/engine` crates: `render` (A6, draws the scene IR) and `authoring` (B1 geometry
  and booleans, B2 text). Wasm budgets: render ≤ 300 KB br, authoring ≤ 350 KB br. Lazy-load extras such as
  `complex-scripts`.
- Document data uses `@staticflux/document/v2` components (A4) with one CRDT doc per page (D14). Composition, locks,
  attribution and undo go through `@staticflux/stage` (A8). Render goes through the render projection (A7) into the
  scene IR (A6).

## Pre-assigned IDs (avoid merge collisions)
| WP | Requirement IDs | LIFECYCLES section | Error codes |
|---|---|---|---|
| B0 Editor spec runtime | IF-19.1–19.29 | §20 | IF-SPEC-001… |
| B1 Elements and styles | IF-20.1–20.29 | §21 | IF-EL-001… |
| B2 Text | IF-21.1–21.29 | §22 | IF-TXT-001… |
| B5 Versioning | IF-22.1–22.29 | §23 | IF-VER-001… |
| B4 Library and lenses | IF-23.1–23.29 | §24 | IF-LIB-001… |
| B3 Tools | IF-24.1–24.29 | §25 | IF-TOOL-001… |
| B6 Accessibility layer | IF-25.1–25.29 | §26 | IF-A11Y-001… |
| B7 Repeat | IF-26.1–26.29 | §27 | IF-REP-001… |

Instaflow requirements go in `docs/instaflow/REQUIREMENTS.md`. Framework additions still use `R*` IDs in
`docs/REQUIREMENTS.md`: append after the highest existing number in your area and say which in your final message.

## Sequencing
- **Wave 3a (parallel):** B0, B1, B2, B5 (services and panels).
- **Wave 3b, after B0 merges:** B4, B3 (incl. smart guides: centre lines, equal spacing, edges, snapping to B1 layout grids), B7 (repeat), then B6.
- **Human checks:** B2's Japanese/Chinese/Korean IME candidate placement needs the owner. Provide a ready-to-open page
  and short steps.
