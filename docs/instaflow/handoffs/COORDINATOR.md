# Coordinator handoff (read this first if you are coordinating M1)

The coordinator is the main session: it plans, briefs one agent at a time, merges, runs the full check, opens PRs,
watches CI, and keeps the log. Agents build. This file is the coordinator's memory; keep it current.

## Read in this order
1. `docs/instaflow/M1-LOG.md`: status table, Next, Owed, journal (newest first).
2. `docs/instaflow/M1-BRIEF.md` (what every agent is told), `M1B-NOTES.md`, `M1C-NOTES.md` (order, scope, pre-assigned
   IDs, WIP branch names), `M1-PLAN.md`, `DECISIONS.md` (D1–D21).
3. `docs/instaflow/ux/` (README index → FOUNDATIONS → surface specs → FLOWS; owner decisions in STUDIO-UX-SPEC §14).
4. `tooling/coordinator/README.md` (merge helpers and traps).

## The owner and how they want to work
- Architect turned product designer (DMBA at California College of the Arts). Cares about UX, polish, coherent
  icons, the Clean Pop visual design. Writes casually; answer plainly, short, decisive. Never misgender: they/them.
- **Slow and serial:** one agent at a time (two only when one is docs-only and touches different files). Tokens are a
  weekly and 5-hour budget (Max plan). Fresh agents from handoffs, never long resumed histories.
- **Durability:** commit and push after every step. Each work package has its own branch `claude/wip-<wp>-<name>`;
  agents push WIP there. Every agent session ends with a handoff in `docs/instaflow/handoffs/`.
- **One PR per work package.** Stack PRs when the owner is away. The owner merges (or says "merge" for a specific PR).
- **Before telling the owner to try something,** list what works and what doesn't yet. (They tried B8 Studio expecting
  it finished and found inert placeholders; that cost trust.)
- No screenshot-based validation by the coordinator unless in bypass mode; ask the owner to check visuals.
- Don't publish npm until the owner runs Release. No model identifiers in commits, PRs or files; commit trailers as in
  M1-BRIEF.
- The owner may interrupt the main thread (there is no stop button for it); background agents die with it. Recover:
  rescue uncommitted files from their worktrees, write down state, relaunch fresh agents that continue from the branch
  and write a handoff first.

## The loop for one work package
1. Brief a fresh agent (worktree isolation, background): setup = reset to the working branch, push a WIP branch;
   "read `docs/instaflow/M1-BRIEF.md` and follow it", plus the notes section with its scope and IDs. Keep the brief
   short; the docs carry the detail.
2. When it reports: remove its worktree (`git worktree remove -f -f` + `git branch -D worktree-…`; they fill the disk),
   merge its WIP branch onto `claude/affectionate-ramanujan-wbyz2g`, resolve conflicts (squash-merge trap: if a file
   is unchanged on our side since the agent's base, take theirs), run `SF_REQUIRE_RUST=1 pnpm check` once in the
   background with output to a scratch log, plus the smokes:
   `NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke` (both topologies) and `smoke:home`.
   Never call a failure a flake: root-cause it (a focused agent if needed).
3. Update M1-LOG (status row + journal), push, open the PR (template-free; describe, validate, follow-ups), subscribe
   to PR activity. After the owner merges: `git checkout -B claude/affectionate-ramanujan-wbyz2g origin/main` and
   force-with-lease push.

## Where things are (2026-10-25, end of day)
- `main`: M1a, M1b (B0–B7), B8 Studio integration, B9 editor in workers, B10a transform basics, site refresh, C0 Home.
- **Working branch** `claude/affectionate-ramanujan-wbyz2g`: C1 Export merged and green (full check + smokes), the UX spec (`docs/instaflow/ux/`), the brand assets
  (`apps/instaflow/brand/`), docs updates. C1 merged (#25). B11a PR #26 and UX primitives PR #27 (docs) open. Owner answered §6 (all recommended); #27 merged. **Fable gap research
  running** on `claude/wip-ux-research` (GAP-AUDIT.md). B11b waits for it.
  **B11a2 agent running** (stacked) on `claude/wip-b11a2-overlays`: B11a2 (overlay and feedback blocks; IDs IF-POL-001…049 free, IF-35.14+), then
  B11b.
- **Next work, in order:** B11a (foundations: kit building blocks, `<sf-icon>` with Lucide, toasts, menus, number
  field, inline edit) → B11b (Studio and Home surfaces per the UX docs, logo wiring, nothing inert) → C2 Import →
  C3 Modes and identity → C4 Hardening (end-to-end checkpoint in CI, performance and loading pass, exit criteria).
  B10b (distort, perspective, warp) is early M2.
- **Logo:** chosen 2026-10-25: cursive "if", colour-split dot (tangerine up-left, mint down-right), no tail. Assets
  and rules in `apps/instaflow/brand/README.md`. Exploration canvas (private): https://claude.ai/artifact/DBXQcprCczNoyq551WeCTC
  (board "Final"). File extension stays `.iflow` (`.ifx` is crowded: fax images, IrfanView).
- **Visual design source:** `docs/instaflow/design/` = the "Clean Pop · final" page only. The original canvas (private):
  https://claude.ai/artifact/DDVDJoutHzzMt5wEoCj5MZ (other pages there are archived).
- **Owed by the owner:** npm Release rerun, deprecate `0.0.0-stage`, trusted publishing then delete `NPM_TOKEN`,
  optional `main` protection, manual IME re-check after B9, optional real-GPU timing run in both topologies.

## Things learned the hard way
- Fable's job is open-ended UX research that finds gaps itself (market analysis, shortcuts, every flow end to end).
  Never brief it as "write X and Y"; give it the baseline (spec + design + code) and ask it to discover what's missing.
  Briefing only named items is how the Export flow stayed frame-only.
- Every UX research brief includes `handoffs/CAPABILITY-COVERAGE.md` (built from REQUIREMENTS sections + src modules)
  and the agent must account for every row. A topic list in a brief is never the inventory; that is how text was missed.
- Owner: convention is not the default. Design the better thing when we can; keep convention only where it serves
  people (muscle-memory shortcuts, gestures) and say why.
- Tests can pass while a person can't use the product. Acceptance comes from `docs/instaflow/ux/FLOWS.md`, written from
  the user's side of the screen.
- Agents' scoped checks must include `pnpm typecheck` (build skips tests).
- Guard tests pin lists (Wasm crates, Wasm budgets, audited elements); a package that adds one must update them.
- Size-limit entries are keyed by name; a renamed entry merges as a stale duplicate.
- Pre-assigned IDs per package prevent collisions; check `grep` before adding framework IDs.
- `pnpm check` once per merge, by the coordinator; agents never run the full suite.
- When the owner reports a problem, find the root cause in the code before explaining (e.g. Delete "didn't work"
  because the canvas shortcut scope only activates while the surface has focus).
