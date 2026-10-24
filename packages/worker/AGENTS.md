# @staticflux/worker — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core` only; never imports `@staticflux/runtime`).
**Budget:** not on the boot path — loaded with the first feature that spawns a worker. Target ≤ 12 KB brotli for
main-thread usage (supervisor + link + replication); worker-side (`runWorker`) ships in the worker bundle.

## Purpose
Everything that crosses a thread boundary: typed envelopes, ports, typed protocols, supervised workers
(LIFECYCLES §3), store replication (owner → read-only replicas, writes as intents, invariant I-9), core-context
replication (R11.1), trace propagation and telemetry forwarding (R11.6), the token broker (R11.7), Web Locks
leader election and SharedWorker helpers (R11.9). Requirements: R11.1–R11.7, R11.9, R11.11, R4.3–R4.4.

## Public API (by file)
- `envelope.ts` — `Envelope { kind, channel, id, epoch, version?, traceparent?, payload }`, `createEnvelope`,
  `isEnvelope`/`validateEnvelope`, `Channels` (`sf/control|context|telemetry|broker`), `replicaChannel`,
  wire errors (`toWireError`/`fromWireError`, `WireResult`).
- `protocol.ts` — `defineProtocol({ id, version, requests, events })`, `request<A, R>({ idempotent, timeoutMs, args, result })`,
  `event<P>()`, `schema<T>(name, guard)`; type helpers `ArgsOf`, `ResultOf`, `EventPayload`.
- `port.ts` — `Port` (postMessage/onMessage/onError/onClose/close); adapters `fromWorker`, `fromSharedWorker`,
  `fromMessagePort`, `fromWorkerScope`, `createMessageChannelPorts`; **`createPortPair()`** in-memory pair with
  `freeze()/thaw()` (frozen tab / hung worker) and `crash()`.
- `link.ts` — `createLink({ port })`: channels, request/response with timeout + `cancel` propagation, traceparent, epoch stamping.
- `rpc.ts` — `createProtocolClient` / `createProtocolServer` (dev validation of args/results/events).
- `patches.ts` — `Patch { op: 'add'|'replace'|'remove', path, value? }` (shared with `@staticflux/data`), `applyPatches`, `DeepReadonly`.
- `replication.ts` — `ReplicableSource` (`getSnapshot`, `onPatches`, `applyIntent`), `defineReplica(id).type<S, Intents>()`,
  `createPublisher` (owner: versions, ring buffer, batching), `createReplica` (read-only, `intent()`, re-handshake),
  `createJsonSource` (small JSON owner store).
- `context.ts` — `defineContext`, `CoreContexts` (session, user, decisions, flags, platform, observability),
  `createContextHub` (main), `createWorkerContexts` (worker), `reactiveSource`/`staticSource`, secret stripping.
- `telemetry-forward.ts` — `createForwardingSink` (worker), `receiveForwardedTelemetry` (main).
- `broker.ts` — `createTokenBroker({ execute, allow })` (owner side), `createBrokerClient` (worker side), `BrokerProtocol`.
- `leader.ts` — `createLeaderElection({ name, locks })`, `detectLocks()`; single-tab fallback.
- `spawn.ts` — `Spawner`, `dedicatedWorkerSpawner`, `sharedWorkerSpawner(create, fallback)`, `inMemorySpawner`,
  `acceptSharedConnections`, `supportsWorker`/`supportsSharedWorker`.
- `supervisor.ts` — `WorkerLifecycle` machine, `createSupervisedWorker(spec)` → `SupervisedWorker` (Subsystem-shaped:
  `id, dependsOn, start, pause, resume, refresh, stop` + `request`, `on`, `whenReady`, `restart`, `inspect`), `WorkerMetrics`.
- `runtime.ts` — `runWorker({ port, protocol, handlers, contexts, setup, onPause/onResume/onRefresh/onShutdown })` (inside a worker).
- `control.ts` — handshake/heartbeat/lifecycle message shapes on `sf/control`.
- `units.ts` — `supervisedWorkerUnit`, `contextHubUnit({ id?, entries? })` (`ContextHubToken`; collects every
  `CoreContextsToken` contribution — one `contribution({ provides: CoreContextsToken, deps, create })` per context, each
  declaring its own deps — plus `entries(context)`; duplicate keys → `SF-WK-031`), `tokenBrokerUnit` (`TokenBrokerToken`).
