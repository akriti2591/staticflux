# apps/instaflow/src/export — AGENTS.md

**Work package:** Instaflow M1c **C1 Export** (D10, D21; IF-29.1–29.28, LIFECYCLES §31, `IF-EXP-001…008`). **Layer:** app.
**Entry points:** `@instaflow/app/export` (`index.ts`: main-thread service, capability, formats, errors),
`@instaflow/app/export/panel` (`panel.ts`), and the worker entry `export.worker.ts` (spawned per export; not a package export).
**Depends on:** `@staticflux/core`, `@staticflux/worker`, `@staticflux/capabilities`, `@staticflux/a11y` (shortcut),
`@staticflux/surface/raster` (headless surface) and `/image` (PNG encoder), `@staticflux/document/v2` (+ `/loro-crdt`,
`/render-projection` in the worker), `@staticflux/blob` (types), `@staticflux/kit` (`button`, `inspector`, `segmented`, `status`)
and `@staticflux/ui` for the panel; app modules `../app` (document, text layer, images, fonts), `../elements`, `../repeat` (through the
document), `../render` (render module, Vello backend), `../text`, `../library`, `../versioning` (types), `../workers/store-port`.
The export Wasm comes from `engine/crates/export` (see `engine/AGENTS.md`).
**Budgets:** export entry 4.25 KB, panel 3 KB brotli excl. framework (`.size-limit.json`); export Wasm 230 KB brotli
(`.size-limit.wasm.json`, `export-wasm`).

## Purpose
Export the page shown, the selection or every page as PNG (1×/2×/3×, transparent option), PDF (real text, vector shapes, all pages
in one file) or SVG, from B5's frozen snapshot, in a worker spawned for the job, cancellable with progress, creating nothing in the
design (D10). One capability (`instaflow/export`) serves the panel, `Mod+Shift+E` and agents.

## Public API (by file)
- `formats.ts` — `EXPORT_FORMATS` (data: label, MIME, extension, raster/vector, wire, multi-page, scales), `EXPORT_SCALES`,
  `EXPORT_SCOPES`, `ExportOptions`, `DEFAULT_EXPORT_OPTIONS`, `validateExportOptions` (IF-EXP-001), `exportFileName`, `PATCH_SCALE`,
  `PAGE_BACKGROUND`, `MAX_EXPORT_PIXELS`, `ExportFile`.
- `service.ts` — `createExportService({ spawn, assets, store, target, title, images, deliver? })` → `ExportService` (`status`,
  `onChange`, `run`, `cancel`, `dispose`); `ExportTarget`, `ExportStatus`, `browserDownload`, `formatOf`.
- `capability.ts` — `ExportCapability` (`instaflow/export`), `ExportShortcut` (`Mod+Shift+E`), `implementExport(service)`.
- `panel.ts` — `<if-export-panel>` (`defineExportPanel`), `exportPanel` (B0 dock contribution), `bindExportPanel`, `ExportPanelPort`,
  `statusText`, `formatBytes`, `EXPORT_SCOPE_LABELS`.
- Worker side: `job.ts` (`runExportJob`, `ExportJobLifecycle` = `instaflow/export-job`, `ExportJobEnv`, `ExportRaster`,
  `describeExportError`), `scene.ts` (`buildPageScene`, `pageSize`), `snapshot-document.ts` (`openSnapshotDocument`,
  `readOnlyOpenDocument`), `export-module.ts` (`loadExportModule`, `decodePlan`, ABI 1), `host.ts` (`hostExportWorker`),
  `protocol.ts` (`ExportWorkerProtocol`: `start`, `run`, `stop`, `progress`), `export.worker.ts` (browser entry).
- `errors.ts` — `IF-EXP-001…008`.

## Semantics (do not regress)
- **Snapshot, not Latest** (IF-29.5, D10): the job reads only the frozen snapshot through a read-only document; nothing is written.
- **The canvas's scene** (IF-29.6): pages are composed exactly as Studio's canvas pipeline does (B1 over B7's repeat view, B4
  images, B2 text, scene IR v4), without overlays; every element keeps its full matrix (skew, flips).
- **PNG is the renderer** (headless Vello, chunked); SVG and PDF come from the export Wasm and meet D21 (rasterize list as data
  in `engine/crates/export/src/plan.rs`; patches rendered by the render module).
- **Lazy**: the export worker is spawned per export; the export Wasm loads only for SVG, PDF and selection exports.
- **Data, not branches**: the format row decides raster vs vector and one file vs one per page.

## Rules
- Repo rules 1–10. Panel from the kit under Clean Pop only; keep it minimal (B11 aligns it with the UX spec).
- New format: a row in `EXPORT_FORMATS` plus a writer in the export crate; a feature a format cannot express: a row in D21's list.

## Test
`pnpm vitest run apps/instaflow/src/export apps/instaflow/src/app/studio-app.test.ts` (needs `pnpm build`: the job tests use the
real authoring and export Wasm in Node) · `cargo test -p export` in `apps/instaflow/engine` (corpus, D21, skew/flips, PDF text) ·
`pnpm build && SF_GPU=1 NODE_PATH=/opt/node-tools/node_modules pnpm vitest run apps/instaflow/src/export/export.gpu.test.ts` (PNG
golden parity, SVG in Chrome; `SF_EXPORT_DUMP=<dir>` keeps the PNGs) · `pnpm --filter @instaflow/app smoke` (export step).
