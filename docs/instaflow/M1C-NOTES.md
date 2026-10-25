# M1c conventions (in and out), plus B8

Read with [M1-BRIEF.md](M1-BRIEF.md). Everything in [M1B-NOTES.md](M1B-NOTES.md) still applies (features plug in through
B0 contributions, UI only from the kit under Clean Pop, Rust in the engine crates, the Checks rules). This file adds
the M1c work packages, their pre-assigned IDs and their order.

## Order (one work package at a time, one PR each)
1. **B8 Studio integration** (the "M1b demo" step in M1-PLAN): the first Studio you can click through.
2. **C0 Home** → **C1 Export** → **C2 Import** (needs C1) → **C3 Modes and identity** → **C4 Hardening** (the M1 exit
   criteria; last).

## Pre-assigned IDs (avoid merge collisions)
| WP | Requirement IDs | LIFECYCLES section | Error codes | Work-in-progress branch |
|---|---|---|---|---|
| B8 Studio integration | IF-27.1–27.29 | §29 | IF-INT-001… | `claude/wip-b8-studio` |
| C0 Home route | IF-28.1–28.29 | §30 | IF-HOME-001… | `claude/wip-c0-home` |
| C1 Export | IF-29.1–29.29 | §31 | IF-EXP-001… | `claude/wip-c1-export` |
| C2 Import | IF-30.1–30.29 | §32 | IF-IMP-001… | `claude/wip-c2-import` |
| C3 Modes and identity | IF-31.1–31.29 | §33 | IF-MODE-001… | `claude/wip-c3-modes` |
| C4 Hardening | IF-32.1–32.29 | §34 | IF-HARD-001… | `claude/wip-c4-hardening` |

Framework IDs (`R*` in `docs/REQUIREMENTS.md`, `SF-*` errors): append after the highest existing number in that area,
**check with `grep` before adding**, and name them in your report. Taken so far in M1b: R11.53–R11.62, R13.24–R13.30,
R15.6, R16.30–R16.31, SF-SURF-016–017. `docs/LIFECYCLES.md` §28 is the A6 render section. Keep sections in numeric
order when you add yours (the files are sorted).

## B8 Studio integration (scope)
Wire what M1b built into the live Studio so a person can create, edit and see a design end to end:
- Studio's canvas port runs A7 sequencing with B1's render source built over **B7's `createRepeatStage`**; resource
  batches (images, fonts) travel ahead of projection deltas on the same ordered channel (B1 follow-up).
- A per-tab **tool session** connects B3's controller and guide overlay, and **B6's `createCanvasA11y`**, to the canvas.
- Every M1b panel and HUD action is placed in the Studio spec (repeat, appearance, typography, library, pages,
  milestones); duplicates of B0 placeholders are replaced, not added.
- Fixes owed to integration: text `duplicate` keeps rich text (B2 handoff), B3's index keeps fresh group bounds when a
  child moves (B6 handoff), the `textbox` role while text is being edited (B6), the asset "Place" host hook (B4/B3).
- A runnable dev entry (`pnpm --filter @instaflow/app dev` or equivalent) and a short "try it" section in
  `apps/instaflow/AGENTS.md`. One Playwright smoke scenario: open Studio, draw a rectangle, type text, milestone.

## C-stage specifics
- **C0** boots with no engine or GPU (D17): check with a size budget and a test that the Home entry imports neither.
- **C1** decides the SVG parity rule (M1-PLAN "Decisions"): write the decision and its numbers into
  `docs/instaflow/DECISIONS.md` as the next free D-number and say so in the report.
- **C4** turns every M1 exit criterion (M1-PLAN § Exit criteria) into a CI check, deletes `apps/instaflow/spikes/`,
  and ratchets size budgets. It is the M1 finish line.
