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

## 22. Text: input, composition, fonts and layout (Instaflow M1b B2; SF-Δ27)

| Machine | States / transitions | Source |
|---|---|---|
| `TextInput` (port) | created → focused ⇄ blurred; focused → composing (`compose-start`) → composing (`compose-update`, `format`) → focused (`compose-commit` \| `compose-cancel`); any → disposed (listeners removed, hidden textarea removed, `host.editContext = null`) | `packages/surface/src/text-input.ts` |
| text session (composition) | idle → previewing (`compose-start`: the composition is a local splice, underlined, laid out) → previewing (`compose-update`) → idle (`compose-commit`: one commit replaces the composition range; `compose-cancel`: nothing written) | `apps/instaflow/src/text/text-session.ts` |
| `instaflow/local-fonts` | unknown → unavailable (no `queryLocalFonts`, terminal) \| prompt \| granted \| denied; prompt → requesting (`request`, from a user gesture) → granted \| denied \| prompt (`cancel`: no user activation); granted → requesting \| prompt (`revoked`) \| denied; denied → prompt \| granted (site settings changed) | `apps/instaflow/src/text/fonts.ts` |
| layout engine build | base (`authoring-text`) → base + complex (`prepare(text)` with Thai, Lao, Khmer or Myanmar: the `authoring-text-complex` chunk loads once, replays fonts and fallbacks, same font ids); a failed load stays on base (retry on the next `prepare`) | `apps/instaflow/src/text/text-engine.ts` |
| text block (layout) | absent → laid out (`layout(id, spec)`, retained in the Wasm) → laid out (relayout replaces it; a block moves between builds when its text starts or stops needing complex scripts) → absent (`drop`) | `text-engine.ts`, `crates/authoring/src/text` |
| scene font (render) | absent → retained (`FONT` with bytes; keyed by sha-256) → aliased (`FONT` without bytes: more ids, one copy) → released (no id references it at the end of a batch); `CLEAR` drops ids, a resnapshot in the same batch re-aliases without resending bytes | `crates/render/src/ir.rs`, `text-scene.ts` (`createSceneFontTable`) |

| ID | Invariant | Error / test |
|---|---|---|
| TXT-1 | Offsets are UTF-16 code units everywhere (TextInput, session, CRDT, layout); paragraph breaks are one `\n`; the content always ends with its final break, which is never deleted | IF-TXT-003; `rich-text.test.ts` |
| TXT-2 | IME compositions never reach the document before `compose-commit`; collaborators only see committed text | `text-pipeline.test.ts` (IME preview) |
| TXT-3 | Collapsed deletes expand by the layout's grapheme / word / line boundaries (conjuncts, ligatures, emoji removed whole) | `text-pipeline.test.ts`, Rust `caret_motions` |
| TXT-4 | Concurrent rich-text edits converge with marks covering the same characters; paragraph styles live on breaks (expand `none`), so splits and merges converge | `rich-text.test.ts` (fast-check, three peers) |
| TXT-5 | Every peer creates its Loro engine with `TEXT_MARK_EXPAND` (one mark-expand table, A4 rule) | `model.test.ts` |
| TXT-6 | Font bytes are content-addressed: registered once per hash in the layout engine and retained once per hash in the render scene | IF-TXT-006; `text-engine.test.ts`, Rust `fonts_are_retained_by_hash…` |
| TXT-7 | Clusters (logical order), words and lines have stable indices for a given text and layout (animation targets, M4) | Rust `clusters_words_and_lines_have_stable_logical_indices`, `text-engine.test.ts` |
| TXT-8 | Which TextInput runs is a variant binding on the `editContext` platform fact; feature code never branches on the browser | `text-input.test.ts` (variant binding) |
| TXT-9 | Text glyphs drawn by Vello GPU match the vello_cpu reference (Latin, Arabic, Devanagari), from both the Rust batch and the TypeScript pipeline | `render.gpu.test.ts` (`gpu-text`, `ts-text`) |
| TXT-10 | **PASS (owner, 2026-10-25, Chrome 155 on macOS; `docs/instaflow/checks/2026-10-25-ime.md`):** with a real OS IME (Japanese, Chinese, Korean) in desktop Chrome, the candidate window sits at the caret / composition, follows wrapped lines and RTL positions, and survives page zoom | Human check: `pnpm ime-check` (page `apps/instaflow/src/text/ime-check/`, steps on the page) |

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

## 24. Library: ingest and rendition jobs (Instaflow M1b B4; IF-3.5–3.9, IF-23)

Both machines live in `apps/instaflow/src/library`. Library metadata changes (rename, tags, folder, favourite, trash,
restore) are single commits on the library document, not machines; trash is a state (`trashedAt`), never a delete.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/library-ingest` (one per file) | provisional (listed under `pv_…`) → hashing (blob store put, progress) → probing (kind's media probe) → recording (asset record blob) → listed (one library commit); hashing → listed (same content already live: deduplicated); any non-terminal → failed (error, or cancelled through the signal: `SF-CORE-002`) | `apps/instaflow/src/library/ingest.ts` |
| `instaflow/rendition-job` (one per asset × role) | queued → decoding → rendering → storing → done (rendition recorded in the library document); queued \| decoding \| rendering \| storing → failed (`IF-LIB-006`) \| cancelled (`cancel(asset)`, queue disposed) | `apps/instaflow/src/library/renditions.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| L-1 | Nothing is listed before the content and the immutable record are stored; a failed or cancelled import lists nothing | IF-LIB-001/002/005, SF-CORE-002; `ingest.test.ts` |
| L-2 | The same bytes never become two live assets (dedupe by content digest); a trashed copy does not count | `ingest.test.ts` |
| L-3 | Asset records are immutable; all mutable metadata and late renditions live in the library document | `records.test.ts`, `library.test.ts` |
| L-4 | A rendition job writes nothing before its blob is stored; regenerating with the same params gives the same blob | IF-LIB-006; `renditions.test.ts` |
| L-5 | `resume()` re-queues exactly the live entries still missing a rendition their kind gets (`RENDITION_PRODUCERS`) | `renditions.test.ts`, `units.test.ts` |
| L-6 | Trashed entries stay GC roots for 30 days (`TRASH_RETENTION_MS`) | `library.test.ts` |
| L-7 | Lens code never branches on the lens: the arrangement, focus and overview come from the feature registry (Canvas is the fallback) | IF-LIB-012; `features.test.ts`, `controller.test.ts` |

