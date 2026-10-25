# Brief for M1 work-package agents

You build ONE work package (WP) of Instaflow M1 in this repository, in your own git worktree. Production code, not a
spike. You start fresh: everything you need is in files, not in anyone's conversation history.

## Read first (only these up front; read more when the work needs it)
1. `CLAUDE.md` (repo rules 1–10, style). Enforced by tooling; never work around them.
2. `docs/instaflow/M1-LOG.md`: what has landed, what is open, follow-ups.
3. The stage notes for your WP: `docs/instaflow/M1B-NOTES.md` (all of M1b and the rules that still apply) and
   `docs/instaflow/M1C-NOTES.md` (B8 and M1c). They hold your **pre-assigned IDs** and your WIP branch name.
4. Your WP row in `docs/instaflow/M1-PLAN.md`; `docs/instaflow/DECISIONS.md` (D1–D19, plus any later ones).
5. **Any WP that touches Studio or Home UI or interaction:** `docs/instaflow/ux/STUDIO-UX-SPEC.md` (how every region,
   handle, shortcut, menu and panel must behave and be arranged) and `docs/instaflow/ux/STUDIO-FLOWS.md` (end-to-end
   flows F-xx that are your acceptance tests). They outrank your own taste. If your WP needs something they don't
   cover, follow established editor conventions (Figma, Canva, Keynote), say so in your report, and propose the spec
   change; never invent silently.
6. Your handoff, if one exists: `docs/instaflow/handoffs/<WP>.md`.
7. The `AGENTS.md` of every package or app folder you touch. Framework shapes (tokens, units, `requires`/`provides`,
   scopes, variant bindings, `Result`/`SfError`): `docs/ARCHITECTURE.md` §3 and `packages/core/AGENTS.md`.

## Deliverables (definition of done)
- Code in the folders your WP names. Framework packages never import `apps/`. App features are headless services plus
  B0 contributions; UI only from `@staticflux/kit` under `cleanPopTheme`.
- Unit tests for every exported function; a contract suite in `packages/testkit` for every port you define.
- `AGENTS.md` for each new or changed folder (one row in the `apps/instaflow/AGENTS.md` table: no blank lines in it).
- Lifecycles in `docs/LIFECYCLES.md`, requirements, error codes with a `fix`, and `docs/FEATURE-NEEDS.md` entries,
  all within your pre-assigned IDs. Keep numbered sections in order.
- Size budgets in `.size-limit.json` for new entry points (tight, with the reason in the name when you raise one).

## Checks (no duplicate runs)
Run only your scope: `pnpm build`, `pnpm typecheck` (the only step that type-checks tests), `pnpm vitest run <your
paths>`, `pnpm lint:boundaries`, `pnpm lint:sf`, `pnpm size`, `pnpm errors:check` (plus `cargo test` in
`apps/instaflow/engine` if you touch Rust, `SF_GPU=1 pnpm test:gpu` if you touch rendering). After a fix, rerun only
what it touched. **Do not run the full `pnpm check`**: the coordinator runs it once at merge. Send long output to a
file and read only the summary.

## Durability
- Commit and push to your WIP branch (`git push origin HEAD:refs/heads/<branch from the notes>`) after every
  meaningful step. It need not pass checks.
- **End every session with a handoff**, finished or not: write `docs/instaflow/handoffs/<WP>.md` (template in
  `handoffs/README.md`), commit and push.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01A3sHuDbT6kQw9Xvoh3q46g
  ```
  No model identifiers in files. Don't open PRs. Push only to your WIP branch.

## Shared files
`docs/REQUIREMENTS.md`, `docs/FEATURE-NEEDS.md`, `docs/LIFECYCLES.md`, `docs/instaflow/REQUIREMENTS.md`,
`.size-limit.json`, `apps/instaflow/package.json`, `apps/instaflow/AGENTS.md`, root `package.json`, `pnpm-lock.yaml`:
add self-contained entries only; never reformat others' content.

## Environment
4 shared CPU cores (never assert wall-clock numbers in unit tests; give heavy tests an explicit, commented timeout).
No GPU: WebGPU via SwiftShader in Chromium. Chromium + Playwright preinstalled (`NODE_PATH=/opt/node-tools/node_modules`).
Rust with `wasm32-unknown-unknown`. Network to npm and crates.io.

## Final report to the coordinator (under 25 lines)
Final commit on your WIP branch, state (done or what is left), IDs and framework IDs used, decisions the plan did not
specify, follow-ups, and the shared files the coordinator must reconcile.

## Coordinator (for whoever runs the merges)
One agent at a time. Merge a finished WIP branch onto a PR branch, run `SF_REQUIRE_RUST=1 pnpm check` once (skip it
when the merged tree equals what was already checked), open one PR per WP, watch CI. Helpers and known merge traps:
`tooling/coordinator/README.md`. Record every step in `docs/instaflow/M1-LOG.md` and push it.
