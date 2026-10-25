# apps/instaflow/src/sequencing — AGENTS.md

**Work package:** Instaflow M1 **A7** (D15, SF-Δ25, IF-7.1–7.3; from spike S2). **Layer:** app.
**Depends on:** `@staticflux/core`, `config` (flags), `document` (`v2`, `render-projection`, `spatial-index`, `loro-crdt` in
tests and workers), `surface` (`input-ring`, input codes), `worker` (`pipeline`, links, protocols, spawners).
**Budget:** worker-side code (editor and render workers); no main-thread boot cost except `boot.ts` + `pacing.ts` (main tick)
+ `protocol.ts`. A per-chunk budget lands with the app build (C4); `@staticflux/document/render-projection` (4.25 KB) and
`/spatial-index` (2.9 KB incl. rbush) are budgeted in `.size-limit.json`.

## Purpose
The editor module and the render module as separate modules that talk only through fixed ports — the input ring in, scene
deltas **before** view-state frames, view frames out — so that one worker or two is a **boot setting, not a code path**
(D15, default one worker). The render module enforces the S2 rules: draw on arrival (small coalescing delay), apply deltas
only up to the frame's `docVersion`, draw only at equality. The renderer itself (A6) sits behind the `RenderPort`.

## Public API (by file)
- `protocol.ts` — pipe declarations (data only): `ViewFrameLayout`/`ViewFrameCell` (seqlock + checksum; `docVersion`, overlay
  `dx/dy`, camera, `viewSeq`, `inputSeq`, `batchSeq`, `peerSeq`, `epoch`, `gestureId`, targets, selection, marquee, `digest`),
  `SceneDeltas` (delta stream of render-projection payloads), `EditorInputRing` (surface input ring), `RenderTickLayout`/
  `RenderTickCell` (main-rAF tick), `SceneProjection` (shape/image/text/vector/video; `spatial.x/y/w/h`), `MAX_VIEW_IDS` (1024).
- `editor-core.ts` — `createEditorCore({ part, actor, onDelta })` → `Result<EditorCore>`: the editor state machine without
  pipes (CRDT part, projector, spatial index, camera, selection, gesture overlay; pan, zoom, drag one, Alt-drag group, marquee,
  nudge, Esc, pointercancel; `remote(update)` imports CRDT updates; IF-ENG-001 on a deleted target), `writeFrame(record, meta)`,
  `displayDigest`, `committedDigest`, `probe`, `dragTargets`, `snapshot`, `final`. `applyWheel`, `ZOOM_MIN/MAX`.
- `editor-module.ts` — `createEditorModule({ part, ports: { input, deltas, frames, peer }, coalesceMs, dropDeltaEvery })` →
  `step()` / `run(signal)` / `stats`; `RemoteUpdatePort`, `scriptedPeer(schedule)` (oracle), `queuedPeer()`.
- `render-port.ts` — **`RenderPort`** (`draw(frame) → Result`, optional `reset`, `dispose`), `RenderFrame { scene, view,
  docVersion, reason }`, `RenderPortFactory`. The contract is in the file header; A6 implements it.
- `render-module.ts` — `createRenderModule({ ports: { frames, deltas, port, ticks }, pacing, now, record, digest })` →
  `update(reason)` ('drawn' | 'held' | 'unchanged' | 'empty' | 'failed'), `vsync(time)`, `run(signal)`, `presented`
  (`PresentedRecord` log), `stats`, `final`, `dispose`; machine `RenderModuleLifecycle` (`instaflow/render-module`).
- `pacing.ts` — `RenderPacing { arrival, coalesceMs, tick: 'worker-raf' | 'main-raf', latchMs }`, presets
  `DEFAULT_RENDER_PACING` (arrival, 1 ms, worker rAF), `MAIN_TICK_PACING` (the experiment: arrival, 0 ms, main tick, 4 ms latch),
  `RAF_ONLY_PACING` (the S2 control); tick sources `rafTicks`, `cellTicks`, `manualTicks`; main side `createMainTick`,
  `driveMainTick`.
- `topology.ts` — `SequencingSettings` (`topology`, `pacing`, `editorCoalesceMs`, `renderPort`), `DEFAULT_SEQUENCING_SETTINGS`
  (colocated), `planSequencing(settings, { isolation, media })` → `SequencingPlan` (workers with roles + media), `workerFor`.
- `flags.ts` / `sequencing.bindings.ts` — `SequencingTopologyFlag` (`instaflow/sequencing-topology`), `RenderTickFlag`
  (`instaflow/render-tick`); `resolveSequencingSettings(read)` (variant tables, the only flag reads).
- `boot.ts` — `bootSequencing({ settings, spawn, scene, peer, isolation, media, remote, dropDeltaEvery, record })` →
  `SequencingSession { plan, input, tick, workers, finish, stop }` (main side).
