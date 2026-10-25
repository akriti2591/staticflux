# apps/instaflow/src/lenses — AGENTS.md

**Work package:** Instaflow M1b **B4 Library and lenses** (lens half; IF-1.3, D4, D19, IF-23.15–23.22). **Layer:** app.
**Entry points:** `@instaflow/app/lenses` (headless: structure, features, controller, story edits; editor worker or main
thread) and `@instaflow/app/lenses/ui` (the Pages panel and its contribution; main thread only).
**Depends on:** `@staticflux/document/v2` (the composition's root part, commits), `@staticflux/stage` (actors),
`@staticflux/a11y` (shortcuts), `src/spec` (B0: `StudioIds`, panel contributions), `src/theme` (lens palette),
`@staticflux/kit` + `@staticflux/ui` + `@staticflux/i18n` (UI). Tests also use `@staticflux/document/loro-crdt`, `@staticflux/testkit/a11y`.
**Budgets:** headless 5 KB, UI 3.5 KB brotli (framework, lit and kit excluded; `.size-limit.json`).

## Purpose
Pages and Canvas are **per-mode features over one document tree** (IF-1.3: never a document type, never an `if` on mode).
A lens's behaviour is a `LensFeature` (`arrange`, `focus`, `overview`) looked up by lens id; its chrome (tools, HUD, extra
panels) is data in B0's variant tables (`STUDIO_LENS_TOOLS`, `STUDIO_LENS_HUD`, `STUDIO_LENS_PANELS`). The Pages **lens
contribution** itself sits with Studio's lenses (`studioLenses`, `StudioIds.lens.pages`, Layout palette, shortcut `5`).

## Public API (by file)
- `structure.ts` — `readCompositionStructure(part, composition?)` → `CompositionStructure { composition, format, pages
  (story order: size, canvas?, name?), loose }` (IF-LIB-010), `structureFeed(part)`, `STRUCTURE_PATHS` (the one place the
  DOCUMENT-FORMAT §3.2 paths live), `DEFAULT_PAGE_SIZE`, `COMPOSITION_KIND`, `PAGE_KIND`, `Rect`, `PageStub`, `LooseElement`.
- `lens-feature.ts` — `LensFeature`, `LensArrangement` (frames in navigation order, loose, bounds), `PageFrame`, `Camera`,
  `Viewport`; `fitCamera`, `fitsAt`, `unionRects`, `frameOf`, `stepFrame`, `frameAtPoint`, `FIT_PADDING`, `MIN_ZOOM`, `MAX_ZOOM`.
- `pages-lens.ts` — `pagesLensFeature` (story column, `PAGES_GAP`); `canvas-lens.ts` — `canvasLensFeature` (canvas
  positions, auto-placement, `CANVAS_GAP`), `readingOrder(frames)`.
- `lens-features.ts` — `LensFeaturesToken` (multi), `lensFeatureContribution(feature)`, `createLensFeatureRegistry(features,
  fallback = Canvas)` (IF-LIB-012).
- `controller.ts` — `createLensController({ features, lens, structure, viewport, camera })` → `arrangement()`, `error()`,
  `current()`, `camera()`, `goTo`, `step`, `first`, `last`, `overview`, `dispose`; `CameraPort`, `LensShortcuts` (data),
  `bindLensShortcuts(registry, controller, { scope, shortcutScope })`.
- `story.ts` — `createStoryWriter({ doc, structure, actor })` → `movePage(page, to)`; `storyMoveOp` (pure; IF-LIB-013).
- `tokens.ts` — `LensContext(Token)`, `LensFeatureRegistryToken`, `LensServices(Token)`, `LensControllerToken`,
  `StoryWriterToken`. `units.ts` — `createLensServices`, `lensFeatureRegistryUnit` (app), `lensServicesUnit` (feature),
  `lensControllerUnit`, `storyWriterUnit`, `lensFeatureUnits` (Pages + Canvas), `lensUnits`.
- UI (`ui.ts`): `pages-panel.ts` — `<if-pages-panel>` (`definePagesPanel`, `storyFrames`, `pageNodes`, `reorderTarget`);
  `contributions.ts` — `pagesPanel` (B0 `PanelContribution`, id `instaflow/pages`), `lensContributionUnits`; `messages.ts` —
  `lensMessages` (`instaflow-lenses`), `lensText`.
- `errors.ts` — `IF-LIB-010` no composition · `011` unknown page · `012` lens feature registry · `013` story move.

## Wiring (the editor provides the context in the open document's scope)
```ts
provide(LensContextToken, { doc, root: await doc.part('root', signal), lens: () => studio.lens?.id, viewport, camera, actor });
compose([...lensUnits, ...lensContributionUnits]);              // drop B0's `instaflow/pages` placeholder
bindLensShortcuts(shortcuts, controller, { scope, shortcutScope: StudioShortcutScope });
```

## Rules
- No branch on lens anywhere: add a lens by contributing a `LensFeature` (and B0 table rows), never by editing the controller.
- The camera belongs to the canvas (A7 view state); lenses only ask `CameraPort.show(camera, reason)`.
- Read the root part only (page stubs); page parts load lazily elsewhere (D14).
- UI from `@staticflux/kit` only, Clean Pop tokens only; the lens mark from `src/theme/lenses.ts`.
- Out of scope: page thumbnails in the filmstrip (follow-up with the A7 projection), placing pages by drag on the canvas (B3).

## Test
`npx vitest run apps/instaflow/src/lenses` (structure on Loro, both features and the reading order, the registry and
fallback, the controller under lens switches and remote edits, shortcuts, story moves, `<if-pages-panel>` keyboard paths +
a11y audit, units, the contribution against Studio's spec).
