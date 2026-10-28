# apps/instaflow/src/elements — AGENTS.md

**Work package:** Instaflow M1b **B1** (elements and styles; IF-4.6–4.7, IF-7.8–7.10, IF-20.1–20.24). **Layer:** app.
**Exports:** `@instaflow/app/elements` (editor and render workers, plus contributions) and `@instaflow/app/elements/panel`
(the inspector element, main thread).
**Depends on:** `@staticflux/core`, `document` (`v2`, `render-projection`, `spatial-index` types), `stage` (composition,
locks, undo guard), `capabilities` (one capability per action), `ui/theme` (`parseColor`, tokens), `kit` (panel only),
`lit`; B0's `../spec` (contribution types and ids); `../render/scene-ir` (A6 wire format). Tests also use `loro-crdt`,
`@staticflux/testkit/a11y`, `@staticflux/ui/testing`, the theme, and the real authoring Wasm (skipped when not built).
**Budgets:** `.size-limit.json` (elements entry, panel entry); authoring Wasm ≤ 350 KB brotli (measured 119.1 KB).

## Purpose
Everything a design element is and does, as headless services plus B0 contributions: the document components, brand kits
and style classes, geometry (Rust), page-space queries for tools, actions (align, distribute, tidy, booleans, flatten,
outline stroke, masks, tokens, duplicate with match keys), the render projection to the scene IR, and the Fill / Stroke /
Effects inspector.

## Public API (by file)
- `components.ts` — v2 components `Spatial` (B10a added `skewX`, degrees; additive, no version bump), `Geometry`, `Style` (v2, migration from the DOCUMENT-FORMAT draft), `Frame`,
  `ImageFit` (`image`), `Source`, `Mask`, `Lineage` (match key), `Lock`, `Policy`, `Layout` (grids), `Brand`;
  `ELEMENT_COMPONENTS`, `ELEMENT_KINDS`, `ELEMENT_KIND_COMPONENTS`, `ELEMENT_COMMON_COMPONENTS` (B2 reuses), `ELEMENT_ROLES`,
  `createElementRegistry({ components, kinds, roles, version })`, paths `P`, `CORNER_PATHS`, `tokenPath`, enums
  (`BLEND_MODE_NAMES`, `SHAPES`, `BOOLEAN_OPS`, `STROKE_*`, `EFFECT_KINDS`, `IMAGE_FIT_NAMES`, `MASK_MODE_NAMES`, …).
- `values.ts` — value shapes (`PaintValue`, `FillValue`, `StrokeValue`, `EffectValue`, `LayoutGridValue`, `SizeValue`) and
  checks (`is*`, `checkElementValue`, `validateElementOps` → IF-EL-001), `tokenName`, `colorToRgba`, `rgbaToHex`.
- `brand-kit.ts` — `brandKitOps(spec)`, `readBrandKit(doc)` → `BrandKitView` (tokens with aliases, classes, rules),
  `brandTokenRule(kit)`, `elementStageRules(kit)` (pass to `createStage`), `resolveTokens`, `tokenType`, `checkToken`
  (IF-EL-002), brand rules (`BrandRule`, `brandViolations`, `checkBrandRules` IF-EL-003, `brandRuleGuard`, `composeGuards`,
  `lintBrandRules`, `ruleValue`, `stageRuleContext`).
- `styles.ts` — `applyClassOps`, `overridesOf` (local vs class, from provenance), `resetOverrideOps`, `detachClassOps`,
  `styleSource`.
