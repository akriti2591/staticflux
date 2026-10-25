# StaticFlux — Lifecycles & Valid States

> Status: **draft spec**. Every lifecycle in StaticFlux is a typed, finite state machine.
> The API exposes only operations valid in the current state; cross-lifecycle invariants are enforced and carry error codes.

## 0. Conventions

- States are **discriminated unions** (`{ state: 'ready', value: T } | { state: 'failed', error: SfError } | …`).
- Transitions not listed are **invalid**: compile-time error where statically detectable, `SF-*` runtime error in dev, telemetry event + safe no-op in prod.
- Every transition emits a telemetry event (`lifecycle.<machine>.<from>→<to>`) at `verbose`; failures at `critical`.
- Every state that owns resources owns a **disposal scope**; leaving the state disposes it.

## 1. App lifecycle

```
starting → core-ready → running ⇄ degraded
                         running ⇄ paused
            running|degraded|paused → reinitializing → core-ready
            any → shutting-down → terminated
```

| State | Allowed commands | Notes |
|---|---|---|
| starting | abort, shutdown | only critical units resolving |
| core-ready | (auto → running) | shell frame rendered |
| running | pause, refresh, reinitialize, shutdown, abort | |
| degraded | same as running | ≥1 subsystem failed; dependents notified |
| paused | resume, shutdown | nothing executes except resume path |
| reinitializing | — | teardown to core in reverse order, then re-boot |
| shutting-down | — | reverse-dependency teardown |
| terminated | — | terminal |

`refresh` is not a state: it bumps the **epoch**; units with `refreshOn` matching move `ready → refreshing → ready`.

## 2. Subsystem (supervised child)

```
idle → starting → running ⇄ paused
running → failed → restarting → starting      (restart policy: backoff, max N in window)
failed (intensity exceeded) → given-up         (app → degraded)
any → stopping → stopped
```

## 3. Worker

```
spawning → handshaking → ready ⇄ busy
ready|busy → unresponsive (missed heartbeat) → crashed
error event → crashed → respawning → spawning
crashed (intensity exceeded) → failed          (fallback activated; app → degraded)
ready|busy → draining → terminated
idle → spawning (start)
unresponsive → ready (heartbeat recovers; avoids respawning throttled background tabs)
failed → spawning (manual restart())
```
`pause` is a flag on ready/busy, not a separate state. Envelope kinds include `cancel` so aborts reach the worker.

On respawn: replicas re-handshake (snapshot/patches), document workers rehydrate from last snapshot, in-flight requests retried if idempotent else failed (`SF-WK-*`).

## 4. Unit (DI) — resolution vs readiness

```
unresolved → resolving → created → initializing → ready ⇄ refreshing
                                        ↘ failed → initializing (retry policy)
any → disposed
```

- **created** = instance exists ("injected"). **ready** = initialized and usable.
- `init()` runs **once per scope instance**; its promise is cached and shared (single-flight).
- `refreshOn: [tokens…]` and app epoch bumps drive `ready → refreshing → ready`; consumers keep the last value during refresh.
- A unit cannot be `ready` while any required dependency is not `ready` (I-3).

## 5. Dependency kinds (all units) and component handles

The readiness lifecycle (§4) applies to **every unit** — stores, services, clients, utilities, components. Dependency kinds are generic:

| Kind | Any unit receives | Semantics | Component alias / render behaviour |
|---|---|---|---|
| required | `T` (narrowed to ready) | must be `ready` before this unit's `init()` | `render`: placeholder until all ready |
| lazy | `DepHandle<T>`: `pending \| ready \| refreshing \| failed` | arrives any time; reactive | `lazy`: reactive |
| functional | `(…args) => Promise<Result<R>>` | resolved + initialized on first call | `functional` |

Units without `init()` are `ready` on creation (zero overhead).

**Deferred units** (`deferredUnits({ id, provides, load })`): a placeholder binding whose first resolution imports a chunk, registers its units and resolves the real provider (once per injector; retried after failure; `di.deferred` span). Boot code should reach deferred units only through `lazy`/`functional` deps.

### 5.1 Init timing (per dependency, overridable)

`init: 'eager' | 'on-arrival' | 'idle' | 'on-visible' | 'on-intent' | 'on-demand'`

| Kind | Default |
|---|---|
| required / render | eager |
| lazy | on-arrival |
| functional | on-demand |

E.g. a heavy functional dep (export PDF) can pre-warm `on-intent` (hover/focus of its trigger); a heavy lazy panel dep can wait for `on-visible`. Init is always single-flight and cached regardless of timing.

### 5.2 Dependency hooks (per dependency, per consumer)

