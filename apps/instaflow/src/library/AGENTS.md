# apps/instaflow/src/library — AGENTS.md

**Work package:** Instaflow M1b **B4 Library and lenses** (library half; IF-3.5–3.10, IF-23.1–23.14). **Layer:** app.
**Entry points:** `@instaflow/app/library` (headless services; the store worker, an editor worker or the main thread) and
`@instaflow/app/library/ui` (the Assets panel and its contribution; main thread only).
**Depends on:** `@staticflux/blob` (A3: `BlobStore` hashing, chunking, dedupe), `@staticflux/document/v2` (A4: the library
document on the repo), `@staticflux/stage` (actors), `@staticflux/surface/image` (scaling, PNG; R11.54–R11.55) and
`@staticflux/surface/raster` (headless surface), `src/render` (A6 scene IR), `src/spec` (B0 contributions), `src/theme` (lens
palette), `@staticflux/kit` + `@staticflux/ui` + `@staticflux/i18n` (UI). Tests also use `@staticflux/document/loro-crdt` and
`@staticflux/testkit/a11y`.
**Budgets:** services 10 KB, UI 6.25 KB brotli (framework, lit and kit excluded; `.size-limit.json`).

## Purpose
The workspace library: which assets exist, their mutable metadata, how files become immutable blob assets, and their
regenerable renditions. Headless services plus one B0 panel contribution; nothing here lays out a screen.

## Public API (by file)
- `kinds.ts` — `BLOB_ASSET_KINDS`, `TREE_ASSET_KINDS`, `LIBRARY_ASSET_KINDS`, `MEDIA_TYPES` / `EXTENSION_TYPES` (data),
  `mediaTypeOf(name, type)`, `assetKindOf(mime)`, `ASSET_KIND_LENS` (kind → lens palette id), `titleFromFileName`.
- `records.ts` — `BlobAssetRecord` (`instaflow.asset/1`: content, media, provenance `imported`), `MediaInfo`,
  `encodeBlobAssetRecord`, `decodeBlobAssetRecord` (IF-LIB-004), `ASSET_RECORD_MIME`, `BLOB_ASSET_SCHEMA`.
- `library-doc.ts` — `LIBRARY_ASSET` (`library`), `LIBRARY_PART`, `LIBRARY_ENTRY_KIND`, `LibraryComponent`, `libraryRegistry`,
  `LibraryPaths`, `RENDITION_ROLES`, `Rendition`, `LibraryEntry`, `NewLibraryEntry`, `readLibraryEntry`,
  `readLibraryEntries`, `entryCreateOps`, `openLibraryDocument(repo, signal)` → `{ doc, part }` (created on first use).
- `library.ts` — `createLibrary({ source, actor, now })` → `entries()` (reactive, newest first), `entry`, `findByContent`,
  `add`, `rename`, `setFolder`, `setFavorite`, `addTag`, `removeTag`, `trash`, `restore`, `setRendition`, `gcRoots`, `dispose`;
  `validateTitle` / `validateTag` / `validateFolder`, `TRASH_RETENTION_MS`, `LIBRARY_FILTERS` + `LIBRARY_FILTER_TESTS` (data),
  `queryLibrary(entries, query)`.
- `ingest.ts` — `createIngestService({ library, blobs, probes, newAssetId, actor, now, onListed })` → `ingest(file, { signal,
  folder })`, `pending()` (reactive, provisional ids), `resolve(pv)`, `dispose`; `IngestFile` (structurally a DOM `File`),
  `MediaProbe`, `IngestMachine` (`instaflow/library-ingest`).
- `renditions.ts` — `createRenditionQueue({ library, blobs, decoder, renderer, encoder, edge, concurrency })` → `request(asset,
  { force })`, `resume()`, `jobs()`, `cancel`, `idle(signal)`, `dispose`; ports `ImageDecoder`, `ThumbnailRenderer`,
  `ImageEncoder`; `RENDITION_PRODUCERS` (data), `missingRenditions`, `THUMBNAIL_EDGE` (256), `RenditionJobMachine`
  (`instaflow/rendition-job`).