## 25. Tools: pointer gestures (Instaflow M1b B3)

The pointer tools of one tab are a small machine; everything a gesture changes is a session-layer preview until the
release commits it as one change set.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/tool-gesture` (one per tab) | idle → pressed (`press`: pointer down; a press on an unselected element selects it at once); pressed → idle (`release` within the drag slop: click semantics; `cancel`); pressed → moving \| resizing \| rotating \| marqueeing \| panning (the kind is `PRESS_GESTURES[behaviour][pressTarget]`); each of those → idle (`release`: commit or keep the selection; `cancel`: Escape or pointercancel, nothing committed). A gesture that cannot begin (IF-TOOL-002) returns to idle | `apps/instaflow/src/tools/gesture.ts` |
| view state (per tab, data) | selection, entered container and camera change only through the tab's `ViewState`; Escape or a click on empty canvas returns to the root container with an empty selection | `apps/instaflow/src/tools/view-state.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| TL-1 | One gesture (move, resize, rotate) commits exactly one change set = one undo step on release; pointer moves write only session-layer previews; cancel writes nothing and clears them | `gesture.test.ts` |
| TL-2 | Position-locked elements never move; a gesture or key command with nothing movable is a value, not a throw | IF-TOOL-002; `transform.test.ts`, `keyboard.test.ts` |
| TL-3 | A target deleted during a gesture is dropped and pruned from the selection; with none left nothing commits | IF-TOOL-004; `gesture.test.ts` |
| TL-4 | Broad + narrow hit testing and marquee equal their brute-force references | `hit-test.test.ts` (fast-check parity) |
| TL-5 | Snapping moves a box by at most the threshold, and a snapped box snaps to itself | `snapping.test.ts` (fast-check) |
| TL-6 | View state is per tab and never written to the CRDT or the store | `view-state.test.ts` |

## 26. Accessibility layer (Instaflow M1b B6)