Hooks are for what the **consumer** does *with* a dependency (subscribe, register, seed state, start streams, wire to another dep) — not the dependency's own init.

```ts
onInjected(deps.presence, (presence, scope) => …)
onReady(deps.presence, async (presence, scope) => { scope.defer(presence.subscribe(...)) }, { blocking: true })
onRefresh(deps.presence, (fresh, scope) => …)
onFailed(deps.presence, (error) => …)
```

- Available to **every unit** (stores, services, utilities, components).
- Scope-bound: resources go into the provided `scope` (or a returned cleanup fn); disposed when the consumer is disposed **or the dependency refreshes** (the hook re-runs against the fresh instance).
- `blocking: true` makes the hook part of the consumer's readiness (component keeps its placeholder until it settles). Non-blocking hook failures are reported, not fatal.
- Each hook run is a span inside the consumer's readiness span.

## 6. Feature lifecycle

```
declared → loading → loaded → activating → activated
activated → mounting → mounted ⇄ hidden
mounted|hidden → unmounting → activated            (logic stays warm)
activated → deactivating → loaded                  (logic disposed)
loaded → archived (heavy: snapshot persisted) | evicted (cheap/warm)
archived → activating (rehydrate from snapshot)
any loading/activating → failed → (retry) | evicted
```

| Policy | Default demotion |
|---|---|
| cheap | unmount → deactivate → evict immediately |
| warm | unmount; keep activated until budget pressure |
| heavy | unmount → archive under pressure |

## 7. Navigation

```
idle → running(stage) → committed → idle
running → cancelled | redirected | blocked | failed
```
Uninterruptible stages defer cancellation until they settle. Every outcome returns to `idle` via a `settle` event. Error codes: `SF-NAV-001…013` (see `docs/errors.json`).

## 8. Surface (messaging)

```
requested → queued → showing → dismissing → dismissed
requested → rejected (gate/arbitration)
showing → suspended (higher-priority surface) → showing
scope end → dismissing (forced)
requested → dismissing (cancelled while the gate decision is pending)
queued → rejected (e.g. coach-mark target never appears)
```

## 9. Session

```
guest → authenticating → authenticated ⇄ refreshing
authenticated → expired | revoked → guest | authenticating
authenticated(embedded) — host-bridged variant
```

## 10. Persistent slice (user data)

```
unloaded → loading → migrating? → ready ⇄ saving
ready → conflicted → (resolver) → ready
loading → failed → ready(defaults, reported)
session end → flushed → cleared(policy)
saving → ready (failed save; error reported, data kept dirty)
cleared → loading (reload after logout / identity switch)
```

## 11. Meter reservation (credits/quotas)

```
estimating → reserved → committed | released | expired
estimating → released (cancelled before the server answered)
reserve → denied(quota | rate)
```

## 12. Cross-lifecycle invariants

| ID | Invariant | Error |
|---|---|---|
| I-1 | Nothing executes in app `paused` except the resume path | SF-APP-001 |
| I-2 | A longer-lived scope never holds a shorter-lived unit | SF-DI-002 |
| I-3 | A unit is `ready` only if all required deps are `ready` | SF-DI-003 |
| I-4 | No dependency cycles | SF-DI-004 |
| I-5 | Feature `mounted` ⇒ feature logic `activated` | SF-FT-001 |
| I-6 | A feature cannot deactivate while a dependent feature is mounted (ref-count) | SF-FT-002 |
| I-7 | A surface cannot outlive its owning scope | SF-MSG-001 |
| I-8 | A gated-out feature's chunk is never fetched | SF-GATE-001 |
| I-9 | Replicas never mutate; writes are intents to the owner | SF-WK-002 |
| I-10 | Responses tagged with a stale epoch are discarded | SF-DATA-001 |
| I-11 | Render deps are never read before ready | SF-UI-001 |
| I-12 | Disposed handles are never used | SF-CORE-001 |
| I-13 | Intents never auto-execute unless policy marks them safe | SF-URL-001 |

## 13. Error format

Every `SfError` carries: `code` (stable), `message` (one line), `units` involved, `scope`, `traceId`, `fix` (suggested remedy), `docs` (link into the machine-readable catalog `docs/errors.json`). Agents look codes up instead of guessing.

## 14. Package-level machines (added during implementation)

