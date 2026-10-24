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
