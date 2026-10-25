# apps/instaflow/src/workspace — AGENTS.md

**Work package:** Instaflow M1c **C0 Home route** (IF-28.1–28.7, IF-28.26–28.28; LIFECYCLES §30; `IF-HOME-*` in `../home/errors.ts`).
**Layer:** app (not a package export: the dev entries import it from source).
**Depends on:** `@staticflux/storage` (`AsyncStore`, IndexedDB), `@staticflux/document/v2`, `@staticflux/blob` (OPFS; `blobs.ts` only),
`@staticflux/capabilities`, `../home` (index format, routes, formats, errors), `../library`, `../versioning` (templates), `../app`
(`openStudioWorkspace`, `createStudioApp`; `studio-session.ts` only). Home may import **only** `browser.ts` and `document-store.ts`
(Loro-free; `../home/home-imports.test.ts`).
**Budget:** none of its own (`document-store.ts` and `browser.ts` count in Home's budget).

## Purpose
The persistent local workspace and the store-side pieces Home relies on: documents in IndexedDB, blobs in OPFS, the Home index
kept in step with the library and with edits, Studio's document chosen from the URL, and workspace templates.

## Public API (by file)
- `document-store.ts` — `documentStoreFromAsyncStore(store, { locks?, lockPrefix? })` (a `DocumentStore` over any `AsyncStore`; key
  layout `DOCUMENT_STORE_KEYS`), `WorkspaceLocks` (structurally `navigator.locks`). Home-safe.
- `browser.ts` — `LOCAL_WORKSPACE`, `openWorkspaceDocuments({ indexedDB?, keyRange?, locks? })` (SF-STORE-002 without IndexedDB). Home-safe.
- `blobs.ts` — `openWorkspaceBlobs()` → `{ blobs, persistent }` (OPFS, else memory). Studio only.
- `home-index-writer.ts` — `projectHomeIndex` (pure), `writeHomeIndex` (CAS + retries, IF-HOME-005), `createHomeIndexWriter({ store,
  library, scope, now?, debounceMs?, timers?, onProblem? })` → `touch`, `describe`, `flush`, `writes`; `observeStoreWrites(store, onWrite)`.
- `studio-document.ts` — `planStudioDocument(intent, context, signal)` → `PlannedDocument { ref, listing, format, created }` (one planner per
  intent kind), `listDesign(library, plan)`, `DEMO_DOCUMENT`, `UNTITLED_DESIGN`.
- `templates.ts` — `SaveAsTemplateCapability` (`instaflow/save-as-template`), `saveAsTemplate`, `newDocumentFromTemplate`, `readMilestone`.
- `studio-session.ts` — `openStudioSession({ intent, documents, blobs?, navigate?, replaceUrl?, newAssetId?, index?, …StudioAppOptions })`
  → `{ app, plan, index, workspace }` (the Studio page's boot over the workspace), `freshAssetId`.

## Semantics (do not regress)
- The index lives in the library head (`app.home`) and changes only by CAS; unchanged → no write; `editedAt` never goes back.
- A design is listed in the library only after the editor opened it; the Home link flushes Latest and the index before leaving.
- Templates are B5 tree assets of kind `template` with their own milestone; "Use template" starts from the newest one.

## Test
`pnpm vitest run apps/instaflow/src/workspace` (the DocumentStore contract on memory and fake IndexedDB, reload and locks, the writer with
manual timers, planners, and `studio-session.test.ts`: new design → draw → index → reload → template → new design from it, over in-process
workers; skipped when the authoring Wasm is not built).
