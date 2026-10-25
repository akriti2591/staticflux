# M1c conventions (in and out), plus B8

Read with [M1-BRIEF.md](M1-BRIEF.md). Everything in [M1B-NOTES.md](M1B-NOTES.md) still applies (features plug in through
B0 contributions, UI only from the kit under Clean Pop, Rust in the engine crates, the Checks rules). This file adds
the M1c work packages, their pre-assigned IDs and their order.

## Order (one work package at a time, one PR each; set by the coordinator, 2026-10-25)
1. **B8 Studio integration** (the "M1b demo" step in M1-PLAN): the first Studio you can click through. *Merged (#20).*
2. **B9 Editor in the worker**: moves the editor and render modules off the main thread, where B8 left them, into the
   D15 topology. Before C4, whose frame budgets need the real threading.
3. **Site refresh** (docs site content, no IDs).
4. **B10a Transform tools, basics**: on top of B9 so nothing is built twice.
5. **C0 Home** → **C1 Export** → **C2 Import** (needs C1) → **C3 Modes and identity** → **C4 Hardening** (the M1 exit
   criteria; last).
6. **B10b Distort, perspective, warp: early M2, not M1.** It needs a warped-image path in the renderer and in C1's
   PDF / SVG export; doing it after M1 keeps the finish line in reach and teaches export warps once.

## Pre-assigned IDs (avoid merge collisions)
| WP | Requirement IDs | LIFECYCLES section | Error codes | Work-in-progress branch |
|---|---|---|---|---|
| B8 Studio integration | IF-27.1–27.29 | §29 | IF-INT-001… | `claude/wip-b8-studio` |
| B9 Editor in the worker | IF-33.1–33.29 | §35 | IF-WRK-001… | `claude/wip-b9-worker` |
| B10a Transform tools, basics | IF-34.1–34.29 | §36 | IF-XF-001… | `claude/wip-b10a-transform` |
| B11 Studio basics and polish | IF-35.1–35.29 | §37 | IF-POL-001… | `claude/wip-b11-polish` |
| C0 Home route | IF-28.1–28.29 | §30 | IF-HOME-001… | `claude/wip-c0-home` |
| C1 Export | IF-29.1–29.29 | §31 | IF-EXP-001… | `claude/wip-c1-export` |
| C2 Import | IF-30.1–30.29 | §32 | IF-IMP-001… | `claude/wip-c2-import` |
| C3 Modes and identity | IF-31.1–31.29 | §33 | IF-MODE-001… | `claude/wip-c3-modes` |
| C4 Hardening | IF-32.1–32.29 | §34 | IF-HARD-001… | `claude/wip-c4-hardening` |

Framework IDs (`R*` in `docs/REQUIREMENTS.md`, `SF-*` errors): append after the highest existing number in that area,
**check with `grep` before adding**, and name them in your report. Taken so far in M1b: R11.53–R11.62, R13.24–R13.30,
R15.6, R16.30–R16.31, SF-SURF-016–017. `docs/LIFECYCLES.md` §28 is the A6 render section. Keep sections in numeric
order when you add yours (the files are sorted).

## B8 Studio integration (scope)
Wire what M1b built into the live Studio so a person can create, edit and see a design end to end:
- Studio's canvas port runs A7 sequencing with B1's render source built over **B7's `createRepeatStage`**; resource
  batches (images, fonts) travel ahead of projection deltas on the same ordered channel (B1 follow-up).
- A per-tab **tool session** connects B3's controller and guide overlay, and **B6's `createCanvasA11y`**, to the canvas.
- Every M1b panel and HUD action is placed in the Studio spec (repeat, appearance, typography, library, pages,
  milestones); duplicates of B0 placeholders are replaced, not added.
- Fixes owed to integration: text `duplicate` keeps rich text (B2 handoff), B3's index keeps fresh group bounds when a
  child moves (B6 handoff), the `textbox` role while text is being edited (B6), the asset "Place" host hook (B4/B3).
- A runnable dev entry (`pnpm --filter @instaflow/app dev` or equivalent) and a short "try it" section in
  `apps/instaflow/AGENTS.md`. One Playwright smoke scenario: open Studio, draw a rectangle, type text, milestone.

## B9 Editor in the worker (scope)
B8 runs the editor and render modules on the main thread (deviation from D15). Move them into the architecture's
threads (`docs/instaflow/ARCHITECTURE.md` §2, §4, §5.3) without losing anything B8 delivered:
- **Main thread keeps only page-side adapters:** pointer and keyboard capture into A5's input ring, EditContext (text
  input), the B6 accessibility DOM, panels and chrome. Everything that decides (document, stage, selection, tools and
  snapping, text layout, camera and view state) runs in the editor module in the worker.
