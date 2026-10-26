# FIX-DRAG-STUTTER handoff — 2026-10-26
**Commit:** head of `claude/fix-drag-stutter` (base `origin/main` bd5501e)  ·  **State:** done (contained fix); proposal below

## Symptom
Owner: moving a shape stutters, and in a grid repeat the lower half of the copies lags about a second behind.

## Root cause (measured, not guessed)
Per pointer move: input ring → editor (gesture move) → document change → repeat view re-expands the copies → B1
projection (≈1.5 KB, 13 rects) **plus the overlay batch** → render worker `renderer.apply` (0.1 ms) marks tiles stale →
the worker's rAF composites → the prep lane re-renders stale tiles. The CPU side is cheap. The lag comes from **which
tiles are fresh when a frame composites**:
1. **The page edge dirtied the whole page on every move.** `canvas-tab.ts` (main: lines 163–170) removed and
   re-upserted `PAGE_EDGE_ID` with every overlay change. The engine dirties a node's whole bbox
   (`engine/crates/render/src/ir.rs:787`), and the edge's bbox is the page. Trace: every move's overlay apply had
   union `-2,-2,1082,1352` (the whole page). After the fix it is about 72 bytes, union = the selection frame.
2. **Stale tiles were left to the prep lane: 4 per rAF, centre first, ties top first.** In Studio,
   `inFrameBudgetMs: 0` and `lane.run({ maxSlices: TILES_PER_FRAME = 4 })` run after `frame()` composites
   (`vello-raster.ts` on main: lines 72, 90). The tiled renderer only rasterizes *holes* in-frame
   (`tiled-renderer.ts:365`), and the order is Manhattan from the centre with ties broken by `ty`
   (`raster-tiling.ts:64`). A grid-repeat move legitimately dirties every tile under the grid, so each move restarts
   the order from the centre. **The bottom row is always last, and stays stale for the whole drag.** It catches up
   only ⌈16/4⌉ = 4 frames after the pointer stops. The empty top row (canvas margin) is also last, but nothing moves
   there. That is why the *lower* half lags. It is neither missing coalescing (applies arrive in one burst) nor
   repeat re-expansion (0.1 ms per apply).

Evidence: a 6×6 grid repeat in Studio, 1600×1000 at DPR 2, 16 visible 512 px tiles, a quick 16-move drag. Probe and
analysis scripts were in the session scratchpad. They use temporary trace hooks, since removed.

| run (SwiftShader) | frames in drag | frames with stale tiles | bottom row stale | settle after last move |
|---|---|---|---|---|
| colocated, before (2 runs) | 7 / 5 | 6 / 4 | 6 / 4 | 922 / 409 ms |
| split, before (2 runs) | 22 / 19 | 21 / 18 | 21 / 18 | 724 / 1148 ms |
| colocated, page edge fix only | 7 | 6 | 6 | 732 ms |
| colocated, after (2 runs) | 4 / 2 | **0 / 0** | **0 / 0** | 501 / 538 ms |
| split, after (2 runs) | 11 / 10 | **0 / 0** | **0 / 0** | 314 / 638 ms |
Screenshot mid-drag (before): the tiles above the bottom row show the moved grid, while the bottom row still shows
the copies at the old place. After: one consistent grid.

## Fix
- `apps/instaflow/src/app/canvas-tab.ts`: re-send the page edge only on a snapshot or when the page size or zoom
  changes.
- `packages/surface/src/tiled-renderer.ts`: new option `inFrameStaleTiles` (default 0, unchanged behaviour). It
  re-renders up to N stale visible tiles before compositing.
- `apps/instaflow/src/app/vello-raster.ts`: `STUDIO_TILE_POLICY` (`inFrameStaleTiles: 64`, enough for a 4K viewport at
  DPR 2) and `studioFrame`. The ring and missing tiles keep `TILES_PER_FRAME = 4`.
- Tests: `canvas-tab.test.ts` (no page-edge upsert during a drag; it fails without the fix), `tiled-renderer.test.ts`
  (in-frame refresh, cap, default off), `vello-raster.test.ts` (a deterministic 6×6 drag journey with a budget of
  0 torn frames, 0 settle frames and ≤ 16 tiles per frame; the old policy tears 12/12 frames).

## Trade-off (read this)
Frames now do more GPU work: the SwiftShader median frame gap went from about 100–300 ms to about 400–590 ms, since
SwiftShader is GPU-bound. Each frame is correct, and nothing waits for a pause in the pointer. On a real GPU a 512 px
tile is cheap. Not measured here: no real GPU.

## Proposal (architectural, not done)
Lift the dragged nodes, and a repeat's instances, into a layer during a move gesture (`TiledRenderer.lift`/`drag`
already exist, S1: 0.85 ms p95). Publish the drag offset in the view frame: `dx`, `dy` and `gestureId` exist but are
always 0 (`canvas-pipeline.ts:329–339`). Drop the layer on commit. A drag then costs no tile raster at all. This
touches the editor ↔ render protocol (D15/B9) and B3's gesture, so it needs a decision.

## Failing or untested
- Run: `pnpm typecheck`, `tsc -b tsconfig.build.json`, vitest (app, render, workers, sequencing, surface: 296 pass),
  `lint:boundaries`, `lint:sf`, `errors:check`, `size`, Studio smoke (colocated PASS, split PASS), `smoke:home` PASS.
  All green.
- Not run: `test:gpu`, a real GPU, the full `pnpm check`.
- Observed, not investigated: in split, Playwright's 16 `mouse.move` calls took 2.0–8.0 s against 0.27–1.3 s
  colocated (main thread slow to take input), with render latency p50 300–700 ms against 46–194 ms.

## Traps
- The machine has 4 cores with a load of about 3. SwiftShader timings vary 2–3× between runs; compare counts, not ms.
- `render_tile` CPU time (≈0.5 ms) hides the GPU cost: frame gaps, not tile ms, show it.
- Not touched: B12's areas (text, page fill stack, `hidden`, crop, group/reorder).
