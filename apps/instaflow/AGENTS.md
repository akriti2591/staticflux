# apps/instaflow — AGENTS.md

**Layer:** app (may import every `@staticflux/*` package; packages never import the app).
Specs: `docs/instaflow/` (ARCHITECTURE is normative for IF-7/IF-8; DECISIONS is authoritative; M1-PLAN lists the work packages).

## Layout
- `engine/` — Rust workspace (render and authoring Wasm, A2/A6), built by `pnpm build:wasm`; see `engine/AGENTS.md`.
- `models/` — model-weights registry for the license check.
- `src/sequencing/` — editor ↔ render sequencing (A7, D15): editor and render **modules** with fixed ports, the topology boot
  setting, the S2 protocol rules, the oracle subject. See `src/sequencing/AGENTS.md`.
- `bench/sequencing/` — bench page for the owner's real-GPU run (`pnpm bench:build`, then `pnpm gpu:run … --real-gpu --headed`).
- `test/threads/` — Node `worker_threads` fixtures (load TypeScript through the worker package's module hooks).
- `spikes/` — Phase 0 spikes, read only, deleted at M1 end (not in the workspace).

## Rules
- Repo rules 1–10 apply (`CLAUDE.md`). Errors are `IF-*` codes defined with `defineError` next to the code that raises them.
- Modules never branch on topology, mode or flags: boot settings resolve into data (plans, variant tables) in `*.bindings.ts`.
- App source never imports `@staticflux/testkit` (tests and the bench may). Test-only modules live in `src/**/testing/`.
- Spike code is ported, never copied.

## Test
`npx vitest run apps/instaflow` (includes the oracle on every topology × medium and the worker_threads run) ·
`npx tsc -p apps/instaflow` (after `pnpm build`) · `SF_GPU=1 pnpm test:gpu` (bench page in Chromium on SwiftShader).