| Machine | States / transitions | Source |
|---|---|---|
| `platform/ai-probe` | unknown → probing → available \| downloadable \| downloading \| unavailable | `packages/platform/src` |
| `platform/facts-source` | idle → listening → disposed | `packages/platform/src` |
| `config/provider` | not-ready → ready ⇄ stale; ready → error → ready; any → fatal | `packages/config/src/resolver.ts` header |
| `i18n/locale` | idle → loading → active; loading → failed (previous locale kept) | `packages/i18n/src` |
| `i18n/catalog` | unloaded → loading → loaded \| failed | `packages/i18n/src` |
| `a11y/focus-trap` | inactive → active → released (focus restored) | `packages/a11y/src` |
| `handoff/entry` | absent → stored → taken \| expired | `packages/handoff/src` |
| `urlstate/intent` | captured → held → authorized → delivered → stripped; captured → rejected | `packages/urlstate/src` |
| `loader/chunk` | unloaded → gated? → loading → loaded \| failed (retry with cache-bust) \| denied | `packages/loader/src` |
| `loader/warmup` | idle → scheduled → warming → warmed \| skipped (backoff facts) | `packages/loader/src` |
| `perf/journey` | open → (phases accumulate) → complete \| abandoned | `packages/perf/src` |
| `capabilities/invocation` | validating → authorizing → confirming → activating → reserving → running → committing → done; any → denied \| cancelled \| failed (reservation released) | `packages/capabilities/AGENTS.md` |
| `advisors/consultation` | idle → asking → answered \| timed-out (default used) \| failed | `packages/advisors/AGENTS.md` |
| `ai/model-availability` | unknown → unavailable \| downloadable → downloading → available | `packages/ai/AGENTS.md` |
| `webmcp/publisher` | unsupported \| idle → publishing → published → unpublished | `packages/webmcp/AGENTS.md` |
| `worker/frame-channel` | idle → handshaking → open → closed (mode: shared ring buffer \| double-buffered transfer) | `packages/worker/src/frame-channel.ts` |
| `wasm/module` | declared → detecting → compiling → instantiating → ready; any → failed | `packages/wasm/AGENTS.md` |
| `surface/lifecycle` | created → attached → (resizing) → detached → disposed | `packages/surface/AGENTS.md` |
| `surface/frame-loop` | stopped → running ⇄ paused → stopped | `packages/surface/AGENTS.md` |
| `storage/idb-connection` | closed → opening → open → blocked \| closed | `packages/storage/AGENTS.md` |
| `storage/tiered-flush` | clean → dirty → flushing → clean \| failed (retry) | `packages/storage/AGENTS.md` |
| `hydrate/island` | static → scheduled → loading → hydrating → interactive; any → failed (retryable) \| skipped (gate denied / never) | `packages/hydrate/AGENTS.md` |
| `hydrate/snapshots` | idle → restoring → restored → saving ⇄ restored; restore skipped on epoch change | `packages/hydrate/AGENTS.md` |
| `worker/tab-coordinator` | candidate → leader \| follower; leader → stepping-down → candidate; follower → candidate (leader lost); terms numbered, stale terms dropped | `packages/worker/AGENTS.md` |
| `sandbox/plugin` | loading → handshaking → running ⇄ restarting → failed \| killed \| stopped | `packages/sandbox/AGENTS.md` |
| `pwa/sw-lifecycle` | installing → installed → activating → activated → redundant | `packages/pwa/AGENTS.md` |
| `pwa/update` | idle → checking → available → activating → activated \| failed; reload fallback on framework-major change | `packages/pwa/AGENTS.md` |
| `platform/async-fact` | idle → probing → settled \| failed (`SF-PLAT-009`: throw, timeout); probing → idle when every caller aborted; settled \| failed → probing on `refresh`; any → disposed (scope) | `packages/platform/src/async-facts.ts` |
| `platform/baseline` (verdict, not a machine) | pending → supported \| unsupported; a synchronous miss is `unsupported` at once and probes nothing; `unsupported` boots only the unsupported plan (`SF-PLAT-010`) | `packages/platform/src/baseline.ts` |

| `testkit/fake-gpu-device` | live → lost (`destroyed` via `destroy()`, `unknown` via `loseDevice`); terminal: `lost` resolves once, pending maps reject (AbortError), submit no-ops, no errors reported | `packages/testkit/src/gpu-fake.ts` |
| `testkit/fake-gpu-adapter` | valid → consumed (first `requestDevice`); `requestDevice` on consumed rejects (OperationError) | `packages/testkit/src/gpu-fake.ts` |
| `testkit/fake-gpu-buffer` | unmapped → pending → mapped → unmapped; pending → unmapped (unmap/destroy/device loss rejects the map) | `packages/testkit/src/gpu-fake.ts` |
| `testkit/fake-canvas-texture` | acquired (`getCurrentTexture`) → presented/expired (`present`, `unconfigure`); using it after → validation error | `packages/testkit/src/gpu-fake.ts` |
| `testkit/media-handle` | open → closed (terminal; `clone` adds a handle on the same resource; use after close → InvalidStateError) | `packages/testkit/src/media-fake.ts` |
| `testkit/golden` | missing → written (update mode) · stored → match \| mismatch (SF-TEST-009) \| updated (update mode) | `packages/testkit/src/golden.ts` |


