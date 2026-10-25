# UX-RESEARCH handoff — 2026-10-25
**Branch:** `claude/wip-ux-research`  ·  **State:** in progress (docs only; `docs/instaflow/ux/` + this file)

## Brief
Open-ended gap hunt across the whole product (editors, product basics, market position), the owner's new direction
(two density personalities, progressive controls, Export answers incl. custom size), then fill the top gaps at the
depth of the Share/Export sections. Deliverable order: `ux/GAP-AUDIT.md` first, then fills, then FLOWS + README.

## Files touched (keep current)
- `docs/instaflow/ux/GAP-AUDIT.md` — new: inventory table, market analysis, ranked gaps, backlog, owner questions.
- `docs/instaflow/ux/DENSITY-DISCLOSURE.md` — new (Layer 1): the two personalities (Calm / Pro), per-surface
  hide/collapse/reveal tables, the clutter audit (what folds in every panel and dialog).
- `docs/instaflow/ux/FOUNDATIONS.md` §3.2, §5.1 — point to DENSITY-DISCLOSURE; §5.12 localisation rules (new).
- `docs/instaflow/ux/STUDIO-UX-SPEC.md` §2.3 (density → personalities), §2.4 Shortcuts (cheat sheet), new §9.1
  Find and replace, §9.2 performance states.
- `docs/instaflow/ux/HOME-FILES-UX-SPEC.md` — new §1.3 New design (sizes, presets, custom size), §1.4 First run,
  §3 Import row + new §3.1 Import.
- `docs/instaflow/ux/OVERLAYS-FEEDBACK.md` §2.3 Export (custom size row), §6 items 7–9.
- `docs/instaflow/ux/FLOWS.md` F-54…F-59 + coverage rows; `ux/README.md` index.

## Status log
- [x] Baseline read (all ux/ specs, design README, DECISIONS, M1-PLAN, REQUIREMENTS §8–12, UX.md §2/§4, src tree).
- [ ] GAP-AUDIT written
- [ ] DENSITY-DISCLOSURE written
- [ ] Export §6 answers + custom size
- [ ] Home: New design (custom size), first run, import
- [ ] Studio: find/replace, cheat sheet, perf states
- [ ] FLOWS + README
- [ ] Final push + report

## Traps for the next pass
- Density words `Focus / Standard / Pro` appear in code (`studio-element.ts`, `shell/spec minDensity`, theme tokens).
  The reframing keeps **three levels in code** and renames what people see; see DENSITY-DISCLOSURE §1.
- Nothing here changes DECISIONS or REQUIREMENTS; new requirement rows are for the WP that builds each piece.
