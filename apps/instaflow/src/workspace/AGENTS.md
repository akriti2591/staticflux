# apps/instaflow/src/workspace — AGENTS.md

**Work package:** Instaflow M1c **C0 Home route** (IF-28.1–28.7, IF-28.26–28.28; LIFECYCLES §30; `IF-HOME-*` in `../home/errors.ts`).
**Layer:** app (not a package export: the dev entries import it from source).
**Depends on:** `@staticflux/storage` (`AsyncStore`, IndexedDB), `@staticflux/document/v2`, `@staticflux/blob` (OPFS; `blobs.ts` only),
`@staticflux/capabilities`, `../home` (index format, routes, formats, errors), `../library`, `../versioning` (templates), `../app`
(`openStudioWorkspace`, `createStudioApp`; `studio-session.ts` only; `mountStudioFrame`: `studio-page.ts` only). Home may import **only** `browser.ts`, `document-store.ts` and
(B11c, lazily, for import and previews) `blobs.ts` (Loro-free; `../home/home-imports.test.ts`).
**Budget:** none of its own (`document-store.ts` and `browser.ts` count in Home's budget).

## Purpose
The persistent local workspace and the store-side pieces Home relies on: documents in IndexedDB, blobs in OPFS, the Home index
kept in step with the library and with edits, Studio's document chosen from the URL, and workspace templates.

## Public API (by file)
- `document-store.ts` — `documentStoreFromAsyncStore(store, { locks?, lockPrefix? })` (a `DocumentStore` over any `AsyncStore`; key
  layout `DOCUMENT_STORE_KEYS`), `WorkspaceLocks` (structurally `navigator.locks`). Home-safe.
- `browser.ts` — `LOCAL_WORKSPACE`, `openWorkspaceDocuments({ indexedDB?, keyRange?, locks? })` (SF-STORE-002 without IndexedDB). Home-safe.
- `blobs.ts` — `openWorkspaceBlobs()` → `{ blobs, persistent }` (OPFS, else memory). Studio, and Home's importer and previews (lazy).
- `design-cover.ts` — #64: `createDesignCover({ asset, render, blobs, library, scope, idleMs?, leaveWaitMs?, timers?, onProblem? })` →
  `touch`, `flush`, `renders`: the open design's `cover` rendition (when missing, `COVER_IDLE_MS` after edits, and on leaving, bounded by
  `COVER_LEAVE_WAIT_MS`); the session runs it, the index writer projects it as `HomeEntry.cover`.
- `home-index-writer.ts` — `projectHomeIndex` (pure; B11c: trashed entries with `trashedAt`, project, favourite, pages, digest, cover, Home's
  projects kept), `writeHomeIndex` (CAS + retries, IF-HOME-005; Home's pending journal applied on top), `createHomeIndexWriter({ store,
  library, scope, now?, debounceMs?, timers?, onProblem?, onWritten? })` → `touch`, `describe` (`format`, `pages`), `flush`, `writes`;
  `observeStoreWrites(store, onWrite)` (the library and the journal are not designs).
- `home-journal-drain.ts` (B11c) — `drainHomeJournal(services, signal)` → `DrainReport { drained, problems }`, `createHomeJournalDrain`
  (single-flight), `DrainServices { store, library, duplicate, flushIndex?, onProblem? }`: Home's journal applied to the library (one
  applier per op kind), the index rewritten, then the ops removed.
- `duplicate.ts` (B11c) — `duplicateDesign({ store, engine, repo, actor, now? }, { source, asset, title }, signal)`: a fresh snapshot of the
  source's Latest as a new, detached document (`createDocumentFromMilestone`), IF-VER-008 when the id is taken.
- `studio-document.ts` — `planStudioDocument(intent, context, signal)` → `PlannedDocument { ref, listing, format, created }` (one planner per
  intent kind), `listDesign(library, plan)`, `DEMO_DOCUMENT`, `UNTITLED_DESIGN`.
- `templates.ts` — `SaveAsTemplateCapability` (`instaflow/save-as-template`), `saveAsTemplate`, `newDocumentFromTemplate`, `readMilestone`.
- `studio-session.ts` — `openStudioSession({ intent, documents, blobs?, navigate?, replaceUrl?, newAssetId?, index?, …StudioAppOptions })`
  → `{ app, plan, index, workspace, drain }` (the Studio page's boot over the workspace; B11c: drains Home's journal before planning, on
  `HOME_JOURNAL_CHANNEL` pings and on visibility; pings Home after each index write; describes the page count), `freshAssetId`,
  `browserHomeChannel`, `HomeChannel`.
- `studio-page.ts` (#62) — `bootStudioPage({ container, status, open, missing, frame? })`: the frame first (`mountStudioFrame`),
  `open()` once it is laid out, then the app mounts in its place, or `missing(details)` (`UnknownDesignError`), or the status line says
  `bootFailureText(failure)` as `role="alert"` (an error result or a throw); never leaves the frame behind.

## Semantics (do not regress)
- The index lives in the library head (`app.home`) and changes only by CAS; unchanged → no write; `editedAt` never goes back.
- A design is listed in the library only after the editor opened it; the Home link flushes Latest and the index before leaving.
- Templates are B5 tree assets of kind `template` with their own milestone; "Use template" starts from the newest one.
- Home's journal is applied in order and each op is idempotent; ops leave the journal only after the library is durable and the index
  rewritten (LIFECYCLES §38 SURF-12, SURF-13).

## Test
`pnpm vitest run apps/instaflow/src/workspace` (the DocumentStore contract on memory and fake IndexedDB, reload and locks, the writer with
manual timers, planners, and `studio-session.test.ts`: new design → draw → index → reload → template → new design from it, over in-process
workers; skipped when the authoring Wasm is not built).