## 15. Document engine v2 machines (SF-Δ3–Δ6, Instaflow M1 · A4)

| Machine | States / transitions | Source |
|---|---|---|
| `document/repo-document` | open ⇄ compacting; open → closing → closed. Compaction inside `closing` keeps the state. Writes and part loads are valid in open and compacting; any use after `closed` → `SF-DOC-014` | `packages/document/src/repo.ts` (`RepoDocumentMachine`) |
| `document/part` | unloaded → loading → loaded → unloaded (evicted); loading → failed → loading (retry on next `part()`). Eviction is refused while the part has non-durable commits (`SF-DOC-015`) | `packages/document/src/repo.ts` (`PartState`) |
| `document/gesture` | open → committed \| aborted. A commit that fails validation leaves the gesture open (fix or abort); staging after the end → `SF-DOC-014` | `packages/document/src/gesture.ts` (`GestureMachine`) |
| `document/commit-durability` | applied (in memory, broadcast) → durable (log seq assigned); applied → failed append → retried in order on the next commit or `flush()` (`onPersistError`) | `packages/document/src/repo.ts` |

Invariants:
- **I-D1** One logical transaction = one commit record, even when it touches several parts (cross-page move); parts are
  validated together before any is applied.
- **I-D2** Log appends are strictly in commit order; a failed append blocks later ones until it succeeds.
- **I-D3** The head is replaced only by compare-and-swap on `generation` (`SF-DOC-011`); compaction never truncates log
  entries it did not fold into the new snapshots.
- **I-D4** Engine handles: after `dispose()` / eviction / close, the engine's live handle count returns to its baseline
  (`SF-DOC-018` names a violation).


## 16. Blob store (`@staticflux/blob`, Instaflow M1 A3)

```
blob/store-leader:   waiting → recovering → leading
                     recovering → waiting            (lead() failed: lock released, retried after retryMs)
                     any → disposed
blob/folder-mirror:  idle → scheduled → flushing → idle | scheduled (more changes arrived)
                     idle | scheduled | flushing → paused     (folder permission lapsed: read-only)
                     paused → flushing                        (regrant(): full sync, then idle)
                     any → disposed
```

| Invariant | Error |
|---|---|
| A commit is acknowledged only after its journal record is flushed (sync handle) or published (temp + `move()`) | — |
| A head is replaced only by temp file + `move()` under `<prefix>:head:<name>`, and only if its `generation` is unchanged | SF-BLOB-003 |
| A head that fails its checksum is reported, never overwritten by CAS | SF-BLOB-010 |
| Only the leader opens journals and swaps Latest heads | SF-BLOB-014 |
| `logFrom` advances only when no dirty part has an uncovered record in an older segment | — |
| A folder head is swapped only after every object it names is in the folder; while paused nothing is written | SF-BLOB-004 |
| GC never sweeps with an incomplete mark set and never deletes an object inside the grace period | SF-BLOB-006 / SF-BLOB-007 (run aborted) |
| An object that fails `verify` is quarantined and no longer served | SF-BLOB-002 |


## 17. Worker pipeline (SF-Δ17–Δ19, Δ22, Δ28; Instaflow M1 A5)

Topology-neutral pipes between the editor and render modules (D15). Every machine below behaves the same on the
`local`, `shared` and `message` media; the contract suites in `packages/testkit` run each case on all three.

| Machine | States / transitions | Source |
|---|---|---|
| `worker/delta-reader` | awaiting-snapshot → live; live → resyncing (gap, epoch change without snapshot, gone blob) → live (snapshot of a newer epoch); resyncing → resyncing (another gap); any → closed | `packages/worker/src/delta-stream.ts` |
| `worker/peer-channel` | waiting → connected; connected → connected (re-wire: new generation) \| disconnected → connected; any → closed | `packages/worker/src/peer-channel.ts` |
| `worker/handle` (ownership of one `Owned`) | live → closed \| sent \| released \| leaked (wrapper collected unclosed, or live at ledger dispose; the handle is closed and reported) | `packages/worker/src/handle-channel.ts` |
| `worker/seqlock-cell` (one write) | even (stable) → odd (writing) → even; readers retry while odd or changed, return the last good copy marked `stale` after `maxRetries` | `packages/worker/src/seqlock-cell.ts` |
| `runtime/worker-scheduler` | running ⇄ paused → disposed (queued tasks fail with SF-SCHED-002) | `packages/runtime/src/worker-scheduler.ts` |

