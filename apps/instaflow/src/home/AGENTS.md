# apps/instaflow/src/home — AGENTS.md

**Work package:** Instaflow M1c **C0 Home route** (D17, D18; IF-28.4–28.25, LIFECYCLES §30, `IF-HOME-001…007`); **B11b/B11c** Home, New
design, files, projects, trash, import, first run (IF-36.35–36.40, LIFECYCLES §38, `IF-POL-054…058`). **Layer:** app.
**Entry point:** `@instaflow/app/home` (`dist/home/index.js`; the dev page `dev/home/main.ts`; the dev server maps `/`, `/files`, `/p/:name`,
`/templates`, `/trash` to it).
**Depends on:** `@staticflux/core`, `@staticflux/ui` (+ `/theme`), `@staticflux/kit` (button, card, tag, icon, icon-button, menu, popover,
inline-edit, confirm-row, feedback, segmented, text-field, size-field, number-field, color-field, disclosure, surfaces), `@staticflux/messaging`
(toasts), `@staticflux/i18n`, `@staticflux/capabilities`, `@staticflux/router` (route table only), `@staticflux/loader` (boot plan data),
`@staticflux/document/v2` (heads, `HeadConflictError`), `@staticflux/blob` (import and previews, loaded on first use), `../workspace/browser.ts`
+ `document-store.ts` + `blobs.ts`, `../library` (`kinds`, `library-doc`, `records`, `errors`), `../app/feedback.ts` (toasts), `../theme`.
**Never** the editor, render, Loro, worker, Wasm or GPU code (D17; `home-imports.test.ts` fails the build otherwise).
**Budgets:** Home's whole boot 111 KB, Home's own code 34 KB brotli (`.size-limit.json`, "@instaflow/app/home"; raised by B11c with reasons).

