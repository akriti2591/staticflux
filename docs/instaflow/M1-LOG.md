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
| B2 Text | Merged; owner IME check pending | `main` | #16 |
| B6 Accessibility layer | Merged; not yet wired to Studio's live canvas | `main` | #17 |
| B8 Studio integration | In progress (fresh agent, from `main` after #18) | `claude/wip-b8-studio` | — |

Each work package's work in progress is pushed to its own branch `claude/wip-<wp>-<name>`, so nothing lives only in
this container.

## Next (one work package at a time; details and IDs in M1C-NOTES.md)
1. **B8 Studio integration** (the M1b demo): the first Studio you can click through.
2. **M1c:** C0 Home → C1 Export → C2 Import → C3 Modes and identity → C4 Hardening (the M1 exit criteria).

Open M1 decisions: Chrome text input (IME check; zip built by `apps/instaflow/src/text/ime-check/pack/pack.sh`);
which worker mode boots by default (D15 says one; the split becomes default only if it meets the budget after the
main-rAF tick fix); folder mirror flush policy; SVG parity rule (C1, becomes D20); reference iGPU runner (C4).

## Owed
- **Owner:** IME check (zip sent 2026-10-25); npm Release rerun (9 packages); deprecate `0.0.0-stage`; set up trusted
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
  approximate where translucent mask shapes overlap (B1); `IF-*` error codes are not in `docs/errors.json`.

## Journal
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