| ID | Invariant | Error |
|---|---|---|
| P-1 | Ordered apply: deltas apply in `base → version` order; a gap or an epoch change resyncs from a newer-epoch snapshot while the last good state stays (E-1) | SF-WK-034 (writer) |
| P-2 | No torn reads: a cell read returns the value of exactly one completed write (seqlock; checksum detector in tests) | — |
| P-3 | Lossless rings: every record pushed after a reader's endpoint is delivered to it once, in order, or the push fails | SF-WK-036 |
| P-4 | A delta never applies before the blobs it references; a gone blob forces a resnapshot | SF-WK-041 |
| P-5 | One owner per handle: after send/release the sender cannot use it; a closeable handle is closed once (by its owner, or as a reported leak) | SF-WK-037, SF-WK-038 |
| P-6 | Peer generations only increase; a re-wire cleans up the previous connection before `onConnect` runs again | SF-WK-040 |
| P-7 | Supersede-on-ack: an overlay disappears in the step that applies its acked version; a late ack of an older intent never removes a newer overlay (E-2) | — |
| P-8 | Worker scheduler: nothing runs while paused (I-1); interaction before critical before visible before idle | SF-SCHED-002 |

| `kit/resize` | idle → resizing (pointer drag, `move` repeats) → idle (`end` commits one `sf-resize`, `cancel` restores the size); keyboard steps commit directly | `packages/kit/src/internal/resize.ts` |
| `kit/tree-drag` | idle → dragging (`over` repeats, drop target filtered by `canDrop`, never into the own subtree) → idle (`drop` fires cancelable `sf-reorder`, `cancel` on dragend) | `packages/kit/src/tree.ts` |


## 18. Stage and undo (`@staticflux/stage`; SF-Δ7, Δ9, Δ10; Instaflow M1 A8)

| Machine | States / transitions | Source |
|---|---|---|
| `stage/undo-step` (one step of one actor) | done (on the undo stack) → undone (applied undo; on the redo stack) → done (applied redo); done → dropped (beyond the per-actor limit, 200); undone → dropped (a new edit by the same actor clears redo). A `conflict` outcome is not a transition: the step stays where it is until the user retries with `overwrite` or `keep-theirs`. A `keep-theirs` undo that restores nothing drops the step (nothing to redo) | `packages/stage/src/undo.ts` |
| `stage/composition` (one cached stage node) | absent → cached (first `read`) → absent (a dependency changed: raw node, layer entry, variant selection, resolved reference, another composition); all → absent on `addLayer` / layer removal; any → disposed | `packages/stage/src/stage.ts` |

| ID | Invariant | Error |
|---|---|---|
| U-1 | Undo and redo apply only the acting actor's own steps (stacks keyed by `meta.actor.id`), as ONE new commit by that actor; other actors' edits are never reverted | — |
| U-2 | An undo or redo over a target changed after the step (by anyone) is flagged as a typed `conflict` and writes nothing, unless the caller chose `overwrite` or `keep-theirs` (D14) | — (typed outcome) |
| U-3 | Stacks are a pure function of the actor's persisted history (`undoOf` / `redoOf` links in commit meta), so a reload rebuilds the same stacks up to the repo's undo horizon | — |
| U-4 | Every write through the undo service (edit, gesture, undo, redo) passes the write guard (locks, final paths) | SF-STAGE-001…003 |
| S-1 | A stage read equals a fresh composition: invalidation removes every cached composition that read a changed dependency, transitively | — |
| S-2 | Final paths and policy locks win regardless of strength; the opinions they beat are reported as `ignored` | — |

## 19. Editor ↔ render sequencing (Instaflow M1 A7; D15, ARCHITECTURE §4)