- `resolve.ts` — `resolveElement` / `resolveComposed` → `ResolvedElement` (box, transform, geometry, fill/stroke stacks,
  effects with glows as shadows, mask, match key, issues), `boxTransform`, `readBox`, `fitRadii`, `fitBox` (the box that
  hugs a local rectangle without moving it, #54 #66), affine helpers.
- `geometry.ts` — `GeometryWasm` (ABI), `loadAuthoringModule` (manifest; IF-EL-006), `createGeometry` → `GeometryService`
  (`outline`, `boolean`, `outlineStroke`, `bounds`, `inkBounds`, `hit`, `intersects`, `transform`, `parsePath`, `toSvg`;
  IF-EL-005), `strokeSpec`, `effectSpec`, `GEOMETRY_VERSION`. #68: `outline`, `boolean` and `outlineStroke` are memoized by
  their inputs (`GEOMETRY_MEMO_LIMIT` entries each, least recently used out; numbers keyed by `keyNumber`; operand paths by
  identity), so transform-only changes (drag, rotate) never re-run them. Paths are values: never mutate one.
- `layout.ts` — `ElementContext`; `elementBounds` (geometry, ink, centre, transform), `pageTransform`, `localOutline`
  (booleans derived; a plain group is the union of its children, so groups and B7 repeat instances can be boolean operands
  and clip masks), `strokeRing`, `maskOf`, `containerBounds` / `containerOf`, `siblingBounds`, `hitElement` (fills, images, frames,
  booleans and text are hit across their area — text since B9, so a double click inside text edits it),
  `gridLines`, `containerGrids`, box helpers; `boundsIn(ctx, node, transform)` (outline bounds in any space; a group's
  local box of content, #66).
- `actions.ts` — `align` (edges × selection | container | page | key), `centerInContainer`, `distribute` (spacing |
  centers), `tidyUp`, `booleanGroup`, `setBooleanOp`, `releaseBoolean`, `flatten` and `outlineStroke` (the vector's box
  hugs its path, nothing moves, #54), `useAsMask`, `setMask`,
  `releaseMask`, `applyToken` (`TOKEN_TARGETS`), `duplicate` (match keys; copies rich texts when `ActionContext.texts` is
  given, B8), `localValues`, **`commitEdit`** (one change set).
- `projection.ts` — `ElementProjection`, `createElementRenderSource` (stage-backed `RenderProjectionSource`), resources
  (`createResourceTable`, `Look`, `lookOf`), `RENDER_FLAGS`, `MASK_INVERT_BIT`.
- `scene.ts` — `createSceneResources`, `createElementSceneEncoder` (diffing; `sceneIdOf`), `lumaToAlpha`,
  `gridOverlayBatch` (non-printing overlay).
- `inspector.ts` — `appearanceModel`, `AppearanceEdit`, `appearanceEditOps`, `NEW_ITEMS`, `swatchOf`.
- `capabilities.ts` — `ELEMENT_ACTIONS`, `elementCapabilities`, `elementCapabilityImplementations(env)`, `runElementAction`,
  `selectionFacts`, `elementActionId` (Lit-free: the editor worker imports it, B9).
- `contributions.ts` — re-exports `capabilities.ts`; `elementHudActions`, `appearancePanel` (`instaflow/appearance`),
  `elementContributionUnits(env)`.
- `panel.ts` (entry `elements/panel`) — `<if-paint-inspector>` (`IfPaintInspectorElement`), `definePaintInspector`,
  `bindPaintInspector(element, source)`, `APPEARANCE_EDIT_EVENT`.
- `errors.ts` — `IF-EL-001` … `IF-EL-007`.
- `testing/` (test-only) — `fixtures.ts` (page + brand kit + stage + undo service, real Wasm in Node; `loadAuthoringWasm`,
  `countingWasm` counts calls per Wasm export), `scene-fixture.ts`.

## Wiring (editor worker)
```ts
const stage = createStage({ root: pageDoc, session, assets, rules: elementStageRules(kitRef) });
const undo = createUndoService({ doc, guard: composeGuards(stageWriteGuard(stage), brandRuleGuard(() => stageRuleContext(stage, kit))) });
const geometry = createGeometry(unwrap(await loadAuthoringModule({ manifestUrl })));
const source = createElementRenderSource({ stage, geometry, kit, root: pageId, orderOf: (id) => part.node(id)?.order });
const projector = createRenderProjector(ElementProjection, source);
// per step: resources first, then the delta (same ordered channel)
send(source.takeResources()); send(projector.project(source.changes()));
// render worker: resources.apply(batch); store.apply(payload); renderer.apply(encoder.encode(store, resources));
```

**B12 (engine gaps for B11b; IF-37.1–37.11):** `actions.ts` adds `group`, `ungroup` (groups and frames; releases masks
inside), `frameSelection` (exact union, optional padding, clip on, no fill), `reorder` / `reorderedChildren` (`forward` ·
`backward` · `front` · `back`), `rename` (IF-FIX-001), `setHidden` / `showAll`, `cropImage` / `imageFillIndex`; each is a
capability (`instaflow/group`, `ungroup`, `frame-selection`, `bring-forward`, `send-backward`, `bring-to-front`,
`send-to-back`, `rename`, `hide`, `show-all`, `image-crop`, `image-crop-reset`) whose output may name `select`.
`components.ts`: `spatial.hidden` (`P.hidden`); `layout.ts`: `isHidden`, hidden children leave group bounds, hits, guides and
masks; `projection.ts`: hidden subtrees are not projected (B12b: `text` is a projection kind, drawn as a group the text layer
fills with glyphs; projection version 2), `pageFill: true` projects the page's `style.fills` as the first
node (`pageFillId`, `pageBox`, `PAGE_FILL_DEFAULT` / `pageFills` from `values.ts`); `inspector.ts`: `pageAppearanceModel`;
`values.ts` / `resolve.ts` / `scene.ts`: image paints carry `offset`, `scale`, `rotation` (`cropOf`, `ResolvedCrop`) and
encode as the scene IR's `IMAGE_CROP` paint.

## Rules
- Document values are data: no functions, tokens are `@name` strings, stacks are lists with stable item `id`s.
- Booleans and masks are derived: never write a boolean result or a masked copy into the document.
- Every action goes through `commitEdit` (or the capability) as one change set; never `part.transact` directly.
- Resources go down the channel before the delta that uses them. The scene IR is A6's wire format: change `ir.rs` and
  `scene-ir.ts` together and keep both byte-identity tests green.
- No `if` on lens or mode: applicability is the contribution's `lenses` / `scopes` plus input validation (IF-EL-004).
- Panel UI only from kit components under the theme; no colours in code.

## Test
`npx vitest run apps/instaflow/src/elements` (needs `pnpm build` for the Wasm-backed suites) ·
`cargo test -p authoring` and `cargo test -p render` in `apps/instaflow/engine` (booleans property tests, element scene vs
its vello_cpu reference) · `SF_GPU=1 pnpm test:gpu` (GPU vs CPU and goldens incl. `render-gpu-element-scene`).
Update the projection snapshot with `SF_UPDATE_GOLDENS=1 npx vitest run apps/instaflow/src/elements/projection.test.ts`,
then `SF_UPDATE_GOLDENS=1 cargo test -p render fixtures` for its CPU reference.
