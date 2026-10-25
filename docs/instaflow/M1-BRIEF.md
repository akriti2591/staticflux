# Brief for M1 work-package agents

You build ONE work package (WP) of Instaflow M1 in this repository. You work in your own git worktree; the
coordinator merges your branch. Production code, not a spike.

## Read first
1. `CLAUDE.md` (repo rules 1–10, style). They are enforced by tooling; do not work around them.
2. `docs/ARCHITECTURE.md`, `docs/LIFECYCLES.md`, `docs/FEATURE-NEEDS.md`, `docs/REQUIREMENTS.md` (framework).
3. `docs/instaflow/M1-PLAN.md` (your WP row), `docs/instaflow/DECISIONS.md` (D1–D15),
   `docs/instaflow/PHASE0-FINDINGS.md`, and the relevant parts of `docs/instaflow/{ARCHITECTURE,DOCUMENT-FORMAT,
   REQUIREMENTS}.md` and `docs/instaflow/PLAN.md` §3 (the SF-Δ rows your WP implements).
4. The spike README your WP comes from (`apps/instaflow/spikes/<spike>/README.md`) and its code, **read only**.
   Port ideas and measurements into tests; never copy spike code wholesale (spikes ignore the repo rules).
5. One existing package as a template for structure and conventions (for example `packages/document`,
   `packages/storage`, `packages/worker`): `AGENTS.md`, `errors.ts`, `units.ts`, tests next to sources.

## Deliverables (definition of done)
- Code in the package(s) your WP names. Framework packages never import `apps/`.
- **Unit tests for every exported function**; a **contract suite** for every port you define (in
  `packages/testkit`, one file per port, named after it).
- `AGENTS.md` for each new or changed package (purpose, public API, allowed deps, budgets, rules).
- Lifecycles for new state machines in `docs/LIFECYCLES.md`; `SF-*` errors with stable codes and `fix` text
  (run `pnpm errors` to regenerate the catalog).
- Requirement IDs in `docs/REQUIREMENTS.md` and needs in `docs/FEATURE-NEEDS.md` for every new API.
- Size budget entries in `.size-limit.json` for new entry points (pick a tight, justified number).
- **`pnpm check` passes** on your worktree (build, typecheck, test, boundaries, sf lint, errors, size).
- Commit on your worktree branch with clear messages ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01A3sHuDbT6kQw9Xvoh3q46g
  ```
  Do not push, do not open PRs, do not touch other WPs' packages.

## Shared files
Several WPs edit `docs/REQUIREMENTS.md`, `docs/FEATURE-NEEDS.md`, `docs/LIFECYCLES.md`, `.size-limit.json`,
`tsconfig.build.json`, root `package.json` and `pnpm-lock.yaml`. Keep your edits to these as **appended,
self-contained sections or entries** (no reformatting of others' content) so merges stay mechanical.

## Environment facts
4 CPU cores shared with other agents (timings are noisy; never assert wall-clock numbers in unit tests; put
performance checks in clearly marked bench files). No GPU: WebGPU only via SwiftShader in Chromium
(`apps/instaflow/spikes/_harness/serve-and-run.cjs` shows the flags). Chromium + Playwright preinstalled
(`NODE_PATH=/opt/node-tools/node_modules`). Rust 1.97 with `wasm32-unknown-unknown`. Network to npm and crates.io.

## Final message to the coordinator (≤ 250 words)
What you built (packages, public API headlines), test counts, `pnpm check` status, decisions you made that the
plan did not specify, anything left undone, and the worktree branch name.