Editor and render are modules behind fixed ports (input ring, scene deltas, view-state frames, optional main tick cell).
One worker (`colocated`, default) or two (`split`) is a boot setting; both run the same module code and the same oracle suite.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/render-module` | waiting → presenting (first consistent frame drawn) \| holding; presenting → holding (frame ahead of the deltas, or the delta reader resyncing); holding → presenting; any → disposed | `apps/instaflow/src/sequencing/render-module.ts` |
| Boot (`bootSequencing`, not a machine) | plan (topology → workers + media) → create input ring and tick cell → spawn workers → `start` each with its roles → (split) relay the editor's pipe endpoints to the render worker (`attach`) → running; any failure stops every worker (IF-SEQ-001) | `apps/instaflow/src/sequencing/boot.ts`, `host.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| E-1 | Ordered apply: deltas apply in increasing `docVersion`; a gap or epoch change resyncs from a snapshot and the last good frame stays | P-1; oracle fault cases (every 25th delta lost) |
| E-2 | Atomic supersede: the render applies deltas only up to the frame's `docVersion` and draws only at equality, so overlay `g` disappears in the frame that applies the delta superseding `g` | `overlayAfterCommit` = 0 in every oracle run |
| E-3 | Overlays are offsets over committed state; a remote move of a target composes; a remote delete of a target cancels the gesture | IF-ENG-001 (value, toast) |
| E-4 | A hit test uses the camera after exactly the inputs before it (the view frame carries `inputSeq`) | oracle camera equality |
| E-5 | One transaction per gesture (pointerup) or per nudge; moves never write the CRDT | oracle commit counts |
| E-6 | Animation is an override (no playback path in M1; enforced when M3 adds it) | — |
| Q-1 | Deltas are published before the view frame that references them; a resnapshot is answered at a step boundary with a fresh frame | `editor-module.test.ts` |
| Q-2 | The render port is called at most once per new (viewSeq, docVersion) and only with a consistent pair | IF-SEQ-003 on draw failure (last good frame kept) |

## 18. Render: GPU devices, tiles, layers, cache budgets (SF-Δ23, Δ24, Δ29; Instaflow M1 A6)

| Machine | States / transitions | Source |
|---|---|---|
| `surface/gpu-device` | idle → attaching → running; attaching → failed; running → lost (`device.lost`, any reason but our own dispose) → attaching (fresh adapter + `restore`) → running; attaching → failed → attaching (next recovery attempt, back-off); failed → attaching (manual retry); * → disposed | `packages/surface/src/gpu-device.ts` |
| renderer phase | cold → warming (`warmUp`) → ready; warming → cold (warm-up failed) | `packages/surface/src/tiled-renderer.ts` |
| tile (cache entry) | absent → fresh (rendered) → stale (an edit hit it; still drawn) → fresh (re-rendered into the same slot); any → evicted (LRU, budget or pressure; never while pinned by the frame); all → forgotten (device lost) | `packages/surface/src/raster-tile-cache.ts` |
| lifted layer | lifted (`lift`: nodes leave the tiles) → dragging (quad moves, no raster) → dropping (`drop`: nodes back in the tiles, texture still drawn) → released (every visible tile under it fresh) | `packages/surface/src/tiled-renderer.ts` |
| cache registration (memory ledger) | registered → reporting ⇄ evicting (budget or pressure) → disposed | `packages/runtime/src/memory-budgets.ts` |

| ID | Invariant | Error |
|---|---|---|
| G-1 | A lost device is never reused: recovery always requests a new adapter and rebuilds from the retained CPU-side scene, never the document | SF-SURF-011 |
| G-2 | Recovery time is reported; over its budget (1 s) it is flagged but completes | SF-SURF-012 |
| G-3 | No holes: a visible tile is drawn from its stale copy, another level or the snapshot until it is fresh | — |
| G-4 | In-frame raster starts only while the in-frame budget is left; the rest goes to the idle lane | — |
| G-5 | A dropped layer is drawn until the tiles under it are fresh (overlay off and committed on in one frame, E-2) | — |
| G-6 | Frames never rasterize before warm-up (cold pipelines); the snapshot is drawn instead | — |
| G-7 | Caches are evicted before features are demoted; pinned (visible) tiles are never evicted | SF-MEM-001 |

## 23. Versioning: Latest save state, milestone creation (Instaflow M1 B5; D2, D10)