- `thumbnails.ts` — `sceneThumbnailRenderer({ backend })` (A6 path), `scaleThumbnailRenderer()` (CPU fallback),
  `pngImageEncoder()`, `browserImageDecoder(apis?)`, `decoderMediaProbe(decoder)`.
- `panel-model.ts` — `createLibraryPanelModel({ library, ingest, blobs, host, urls, signal })`; `LibraryHost` port (`pickFiles`,
  `place`), `ObjectUrls` / `browserObjectUrls`, `browserPickFiles(signal)`, `IMPORT_ACCEPT`, `ImportSummary`.
- `tokens.ts` — `LibraryContext(Token)`, `LibraryServices(Token)`, `LibraryPanelModelToken`. `units.ts` —
  `createLibraryServices(context, scope)`, `libraryServicesUnit` (feature scope), `libraryPanelModelUnit`, `libraryUnits`.
- UI (`ui.ts`): `library-panel.ts` — `<if-library-panel>` (`defineLibraryPanel`, `libraryNodes`, `importFromPicker`,
  `importFiles`); `contributions.ts` — `libraryPanel` (B0 `PanelContribution`, id `instaflow/assets`),
  `libraryContributionUnits`; `messages.ts` — `libraryMessages` (`instaflow-library`), `libraryText`.
- `errors.ts` — `IF-LIB-001` unsupported media · `002` import store failure · `003` unknown asset · `004` record/entry
  malformed · `005` decode · `006` rendition · `007` metadata · `008` already listed · `009` disposed.

## Wiring (the app does it when a workspace opens)
```ts
const document = await openLibraryDocument(repo, signal);                     // heads/library.json
const renderer = backend ? sceneThumbnailRenderer({ backend }) : scaleThumbnailRenderer(); // boot binding
provide(LibraryContextToken, { document, blobs, actor, newAssetId, host, decoder: browserImageDecoder(), renderer, encoder: pngImageEncoder() });
compose([...libraryUnits, ...libraryContributionUnits]);                       // drop B0's `instaflow/assets` placeholder
```

## Semantics (do not regress)
- **Immutable records, mutable library:** the asset record is written once; title, tags, folder, favourite, trash and
  renditions live in the library document (`library.*` paths). Trash is `trashedAt`, never a delete.
- **Nothing half-listed:** content and record are stored before the one library commit; failures and cancellation list
  nothing. Same bytes → the existing live entry (`deduplicated`).
- **Renditions are derived:** a job writes only after its blob is stored; `resume()` is the crash/next-session path; the PNG
  encoder is deterministic, so a regenerated thumbnail is the same blob.
- **No branches on kind or renderer:** probes, producers, filters and lens marks are tables; the renderer is a binding.

## Rules
- Repo rules 1–10 (`CLAUDE.md`). App code never imports testkit; `test-helpers.ts` is excluded from the build.
- UI from `@staticflux/kit` only, Clean Pop tokens only; lens colour and shape from `src/theme/lenses.ts`.
- The Assets panel replaces B0's placeholder of the same id: compose one or the other (duplicates are IF-SPEC-002).
- Out of scope here: element creation on Place (B1/B3 implement `LibraryHost.place`), folder tree UI, GC runs (A3 `collectGarbage`
  with `gcRoots()`), video/audio renditions (M3), composition covers (follow-up: render page 1 through the A7 projection).

## Test
`npx vitest run apps/instaflow/src/library` (kinds, records, library document on Loro, the service, ingest with dedupe /
cancel / probe failures, the rendition queue with cancel / resume / idempotence, both thumbnail renderers against a recording
backend, the panel model, `<if-library-panel>` keyboard paths + a11y audit, units and the contribution against Studio's spec).