- **Back to main:** caret, selection and character bounds for EditContext; B6 projection snapshots; the read
  projections panels need (selection, inspector values). Overlays (selection, handles, guides) stay in the render
  scene, drawn in the same frame as content.
- **Render** into an `OffscreenCanvas` in the worker; topology by the D15 boot setting (one worker by default, two
  available), modules never branch on it.
- **Must pass, in both topologies:** B8's smoke test (draw, type, milestone); select, move, resize and rotate in a real
  browser; overlay matches content during a drag; tab hidden then visible keeps state; switching lens and page; the
  automated IME check (`apps/instaflow/src/text/ime-check/pack/auto-check.mjs`). The owner reruns the manual IME check.
- Keep frame metrics (A7) working, so C4 can budget them.

## B10a Transform tools, basics (scope)
Photoshop-style Free Transform basics on top of B3: flip horizontal / vertical (also on negative resize), skew
(Mod-drag a side handle) with snapping, a draggable pivot (reference point) used by rotate and scale, a numeric
transform bar (X, Y, W, H, angle, skew) as a B0 contribution, and Mod+T to enter transform mode. Every transform is one
undo step, works on rotated and nested elements, and is a capability agents can call.

## UX spec first, then B11 (owner, 2026-10-25)
The owner's first hands-on session found missing basics (no visible delete or rotate, no clipboard) and an unpolished
UI, while every test passed: tests checked plumbing, not what a person expects. So:
1. A UX analyst writes `docs/instaflow/ux/STUDIO-UX-SPEC.md` and `STUDIO-FLOWS.md` (plain Markdown, for agents).
2. **B11 Studio basics and polish** implements the spec's gap table and turns the M1 must-pass flows into end-to-end
   tests in CI (both topologies), written from the user's side of the screen (find controls as a person would).
3. C2–C4 follow; every later WP that touches UI reads the spec and flows (M1-BRIEF reading list item 5).

## C-stage specifics
- **C0** boots with no engine or GPU (D17): check with a size budget and a test that the Home entry imports neither.
- **C1** exports from B5's frozen export snapshot (no record, D10). It must write each element's **full 2D matrix**
  (rotation, scale, **skew and flips** from B10a's `spatial.skewX` and negative scales), every B1 appearance layer, masks
  and B2 text (real text in PDF), and B7 repeats expanded. Golden-image parity against the renderer for PNG.
- **C1** decides the SVG parity rule (M1-PLAN "Decisions"): write the decision and its numbers into
  `docs/instaflow/DECISIONS.md` as the next free D-number and say so in the report.
- **C4 includes a loading and performance pass** (owner, 2026-10-25; deliberately last, once features settle). Use what
  the framework already has but Instaflow doesn't use yet: `@staticflux/loader` (logical chunks, `sf-manifest`, boot
  plans, warmup tiers), the vite plugin (chunk manifest, preloads, budgets), `@staticflux/perf` (journeys, feature
  marks, detectors, budgets) and DI's `render` / `lazy` / `functional` dependencies. Deliver:
  - a **production build** of Instaflow (minified, compressed: brotli and gzip) and a report per entry route (Home,
    files, Chat when it exists, Studio opened directly, Studio from Home): JavaScript and Wasm for the first render vs
    later, the chunk graph and load waterfall;
  - proof that DI boundaries split code as intended (what each surface loads before first render, what loads on
    first use), and fixes where they don't;
  - budgets per route and chunk in CI (size-limit + `sf` budgets), plus performance tests: time to first render and
    to interactive per route, input-to-frame latency, pan / zoom / drag p95, time to sharp, and per-feature timings
    (open a large design, export, milestone, paste an image);
  - a short readable performance page in the docs with the numbers and how to rerun them.
- **C4** turns every M1 exit criterion (M1-PLAN § Exit criteria) into a CI check, deletes `apps/instaflow/spikes/`,
  and ratchets size budgets. It is the M1 finish line.
