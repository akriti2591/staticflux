# apps/instaflow/src/workers — AGENTS.md

**Work package:** Instaflow M1c **B9** (editor in the worker; D15; IF-33.1–33.26, LIFECYCLES §35, `IF-WRK-001…006`).
**Layer:** app (not a package export: the dev entry spawns `studio.worker.ts` from source).
**Depends on:** `@staticflux/core`, `worker` (links, protocols, spawners, `pipeline`), `surface` (input ring, input codes,
`text-input` types), `document` (`v2`, `loro-crdt` in the entry), `stage`, `a11y` (shortcut registry), `capabilities`, `blob`
(types); `../app` (canvas pipeline, canvas tab, document, text layer and editing, images, Vello raster), `../sequencing`
(plan, pacing, input ring, view frames, render module), and the editor-side modules of B1–B7. Tests also use
`@staticflux/testkit` (TextInput, DocumentStore and repository contracts), the Node Wasm fixtures and `happy-dom`.
**Budget:** none yet (no export; the app and worker chunk budgets land with C4).

## Purpose
Run Studio's editor module and render module in the D15 topology — one worker by default, two by the boot setting —
with main keeping only page-side adapters. Modules never ask which topology they run in: `planSequencing` turns the
setting into roles and media; the host wires endpoints directly in one worker and main relays them across two.

## Public API (by file)
- `protocol.ts` — data only: `StudioWorkerProtocol` (requests `start`, `attach`, `canvas`, `sync`, `open`, `resize`, `visible`,
  `tool`, `select`, `invoke`, `call`, `text`, `place`, `hud`, `zoom`, `inspect`, `metrics`, `stop`; events `pipes`, `view`,
  `mirror`, `a11y`, `labels`, `text`, `announce`, `problem`, `tool`), `StudioStartArgs`, `StudioEditorStart`, `StudioAssets`,
  `StudioDocumentRef`, `StudioStarted`, `CanvasHandoff`, `ViewProjection`, `StudioInspection`, `InspectedElement`,
  `StudioMetrics`.
- `host.ts` — **`hostStudioWorker({ port, env })`** (worker side; roles from `start`), `StudioWorkerEnvironment` (editor env
  loader, raster factory, raf, timers), machine `StudioWorkerLifecycle` (`instaflow/studio-worker`).
- `editor-module.ts` — **`createStudioEditor(options)`** → `StudioEditor` (`open`, `sync`, `handle` ring events, `setTool`,
  `setViewport`, `select`, `invoke`, `call`, `text`, `place`, `hud`, `zoom`, `inspect`, `input` counters), `EditorEnv`,
  `EditorEvents`, `DOUBLE_CLICK`.
- `boot.ts` — **`bootStudioWorkers(options)`** (main side) → `StudioWorkers` (`plan`, `input`, `editor`, `render`, `started`,
  `everyWorker`, `stop`).
- `mirror.ts` — **`defineMirror<Shape>(id, initial)`**, `createMirrorServers(emit)` (worker: `serve`, `call`, `repost`),
  `createMirrorHub(call)` (main: `view(def)` → `read`, `ready`, `onChange`, `call`; `apply`), `reportFailure`.
- `mirrors.ts` — data and types: `TypographyMirror`, `AppearanceMirror`, `RepeatMirror`, `MilestonesMirror`, `LatestMirror`,
  `StoryMirror`, `TransformMirror` (B10a: the numeric transform bar's model, `apply` / `commit` / `cancel`) and their shapes.
- `store-port.ts` — `StudioStoreProtocol`, `serveStudioStore(link, { store, blobs })` (store side), `remoteDocumentStore(client)`,
  `remoteBlobs(client)` (editor side).
- `text-port.ts` — `createRemoteTextHost(send, kind)` (editor side: a `TextHostPort` whose TextInputs talk to main),
  `createTextHostBridge(options)` (main: host div + platform TextInput), `TextHostCommand`, `TextHostEvent`.
- `wire.ts` — `toWire` / `fromWire` (`SfError`s inside values cross as marked wire errors), `WIRE_ERROR_KEY`.
- `errors.ts` — `IF-WRK-001` boot · `002` role · `003` mirror · `004` capability not served · `005` store port · `006` canvas
  hand-off.
- `studio.worker.ts` — the browser entry (loads authoring and render Wasm, fonts; Loro with B2's mark rules; Vello on the
  transferred `OffscreenCanvas`).
- `test-helpers.ts` (test-only) — `inProcessWorkers` (the host on in-memory ports with Node fixtures and recording rasters),
  `nodeEditorEnv`, `inputWriter`, `dragEvents`, `until`, `fakeDecoder`.

## Rules
- Nothing the worker imports may reach Lit, the kit, the UI runtime or a main-thread module (`worker-imports.test.ts`).
  Split Lit-free code out of a contributions file instead of importing the file (B9 did: `elements/capabilities.ts`,
  `repeat/capabilities.ts`, `text/commands.ts`, `spec/studio-ids.ts`, `a11y/describe.ts`, `tools/overlay-labels.ts`).
- Input reaches the editor only through A5's ring; frames and records only through the pipes; this protocol carries
  control, read projections and forwarded actions.
- Every read projection is plain data (`toWire` for errors); post only when it differs; main asks `sync` once it listens.
- The editor writes storage only through the store port; never hold a store in the editor.
- A new panel service on main is a mirror (`defineMirror` + `serve` + a main adapter in `../app/panel-mirrors.ts`), never a
  second copy of the document.

## Test
`pnpm vitest run apps/instaflow/src/workers apps/instaflow/src/app` (needs `pnpm build` for the Wasm-backed suites): the
host in both topologies (roles, routing, error codes, metrics), the TextInput contract over the port with both platform
inputs, the DocumentStore and repository contracts over the store port, mirrors, wire values, the import guard, and the
Studio app end to end over in-process workers in both topologies. Browser: `pnpm --filter @instaflow/app smoke`.
