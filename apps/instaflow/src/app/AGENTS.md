# apps/instaflow/src/app — AGENTS.md

**Work package:** Instaflow M1b **B8** (Studio integration, the M1b demo; IF-27.1–27.25, LIFECYCLES §29, `IF-INT-001…005`).
**Layer:** app (the composition root; not a package export: the dev entry imports it from source).
**Depends on:** every M1b folder (`spec`, `studio`, `elements`, `repeat`, `text`, `tools`, `a11y`, `lenses`, `library`,
`versioning`, `sequencing`, `render`, `theme`) and the framework packages they use; `lit` (`ref`), `@staticflux/gate`.
Tests use B1's and B2's Node fixtures (real authoring Wasm, skipped when not built) and `happy-dom`.
**Budget:** none yet (no export); the app build budget lands with C0/C4.

## Purpose
Wire, don't rebuild: the glue that turns M1b's headless services and contributions into the Studio a person can click
through. Feature behaviour stays in its folder; this folder composes, binds and routes.

## Public API (by file)
- `canvas-pipeline.ts` — **scene records** (`encodeSceneRecord` / `decodeSceneRecord`: resources, assets, projection, IR in
  that order), `ElementSceneDeltas`, `createElementSceneSide()` (the render module's scene adapter + render-side resources),
  `createCanvasPublisher` (editor side: records first, then the view frame), **`startCanvasPipeline`** (local medium, A7's
  render module), `SceneIrSource`, machine `CanvasPipelineLifecycle` (`instaflow/canvas-pipeline`).
- `element-port.ts` — `CanvasRaster` (apply IR, camera, present, resize), `createElementRenderPort` (A7 `RenderPort` over
  B1's scene encoder), `createRecordingRaster` (tests, headless).
- `vello-raster.ts` — `createVelloRaster` (browser: A6 backend + tiled renderer + GPU device; rAF frames), `rasterCamera`.
- `document.ts` — `openStudioWorkspace` (repo, Loro with `TEXT_MARK_EXPAND`, blobs, library document),
  `createStudioDocument` (root part + one part per page, D14), **`openStudioDocument`** (one stage, session layer, undo
  service and B7 repeat view over every page part; `target`, `context` with the rich-text reader, `commitOps`), `STUDIO_BRAND`.
- `fonts.ts` — `createStudioFonts` (engine, fallbacks, defaults), `STUDIO_SCRIPT_FALLBACKS`, `STUDIO_TEXT_DEFAULTS`.
- `text-layer.ts` — `createTextLayer` (B2 layout + glyph IR per text element, dirty by invalidation), `textBoxOps`,
  `StudioFonts`.
- `text-editing.ts` — `startTextEditing` (TextInput host over the text box, B2 session, one change set per keystroke),
  `textToClient`.
- `creation.ts` — `CREATION_TOOLS` (Shape, Frame, Text rows), `createCreationController`, `dragBox`, machine
  `CreateGestureLifecycle` (`instaflow/create-gesture`).
- `images.ts` — `createImageUploads` (decode once, upload on the asset section, `images` lookup), `placeImageOps`.
- `canvas-tab.ts` — **`openCanvasTab`** (per tab and page: B3 view/index/tool session/controller/commands/shortcuts, overlay,
  creation, text layer and editing, B6 `createCanvasA11y`, the pipeline; Undo/Redo/Delete/Duplicate), `OVERLAY_FIRST_ID`,
  `DUPLICATE_OFFSET`.
- `studio-canvas.ts` — **`studioCanvas`** (B0 `CanvasPort`: canvas + label layer in the surface, DOM input → tab, resize,
  `showPage`), `RasterFactory`.
- `registries.ts` — `replaceById`, `studioContributions(bindPanel)`, `studioAppRegistries`.
- `studio-app.ts` — **`createStudioApp`** (panel services in the UI injector, capability registry, Studio controller, canvas,
  scope-follows-selection, HUD dispatch `runHudAction`, `createMilestone`, `place`, `mount(container)`, `spoken`).
- `errors.ts` — `IF-INT-001` pipeline start · `002` scene record · `003` no open page · `004` canvas backend · `005` document.
- `test-helpers.ts` (test-only) — `createStudioFixture`, `scriptedTextInput`, `lendDom`, `manualTimers`.

## Rules
- No feature logic here: if a fix belongs to a feature, make it there (and note it in the handoff).
- Resources and uploads go ahead of the projection in the same record; never send them on a side channel.
- What a tool, HUD action or panel binding does is a table row (`CREATION_TOOLS`, `HUD_INPUTS`, `BINDERS`), never a branch.
- Everything is disposed with its scope (app scope, tab scope); DOM listeners take the scope's signal.

## Try it / test
`pnpm build` once (Wasm), then `pnpm --filter @instaflow/app dev` and open http://localhost:5174/dev/studio/ in Chrome.
`pnpm vitest run apps/instaflow/src/app` (pipeline, tab, registries, the composition end to end in Node) ·
`NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke` (Playwright, WebGPU on SwiftShader).