The canvas projection of one tab and its selection announcer are two small machines; the focus path is data derived from
the tab's view state.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/a11y-projection` (one per tab) | dirty (initial) → clean (`flush`: a snapshot is projected and applied); clean → dirty (`invalidate`: a stage invalidation or a camera, viewport, selection or entered-container change; one flush is scheduled per burst); clean \| dirty → disposed (`dispose`, with the tab scope). Terminal: disposed | `apps/instaflow/src/a11y/projection.ts` |
| `instaflow/a11y-announce` (one per tab) | idle → pending (`change` of selection or entered container); pending → pending (`change`: the quiet period restarts); pending → idle (`speak`: one polite announcement); pending → holding (`hold`: a pointer gesture started); holding → holding (`change`); holding → pending (`release`: the gesture ended); any → disposed. Terminal: disposed | `apps/instaflow/src/a11y/announce.ts` |
| focus path (data) | focus node = last selected element (a derived instance → its source), else the entered container, else none (the canvas surface); DOM focus moves to it only while the canvas has focus | `apps/instaflow/src/a11y/projection.ts`, `dom.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| A11Y-1 | Projected ids are exactly the in-view elements with their own bounds, their ancestors, the selection and the entered container, in document order (equal to a brute-force reference under random edits and camera moves) | `projection.test.ts` (fast-check) |
| A11Y-2 | Derived repeat instances never get nodes; a selected instance focuses its source, described "instance k of n" | `projection.test.ts` |
| A11Y-3 | Exactly one projected node is in the tab order (the focus node), or none when nothing is selected | `projection.test.ts`, `dom.test.ts`, `studio-chrome.test.ts` |
| A11Y-4 | DOM focus follows B3's selection under B3's keys (Tab, Enter, Shift+Enter, Escape, arrows) and never leaves the canvas for `<body>`; focus moved by the layer is not reported back as a selection | `canvas-a11y.test.ts`, `dom.test.ts` |
| A11Y-5 | No announcement while a gesture runs; one polite announcement per settled change | `announce.test.ts` |
| A11Y-6 | A disposed projector or mount refuses work; a missing root page is a value, not a throw | IF-A11Y-002, IF-A11Y-001; `projection.test.ts`, `dom.test.ts` |

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

## 28. Render: GPU devices, tiles, layers, cache budgets (SF-Δ23, Δ24, Δ29; Instaflow M1 A6)

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

## 29. Studio integration: canvas pipeline, creation tools, text editing (Instaflow M1b B8)

Studio's live canvas wires M1b over A7's ports: B1's element render source on B7's repeat view publishes scene records
(resources, asset uploads, projection, text IR, in that order) and view frames; A7's render module draws consistent
pairs through the element render port. One canvas tab per shown page holds B3's tool session, the creation tools, B2's
editing session and B6's accessibility layer, all disposed with the tab scope.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/canvas-pipeline` | starting → running (`run`: streams attached, first snapshot and frame written) → stopped (`stop`, or the tab scope's signal); starting → stopped. Terminal: stopped | `apps/instaflow/src/app/canvas-pipeline.ts` |
| `instaflow/create-gesture` | idle → pressed (`press`, a creation tool is active) → drawing (`draw`: the pointer left the slop; the box shows as B3's marquee overlay) → idle (`release`: one create, the new element selected, the toolbar back on Select) \| idle (`cancel`: nothing written); pressed → idle (`release`: a click creates the tool's default size) | `apps/instaflow/src/app/creation.ts` |
| text editing (per tab) | none → editing (`editText`: Text tool click, or a double click on text; the text host is the focused `textbox`, canvas shortcuts off) → none (Escape / Tab, a pointer down elsewhere, the element deleted, page switch); an element left empty is deleted on exit | `apps/instaflow/src/app/text-editing.ts` |
| canvas tab | none → open (`showPage`: pipeline, tool session, accessibility layer on the page) → none (next `showPage`, or the canvas port stops); the raster outlives tabs | `apps/instaflow/src/app/studio-canvas.ts` |
| Studio scope | asset ⇄ selection (`setScope`, serialized: the canvas selection changed; the selection's HUD actions and inspectors mount) | `apps/instaflow/src/app/studio-app.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| INT-1 | Within a scene record, resources and asset uploads precede the projection payload that references them; a snapshot carries every live resource and upload | IF-INT-002; `canvas-pipeline.test.ts` |
| INT-2 | The render port draws only consistent frames (A7: records applied up to the frame's `docVersion`) | `canvas-pipeline.test.ts` |
| INT-3 | A creation gesture is one undo step; its preview never touches the document | `canvas-tab.test.ts` |
| INT-4 | A keystroke is one undo step: the text ops and the box size they imply share one change set | `canvas-tab.test.ts` |
| INT-5 | While text is edited the canvas shortcuts are inactive and the element's projected node is hidden from assistive technology (the text host is the textbox) | `canvas-tab.test.ts` |
| INT-6 | The IME control bounds are the committed block's, never the composition preview's | `text-session.ime.test.ts` |
| INT-7 | Every HUD click runs its capability through the one pipeline (validation, attribution, one change set); placeholders say they arrive later | `studio-app.test.ts` |
| INT-8 | While text is edited, a press inside its box places the caret or selects (Shift extends; 2 / 3 / 4 clicks = word / paragraph / all; a drag extends by the press's unit) and never ends editing; a press outside ends it. The caret, else the selection rects, are drawn in the overlay (never exported) | `text-editing.pointer.test.ts`, `canvas-tab.test.ts`; smoke (Mod+A, click, drag) |
| INT-9 | A text element's opacity, blend and effects apply to its text group as one layer (canvas, PNG, SVG, PDF alike, D21) | `text-tree.test.ts` (B12b: on the element's own node, the group's parent), `job.test.ts` |

## 30. Home route: Home model, the Home index, Studio over the workspace (Instaflow M1c C0; D17)

Home is a separate, light boot: it reads the Home index (a projection of the library in the library head, `app.home`)
from the persistent workspace store and links into Studio. Studio's store side keeps the index in step and plans its
document from the URL.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/home` | loading → ready (`loaded`) \| failed (`fail`: IF-HOME-001); ready → loading, failed → loading (`refresh`: bfcache restore, tab visible, "Try again"); any → disposed (`dispose`: the boot scope). Terminal: disposed | `apps/instaflow/src/home/model.ts` |
| Home index writer | idle → scheduled (`touch` / `describe`, a library change) → writing (debounce elapsed, or `flush`) → idle; writing → scheduled (a trigger during the write); a failed write stays dirty until the next trigger; disposed with the store side's scope (pending timer cleared, nothing written after) | `apps/instaflow/src/workspace/home-index-writer.ts` |
| Studio document plan | URL → `open` (existing design) \| `new` (fresh asset from a format, or B5 new document from a template's newest milestone) \| `demo`; then editor boot → listed (library entry added once the editor has the document) → URL replaced with `/s/:asset` (new designs) | `apps/instaflow/src/workspace/studio-document.ts`, `studio-session.ts` |
| Leaving Studio | Home link click → `if-navigate` (cancelled by the app) → Latest flushed → Home index flushed → navigate | `apps/instaflow/src/app/studio-app.ts`, `src/workspace/studio-session.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| HOME-1 | Home's entries never reach the editor, render, Loro / CRDT, worker, Wasm or GPU modules (D17) | `home-imports.test.ts`; smoke (no worker, no Wasm, no GPU adapter) |
| HOME-2 | The Home index changes only by compare-and-swap on the library head; other `app` fields are kept; an unchanged index is not written | IF-HOME-005; `home-index-writer.test.ts` |
| HOME-3 | `editedAt` never moves backwards; trashed entries are never listed | `home-index-writer.test.ts` |
| HOME-4 | A design is listed in the library only after the editor opened its document (no entry points at nothing) | `studio-session.test.ts` |
| HOME-5 | Every Home action, by hand or by an agent, runs through the capability pipeline and navigates only on success | IF-HOME-002/003; `model.test.ts` |
| HOME-6 | Leaving Studio by the Home link loses no edit: Latest and the index are flushed before the navigation | `studio-session.test.ts`; `home.smoke.mjs` |
| HOME-7 | The persistent store never reuses a log seq and serializes head swaps and appends per asset | SF-DOC-011; `document-store.test.ts` (DocumentStore contract) |

## 31. Export: the export job, the export worker, the export service (Instaflow M1c C1; D10, D21)

An export freezes Latest into a snapshot (B5), spawns one export worker, runs one job there and hands the files to the
person. Nothing is written to the document (D10).

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/export-job` | queued → opening (`open`: the snapshot opened read-only) → composing (`compose`: a page's scene) → rendering (`render`: PNG chunks or D21 raster patches) → composing (next page) \| writing (`write`: PNG encode, SVG / PDF writer) → done; any non-terminal → failed (`fail`) \| cancelled (`cancel`: the signal). Terminal: done, failed, cancelled | `apps/instaflow/src/export/job.ts` |
| Export service status | idle → running (`run`; progress events update it) → done \| failed \| cancelled; any of those → running on the next `run`; a `run` while running is refused (IF-EXP-007, `busy`) | `apps/instaflow/src/export/service.ts` |
| Export worker | spawned per `run` → started (`start`: store port, Wasm manifest, fonts) → running (`run`: one job) → stopped (`stop`, then terminated) whatever the outcome; a crash fails the run (IF-EXP-007) | `apps/instaflow/src/export/service.ts`, `host.ts`, `export.worker.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| EXP-1 | An export reads only its frozen snapshot: later edits never appear, and nothing (head, milestones, undo, library) changes | IF-EXP-003; `job.test.ts`, `snapshot-document.test.ts`; smoke |
| EXP-2 | One export at a time per Studio; every export has its own worker, terminated after the job | IF-EXP-007; `service.test.ts` |
| EXP-3 | Cancelling (panel, signal, Studio closing) ends the job `cancelled`, delivers nothing and stops the worker | `job.test.ts`, `service.test.ts` |
| EXP-4 | The export Wasm is loaded only inside an export worker, only for SVG, PDF or selection exports | `job.test.ts`; smoke (no `export.*.wasm` request before the PDF export) |
| EXP-5 | Every element keeps its full matrix (rotation, scale, skew, flips) in every format; repeats are expanded | `job.test.ts`; `cargo test -p export` (`skew_and_flips_match_the_renderer`) |
| EXP-6 | PNG is the renderer's own output (golden parity); SVG and PDF meet D21 | `export.gpu.test.ts`; `cargo test -p export` (corpus) |

## 35. Editor in the worker: Studio's worker topology (Instaflow M1c B9; D15)

Studio's editor module and render module run in workers by the boot setting (one worker by default, two available);
main keeps the page-side adapters. The editor posts scene records (resources, uploads, image table, projection, text IR,
overlay — record format 2) and view frames on the pipes; the render module draws consistent pairs into the transferred
`OffscreenCanvas`. Read projections (view, mirrors, accessibility snapshots, labels, the text host) flow back to main;
input flows in through A5's ring; the store side answers on the store port.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/studio-worker` | idle → starting (`start`: roles, media, pacing; the editor role attaches the ring, opens the store port, loads its environment, creates the pipes and opens the document) → running (`run`) \| failed (`fail`: IF-WRK-001 with the step); running \| failed \| idle → stopped (`stop`, or the link closed). Terminal: stopped | `apps/instaflow/src/workers/host.ts` |
| render role (per worker) | waiting → drawing once **both** the pipe endpoints (direct in one worker, `attach` from main across two) and the canvas (`canvas`) arrived, in any order; a second `attach` (IF-WRK-002) or `canvas` (IF-WRK-006) is refused | `apps/instaflow/src/workers/host.ts` |
| editor tab | none → open (`open`: the tab attaches its page's sources to the publisher, which writes a snapshot) → none (next `open` detaches it first, or the worker stops) | `apps/instaflow/src/workers/editor-module.ts`, `apps/instaflow/src/app/canvas-tab.ts` |
| text host (main) | none → open (`open` command: host div and platform TextInput) → none (`close`: Escape / Tab hand focus to the surface); commands of another session are dropped | `apps/instaflow/src/workers/text-port.ts` |
| boot (main) | spawn every worker of the plan → start each with its roles (a crash or failure stops all: IF-WRK-001) → relay the pipes (split) → running; `stop` stops and terminates every worker and closes the ring and the store port | `apps/instaflow/src/workers/boot.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| WRK-1 | Module code never asks which topology it runs in: the plan is data, endpoints are routed by the host or by main | `host.test.ts`, `studio-app.test.ts` (both topologies) |
| WRK-2 | Input reaches the editor only through the input ring; text-host key events are never forwarded (the host's TextInput turns them into intents); its pointer events go through the ring (caret and selection by pointer, FIX-TEXT-FIRST-KEY) | `studio-canvas.ts`; smoke |
| WRK-3 | The overlay travels in the same record as the content change it frames, applied after the content (one frame, E-2) | `canvas-tab.test.ts`; smoke (pixels during a paused drag) |
| WRK-4 | A platform text state is applied only when no intent is in flight; `composing` follows the intents | `text-port.test.ts` (TextInput contract over the port) |
| WRK-5 | The editor writes storage only through the store port | `store-port.test.ts` (DocumentStore and repository contracts over the port) |
| WRK-6 | Every capability run, panel action and Place goes to the editor; main forwards only ids the editor reported | IF-WRK-003, IF-WRK-004; `host.test.ts`, `mirror.test.ts` |
| WRK-7 | The worker import graph has no Lit, kit, UI runtime or main-thread module | `worker-imports.test.ts` |
| WRK-8 | A page switch replaces the scene with a snapshot of the new page (the publisher outlives tabs) | `canvas-tab.test.ts` |
| WRK-9 | The text session posts one text state per handled intent, with the caret after the edit: a commit's own document invalidation never pushes the session's state mid-commit (else main applies the new text with the old caret and the next key lands before it: FIX-TEXT-FIRST-KEY) | `text-editing.first-key.test.ts`; smoke (typing step) |

## 36. Transform tools: Free Transform session (Instaflow M1c B10a)

Photoshop-style Free Transform basics on top of B3's gestures (§25), in the editor worker. Mod+T (or the HUD's Free
transform) starts a session on the selection; until Enter every step (a drag, a key command, a numeric-bar edit) is a
session-layer preview the next step builds on. The pivot is view state per selection, never the document.

| Machine | States / transitions | Source |
|---|---|---|
| `instaflow/transform-session` (one per tab) | idle → active (`enter`: Mod+T or Free transform on a selection with something movable; IF-TOOL-002 otherwise; a no-op when active); active → active (`stage`: a step joined the session, its values shown in the session layer); active → idle (`commit`: Enter, Apply, or a new selected set — one change set for every staged value, IF-TOOL-004 when every target vanished; `cancel`: Escape, Cancel, Undo, or the tab scope ending — nothing written, previews cleared). `commit` / `cancel` while idle is IF-XF-002 | `apps/instaflow/src/tools/transform-mode.ts` |
| `instaflow/tool-gesture` (B3, §25) | adds pressed → skewing (`skew`: a side handle pressed with Mod) and pressed → pivoting (`pivot`: the pivot handle; Alt prefers it over a resize handle); both → idle (`release` \| `cancel`). While a session is active the behaviour is `transform` (`MODE_BEHAVIOURS`): a press outside the frame rotates, a release stages instead of committing (`SINKS`), a cancelled step restores the staged previews | `apps/instaflow/src/tools/gesture.ts` |
| pivot (view state, per tab) | undefined (the frame centre) → a frame fraction (`setPivot`: dragged, snapping to the nine reference points; Mod: free) → undefined (Alt-click on it, or the selected set changes) | `apps/instaflow/src/tools/view-state.ts` |
| transform-mode shortcut scope | inactive → active while a session is (`TransformModeShortcutScope`, a child of the canvas scope: its Enter and Escape shadow the canvas scope's select-children and deselect) | `apps/instaflow/src/app/canvas-tab.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| XF-1 | A whole session is one change set = one undo step on commit; nothing is written before; cancel writes nothing and clears every preview | IF-XF-002; `transform-mode.test.ts`, `canvas-tab.test.ts`, smoke |
| XF-2 | Flip, skew, rotate, scale and the numeric bar are each one change set outside a session; position-locked elements never move | IF-TOOL-002; `transform-mode.test.ts`, `contributions.test.ts` |
| XF-3 | Flipping twice is the identity; skew then the inverse skew restores; rotating or scaling about the pivot keeps it fixed (rotated, skewed and nested elements) | `free-transform.test.ts` (fast-check) |
| XF-4 | Any non-singular page affine decomposes into the box (rotation · flips and scale · horizontal skew) and lands every corner where the affine sends it; a flip stays a flip | `free-transform.test.ts` (fast-check) |
| XF-5 | A session stages only the fields that differ from its base, so restoring its previews never hides a concurrent change by someone else | `contributions.test.ts` |
| XF-6 | The pivot never enters the CRDT or the store; it resets when the selected set changes | `transform-mode.test.ts` |

## 37. Foundations: kit building blocks (Instaflow M1c B11a)

The non-overlay building blocks of `docs/instaflow/ux/FOUNDATIONS.md` that Studio and Home compose. Both machines live in
the element and end with it; neither writes anywhere: the app turns each `sf-change` into one undo step.

| Machine | States / transitions | Source |
|---|---|---|
| `kit/number-scrub` (per number field) | idle → pressed (`press`: primary button on the label, scrub on, not disabled; typed text is committed first and a refusal stops the press); pressed → scrubbing (`move`: ≥ 2 px of travel; every step change emits `sf-input`); pressed → idle (`release` without travel: focus moves to the field); scrubbing → idle (`release`: one `sf-change` when the delta is not 0; `cancel`: Escape or `pointercancel`, `sf-input` back to the start value, no `sf-change`) | `packages/kit/src/number-field.ts` |
| `kit/inline-edit` (per inline edit) | viewing → editing (`start`: `edit()`, the trigger, or the app setting `editing`; focus in, text selected; `sf-edit-start`); editing → editing (`refuse`: empty or too long, inline error); editing → viewing (`commit`: Enter or blur with a valid name, `sf-change` only when it changed; `cancel`: Escape, or a blur after a refusal, `sf-cancel`) | `packages/kit/src/inline-edit.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| FND-1 | One scrub or one typed commit is one `sf-change`; live previews are `sf-input` only | `number-field.test.ts` |
| FND-2 | A typed value that does not parse never changes the value; Escape restores it | SF-KIT-001; `number-field.test.ts` |
| FND-3 | A refused name never reaches the app; leaving the field restores the previous name | SF-KIT-002; `inline-edit.test.ts` |
| FND-4 | Icons are data: only allowed SVG tags and attributes render, and the generated modules match Lucide and the custom SVGs | `icon.test.ts` |
| FND-5 | Every B11a block passes the full audit under Clean Pop | `apps/instaflow/src/a11y/foundations.test.ts`, guarded by `chrome.test.ts` |

**B11a2: overlays, feedback, hints** (OVERLAYS-FEEDBACK §1–§5). The overlay sessions live in their element and end with it; the
toast timers and dismiss guards live in the surface manager (LIFECYCLES §8 is unchanged: guards only *hold* a `dismiss` event).

| Machine | States / transitions | Source |
|---|---|---|
| `kit/overlay-session` (per open menu, submenu or popover) | closed → open (`show()` / `showAt()`: nesting checked first — refused stays closed with SF-KIT-003; marks the host `data-sf-overlay`, announces `sf-overlay-open`); open → closed (`escape`: only when it has no open child; `outside`: consumed or passed through; `scroll` (menus, pass-through popovers); `blur`; `resize`; `replaced`: another layer-3 overlay opened outside it, or any modal; `parent`: the overlay around it closed; the app's `hide()`); focus returns unless `replaced` (or a passed-through press) | `packages/kit/src/internal/overlay-session.ts`, `menu.ts`, `popover.ts` |
| `kit/submenu-hover` (per menu with submenu rows) | idle → opening (pointer on a submenu row; 150 ms) → open; open → closing (pointer on a sibling row; 300 ms) → idle; re-entering the row or the submenu, or leaving the menu for empty space, cancels (leaving never closes, #58); → / Enter open at once with focus in, ← / Escape close with focus on the row | `packages/kit/src/menu.ts` |
| `kit/tooltip` (per tooltip) | hidden → waiting (hover: 500 ms, or 0 inside the 300 ms warm period) → shown; hidden → shown (keyboard focus; a 500 ms touch long-press, whose click is swallowed); shown → hidden (leave 80 ms, blur, press, any key, scroll, another tooltip opening); hiding starts the document's warm period | `packages/kit/src/internal/tooltip-core.ts` |
| `messaging/toast-timer` (per showing toast) | running → paused (`holdToasts()`, ref-counted: pointer, focus, hidden tab) → running with the time left; running → refreshed (a deduplicated repeat: count + 1, full duration again); running → expired (`timeout` dismiss); sticky toasts have no timer | `packages/messaging/src/manager.ts` |
| `kit/dialog-frame` (per `<sf-dialog>`) | editing → asking (a user dismissal while `dirty`: the inline `Discard changes?` row) → editing (`Keep editing`, Escape) or closed (`Discard`); editing → previous step (Escape or the back chevron on step > 1, `sf-back`) | `packages/kit/src/surfaces.ts` |
| `instaflow/hint-session` (per tab) | for each hint: offered → showing (enabled, not suppressed, fewer than two shown this session, not seen) → seen (`×`, 6 s, the target used); offered → seen (the session cap reached); offered → skipped (switched off or suppressed) | `apps/instaflow/src/studio/hints.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| FND-6 | A refused nesting never opens anything; a second modal is never queued or stacked under the strict policy | SF-KIT-003, SF-MSG-008; `overlay.test.ts`, `policy.test.ts` |
| FND-7 | One Escape closes exactly one surface, innermost first; tooltips never consume it | `overlay.test.ts`, `menu.test.ts`, `tooltip.test.ts`, `policy.test.ts` |
| FND-8 | A consumed outside press reaches nothing behind the menu (no pointerdown, no click) | `menu.test.ts` |
| FND-9 | Focus never lands on `body` when an overlay closes: trigger, fallback, or nearest surviving landmark | `focus-return.test.ts`, `overlay.test.ts`, `dialogs.test.ts` |
| FND-10 | A toast timer never runs while held, and resumes with exactly the time it had left | `policy.test.ts`, `dialogs.test.ts` |
| FND-11 | No error code is ever rendered; `Copy diagnostics` alone carries it | `feedback.test.ts` (kit and Instaflow) |
| FND-12 | At most two hints per session; a seen hint never shows again on that device until `Reset hints` | `apps/instaflow/src/studio/hints.test.ts` |
| FND-13 | Every B11a2 block passes the full audit under Clean Pop | `apps/instaflow/src/a11y/foundations.test.ts`, guarded by `chrome.test.ts` |

## 38. Studio and Home surfaces (Instaflow M1c B11b)

The surfaces keep no document state: every edit is one capability run or one mirror action (one change set). The machines below
live in their element and end with it; the per-device state lives in `localStorage` (a convenience: it may come back empty).

| Machine | States / transitions | Source |
|---|---|---|
| selection pill (per Studio) | hidden (nothing selected, or the selection off-screen) → shown (a selection whose frame is visible); shown → hidden-for-gesture (`gesture` ≠ idle) → shown (120 ms after the gesture ends, at the new place); shown → frozen (a pill popover or menu opened: the place stays) → shown (the last one closed) | `apps/instaflow/src/studio/studio-element.ts`, `hud.ts` |
| command bar (per Studio) | closed → open (`Mod+K` or a click: the filter focused) → closed (a row runs: recorded first in the recents, then `if-command`; Escape; outside press) | `apps/instaflow/src/studio/command-bar.ts` |
| inspector section (per section, per device) | open ↔ collapsed (the disclosure; default from §5.1, remembered under `instaflow/ui/inspector-sections`); Pro: pinned open (no toggle); `reveal(section)` → open | `apps/instaflow/src/studio/inspector.ts` |
| stack row (per row) | collapsed ↔ expanded (a click on its summary; Pro: always expanded) | `apps/instaflow/src/studio/inspector-paint.ts` |
| `kit/tree` row rename (per tree) | viewing → renaming (`renaming = id`: the field focused, text selected; the row not draggable) → viewing (Enter or blur: `sf-rename` when the trimmed name changed and is not empty, else `sf-rename-cancel`; Escape: `sf-rename-cancel`); focus returns to the tree | `packages/kit/src/tree.ts` |
| a page (per page id) | absent → in the story (Add / Duplicate: part created and attached, stub created after a page — one step) → out of the story (Delete: the stub goes, the part keeps its content — one step) → in the story (undo) | `apps/instaflow/src/lenses/page-ops.ts`, `workers/editor-module.ts` (`StoryMirror`) |
| clipboard (per Studio) | empty → held (Copy or Cut ran: the payload in memory and, when the browser allows, on the system clipboard) → held (a later copy replaces it; a paste of Studio's payload from another tab replaces it). Paste stacking (per editor): count 0 → k (each non-in-place paste of the same payload) → 0 (a new copy) | `apps/instaflow/src/app/clipboard-controller.ts`, `workers/editor-module.ts` (`pastes`) |
| style clipboard (per editor) | empty → held (Copy style: the first element's style values) → held (the next Copy style replaces it); Paste style reads it, never clears it | `apps/instaflow/src/app/studio-commands.ts` |
| context menu (per Studio) | closed → resolving (right-click, Shift+F10 or a Layers row: `contextAt` selects the target) → open (the target's groups at the point; keyboard opens focus the first row) → closed (a row runs, Escape, an outside press: focus returns to the canvas or the row) | `apps/instaflow/src/studio/studio-element.ts`, `context-menu.ts` |
| cheat sheet (per Studio) | closed → open (`?`: a registry snapshot, the search focused) → closed (`?` again, Escape, the close button) | `apps/instaflow/src/studio/shortcuts-sheet.ts` |
| New design dialog (per Home; B11b/B11c) | closed → open (`＋ New design`, a format chip, `Custom…`, `▾ › Custom size…`: the remembered draft, the name or W focused) → closed (Create: the draft remembered per device, `if-create`, the capability runs and Home leaves for Studio; Cancel, ×, Escape) | `apps/instaflow/src/home/new-design.ts` |
| Home page (per Home; B11c) | home ↔ files ↔ project ↔ templates ↔ trash (`go`: pushes history; Back / Forward: `show`); a renamed project replaces its page; a deleted one goes to home | `apps/instaflow/src/home/model.ts`, `routes.ts` |
| Home journal op (per op; B11c) | appended (Home: compare-and-swap on `home-journal`, shown at once over the index) → applied (Studio's drain: the library commit, or dropped when it no longer applies or fails, reported) → indexed (the Home index rewritten, the library flushed first) → removed (gone from the journal). A failed index rewrite keeps every op of that run | `apps/instaflow/src/home/journal.ts`, `src/workspace/home-journal-drain.ts` |
| card rename (per Home) | viewing → renaming (⋯ › Rename, F2 / Mod+Shift+R, a double-click on the title: the card is no link meanwhile, the field focused with the text selected) → viewing (Enter / blur: `instaflow/rename-design` when changed, a toast with Undo; Escape: nothing) | `apps/instaflow/src/home/home-element.ts` |
| Files selection (per Home) | empty → selecting (a checkbox, Shift range from the anchor, Mod toggle, Mod+A, Space on a card: the bulk bar rises) → empty (×, Escape, an operation ran, the page changed); bulk trash of six or more: selecting → confirming (inline in the bar) → empty (confirmed) or selecting (Cancel) | `apps/instaflow/src/home/home-element.ts`, `files-view.ts` |
| Home import (per drop or pick) | idle → refusing (unsupported files toasted) / storing (one file at a time to the blob store; the progress row for several, Cancel stops before the next file) → listed (one journal op per new content; the same content is `existing`) → idle | `apps/instaflow/src/home/model.ts`, `importer.ts` |
| first run (per device) | unseen (the welcome card, the formats hint) → answered (`Keep my designs…`: persistence asked on the click; the status line for the session) or dismissed (×) → seen (`instaflow/ui/first-run`; Settings › Reset hints → unseen) | `apps/instaflow/src/home/first-run.ts`, `home-element.ts` |
| density (per device; B11c) | standard (default) ↔ focus ↔ pro (`View ▾`, Settings › General, `Mod+.` cycles focus → standard → pro → focus; another tab's change arrives by the `storage` event); every change: the spec's density follows, the root's `data-sf-density` follows | `apps/instaflow/src/settings/device-settings.ts`, `src/app/studio-app.ts` |
| routable dialog (per Studio; B11c) | closed → open in-app (`⋯`, `Mod+,`, Export: `/d/<key>` pushed) → closed (×, Escape, an action: `history.back()`; Back: the bridge closes it). closed → open from a link (cold boot, after the intents) → closed (×, Escape: the path replaced with the design's). open → open (Settings' section: replaced in the query) | `apps/instaflow/src/app/studio-app.ts`, `@staticflux/messaging` `routable.ts` |
| arrival link (per boot; B11c) | read (the route: view params and intents) → the canvas opens on `page` → lens → dock → selection intent (select the existing ids, zoom; missing ids toasted) → inspector intent (reveal) → dialog → stripped (intents and an unknown dialog key replaced away) | `apps/instaflow/src/app/studio-app.ts`, `src/home/routes.ts` |
| find bar (per Studio; B11c) | closed → open (`Mod+F`, `⋯ › Find…`, the command bar; `Mod+Alt+F`: Replace row open; the field focused) → searching (typing: after 150 ms; Kind, Aa or Scope changed: at once; a newer search wins) → stepping (Enter / ↑ ↓ / `Mod+G`: the match selected, its page shown) → replacing (one undo step; then a new search; the focus stays in the bar) → closed (Escape, ×: the selection stays, the focus returns to the canvas) | `apps/instaflow/src/studio/find-bar.ts`, `src/app/find-replace.ts` |
| image tab (per fill row; B11c) | solid / gradient (the paint) → choosing (the Image tab picked: the chooser shows, the paint is unchanged) → image (a workspace image or an upload picked: one step `Fill kind`) or back (another tab: the paint converts); image → solid / gradient (converts) | `apps/instaflow/src/studio/inspector-paint.ts` |
| canvas drop (per Studio; B11c) | idle → over (files dragged over the canvas: the outline) → idle (leave) or importing (drop: screened, imported) → filled (a shape or frame under the point) / placed (anywhere else) → idle | `apps/instaflow/src/studio/studio-element.ts`, `src/app/studio-app.ts`, `workers/editor-module.ts` (`imageFill`) |
| first-use hint (per hint, per device; B11c) | unseen → offered (the first use: queued until its target is visible) → showing (≤ 2 per session) → seen (the target used, ×, its timer); offered past the cap → seen at once; suppressed (a deep-linked arrival) → nothing offered; Reset hints → unseen | `apps/instaflow/src/studio/hints.ts`, `src/app/studio-app.ts` |

| ID | Invariant | Error / test |
|---|---|---|
| SURF-1 | The pill and the inspector render only controls the selection kind declares; the More menu and the command bar list only capabilities the selection can run | IF-POL-001; `hud.test.ts`, `inspector.test.ts`, `command-bar.test.ts` |
| SURF-2 | Every pill, inspector and command-bar edit is one undo step; a commit that changes nothing writes no step | `studio.smoke.mjs` (undo ×4, W = 150), `editor-module.ts` (no-op filter) |
| SURF-3 | A page side is 16…8192 px; a refused size changes nothing | IF-POL-050; `studio-app.test.ts` |
| SURF-4 | Undo and redo run one at a time, in order; the selection never names an element an undo removed | `canvas-tab.ts`; `studio.smoke.mjs` |
| SURF-5 | Every surface element passes the full audit under Clean Pop | `chrome.test.ts` guards the list |
| SURF-6 | A design never has zero pages; a deleted page's content survives in its part until undo brings the stub back | IF-POL-052; `page-ops.test.ts`, `studio-app.test.ts` |
| SURF-7 | A Layers drop or Alt+↑/↓ writes the paint order the list shows (above a row = after it in the document) | `layers-panel.test.ts`, `studio.smoke.mjs` |
| SURF-8 | A paste never reuses an id: every pasted node gets a new one, the top level is selected, and each paste or cut is one undo step | `clipboard.test.ts`, `studio.smoke.mjs` (Mod+V, Mod+Shift+V, undo ×2) |
| SURF-9 | The context menu lists a capability only when the selection's `actions` include it, and Paste / Paste style only when there is something to paste | `context-menu.test.ts`, `studio-element.test.ts` |
| SURF-10 | The cheat sheet lists exactly the registered, unshadowed shortcuts (each once) | `shortcuts-sheet.test.ts`, `shortcut-sheet.test.ts` (kit) |
| SURF-11 | Home never opens the library or any document (D17): it reads heads and writes only its journal head (and, on import, the blob store) | `home-imports.test.ts`, `home.smoke.mjs` (no worker, no Wasm, no GPU) |
| SURF-12 | A journal op is idempotent on the index and on the library; ops apply in order; an op whose asset is gone changes nothing | IF-POL-055; `journal.test.ts`, `home-journal-drain.test.ts` |
| SURF-13 | The drain removes an op only after the library is durable and the index rewritten, so Home never shows a change undone | `home-journal-drain.test.ts`, `home.smoke.mjs` (journal drained, the library holds the rename, the copy and the image) |
| SURF-14 | A trashed file shows only on the Trash page; Delete forever applies only to trashed files and cannot be undone (inline confirm, no toast Undo) | IF-HOME-002; `model.test.ts`, `home-element.test.ts` |
| SURF-15 | A design name is 1–200 characters and a project name 1–60 without `/`; a refused name changes nothing | IF-POL-056, IF-POL-058; `model.test.ts` |
| SURF-16 | The same content is never imported twice; video, audio and other files are refused before a byte is stored | IF-POL-057; `model.test.ts`, `importer.test.ts` |
| SURF-17 | Density is one value per device: the device setting, the mounted spec and the root attribute never disagree after a change settles; it is never written to a document, a milestone or a URL | `studio-app.test.ts` (`Mod+.`, another tab), `home.smoke.mjs` (Pro remembered across a boot) |
| SURF-18 | At most one routable dialog is open, and the URL names it: an in-app open pushes, its dismissal goes back; a deep-linked one replaces the path on dismissal; Back never leaves a dialog open without `/d/` in the URL | `studio-app.test.ts`, `home.smoke.mjs` (Back closes Settings; Escape on `/d/export` → `/s/:asset`) |
| SURF-19 | An arrival link never blocks: unknown pages and elements fall back one level with one toast, and the consumed intents are stripped so a reload does not repeat them; foreign query keys survive | `routes.test.ts`, `studio-app.test.ts`, `home.smoke.mjs` |
| SURF-21 | A replace is one undo step whatever the pages it touches; it never writes to a locked element or a derived repeat instance; a replace with nothing to write writes no step | `find-replace.test.ts`, `studio-app.test.ts`, `studio.smoke.mjs` (Replace all, one step, Mod+Z) |
| SURF-22 | An image fill or a placed image never reaches the document before its picture is uploaded to the render module; a refused file writes nothing and toasts once with its fix | IF-POL-059, IF-POL-060; `studio-app.test.ts`, `studio.smoke.mjs` (Place image…, Add image, Background image, PDF has images) |
| SURF-23 | A shortcut the chrome shows runs: every key a tooltip, menu or inspector row names is registered in a scope that is active whenever the control is (text keys: while editing; B I U S: also with a text selected) | `text-keys.test.ts`, `studio.smoke.mjs` (⌘B while editing) |
| SURF-20 | At most two hints show per session; none show while hints are off or after a deep-linked arrival | `hints.test.ts`, `home.smoke.mjs` |

## 39. Engine gaps for B11b: typing steps, hidden elements, page fill, crops (Instaflow M1c B12)

What B12 adds to B2's text session (§21) and B1's elements. Nothing here is a new `defineMachine`: the typing run lives in
the session and ends with it; hidden, page fill and crop are document values every reader derives from.

| Machine | States / transitions | Source |
|---|---|---|
| typing run (per text session) | none → typing (`insert` of one grapheme from a collapsed caret, or an IME commit: a fresh step key) → typing (the next one at the run's end within 1 s: same key, so the same change set = one undo step) → none (a pause ≥ 1 s, a caret move by arrow or pointer, a style change, Enter, Shift+Enter, Tab in a list, a paste, a selection delete, a failed commit, or an outside change seen by `refresh`); none → deleting (a delete from a collapsed caret) → deleting (the next delete at the caret within 1 s) → none (as above); typing ↔ deleting always starts a new step | `apps/instaflow/src/text/text-session.ts` (step keys), `apps/instaflow/src/app/text-editing.ts` (key → change set) |
| key intents during a composition | composing: every key intent is ignored (the IME owns the keys); the composition ends with `compose-commit` (one step, coalescing like typing) or `compose-cancel` (nothing written) | `apps/instaflow/src/text/text-session.ts` |
| web font decoder (per font library) | unloaded → loading (first WOFF2 / WOFF upload) → loaded (decodes every later one) ; loading → unloaded (the load failed: IF-FIX-002, retried on the next web font) | `apps/instaflow/src/text/fonts.ts` (`webfontDecoder`) |
| main's text view (B12b P1, per text host, editor side) | base 0 (the empty initial state) → base v (the first intent stamped with v: rebuilt from the posted state v) → itself (each later intent stamped v: main's local edit applied) → base w > v (main applied state w); states posted below the current base are dropped. Each intent is rebased onto the editor's state when the rebuilt view differs from it | `apps/instaflow/src/workers/text-port.ts` (`createRemoteTextHost`, `rebaseIntent`) |

| ID | Invariant | Error / test |
|---|---|---|
| ENG-1 | Every structure action (group, ungroup, frame selection, reorder, rename, hide, show all, crop, reset crop) is one change set = one undo step; nothing to change is refused, never an empty step | IF-EL-004, IF-FIX-001; `structure-actions.test.ts`, `image-crop.test.ts` |
| ENG-2 | Group, frame selection and ungroup never move anything on the page (exact bounds before = after) | `structure-actions.test.ts` |
| ENG-3 | A hidden element and its subtree are in no render scene, export, hit test, marquee, snapping guide, group bound or accessibility tree; showing restores all of them | `page-fill-hidden.test.ts`, `structure-actions.test.ts`, `a11y/projection.test.ts`, `text-layer.b12.test.ts`, `export/job.test.ts` |
| ENG-4 | The page fill is the first node of the page's scene for the canvas and every export, absent when `transparent`, and never hit | `page-fill-hidden.test.ts`, `export/job.test.ts`, `canvas-tab.test.ts` |
| ENG-5 | An image paint without a crop is encoded exactly as before (IR tag 4); with one, the TS and Rust writers emit identical bytes and every backend places the picture alike | `scene-ir.test.ts` (`crops` fixture), `draw.rs` crop tests, `ir.rs` round trip |
| ENG-6 | Coalesced typing never spans an outside change: after an undo or a collaborator's edit the next keystroke is a new step | `b12-text.test.ts` |
| ENG-7 | During a composition nothing is committed and the control bounds stay the committed block's; the text host never re-lays the block out mid-composition | `text-session.ime.test.ts`, Studio smoke (IME step) |
| ENG-8 | A web font is stored and hashed as the OpenType it decodes to; a damaged file is never stored | IF-FIX-002; `webfont.test.ts`, `webfont.rs` tests |
| ENG-9 | (B12b P1) An intent main produced before it applied the editor's latest text state is rebased onto that state: a key, a delete or a composition at main's caret lands at the caret or selection the editor draws (after End, Home, a click, a drag, Shift+arrows), never at main's old caret; main resyncs from the next state. Typing coalescing is unchanged | `text-editing.caret-move.test.ts`, `text-port.test.ts`; Studio smoke (IME right after End, both topologies) |
| ENG-10 | (B12b P2) Text is drawn as a node of the element tree: tree paint order, its parents' opacity, blend and effects, frame clips, masks, `hidden` and reorders apply as to shapes; the canvas's scene equals the export scene (PNG, SVG, PDF) and the hit test's order is the drawn one | `text-tree.test.ts`, `export/job.test.ts` |
| ENG-11 | (B12b P2) Records coalesced into one render frame never fail the draw: glyphs whose element node a later record removed are dropped (an upsert under a missing parent is ignored; a cycle still fails) | `text-tree.test.ts` (create, edit, delete in one frame), `ir.rs` tests |
