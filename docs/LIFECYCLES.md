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
```

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

Hooks for every unit (scope-bound, auto-disposed): `onInjected`, `onReady`, `onRefresh`, `onFailed`.
Units without `init()` are `ready` on creation (zero overhead).

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
Uninterruptible stages defer cancellation until they settle.

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
```

## 11. Meter reservation (credits/quotas)

```
estimating → reserved → committed | released | expired
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
