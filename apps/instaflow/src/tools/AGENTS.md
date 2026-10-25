# apps/instaflow/src/tools — AGENTS.md

**Work package:** Instaflow M1b **B3** (tools; IF-7.2, IF-7.8, IF-24.1–24.27). **Layer:** app.
**Export:** `@instaflow/app/tools` (editor worker; headless — the canvas feeds pointer and key events and draws the overlay).
**Depends on:** `@staticflux/core` (Result, machines, boxes, scopes), `document` (`spatial-index` = A7's rbush index, `v2`
types), `stage` (session layer previews, locks, undo through B1's `commitEdit`), `capabilities` (transform capabilities),
`a11y` (shortcuts), `ui/theme` (theme type), `lit` (label template); B1's `../elements` (geometry queries, hit tests,
actions, components), B0's `../spec` (contribution types and ids), `../render/scene-ir` (overlay scene), `../theme`
(Clean Pop colours). Tests use `fast-check`, B1's test fixtures and the real authoring Wasm (skipped when not built).
**Budget:** `.size-limit.json` (`@instaflow/app/tools`, framework, lit and B1's shared modules excluded).

## Purpose
Everything the pointer and keyboard do on the canvas, as headless services plus B0 contributions: hit testing (rbush
broad phase → exact B1 geometry), select, Shift / Mod multi-select, double click to enter, marquee, round transform
handles (move, resize, rotate), nudge, smart guides and snapping (edges, centres, container, layout grids, equal
spacing with distance labels), and per-tab view state (camera, selection, entered container, tool, hover, overlay).
No screen layout: Studio places the tools from the spec.

## Public API (by file)
- `view-state.ts` — `createViewState({ tab, root, camera?, tool?, viewport? })` → `ViewState` (reactive `camera`,
  `selection`, `context`, `tool`, `hover`, `overlay`, `viewport`; `setCamera`, `panBy`, `zoomBy`, `select`, `toggle`,
  `clear`, `setContext`, `setTool`, `setHover`, `setOverlay`), `createViewStates()` (`open`, `get` IF-TOOL-003, `close`,
  `tabs`); camera maths `toPage`, `toScreen`, `zoomAbout`, `fitCamera`, `stepZoom`, `ZOOM_RANGE`, `ZOOM_STEPS`.
- `hit-test.ts` — `ToolContext`, `createElementIndex(ctx, root, scope?)` → `ElementIndex` (`refresh` re-indexes a changed
  node's subtree and its ancestors, so group bounds stay fresh (B8), `rebuild`,
  `stats`, `dispose`); `hitTest(ctx, index, x, y, { tolerance, context, deep })` → `Hit { leaf, target, kind }`;
  `marqueeSelect(ctx, index, rect, { context, mode: touch | contain })`; brute-force references `hitTestBrute`,
  `marqueeSelectBrute`; `selectionTarget`, `isHittableLeaf`, `canvasSelectable`, `paintOrder`, `comparePaintOrder`,
  `elementsInPaintOrder`, `selectionBounds`, `rectFrom`.
- `snapping.ts` — `collectSnapTargets(ctx, { moving, container?, grids?, extra? })` → `SnapTargets`;
  `snapBox(box, targets, { threshold, features?, spacing?, kinds? })` → `SnapResult { dx, dy, guides, labels }`;
  `snapPoint`, `shiftBox`, `formatDistance`, `SNAP_THRESHOLD_PX`, `SNAP_LINE_KINDS`, `Guide`, `GuideLabel`.
- `transform.ts` — `selectionFrame`, `transformHandles(frame, zoom)`, `pickHandle`, `HANDLE_DIRECTIONS`,
  `HANDLE_SIZES`; `captureTransform(ctx, nodes)` (IF-TOOL-002) → `TransformStart`; `moveValues`, `resizeValues`,
  `resizedBounds`, `fixedFraction`, `resizeByValues`, `rotateValues`, `snapRotation`, `angleAbout`, `normalizeDegrees`,
  `axisAligned`, `valuesToOps`, `boundsAfter`.
- `overlay.ts` — `ToolOverlay`, `EMPTY_OVERLAY`, `overlayColors(theme)`, `toolOverlayBatch(overlay, zoom, { firstId, clear, ids })`
  (`clear: false` + `ids` write into a shared scene, B8; non-printing
  scene IR), `guideLabelTemplate(labels, camera)` (`<sf-tag mono>` distance labels).
- `gesture.ts` — `ToolSession` (ctx, B1 `EditTarget`, session layer, index, view, actor), `createToolController(session)`
  → `pointer(event)`, `wheel(event)`, `cancel()`, reactive `state`; machine `ToolGestureLifecycle`
  (`instaflow/tool-gesture`, LIFECYCLES §25); tables `PRESS_GESTURES`, `GESTURES`, `TOOL_BEHAVIOURS`, `POINTER`;
  `refreshOverlay`, `pruneSelection`, `selectionBox`.
- `keyboard.ts` — `createToolCommands(session)` → `ToolCommands` (arrow, nudge, pan, resizeBy, rotateBy, selectSibling,
  selectAll, enter, selectParent, escape, zoomStep, zoomTo, fitAll, fitSelection); `TOOL_KEYMAP`, `ARROW_ACTIONS`,
  `CanvasToolsShortcutScope` (child of Studio's scope), `bindToolShortcuts(registry, commands, scope, onOutcome)`.
- `contributions.ts` — `selectTool` / `handTool` (B0 ids `instaflow/select`, `instaflow/hand`), `toolContributions`,
  capabilities `instaflow/move-by`, `resize-by`, `rotate-by`, `rotate-90-cw`, `rotate-90-ccw` (`toolCapabilities`,
  `toolCapabilityImplementations(env)`), `toolHudActions`, `runTransform`, `toolContributionUnits(env)`.
- `errors.ts` — `IF-TOOL-001` gesture order · `002` nothing to transform (empty or position-locked) · `003` view state
  out of range / unknown tab · `004` every gesture target was deleted.
- `testing/` (test-only) — `createToolFixture(ops)` (B1 page + kit + stage with the session layer, real Wasm, index,
  view state, `ToolSession`).

## Wiring (editor worker, per tab)
```ts
const session = createSessionLayer();
const stage = createStage({ root: page, session, assets, rules: elementStageRules(kitRef) });
const ctx = { stage, geometry, kit };
const index = createElementIndex(ctx, pageId, tabScope);
const view = viewStates.open({ tab, root: pageId });
const tools: ToolSession = { ctx, target: { undo, stage, part: pageId }, session, index, view, actor: () => person };
const controller = createToolController(tools);           // pointer events in canvas pixels
const commands = createToolCommands(tools);               // keyboard paths
bindToolShortcuts(registry, commands, tabScope);           // canvas focus: registry.activate(CanvasToolsShortcutScope, focusScope)
// draw: toolOverlayBatch(view.overlay, view.camera.zoom) into the overlay scene (never exported)
```

## Rules
- One gesture = one change set = one undo step: previews go to the **session layer** only, commits through B1's
  `commitEdit`. Never write the part directly, never commit per pointer move.
- Position-locked elements never move; fully locked ones (position and content) are not selectable on the canvas.
- No branch on lens, mode or flags: gestures come from `PRESS_GESTURES`, behaviours from `TOOL_BEHAVIOURS`, arrow keys from
  `ARROW_ACTIONS`. A new tool adds rows, not `if`s.
- Align, centre in container and distribute are B1's capabilities; do not re-implement them here.
- View state never enters the CRDT or the store (IF-7.2). Overlay colours come from the theme; labels are kit tags.
- `hitTest` and `marqueeSelect` must agree with their brute-force references (parity properties in the tests).

## Test
`npx vitest run apps/instaflow/src/tools` (needs `pnpm build` for the Wasm-backed suites): view state and camera maths,
snapping unit cases plus fast-check properties (within threshold, stable), hit-test and marquee parity with brute force
(fast-check on random nested scenes), transforms on rotated and nested elements, the gesture controller (preview, one
undo step, guides, cancel, handles, marquee, hand, locks, vanished targets), keyboard paths through the real shortcut
registry, overlay encoding and the contributions with the Studio registries.