## Purpose
The light surface a person lands on and manages files from: New design, recents, templates, projects, Files, the trash, import. It reads
the **Home index** (a projection of the library kept in the library head by Studio's store side, `../workspace`) with **Home's journal**
applied on top, writes file operations to that journal (Studio applies them to the library), and links into Studio; everything it does is a
capability, so agents can do it too.

## Public API (by file)
- `index-record.ts` — `HomeIndex` (`instaflow.home-index/1`, `projects?`), `HomeEntry` (B11c: `folder`, `favorite`, `trashedAt`, `pages`,
  `digest`), `HomeProject`, `ProjectSummary`, `DesignSize`, `HOME_INDEX_APP_KEY` (`home`), `readHomeIndex` (tolerant), `readHomeEntry`,
  `readHomeProjects`, `withHomeIndex`, `sameHomeIndex`, `byEdited`, `recentDesigns`, `workspaceFiles`, `workspaceTemplates` (live only),
  `trashedFiles`, `workspaceProjects`.
- `journal.ts` — the Home journal: `HOME_JOURNAL_ASSET` (`home-journal`), `HOME_JOURNAL_CHANNEL`, `HomeOp` / `HomeOpBody` (rename, move,
  favorite, trash, restore, purge, duplicate, import, project-add / -rename / -remove), `ImportedMedia`, `homeOp`, `homeOpId`,
  `readHomeOp`, `readHomeJournal`, `journalHead`, `overlayJournal` (pure, idempotent), `updateHomeJournal` / `appendHomeOps` /
  `removeHomeOps` (CAS, IF-POL-055).
- `formats.ts` — `DESIGN_FORMAT_IDS`, `DESIGN_FORMATS`, `DEFAULT_DESIGN_FORMAT`, `CUSTOM_FORMAT`, `NEW_DESIGN_FORMAT_IDS`, `NEW_DESIGN_CHIPS`,
  `DESIGN_SIZE_LIMITS` (1…16 384), `DESIGN_PAGE_LIMITS`, `designFormat`, `designFormats`, `formatOfSize`, `aspectOf`, `groupDigits`.
- `size-presets.ts` — `SIZE_PRESET_GROUPS` (social, print, screen), `sizePreset`.
- `routes.ts` — `homeRoute` (`/`), `studioRoute` (`/s/:asset`), `newDesignRoute` (`/new?format|template|w|h|unit|pages|name|bg`), B11c
  `filesRoute` (`/files?q|filter|sort|view`), `projectRoute` (`/p/:name`), `templatesRoute`, `trashRoute`, `instaflowRoutes()`, `homeHref`,
  `studioHref`, `newDesignHref`, `HomeView`, `homeViewHref`, `readHomeView`, `FILES_FILTERS` / `FILES_SORTS` / `FILES_LAYOUTS`,
  `DESIGN_UNITS`, `readStudioIntent` → `StudioIntent` (`open | new | demo`).
- `capabilities.ts` — `NewDesignCapability` (formats or `custom` W × H), `OpenDesignCapability`, `UseTemplateCapability`, B11c
  `RenameDesignCapability`, `DuplicateDesignCapability`, `MoveToProjectCapability`, `FavoriteCapability`, `TrashDesignsCapability`,
  `RestoreDesignsCapability`, `DeleteForeverCapability`, `NewProjectCapability`, `RenameProjectCapability`, `DeleteProjectCapability`,
  `SearchFilesCapability`; `HOME_FILE_CAPABILITIES`, `HOME_CAPABILITIES`, `HomeQuickAction`, `HOME_QUICK_ACTIONS`.
- `model.ts` — `createHomeModel({ source, host, signal, journal?, importer?, view?, now?, newAssetId?, capabilities? })` → `HomeModel` (`state`,
  `error`, `index`, `view`, `recents()`, `files()`, `templates()`, `projects()`, `trashed()`, `entry`, `search`, `go`, `show`, `newDesign`, `open`,
  `useTemplate`, `runQuickAction`, `rename`, `duplicate`, `move`, `favorite`, `trash`, `restore`, `deleteForever`, `newProject`, `renameProject`,
  `deleteProject`, `importFiles`, `dispose`); `HomeMachine` (`instaflow/home`), `storeIndexSource(store)` (index + journal),
  `storeJournalWriter(store, ping?)`, `HomeHost` (`navigate`, `push?`), `HomeImporter`, `ImportSummary`, `ENTRY_HREFS`, `HOME_NAME_LIMITS`,
  `validateHomeName`, `copyTitle`, `searchEntries`, `importRefusal`, `newHomeAssetId`.
- `files-view.ts` — `filesList` (filter, sort, project), `FILES_FILTER_TESTS`, `FILES_SORT_ORDERS`, `ProjectFilter`, `readFilesPrefs` /
  `writeFilesPrefs` (`instaflow/ui/files`), `selectRange`, `trashByDay`.
- `first-run.ts` — `readFirstRun` / `markFirstRunSeen` / `resetFirstRun` (`instaflow/ui/first-run`), `StoragePort`, `readStorageFacts`,
  `requestPersistence`, `formatBytes`, `browserStorage`.
- `importer.ts` — `createHomeImporter({ blobs, actor, probe?, now? })`, `openBrowserImporter()` (OPFS), `browserImageProbe`, `GUEST_ACTOR`.
- `previews.ts` — `createPreviewSource({ open, urls?, signal })` (object URLs for image entries, read once by digest), `PREVIEW_MAX_BYTES`.
- `new-design.ts` — `<if-new-design>` (the New design dialog: chips, `<sf-size-field>`, presets, start from, name, more), the draft as pure
  functions (`initialDraft`, `chooseFormat`, `setDraftSize`, `setStartFrom`, `draftRequest`), `readNewDesignMemory` / `writeNewDesignMemory`.
- `home-element.ts` — `<if-home>` (`defineHome`, render dep `HomeModelToken`, lazy `I18nToken` and `ToastsToken`; `.previews`, `.storage`),
  `fileActions(entry)` (the file menu's rows, data), `isPlainActivation`, `BULK_TRASH_CONFIRM_FROM`, `ASSETS_DRAG_TYPE`. `home-styles.ts`.
- `boot.ts` — `bootHome({ container, scope, store?, host?, importer?, theme? })` → `{ model, element, toasts }`; refreshes on bfcache
  restore, visibility and Studio's ping; follows Back / Forward.
- `boot-plan.ts` — `INSTAFLOW_CHUNKS`, `HOME_BOOT_PLAN`, `STUDIO_BOOT_PLAN`, `bootClosure`.
- `messages.ts` — `homeMessages` (`instaflow-home`), `homeText`, `fallbackText` (English plurals without the service), `relativeTime`.
  `tokens.ts` — `HomeModelToken`. `errors.ts` — `IF-HOME-001…007`, `IF-POL-054…058`.

## Semantics (do not regress)
- **No engine** (D17): Home reads heads and writes only its journal head (and blobs on import); it never opens a document. The graph test
  and the size budget hold it.
- **One pipeline** (D18): buttons, cards, menus, keys and agents all invoke the capabilities; cards are real links whose plain click / Enter
  runs the capability instead, modified clicks stay the browser's.
- **Three places that agree** (HOME-FILES §3): `⋯`, the context menu and the keys on a focused card run the same operation; `fileActions` is
  the one table.
- **Data, not branches**: entry hrefs, kind labels and icons, the file menu, filters and sorts, pages, quick actions and formats are tables.
- Keyboard: one native focusable per action, reading order; a card's actions follow its link. Results and problems in a polite live region.

## Rules
- Repo rules 1–10. UI from the kit under Clean Pop only (`docs/instaflow/design/HomeCP.dc.html`); layout CSS uses theme tokens.
- Add a quick action as a row with its own capability, never as a branch in the element; a file operation as a journal op kind (index
  applier here, library applier in `../workspace/home-journal-drain.ts`) and a capability.
- Studio-side work (planning the document, listing it, writing the index, draining the journal, templates, duplicates) belongs in
  `../workspace`, not here.

## Test
`pnpm vitest run apps/instaflow/src/home` (index record, journal, routes and formats, files view, first run and previews, the importer, model
and capabilities, `<if-home>` and `<if-new-design>` with the a11y audit in every state, boot, boot plans, the import graph) ·
`NODE_PATH=/opt/node-tools/node_modules pnpm --filter @instaflow/app smoke:home`.
