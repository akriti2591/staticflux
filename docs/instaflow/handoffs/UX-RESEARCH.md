# UX-RESEARCH handoff — 2026-10-25
**Branch:** `claude/wip-ux-research` (pushed)  ·  **State:** done for this pass (docs only; owner questions open)

## Brief
Open-ended gap hunt across the whole product (editors, product basics, market position), the owner's direction (keep
Focus / Standard / Pro and think each through per surface; progressive controls; Export answers incl. custom size;
better-than-convention, with every departure justified), then fill the top gaps at the depth of Share/Export.

## Files touched
- `docs/instaflow/ux/GAP-AUDIT.md` — **new**: inventory (surfaces, flows, primitives: status · reference · spec),
  market analysis (best version per area; convention kept and why; departures and why), top gaps ranked, backlog
  B-1…B-13, owner questions Q-A…Q-H with recommendations first.
- `docs/instaflow/ux/DENSITY-DISCLOSURE.md` — **new** (Layer 1): three modes as personalities; per-surface tables for
  Studio chrome, inspector per selection kind (essential/more tiers), dock panels, HUD, Home, Chat, dialogs/Settings;
  spacing and type tokens per mode; moving between modes (`View ▾`, Settings preview strip, `Mod+.` cycle, `Mod+\`
  overrides) and memory; disclosure blocks (`<sf-disclosure>` with summary); clutter audit §8.
- `FOUNDATIONS.md` — §3.2 and §5.1 now point to DENSITY-DISCLOSURE; **new §5.12 Localisation** rules.
- `STUDIO-UX-SPEC.md` — §2.3 points to DENSITY-DISCLOSURE; **new §2.3.1 cheat sheet** (`?`); **new §9.1 Find and
  replace** (text, font, colour across pages); **new §9.2 Performance states**.
- `HOME-FILES-UX-SPEC.md` — **new §1.3 New design** (formats, size field pair, custom size, presets menu,
  orientation, units, start from template); **new §1.4 First run**; §3 Import row; **new §3.1 Import** (every file
  kind × every drop target, PDF as image pages in M1, question toast for `.iflow`).
- `OVERLAYS-FEEDBACK.md` — §2.3 Export: **Custom size (output pixels)** row with the shared size field pair; preset
  row's `Other sizes…` link; §6 items 7–8 marked answered, item 9 rewritten in plain words and reopened.
- `FLOWS.md` — F-54 custom size, F-55 import, F-56 find/replace, F-57 shortcuts, F-58 density modes, F-59 first run;
  coverage rows. `README.md` — index rows for the two new files and the new sections.

## Decisions taken in this pass (recommendations; none reopen DECISIONS or STUDIO §14)
- Density: three modes stay; Focus+Standard = calm, Pro = dense; a mode only reveals, never moves a control. New
  one-liners: "Just your work." / "Your work, with the panels that explain it." / "Everything, with numbers."
- Home has two looks (Focus = Standard); Chat honours all three (Q-D).
- One **size field pair** block in New design, Page › Size and Export; Export's custom size = output pixels at the
  page's ratio; a different ratio is **Resize design** (backlog B-5), never Export (Q-A, Q-B).
- Export item 9: hide non-fitting presets + `Other sizes…` link; open question whether to pull Resize design forward.
- First run: one card, one button that requests `persist()` on a gesture; no tour, no questionnaire (Q-E).
- `Mod+F` is Studio's find bar (Q-F); PDF imports as image pages in M1 (Q-G); cheat sheet shows one platform (Q-H).
- Notifications: none in M1/M2 (toasts only); an inbox arrives with comments and accounts.

## What the next pass should do (ranked backlog is GAP-AUDIT §4)
1. Owner answers Q-A…Q-H (defaults = recommendations).
2. B-1 Timeline lens UX spec (D5 must-have, nothing specified) — biggest hole left.
3. B-5 Resize design (unblocks Export item 9), B-4 Brand panel, B-2 Pixel lens, B-3 Flow lens, B-8 presence/comments.
4. B-13 Settings field-level spec; B-6 configurable mini editors.

## For builders (what the fills imply)
Kit (StaticFlux, generic): `<sf-disclosure>` (summary slot, persisted key), `<sf-size-field>` (W/H, lock, orientation,
unit, presets slot), `<sf-shortcut-sheet>` (grid over a registry snapshot), density token rows (DENSITY §6), `Intl`
adapters. Instaflow: control `tier` in `src/spec/controls.ts`; Pro split dock, Focus rail-click floating panels,
`Mod+.` cycle (`src/studio`); New design dialog + `/new?format=custom&w=&h=&unit=` (`src/home`); first-run card and
gesture-bound persist; Home and canvas drop targets, PDF rasteriser, font ingest; find bar + `TextIndexMirror` /
`UsageMirror` + `instaflow/find|replace` capabilities; Export Size row over the existing scale plumbing.

## Traps
- `/new` is now a routable dialog on Home (the only one); NAVIGATION §2.2 needs the `format=custom&w=&h=&unit=` view
  keys added when built (not added here to keep the URL contract edit with the WP).
- STUDIO §2.3.1 (cheat sheet) sits between §2.3 and §2.4; references use §2.3.1.
- `Mod+G`/`Mod+Shift+G` mean next/previous match **only while the find bar has focus**; Group otherwise.
- `Mod+.` is new; check it against `RESERVED_COMBOS` (Chrome does not reserve it).
- Export's Size pair snaps to 1×/2×/3× in M1 like the Width field it replaces; the `(c)` arbitrary-scale follow-up
  unlocks free values.
