# apps/instaflow/src/app — AGENTS.md

**Work package:** Instaflow M1b **B8** (Studio integration, the M1b demo; IF-27.1–27.25, LIFECYCLES §29, `IF-INT-001…005`),
reshaped by M1c **B9** (editor in the worker; IF-33.x, LIFECYCLES §35): the files below are either **main-side** adapters or
**editor-side** pieces the worker (`../workers`) runs.
**Layer:** app (the composition root; not a package export: the dev entry imports it from source).
**Depends on:** every M1b folder (`spec`, `studio`, `elements`, `repeat`, `text`, `tools`, `a11y`, `lenses`, `library`,
`versioning`, `sequencing`, `render`, `theme`), `../workers`, and the framework packages they use; `lit` (`ref`, main side
only), `@staticflux/gate`. Tests use B1's and B2's Node fixtures (real authoring Wasm, skipped when not built) and `happy-dom`.
**Budget:** none yet (no export); Home's budget landed with C0 (`@instaflow/app/home`), Studio's app build budget lands with C4.

## Purpose
Wire, don't rebuild: the glue that turns M1b's headless services and contributions into the Studio a person can click
through. Feature behaviour stays in its folder; this folder composes, binds and routes.

## Public API (by file)
Editor side (imported by the worker; DOM-free, Lit-free):
- `canvas-pipeline.ts` — **scene records** (`encodeSceneRecord` / `decodeSceneRecord`, format 2: resources, assets, image table,
  projection, text IR, overlay batches), `ImageBinding`, `ElementSceneDeltas`, `createElementSceneSide()` (render side: scene
  adapter, resources, `images` lookup, queued IR), `createCanvasPublisher` (attachable per page: records first, then the
  view frame with the consumed input), `createCanvasPipes({ medium })` (editor side of the pipes), `attachCanvasRender`
  (render side; machine `CanvasPipelineLifecycle`, `instaflow/canvas-pipeline`), `SceneIrSource`, `canvasPipeTransfer`.
- `element-port.ts` — `CanvasRaster`, `createElementRenderPort` (images resolve through the scene side by default),
  `createRecordingRaster` (tests, headless).
- `vello-raster.ts` — `createVelloRaster` (render worker: A6 backend + tiled renderer + GPU device on the transferred
  `OffscreenCanvas`; worker rAF frames), `rasterCamera`.
- `document.ts` — `openStudioWorkspace` (store side: repo, Loro with `TEXT_MARK_EXPAND`, blobs, library document),
  `createStudioDocument`, **`openStudioDocument`** (one stage, session layer, undo service and B7 repeat view over every page
  part), `freshPeer`, `STUDIO_BRAND`.
- `fonts.ts` — `createStudioFonts`, `STUDIO_SCRIPT_FALLBACKS`, `STUDIO_TEXT_DEFAULTS`.
- `text-layer.ts` — `createTextLayer`, `textBoxOps`, `StudioFonts`.
- `text-editing.ts` — `startTextEditing` over a **`TextHostPort`** (`open`, `place`, `close`; rects in surface px),
  `textToSurface`, `TextExitReason`.
- `creation.ts` — `CREATION_TOOLS`, `createCreationController`, `dragBox`, machine `CreateGestureLifecycle`.
- `images.ts` — `createImageUploads` (asset section + image table), `placeImageOps`.
- `canvas-tab.ts` — **`openCanvasTab`** (per tab and page, in the editor: B3 view/index/tool session/controller/commands,
  shortcuts on the editor's registry, the overlay as the record's overlay section, creation, text layer and editing over
  the host port, B6's editor side with snapshots out, labels out; Undo/Redo/Delete/Duplicate; B10a: the tab's transform
  session, its shortcut scope while active, Undo cancels a session), `OVERLAY_FIRST_ID`,
  `DUPLICATE_OFFSET`.
- `canvas-shortcuts.ts` — `canvasShortcutDefs()` (B3's keymap + Undo, Redo, Delete, Duplicate as data), the four defs.

Main side:
- `studio-canvas.ts` — **`studioCanvas`** (B0 `CanvasPort` over the workers: canvas hand-off, input forwarder into the ring with
  text-host events filtered, pointer capture and focus, canvas shortcuts registered with no-op handlers and the canvas scope
  on focus, `mountCanvasA11y` for snapshots, the text host bridge, labels, resize / DPR / visibility to both modules,
  `showPage`), `offscreenHandoff`, `CanvasHandoffFactory`.
- `panel-mirrors.ts` — panel models over the editor's mirrors: `appearanceSource`, `repeatSource`, `transformSource` (B10a), `typographyFromMirror`,
  `milestonesFromMirror`, `latestFromMirror`, `structureFromMirror`, `storyFromMirror`.
- `registries.ts` — `replaceById`, `studioContributions(bindPanel)`, `studioAppRegistries`.
- `studio-app.ts` — **`createStudioApp`** (boots the workers, store side on main, mirrors and panel services in the UI
  injector, the capability registry with forwarding implementations, Studio controller, canvas, scope-follows-selection,
  lens controller over the mirrored structure, HUD dispatch, `createMilestone`, `place`, `inspect`, `element`, `metrics`,
  `mount(container)`, `spoken`, `view`, `tab`; C0: `library`, `flush()` (Latest durable), `leave(href)` (the Home link: flush, then
  `options.leave`), `saveAsTemplate(title?)` (`instaflow/save-as-template` on main over `options.templates`), `homeHref`).
- `errors.ts` — `IF-INT-001` pipeline start · `002` scene record · `003` no open page · `004` canvas backend · `005` document.
- `feedback.ts` (B11a2, main side) — `feedbackFor(error, origin, copy?)` (level by origin refined by `FAMILY_LEVELS`; Instaflow words per error
  definition; never the code), `ToastsToken` / `createToasts(manager, owner)` (`show`, `undoable` → `Restored`, `error`, `undoNewest` for Home's
  `Mod+Z`), `INSTAFLOW_SURFACE_UNITS` (messaging under `strictSurfacePolicy`). B11b binds the units and the token.
- `test-helpers.ts` (test-only) — `createStudioFixture`, `scriptedTextInput`, `lendDom`, `manualTimers`.

## Rules
- No feature logic here: if a fix belongs to a feature, make it there (and note it in the handoff).
- Editor-side files never touch the DOM or import Lit (the worker loads them; `../workers/worker-imports.test.ts`).
- Resources, uploads and the image table go ahead of the projection in the same record; the overlay goes in the same record
  as the content it frames, last. Never send them on a side channel.
- What a tool, HUD action or panel binding does is a table row (`CREATION_TOOLS`, `HUD_INPUTS`, `BINDERS`), never a branch.
- Everything is disposed with its scope (app scope, tab scope); DOM listeners take the scope's signal.

## Try it / test
`pnpm build` once (Wasm), then `pnpm --filter @instaflow/app dev` and open http://localhost:5174/dev/studio/ in Chrome
(`?topology=split` for two workers). `pnpm vitest run apps/instaflow/src/app apps/instaflow/src/workers` (pipeline, tab,
mirrors, the composition end to end over in-process workers in both topologies) ·
`NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke` (Playwright, WebGPU on SwiftShader, both
topologies).
