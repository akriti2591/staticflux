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
| `src/tools/` | Hit testing (rbush → exact geometry), select, marquee, round transform handles, nudge, smart guides and snapping, per-tab view state, keyboard paths, Select/Hand tool and transform capability contributions (B3); export `@instaflow/app/tools` | `src/tools/AGENTS.md` |
| `src/repeat/` | Live radial / grid / mirror repeats: the `repeat` component, the repeat view over the stage (derived instances for render, bounds, booleans, masks, hit queries), expand with deterministic match keys, handles, Repeat panel and contributions (B7); exports `@instaflow/app/repeat`, `/repeat/panel` | `src/repeat/AGENTS.md` |
| `src/a11y/` | Accessibility layer (B6): virtualized DOM projection of the canvas (roles, names, reading order, repeat instances), focus path over B3's selection and keys, polite selection announcements, `describe-canvas` contribution, chrome audit guard; export `@instaflow/app/a11y` | `src/a11y/AGENTS.md` |
| `src/sequencing/` | Editor and render **modules** with fixed ports, the topology boot setting, the S2 protocol rules, the oracle subject (A7, D15) | `src/sequencing/AGENTS.md` |
| `src/text/` | Text (B2): rich text model, Parley layout service over the authoring text Wasm, fonts (LFA, uploads, tokens), TextInput editing session, scene projection, Typography panel and HUD, a11y data, human IME check page; export `@instaflow/app/text` | `src/text/AGENTS.md` |
| `test/fonts/` | OFL test fonts (Noto subsets, Inter subset) for text tests and goldens | `test/fonts/README.md` |
| `src/theme/` | Clean Pop theme (`cleanPopTheme`, DS1) and the typed lens palette | `src/theme/AGENTS.md` |
| `src/versioning/` | Latest save state, milestones, compare, New document from milestone, templates with slots, frozen export snapshot, the Milestones panel / save status / "Milestone" command contributions (B5); exports `@instaflow/app/versioning` and `/versioning/ui` | `src/versioning/AGENTS.md` |
| `src/library/` | Workspace library (B4): library document, ingest and content hashing over `@staticflux/blob`, immutable asset records, rendition jobs (A6 scene renderer or CPU fallback), the Assets panel contribution; exports `@instaflow/app/library` and `/library/ui` | `src/library/AGENTS.md` |
| `src/lenses/` | Pages and Canvas lenses as per-mode features (B4): structure reader, `LensFeature` registry, lens controller and shortcuts, story edits, the Pages panel contribution; exports `@instaflow/app/lenses` and `/lenses/ui` | `src/lenses/AGENTS.md` |
| `src/spec/` | Editor specs (B0, D16): contribution tokens, `EditorSpec` schema, registries, gate adapter, Studio spec, example mini editor, proposals | `src/spec/AGENTS.md` |
| `src/studio/` | The Studio shell (B0): controller, `<if-studio>` frame laid out from the spec, the canvas port over A7 | `src/studio/AGENTS.md` |
| `src/app/` | Studio integration (B8): the composition root — canvas pipeline over A7 (resources ahead of deltas), per-tab tool session with creation tools, text editing and the accessibility layer, Vello raster, real registries and panel services, HUD dispatch, Place | `src/app/AGENTS.md` |
| `dev/studio/` | Studio dev entry (B8): `pnpm --filter @instaflow/app dev`, see **Try it** below | `src/app/AGENTS.md` |
| `test/smoke/` | Studio smoke scenario (B8): Playwright on SwiftShader, `pnpm --filter @instaflow/app smoke` | `src/app/AGENTS.md` |
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

## Try it (Studio, M1b demo)
```sh
pnpm install && pnpm build                 # once: TypeScript and the engine Wasm
pnpm --filter @instaflow/app dev           # then open http://localhost:5174/dev/studio/ in Chrome (WebGPU)
```
Draw with Shape (`R`) or Frame (`F`), select and drag (smart guides snap), type with Text (`T`), pick actions on a
selection in the HUD (Radial / Grid / Mirror repeat, align, booleans, masks; more under ⋯), edit Fill / stroke / effects
and Typography in the inspector, import and Place images from Assets, switch pages in Pages, press Milestone. `Mod+Z`
undoes, `Mod+D` duplicates, Delete deletes; `Tab`, Enter and arrows work on the canvas with a screen reader. The document
lives in memory (a reload starts over; storage lands with C0). Smoke check (headless, SwiftShader):
`NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke` (`-- --headed`, `-- --screenshot=out.png`).

## Test
`pnpm vitest run apps/instaflow` (includes the oracle on every topology × medium and the worker_threads run) ·
`cargo test` in `engine/` · `SF_GPU=1 pnpm test:gpu` (real WebGPU on SwiftShader; `SF_GPU=real` for a real GPU).
