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

## Where things are (2026-10-27, bug phase)
- `main`: everything through B11c (Studio + Home rebuild), B12/B12b, drag-stutter and text fixes, all UX specs
  (FOUNDATIONS, OVERLAYS-FEEDBACK, NAVIGATION, DENSITY-DISCLOSURE, GAP-AUDIT, TEXT-FONTS, APPEARANCE-TRANSFORM,
  MOTION-TIMELINE, STUDIO, HOME-FILES, CHAT, DEVTOOLS, FLOWS). Open PR: #38 (issue form, config only).
- **Bug phase (owner rules above: one bug at a time, failing test first, root cause, smallest fix, own PR "Fixes #n",
  owner verifies before the next; check a "missing" thing exists **on the running UI** first).**
  Issues #39–#55. Order: #41 focus (PR #57, owner verified) → **#58 popovers close on pointer leave (running, `claude/fix-58-popover-dismiss`)** → #42 → #53 Shift multi-select reverts →
  section collapses on popover use (then re-check #44 Page › Background `+ Add ▾`) → #48 top element hit (then
  re-check #49 group/mask, #50 union, #52 radial repeat) → #51 subtract blanks (intermittent; image suspected) →
  #54 paths don't resize (flatten bounds) → #39 Finder paste white screen → #43 page bg image not on canvas →
  #45 colour popover cropped → #46 page W/H truncated → #47 polygon Sides (control defined, never rendered: add to
  inspector + HUD, label Sides) → #56 Settings shortcuts sheet (two scroll bars, raw key names, lists unbuilt tools) → #55 inspector layout + #40 dock padding
  (spec merged in #59: COMPONENT-ANATOMY.md + INSPECTOR-LAYOUT-SPEC.md; owner said yes to all five §9 questions
  on 2026-10-27; one implementation pass, owner reviews).
- Merged and owner verified: #57 (#41), #61 (#58), #63 (#42; #44 narrowed to Background `+ Add ▾` items opening their editors).
  Running: #53 (`claude/fix-53-shift-select`). Proposed next: #43 (bg image shows now, lost on reload: persistence;
  check placed images too), then the canvas selection bugs. New: #64 Home/Files previews blank (after the canvas bugs).
- **#62 Studio blank until Wasm loads** (owner): mount the shell first with placeholders, preload the Wasm. Proposed
  right after #42; with it in C4: split `studio-element.ts` (1,290 lines: shortcuts/menus/commands into modules),
  lazy-load rare panels (find, shortcuts sheet, settings) with real placeholders.
- **After the bugs:** fonts package (owner approved): Google Fonts catalogue (download on pick, cached in the
  workspace), small curated offline set, fonts on this computer in Studio, picker rows previewed in their own face
  (lazy, visible rows). Lists stay M2 (T-10). Then split input-lag look, C2 Import, C3 Modes/identity, C4 (e2e in CI,
  perf pass: drag layer, Home boot split 117 KB, per-route JS), M2 (agent layer, B10b, lists), M3 timeline, M4 motion.
- Open owner questions: 12 motion questions (MOTION-TIMELINE §18), not needed until M3.
- **Next work, in order:** B12 engine gaps → B11b (Studio and Home surfaces per the UX docs, logo wiring, nothing inert) → C2 Import →
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
- **Bug phase rule (owner, 2026-10-27):** the owner reports bugs in any form; the coordinator files one GitHub issue per
  bug and fixes them **one at a time**: failing test first, root cause with evidence, smallest fix, its own small PR
  that closes the issue, owner verifies before the next. No big multi-feature agents for bug work; one bug per brief
  if an agent is used at all. The owner felt big batches lowered quality (inert controls, misreported budgets).
- **UX spec method (owner, 2026-10-27):** no visual mockups (token cost). Fable writes exhaustive Markdown specs on a
  **reusable layer**: `ux/COMPONENT-ANATOMY.md` (every block's parts, sizes and spacing per density, type, colour
  tokens, radius, states), grounded in Clean Pop; surface specs only map sections to those blocks. **Research is
  required and cited** (Fable did zero web searches in its first five passes; if no web access, say so). Builders follow
  the blocks. Reason: the Studio looked "off" because specs were behavioural only and each builder improvised layout.
- **UI inventory (cheap, mechanical):** `docs/instaflow/ux/UI-INVENTORY.md` lists every custom element (74 on
  2026-10-27). Give it to every UX/anatomy brief so agents don't spend tokens discovering components. Regenerate:
  `git grep -h -o -E "tag: '(sf|if)-[a-z-]+'|_TAG = '(sf|if)-[a-z-]+'|customElements.define\('(sf|if)-[a-z-]+'" -- packages apps/instaflow/src ':!*.test.ts'`.
- **Check it exists first (owner):** for a "missing" UI report, first look for the feature and any other path to it
  (collapsed sections, More folds, menus, shortcuts). If it exists, tell the owner where, and narrow the issue to
  discoverability or close it; never force a fix. **Verify on the running UI (or the render path), never from a
  definition alone**: on #47 the coordinator wrongly claimed sides existed because a control was defined but never rendered.
- Fable's job is open-ended UX research that finds gaps itself (market analysis, shortcuts, every flow end to end).
  Never brief it as "write X and Y"; give it the baseline (spec + design + code) and ask it to discover what's missing.
  Briefing only named items is how the Export flow stayed frame-only.
- Every UX research brief includes `handoffs/CAPABILITY-COVERAGE.md` (built from REQUIREMENTS sections + src modules)
  and the agent must account for every row. A topic list in a brief is never the inventory; that is how text was missed.
- Owner: I sequence the build; UX designs every feature now (deferred too): its outlet in the UI and its flows to
  completion and follow-up. Put this in every UX brief (CAPABILITY-COVERAGE.md has the wording).
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