- `host.ts` — `hostSequencingWorker({ port, engine, renderPorts, raf, timeOrigin, now })` (worker side; roles from `start`).
- `control.ts` — `SequencingControl` protocol (`start`, `attach`, `finish`, `stop`; event `pipes`), `StartArgs`, `WorkerFinal`.
- `digest.ts` — `mix`, `elementTerm`, `viewPartDigest`, `committedDigest`, `displayDigest` (the S2 additive display hash).
- `digest-renderer.ts` — `createDigestRenderer(inner?)` (the oracle's fake renderer; tees to a real port), `frameDigest`.
- `scene.ts` — `elementBounds` (ink bounds), `paintKey`/`comparePaintKeys`, `gridSceneOps`/`gridSceneSnapshot` (S2 scene).
- `errors.ts` — `IF-ENG-001` target gone (E-3), `IF-SEQ-001` boot failed (step in `details.step`), `IF-SEQ-002` role misuse,
  `IF-SEQ-003` render port missing / draw failed.
- `testing/` (test-only) — `oracle-subject.ts` (`createSequencingReference`, `createInProcessSequencingSubject`,
  `bootInProcessPipeline`, `createFakeRaf`, `throughRing`, `toPresentedFrame`, `ORACLE_PEER`), `oracle-setup.ts`.

## Rules
- Modules never ask which topology they run in. `planSequencing` turns the setting into data; `host.ts` routes endpoints
  (direct in one worker, relayed by main across two). New module code must work on `local`, `shared` and `message` media.
- Publish order in a step: every delta first, then one view frame. A resnapshot is answered at the end of a step (never in the
  middle of an input record) together with a fresh frame, so a snapshot and its frame describe the same consumed input.
- The render module never draws a frame whose `docVersion` differs from its applied version, and never applies a delta newer
  than the frame it is about to draw. It keeps the last good frame meanwhile (holding).
- Overlays are offsets over committed state and carry gesture ids; commits list the ids they supersede (E-2).
- Remote updates are applied at input-record boundaries (`RemoteUpdatePort.take(consumed)`), so state is always a prefix of
  "inputs + remotes in order" — this is what makes the oracle exact. Production feeds use `queuedPeer`.
- The oracle requires every scene copy to load the same snapshot with the same peer id (`ORACLE_PEER`); production editors use
  their own random peer.
- Render ports must follow the `render-port.ts` contract; run a new port under the oracle with
  `createInProcessSequencingSubject({ renderPort })`.

## Tests
- Unit tests per file (`*.test.ts`), plus the **oracle** (IF-7.3): `sequencing.oracle.{colocated,split,main-tick}.test.ts`
  run testkit's `runSequencingOracleContract` at 2,000 gestures on 2,000 elements on every topology × medium (local, shared,
  message), with the main-rAF tick, rAF-only drawing, and lost deltas (E-1). `sequencing.threads.test.ts` runs the same suite
  with real Node worker threads (1,000 gestures). `sequencing.gpu.test.ts` builds the bench page and runs it in Chromium
  (only with `SF_GPU`).

## Bench (the main-rAF tick experiment, D15 decision input)
```sh
pnpm build && pnpm --filter @staticflux/instaflow bench:build
# owner machine, real GPU (Chrome headed, display at 60/100/120 Hz; budget = measured frame + 4 ms):
pnpm gpu:run apps/instaflow/bench/sequencing/dist index.html --real-gpu --headed --query='topology=colocated'
pnpm gpu:run apps/instaflow/bench/sequencing/dist index.html --real-gpu --headed --query='topology=split'
pnpm gpu:run apps/instaflow/bench/sequencing/dist index.html --real-gpu --headed --query='topology=split&tick=main-raf'
```
Query: `topology`, `tick` (worker-raf | main-raf), `arrival` (1 | 0), `coalesce`, `latch`, `gfx` (webgpu | none), `gestures`
(2000), `elements` (10000), `pace` (4 ms), `seed`. The page prints and publishes correctness (oracle check of every presented
frame) and latency (input → first presented frame; present = first render tick ≥ submit, a lower bound like S2).

Container results (2026-10-25; 4 shared cores, headless Chromium, `gfx=none`, 2,000 gestures on 10,000 elements, 60 Hz,
budget 20.67 ms). Correctness PASS in every run. Latency in ms (input → present estimate):

| Run | p50 | p95 | pan p95 | pointer p95 | nudge p95 | input → submit p95 |
|---|---|---|---|---|---|---|
| one worker, worker rAF (default) | 15.85 | 32.42 | 16.06 | 32.38 | 49.22 | 18.27 |
| two workers, worker rAF | 15.88 | 32.21 | 16.16 | 16.16 | 49.19 | 16.54 |
| two workers, **main-rAF tick** | 15.86 | 32.41 | 16.11 | 32.17 | 49.33 | 17.73 |
| one worker, main-rAF tick | 15.91 | 32.56 | 17.21 | 32.52 | 49.28 | 14.16 |
| two workers, rAF-only draw (control) | 32.52 | 48.49 | 32.78 | 35.79 | 65.85 | 33.02 |

Draw on arrival keeps every topology at ≈ 1 frame median (rAF-only: 2 frames, as in S2). The p95 tail here is the editor's
commit cost (one CRDT transaction for a 100-element drag, or a nudge of up to 1,024 selected elements, in the pointerup /
keydown frame), not the topology: pan stays at one frame. The late worker-rAF phase the owner measured does not show in this
headless container, so the main-rAF tick shows no gain or loss here. **Real-GPU latency: INCONCLUSIVE** — needs the owner run
above (and the iGPU reference) before D15's default can change. `gfx=webgpu` on SwiftShader: correctness PASS, latency
194–281 ms median (SwiftShader frames), not representative.