- `errors.ts` — `SF-WK-001` … `SF-WK-018`, `SF-WK-031` duplicate core-context key.
- `coordinator.ts` — **multi-tab coordinator** (R11.9, research §6 Notion pattern): `createTabCoordinator({ id, owned, transport:
  'shared-worker'|'leader-tab'|'auto', sharedWorker?, locks?, broadcast?, lifecycle?, snapshots?, tabId?, clock? })` →
  `TabCoordinator` (`role`, `transport`, `term`, `leaderId`, `isLeader`, `start`, `replica(def)`, `intent(def, action, args,
  { timeoutMs, idempotent })`, `whenReady`, `stepDown`, `onRoleChange`, `inspect`, `dispose`); `ownedResource(def, create)`;
  `createCoordinatorHost({ id, owned, term, restore, snapshots })` (runs in the SharedWorker: `acceptSharedConnections(self,
  (p) => host.connect(p))`, or in the leader tab); `CoordinatorRoleLifecycle`, `TabCoordinatorMetrics`;
  ports `BroadcastChannelLike`/`detectBroadcastChannel`, `TabLifecyclePort`/`documentTabLifecycle`, `SnapshotStore`/`createMemorySnapshotStore`.
- `coordinator-unit.ts` — `tabCoordinatorUnit({ id, provides, options })`, `TabCoordinatorToken`.
- `coordinator-errors.ts` — `SF-WK-027` stopped, `SF-WK-028` unknown resource, `SF-WK-029` transport unavailable, `SF-WK-030` stale term.
- `coordinator-fakes.ts` — test-only (not exported): `createMemoryLocks` (per-tab views, `crashTab`), `createMemoryBroadcastHub`
  (per-tab `freeze/thaw`, `crashTab`, `inject`), `createFakeTabLifecycle`.

## Lifecycle (LIFECYCLES §3, as implemented)
`idle → spawning → handshaking → ready ⇄ busy`; `ready|busy → unresponsive → crashed` (and `unresponsive → ready`
when a heartbeat recovers); `crashed → respawning → spawning` with backoff; `crashed → failed` when restarts in
`periodMs` reach `intensity` (fallback activated, SF-WK-005); `* → draining → terminated`; `failed → spawning` via `restart()`.
On respawn: hello carries contexts + `rehydrate()`; replicas re-handshake (new owner epoch → snapshot);
idempotent in-flight requests are retried, others fail with SF-WK-004.

## Tab coordinator (`worker/tab-coordinator`, mirror into docs/LIFECYCLES.md §14)
`idle → candidate → leader | follower`; `follower → follower` (new term) `| candidate` (leader lost: `bye`, SharedWorker port
closed); `leader → stepping-down → candidate` (`stepDown()`, `freeze`/`pagehide`, split brain); `* → stopped`.
- Local reads always go through a `Replica` (the leader attaches its own replicas over an in-memory pair), so feature code is
  role-agnostic; the replica object survives failovers.
- Leader-tab bus: BroadcastChannel `sf-tabs:<id>` carrying `announce | join | bye | stale | data` with `{ from, to?, term }`;
  `data` frames are virtual point-to-point ports, so `Link` + `createPublisher`/`createReplica` run unchanged.
- Terms: new leader = known term + 1; frames from another term are dropped (SF-WK-030 event + `worker/tabs-stale-dropped`).
  A leader told of a higher term (`stale` reply, or a `join` carrying one) re-keys to term + 1 keeping owner state.
- Failover restores each owner from the new leader's replica state (plain-JSON copy) or the `SnapshotStore`.
- Suspended tabs do not queue for the lock; leaders step down on suspend; replicas resync on resume.
- Without Web Locks or BroadcastChannel: `single-tab` (this tab owns). `'auto'` falls back from SharedWorker to leader-tab when the
  spawner fails or reconnects are exhausted (`maxReconnects`).
- `intent()` waits for an owner during failover (bounded by `timeoutMs`); it resends only when `idempotent: true`.

## Rules
- Replicas never mutate (I-9): writes go through `replica.intent()`; dev guards throw SF-WK-002.
- One owner per store; the owner flushes patches before answering hello/intents (read-your-writes).
- Never put credentials in a context: the hub strips secret-looking keys (SF-WK-012); use the token broker.
- Every envelope carries `traceparent` when a span is active; pass `parent` to requests.
- Heartbeats are suspended while paused and skipped when our own timer fired late (frozen/throttled tab).
- Feature-detect `Worker`, `SharedWorker`, `navigator.locks`, `requestAnimationFrame`; always offer a fallback.
- Client gating is UX, not security: the broker's server re-checks every call.

## Test
`pnpm vitest run packages/worker` (in-memory ports; no real workers needed).

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/worker (full) | 14 KB | packages/worker/dist/index.js |
| @staticflux/worker/channels | 9.5 KB | packages/worker/dist/channels.js |
| @staticflux/worker/coordinator | 14 KB | packages/worker/dist/coordinator-entry.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
