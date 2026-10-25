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
| B3 Tools and smart guides | Done in worktree, to merge next | `worktree-agent-a4db0671f0de97faf` @ 1943fb2 | — |
| B7 Repeat | Finishing (its check run) | `worktree-agent-a495c8fac8b82e2ee` | — |
| B2 Text | Asked to checkpoint + hand off | `worktree-agent-aee5798a92554cab5` | — |
| B6 Accessibility layer | Not started; after B3, B7, B2 | — | — |

Worktree branches are local to this container. They become durable only once merged onto the working branch and
pushed; handoff files are copied onto the working branch as soon as they exist.

## Owed
- **Owner:** npm Release rerun (9 packages); deprecate `0.0.0-stage`; set up trusted publishing, then delete
  `NPM_TOKEN`; reference iGPU runs; B2's IME check (page comes with B2).
- **Engineering follow-ups:** resource batches ahead of projection deltas on A7's pipes (B1); blob ↔ DocumentStore
  adapter (B5); asset "Place" host hook (B4/B3); page thumbnails (B4); import capability for agents (B4); B3's
  follow-ups (in its PR); luminance masks approximate where translucent mask shapes overlap (B1); flaky timeouts under
  load: Loro leak test, `costs.test.ts`, worker threads, headless surface.

## Journal
- **2026-10-25** Owner: build slowly, coordinator keeps the log, commit often, handoffs between agent sessions. Set up
  this log and `handoffs/`. Made `pnpm typecheck` incremental (rerun 69 s → 12 s). B3 finished (1943fb2); B2 asked
  to checkpoint.
- **2026-10-25** PR #12 merged (B5, B0, B1, B4 + M1b conventions). Branch reset to `main`.
- **2026-10-25** ID fixes while merging: B0 → R13.25–R13.30, B4 → R11.54–R11.55; render lifecycle §18 → §28.