Latest is saved continuously (no save button); milestones are explicit, immutable full snapshots of canonical parts.
Both machines live in `apps/instaflow/src/versioning`. The frozen export snapshot and New document from milestone are
single calls, not machines.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/latest-save` | saved → saving (commit) → saved (acked: the newest commit is durable); saving → stalled (2 s without an ack, or an append failed) → saving (retry after `retryMs`) \| saved (acked); stalled → stalled (commit, stall); any → disposed | `apps/instaflow/src/versioning/latest.ts` |
| `instaflow/milestone-create` (one per call, queued per document) | queued → flushing (Latest flushed) → capturing (canonical parts; only changed parts encoded and written) → recording (record blob; id = digest) → swapping (head CAS + retry, then mirror flush) → created; any non-terminal → failed | `apps/instaflow/src/versioning/milestones.ts` |

Top-bar status derived from `instaflow/latest-save` and the folder mirror (`blob/folder-mirror`): saving/stalled →
`saving` (stalled = "Not saved yet: <cause>"); saved + mirror paused, read-only or failing with pending changes →
`offline-mirror-behind`; otherwise `saved`.

| ID | Invariant | Error / test |
|---|---|---|
| V-1 | An acknowledgement only clears `saving` when no newer commit is unacknowledged | `latest.test.ts` |
| V-2 | A milestone writes only parts whose canonical digest is new; unchanged parts share digests with earlier milestones | `milestones.test.ts` |
| V-3 | Milestone records are immutable: pin and rename change head fields only | `milestones.test.ts` |
| V-4 | Creating, opening and branching from a milestone never read older milestones (cost independent of age) | `costs.test.ts`, `versioning.bench.ts` |
| V-5 | Versioning head updates are CAS with retry and survive the repo's compaction (which adopts the newer head) | IF-VER-004 |
| V-6 | A new document from a milestone names no source object (fresh peer and history; `createdFrom` is a label) | IF-VER-008; `new-document.test.ts` |
| V-7 | A frozen snapshot writes no record and no head; later edits never change what it reads | `snapshot.test.ts` |
| V-8 | A template use with an invalid fill or an empty required slot writes nothing | IF-VER-006, IF-VER-007 |

## 20. Editor spec runtime (`@staticflux/shell/spec` + `apps/instaflow/src/spec`; Instaflow M1b B0, D16)

An editor is a spec over a closed vocabulary of registered contributions. The runtime validates and gates a spec, diffs
it against what is mounted and drives a mount port with the minimal changes; proposals carry a spec from a person, a
preset or an agent through validation and (for agents in Plan/Ask) a preview.

| Machine | States / transitions | Source |
|---|---|---|
| `shell/spec-runtime` (one editor surface) | empty → applying (a valid spec) → mounted (`settle`) \| empty (`clear`: the spec mounted nothing); mounted → applying (next spec, `revalidate`); any → disposed (every slot unmounted, 0 ms). An invalid or gated spec never leaves `empty`/`mounted` (nothing is touched); applies are serialized | `packages/shell/src/spec-runtime.ts` |
| layout entry (`createSpecLayoutPort`, one slot) | absent → entering (mount, motion > 0) → present (after the step); absent → present (0 ms); present → moving (move) → present; present → exiting (unmount) → absent (after the step); 0 ms or an aborted step settles at once | `packages/shell/src/spec-layout-port.ts` |
| `instaflow/spec-proposal` | proposed → validated → previewing (agent in Plan/Ask) → mounting (`open`) → mounted; validated → mounting (person, preset, agent in Accept edits/Autopilot); proposed \| validated \| mounting → rejected (schema IF-SPEC-001, vocabulary or gating SF-SHELL-009 — also when a preview is no longer allowed on `open`); previewing → declined \| superseded (a newer preview); mounting → failed (the port failed every slot it touched); mounted → superseded (a later spec mounted). Terminal: rejected, declined, superseded, failed | `apps/instaflow/src/spec/proposals.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| SP-1 | Closed vocabulary: a spec names only registered sections and contributions; every problem is reported at once with its own code and fix, and nothing mounts | SF-SHELL-009 (`details.issues`: 010 unknown, 011 context, 012 gated, 013 slot) |
| SP-2 | Specs never bypass gating: every slot with a gate resource is decided through the `DecidePort` (`@staticflux/gate`, agents as agents); gating wins over pinning | SF-SHELL-012; `runSpecRuntimeContract` |
| SP-3 | Minimal diff: a slot present before and after is never unmounted; mounts and unmounts are exactly the set differences; moves are placement changes plus, per group, size − longest kept run | `runSpecRuntimeContract` (property) |
| SP-4 | Pinned slots are never removed by a new spec (only `unpin` by the person, or a gate denial) | `runSpecRuntimeContract` (property) |
| SP-5 | Port order per apply: unmounts (reverse display order), moves, context, mounts (display order), all started in one task; each step 120–200 ms, 0 under reduced motion | `runSpecRuntimeContract`, `runSpecMountPortContract` |
| SP-6 | A port's view equals the runtime layout after every apply (insert after `diff.after` anchors) | `runSpecMountPortContract` (layout model, `<if-studio>` DOM) |
| SP-7 | Proposal routing is data (`PROPOSAL_ROUTES[source][autonomy]`); an agent's spec mounts only in Accept edits or Autopilot, or when the person opens its preview | `proposals.test.ts` |

## 21. Elements, masks, booleans and render resources (Instaflow M1b B1)

Element state is document data (no runtime machines): booleans and masks are **derived** from components, so every
"transition" is one change set, undoable as one step, and never destroys the operands or the masked content.

