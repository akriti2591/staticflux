# M1 orchestration log

The coordinator's durable record: what has landed, what is in flight, where each piece of work lives, and what is
owed. Updated and committed at every step, so a new session (or a new coordinator) can pick up from here alone. Newest
entries at the top of **Journal**.

## How we work (owner's rules, 2026-10-25)
- **Slow and serial.** At most one or two agents at a time. No rush; tokens are a weekly and 5-hour budget.
- **The coordinator knows everything.** State lives in this log, `M1B-NOTES.md`, `M1-PLAN.md`, `DECISIONS.md` and
  `handoffs/`, not in any agent's history. The coordinator keeps its own context small: test output goes to log files,
  only the summary is read.
- **Commit early and often.** Every merge, fix and note is committed and pushed to the working branch as soon as it is
  sound, so nothing depends on a container surviving.
- **Every agent session ends with a handoff** (`handoffs/<WP>.md`, template in `handoffs/README.md`) and a commit, even
  when it stops early. The next agent starts fresh from the handoff, never by resuming a long history.
- **One PR per work package.** Checks: agents run scoped checks; the coordinator runs one full check per merge
  (`M1B-NOTES.md` § Checks).

## Status
| WP | State | Where | PR |
|---|---|---|---|
| A1–A10, DS1 | Merged | `main` | #9, #10, #11 |
| B5 Versioning | Merged | `main` | #12 |
| B0 Editor spec runtime | Merged | `main` | #12 |
| B1 Elements and styles | Merged | `main` | #12 |
| B4 Library and lenses | Merged | `main` | #12 |
| B3 Tools and smart guides | Merged | `main` | #13 |
| B7 Repeat | Merged | `main` | #14 |
| B2 Text | Merged; IME check passed (D20) | `main` | #16 |
| B6 Accessibility layer | Merged; not yet wired to Studio's live canvas | `main` | #17 |
| B8 Studio integration | Merged; editor on the main thread until B9 | `main` | #20 |
| B9 Editor in the worker | Merged; owner IME re-check pending | `main` | #21 |
| Site refresh | Merged | `main` | #22 |
| B10a Transform tools, basics | Merged | `main` | #23 |
| C0 Home route | PR open (full check 4,314 tests; Studio and Home smokes green) | working branch | #24 |

