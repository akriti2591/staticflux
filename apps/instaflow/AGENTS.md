# Instaflow — AGENTS.md

**Area:** app (`apps/instaflow`, package `@instaflow/app`, layer `app`; may import every `@staticflux/*` package,
packages never import the app). Specs: `docs/instaflow/` (ARCHITECTURE is normative for IF-7/IF-8; DECISIONS is
authoritative; M1-PLAN lists the work packages; `design/` is the approved Clean Pop visual design).

## Layout
| Path | Contents | Docs |
|---|---|---|
| `engine/` | Rust workspace (render, authoring crates) built to Wasm by `pnpm build` (A2, A6) | `engine/AGENTS.md` |
| `src/render/` | Vello `RasterBackend`, render Wasm loader, scene IR encoder (A6); export `@instaflow/app/render` | `src/render/AGENTS.md` |
| `src/elements/` | Element components, brand kits and classes, geometry service, actions, render projection → scene IR, Fill/Stroke/Effects panel (B1); exports `@instaflow/app/elements`, `/elements/panel` | `src/elements/AGENTS.md` |
| `src/sequencing/` | Editor and render **modules** with fixed ports, the topology boot setting, the S2 protocol rules, the oracle subject (A7, D15) | `src/sequencing/AGENTS.md` |
| `src/theme/` | Clean Pop theme (`cleanPopTheme`, DS1) and the typed lens palette | `src/theme/AGENTS.md` |
| `src/versioning/` | Latest save state, milestones, compare, New document from milestone, templates with slots, frozen export snapshot, the Milestones panel / save status / "Milestone" command contributions (B5); exports `@instaflow/app/versioning` and `/versioning/ui` | `src/versioning/AGENTS.md` |
| `src/spec/` | Editor specs (B0, D16): contribution tokens, `EditorSpec` schema, registries, gate adapter, Studio spec, example mini editor, proposals | `src/spec/AGENTS.md` |
| `src/studio/` | The Studio shell (B0): controller, `<if-studio>` frame laid out from the spec, the canvas port over A7 | `src/studio/AGENTS.md` |
| `bench/sequencing/` | Bench page for the owner's real-GPU run (`pnpm --filter @instaflow/app bench:build`, then `pnpm gpu:run … --real-gpu --headed`) | `src/sequencing/AGENTS.md` |
| `test/threads/` | Node `worker_threads` fixtures (TypeScript loaded through the worker package's module hooks) | — |
| `models/` | Model-weights license registry (A2) | `models/AGENTS.md` |
| `spikes/` | Phase 0 spikes, read only, deleted at M1 end (not in the workspace) | `docs/instaflow/PHASE0-FINDINGS.md` |

## Rules
- Repo rules 1–10 apply (`CLAUDE.md`). Errors are `IF-*` codes defined with `defineError` next to the code that raises them.
- Modules never branch on topology, mode or flags: boot settings resolve into data (plans, variant tables) in `*.bindings.ts`.
- App source never imports `@staticflux/testkit` (tests and the bench may). Test-only modules live in `src/**/testing/`.
- Framework packages are imported through their exports only. Spike code is ported, never copied.
- `pnpm build` compiles `src/` to `dist/` (`tsconfig.json`, referenced from `tsconfig.build.json`); `pnpm typecheck`
  covers `src/` with its tests and `bench/` (`tsconfig.test.json`).

## Test
`pnpm vitest run apps/instaflow` (includes the oracle on every topology × medium and the worker_threads run) ·
`cargo test` in `engine/` · `SF_GPU=1 pnpm test:gpu` (real WebGPU on SwiftShader; `SF_GPU=real` for a real GPU).