| Machine | States / transitions | Source |
|---|---|---|
| boolean group (data) | plain group ⇄ live boolean (`geometry.boolean` set / `null`); live → released (`releaseBoolean`: operands back in the parent at the same page position, group deleted); live → flattened (`flatten`: one vector with the derived outline, same style and match key; operands deleted) | `apps/instaflow/src/elements/actions.ts` |
| mask (data) | none → masking (`mask.mode` set; the element stops drawing and masks the later siblings) ⇄ mode / invert changes; masking → none (`releaseMask`: nothing else changes) | `actions.ts`, `scene.ts`, `crates/render/src/draw.rs` |
| render resource (look, path, ring) | absent → defined (first `intern`, sent in the next resource batch) → defined (more users) → dropped (last `release`, sent as a drop); defined-and-released before a batch is never sent | `apps/instaflow/src/elements/projection.ts` |
| projected element (render source) | absent → projected (created, or no longer a boolean operand) → projected (moved / updated: only changed render paths) → absent (deleted, or became an operand) | `projection.ts` (`createElementRenderSource`) |

| ID | Invariant | Error / test |
|---|---|---|
| EL-1 | Every element action and panel edit is one change set = one undo step, checked for value shapes, locks, finals and brand rules before it commits | IF-EL-001, SF-STAGE-001…003, IF-EL-003; `actions.test.ts`, `brand-kit.test.ts` |
| EL-2 | Boolean results and masks are derived: operands and masked content stay in the document unchanged; release restores the exact previous drawing | `actions.test.ts` (release, operand edit re-derives) |
| EL-3 | A resource batch reaches the render side before the projection delta that references it (same ordered channel); a look or path that arrives late re-encodes the slot | `projection.test.ts`, `scene.test.ts` |
| EL-4 | Ink bounds include strokes and effects (shadows, glows, blur), so tiles never clip them; a non-inverted mask clips them | `layout.test.ts`, Rust `ink_bounds` tests |
| EL-5 | Match keys survive duplication (elements and pages) while node ids stay unique | `actions.test.ts` (duplicate) |
| EL-6 | Scene IR v2 bytes are identical from TypeScript and Rust; GPU output matches vello_cpu within `gpuVsCpu` | `scene-ir.test.ts`, `render.gpu.test.ts` |

## 27. Repeat (Instaflow M1b B7)

A repeat is document data (`repeat.*` on a group); its instances are derived by the repeat view and never stored. Every
transition except a handle drag's preview is one change set, undoable as one step.

| Machine | States / transitions | Source |
|---|---|---|
| repeat group (data) | plain group → live repeat (`makeRepeat` wraps siblings, or `repeat.kind` set) ⇄ parameter / generator changes (`setRepeat`); live → plain group (`releaseRepeat`: parameters cleared, source unchanged); live → expanded (`expandRepeat`: real instance groups, the source in the first, deterministic keys; the group stays a plain group) | `apps/instaflow/src/repeat/actions.ts` |
| derived instance (view) | absent → present (count grows, the repeat becomes live, or a source node is created) → present (source or parameters change: re-derived) → absent (count shrinks, release, expand, source deleted) | `apps/instaflow/src/repeat/stage.ts` |
| `instaflow/repeat-handle-drag` | dragging → dragging (`move`: session-layer preview) → committed (`commit`: one change set) \| cancelled (`cancel`, Esc, `AbortSignal`, or a commit with nothing to write) \| failed (the commit was refused: locks, values); the session preview is cleared on every exit. Terminal: committed, cancelled, failed | `apps/instaflow/src/repeat/handles.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| REP-1 | Instances are derived: the document holds only the source and the parameters; derived nodes are locked in the view and any write that targets one is refused | IF-REP-004; `stage.test.ts` |
| REP-2 | The view shows exactly `instanceCount(params)` instance wrappers, each with a full copy of the source; instance 0 is the identity and holds the real source nodes | `stage.test.ts`, `instances.test.ts` (properties) |
| REP-3 | Editing the source invalidates every copy and the wrappers of every repeat above it; dropped wrappers are invalidated so the projection deletes them | `stage.test.ts`, `actions.test.ts` (incremental projection) |
| REP-4 | Expand is one undo step and its render equals the live render | `actions.test.ts` (property) |
| REP-5 | Match keys are deterministic: instance `k` of key `key` is `key~k` live and expanded; re-expanding writes the same keys | `actions.test.ts` (property) |
| REP-6 | A handle drag writes nothing until commit and leaves no session opinion behind on any exit | IF-REP-005; `handles.test.ts` |
