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
| B7 Repeat | PR open (full check: 4,035 tests pass) | working branch | #14 |
| B2 Text | Checkpointed, nearly done (`handoffs/B2.md`); fresh agent finishing it | `claude/wip-b2-text` @ a2328e6 | — |
| B6 Accessibility layer | Not started; after B3, B7, B2 | — | — |

Each work package's work in progress is pushed to its own branch `claude/wip-<wp>-<name>`, so nothing lives only in
this container.

## Overnight plan (owner away, 2026-10-25)
PRs stack so the owner can merge them in order in the morning:
1. #14 B7 (working branch → `main`).
2. B2: fresh agent finishes on `claude/wip-b2-text`; coordinator merges onto `claude/m1b-b2-text`, stacked on the
   working branch (PR base = working branch).
3. Flaky timeouts (Loro leak test, `costs.test.ts`, worker threads, headless surface): coordinator fixes on
   `claude/fix-flaky-timeouts` off `main`, own PR.
4. B6 accessibility: fresh agent after B2, stacked on B2's branch.
One agent at a time. Every PR's CI watched; red CI fixed before moving on.

## Owed
- **Owner:** npm Release rerun (9 packages); deprecate `0.0.0-stage`; set up trusted publishing, then delete
  `NPM_TOKEN`; reference iGPU runs; B2's IME check (page comes with B2).
- **Engineering follow-ups:** resource batches ahead of projection deltas on A7's pipes (B1); blob ↔ DocumentStore
  adapter (B5); asset "Place" host hook (B4/B3); page thumbnails (B4); import capability for agents (B4); B3's
  follow-ups (in its PR); luminance masks approximate where translucent mask shapes overlap (B1); flaky timeouts under
  load: Loro leak test, `costs.test.ts`, worker threads, headless surface.

## Journal
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