| C1 Export | Merged (akriti2591/staticflux#25) | main | — |
| UX spec | Done, on the working branch | `docs/instaflow/ux/` | — |

Each work package's work in progress is pushed to its own branch `claude/wip-<wp>-<name>`, so nothing lives only in
this container.

## Next (one work package at a time; order, scope and IDs in M1C-NOTES.md)
1. B11a done (PR open), narrowed to icons, number field, inline rename and other non-overlay controls
   (`claude/wip-b11a-foundations`). In parallel, docs only: the UX primitives spec (Fable, `claude/wip-ux-primitives`):
   overlays, dialogs and nesting (Share, Milestones), the error/feedback hierarchy, tooltips, coach marks, the HUD per
   selection type, deep links, Chat expansion, DevTools UX.
2. Then B11a2 (overlay and feedback blocks from that spec), then B11b.
2. **B11a** foundations, then **B11b** Studio and Home surfaces (UX docs, owner decisions in STUDIO-UX-SPEC §14, logo).
3. C2 Import → C3 Modes and identity → C4 Hardening (end-to-end checkpoint in CI, performance and loading pass).
4. B10b distort / perspective / warp: early M2.
Coordinator memory: `docs/instaflow/handoffs/COORDINATOR.md`.

Open M1 decisions: which worker mode boots by default (D15 says one; the split becomes default only if it meets the budget after the
main-rAF tick fix); folder mirror flush policy; SVG parity rule (C1, next free D-number); reference iGPU runner (C4).

## Owed
- **Owner:** manual IME re-check after B9 (typing now crosses a worker); optional real-GPU timing run in both
  topologies (feeds D15's default); npm Release rerun (9 packages); deprecate `0.0.0-stage`; set up trusted
  publishing, then delete `NPM_TOKEN`; reference iGPU runs; optional: protect `main` (no force push or deletion,
  require PRs; no required approvals; bypass for the version PR if status checks are required).
- **Taken by B8:** repeat-aware render source and resource batches ahead of projection deltas (B1, B7); per-tab tool
  session with B3's overlay and B6's accessibility layer on the live canvas; all M1b panels and HUD actions in the
  Studio spec; text duplicate keeps rich text (B2); fresh group bounds in B3's index (B6); `textbox` role while
  editing text (B6); asset "Place" host hook (B4, B3).
- **Later follow-ups:** blob ↔ DocumentStore adapter (B5); page and cover thumbnails, large-image downscale before GPU
  upload, import capability for agents (B4); resize snapping for rotated elements, flip on negative resize, snapping
  outside the container, a guides toggle, remote edit to a dragged element overwritten on release (B3); edits inside a
  repeat re-project every instance (benchmark), nested-repeat key order after expand (B7); colour emoji (B2);
  projection snapshots across the worker boundary, real-browser axe and screen-reader passes (B6); luminance masks
  approximate where translucent mask shapes overlap (B1); CJK text is invisible without local fonts and missing glyphs
  draw nothing instead of a .notdef box: ship or load CJK fallback fonts and draw .notdef (IME check); `IF-*` error codes are not in `docs/errors.json`.

## Journal
- **2026-10-25** UX primitives spec done (PR #27, docs only): OVERLAYS-FEEDBACK, NAVIGATION-DEEPLINKS, DEVTOOLS-UX-SPEC,
  HUD §4.2 (one control model), Chat §7–9, F-47–F-52. Six owner questions in OVERLAYS-FEEDBACK §6 (asked). Next after
  #26 and #27 merge: B11a2 (overlay and feedback blocks), then B11b.
- **2026-10-25** B11a merged on the working branch (58201ab…74721f1): `<sf-icon>` + 89 Lucide and 15 custom icons,
  number field, inline edit, swatch; R13.32–35, SF-KIT-001–002, IF-35.1–35.13, §37. Full check, smokes and
  agents:check green (regenerated the stale surface AGENTS.md row order, drift from main). PR opened.
- **2026-10-25** Owner: primitives need real design (dialogs, errors, toasts, coach marks, tooltips, nested pop-ups like
  Share and Milestones, a Canva-style HUD per selection type, deep links to everything). FOUNDATIONS had about 7 lines
  each and no deep links. B11a was narrowed to non-overlay blocks; a Fable agent is writing OVERLAYS-FEEDBACK.md,
  NAVIGATION-DEEPLINKS.md, DEVTOOLS-UX-SPEC.md, HUD (§4.2) and Chat expansion. New WP B11a2 (overlay blocks) before B11b.
- **2026-10-25** C1 merged (#25). Working branch reset to main. B11a agent launched on `claude/wip-b11a-foundations`.
- **2026-10-25** C1 full check: three guard lists didn't know C1's additions (export Wasm crate, its 230 KB brotli
  budget, the Export panel in the chrome audit coverage). Lists updated; check, smokes (both topologies) and Home smoke
  green. C1 PR opened.
- **2026-10-25** Owner decisions on the UX spec: **all ten recommendations accepted** (rotate handle below + corner
  zones; Standard density; density in a View menu and Settings; Share hidden until Export, then Export; raspberry as
  the agent role colour for any provider; Canvas + Pages lenses always, others with content; white frames with a
  non-printing hairline and label; tangerine default shape fill; Lucide icons with ISC credit). **End-to-end tests in
  CI wait** for a checkpoint after everything is built (C4). B11 split into B11a foundations and B11b surfaces. Logo
  chosen: cursive if, colour-split dot, no tail (`apps/instaflow/brand/`). `.iflow` stays the extension. Coordinator
  memory written to `docs/instaflow/handoffs/COORDINATOR.md`.
- **2026-10-25** C1 done (232aeb9; restarted agent wrote a handoff first): PNG / PDF / SVG export in a worker, Export
  panel and capability, D21 (SVG/PDF parity rule with measured numbers). PDF via pdf-writer (krilla was 481 KB);
  render and library budgets +0.25 KB each (scene IR text runs carry their text).
- **2026-10-25** UX spec done (creative director, cdaf58b): `docs/instaflow/ux/` README, FOUNDATIONS (principles, vocabulary,
  building blocks with a StaticFlux-vs-Instaflow code map), STUDIO / HOME-FILES / CHAT specs, FLOWS. Ten open questions
  for the owner in STUDIO-UX-SPEC §14. B11 waits for the owner's answers. Logo: owner chose the cursive "if"; rounds 3
  and 4 (glitch dot × tail) on the logo canvas, waiting for the pick.
- **2026-10-25** Owner: a loading and performance pass (per-route first-render JS in a production build, DI
  boundaries proven, chunk and feature performance tests with budgets) belongs at the end, in C4. Written into
  M1C-NOTES. Logo: six directions on the "Instaflow Logo" canvas, waiting for the owner's pick.
- **2026-10-25** Session interrupted: the C1 agent and the UX creative director stopped. C1's uncommitted files rescued to
  `claude/wip-c1-export` (60908ed); both restarted fresh (C1 continues from its branch and writes a handoff first;
  creative director on Fable, high effort, with the owner's new findings: tools without labels or tooltips, Pen is a
  placeholder that does nothing, frames only drawable inside a white box and white on white, the canvas is a box in
  a box instead of the design's dotted infinite canvas with a page card).
- **2026-10-25** #24 (C0) merged. Owner's first hands-on session: no visible delete or rotate, no clipboard, UI
  unpolished, while all tests passed. Owner's call: a UX analyst (Fable, medium effort) writes a Markdown UX spec and
  end-to-end flows for agents first (`docs/instaflow/ux/`, branch `claude/wip-ux-spec`); then B11 Studio basics and
  polish implements it with end-to-end tests in CI. M1-BRIEF now requires the spec for any UI work. C1 continues.
- **2026-10-25** #23 (B10a) merged. C0 done (b176c83): Home at `/`, recents, templates, quick actions as capabilities;
  designs persist (IndexedDB adapter passing the store contract). Full check caught one gap: B6's audit-coverage guard
  didn't list the new Home element (its own test already audits it). Registered; all checks pass. Next: C1 Export.
- **2026-10-25** #22 (site refresh) merged. B10a done (03116b4): flip, skew, pivot, numeric transform bar, Mod+T session
  (plus a "Free transform" HUD action: Chrome reserves Mod+T in a normal window). Mod on a side handle now skews
  (B3 change). Next: C0 Home.
- **2026-10-25** #21 (B9) merged: Studio's editor and renderer run in workers. Site refresh started (docs site only).
- **2026-10-25** B9 smoke failure root-caused (not Shift, not a flake): the selection HUD grew from one to two rows and
  moved the canvas 40 px under a drag. HUD now has a fixed height (test fails without it); smoke 30/30 per topology.
- **2026-10-25** B9 done (7a10e9a): editor and render in workers, one by default, two with `?topology=split`; main keeps
  page-side adapters; store stays on main behind a port for now. Full check passes. Studio smoke: 1 failure in 5 runs
  (colocated `move`: +60 x, 0 y, matching the Shift axis lock). Not treated as a flake: a focused agent is proving
  the cause and fixing it; the PR waits for 10 green runs in both topologies.
- **2026-10-25** #20 (B8) merged at the owner's request: Studio is playable. Owner left sequencing to the coordinator:
  B9 (worker) → site refresh → B10a → M1c; B10b in early M2. IDs for B9 and B10a in M1C-NOTES.
- **2026-10-25** B8 done (e4a375b): first clickable Studio (`pnpm --filter @instaflow/app dev`), smoke test, integration
  fixes. **Deviation:** editor and render modules run on the main thread instead of the D15 worker; proposed B9 moves
  them into the worker (input ring in; caret, accessibility and overlay data out; OffscreenCanvas) before C4. B10
  Transform tools proposed (flip, skew, pivot, numeric bar; then distort, perspective, warp). Both await the owner.
- **2026-10-25** IME check passed on the owner's Mac (Chrome 155): 8/8 automated, 7/7 by hand, both text inputs →
  **D20** (keep EditContext on Chrome). Results in `docs/instaflow/checks/`. Findings: no CJK fallback fonts / no
  .notdef boxes (follow-up); EditContext control bounds grow by a line per key during composition (sent to B8).
- **2026-10-25** #18 (M1c prep) merged. B8 started: one fresh agent, briefed by `M1-BRIEF.md` + `M1C-NOTES.md`.
- **2026-10-25** M1c prep: B8 added to the plan; `M1C-NOTES.md` (IDs, order, scope); `M1-BRIEF.md` rewritten for the
  current rules (scoped checks, WIP branches, handoffs, D1–D19); merge helpers moved to `tooling/coordinator/`; IME
  check zip sources and `pack.sh` committed; LIFECYCLES and Instaflow REQUIREMENTS sections sorted.
- **2026-10-25** #17 (B6) merged: **M1b complete in `main`.** #15 (test timeouts) merged too.
- **2026-10-25** #14 (B7) and #16 (B2) merged. `main` merged into `claude/m1b-b6-a11y` (no code change); #17 now
  targets `main`.
- **2026-10-25** B6 finished by a fresh agent (e84ea2e). Full check caught 8 test type errors: my scoped-check list
  left out `pnpm typecheck` (build skips tests). Fixed, rule updated in M1B-NOTES. PR #17 stacked on #16. **M1b's eight
  work packages are all built.** Next for the owner: merge #14 → #16 → #17 (and #15 anytime), IME check.
- **2026-10-25** #14 (B7) and #15 (timeouts) green, waiting for the owner. B2 finished by a fresh agent (177k tokens
  vs 360–780k for long-running ones) at 8cad75c; merged onto `claude/m1b-b2-text`, PR #16 stacked on #14. Next: B6.
- **2026-10-25** #13 merged. B7 merged on the working branch, PR #14. Fresh agent finishing B2 from its handoff.
  Owner away until morning: stack PRs (plan above).
- **2026-10-25** Owner: one branch per work package for work in progress. Pushed `claude/wip-b2-text` and
  `claude/wip-b7-repeat`.
- **2026-10-25** B3 merged on the working branch (full check: 3,994 tests pass), PR #13. B7 done (405f7c1). B2
  checkpointed (a2328e6), handoff saved to the working branch.
- **2026-10-25** Owner: build slowly, coordinator keeps the log, commit often, handoffs between agent sessions. Set up
  this log and `handoffs/`. Made `pnpm typecheck` incremental (rerun 69 s → 12 s). B3 finished (1943fb2); B2 asked
  to checkpoint.
- **2026-10-25** PR #12 merged (B5, B0, B1, B4 + M1b conventions). Branch reset to `main`.
- **2026-10-25** ID fixes while merging: B0 → R13.25–R13.30, B4 → R11.54–R11.55; render lifecycle §18 → §28.
