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
- `units.ts` — `supervisedWorkerUnit`, `contextHubUnit` (`ContextHubToken`), `tokenBrokerUnit` (`TokenBrokerToken`).
- `errors.ts` — `SF-WK-001` … `SF-WK-018`.

## Lifecycle (LIFECYCLES §3, as implemented)
`idle → spawning → handshaking → ready ⇄ busy`; `ready|busy → unresponsive → crashed` (and `unresponsive → ready`
when a heartbeat recovers); `crashed → respawning → spawning` with backoff; `crashed → failed` when restarts in
`periodMs` reach `intensity` (fallback activated, SF-WK-005); `* → draining → terminated`; `failed → spawning` via `restart()`.
On respawn: hello carries contexts + `rehydrate()`; replicas re-handshake (new owner epoch → snapshot);
idempotent in-flight requests are retried, others fail with SF-WK-004.

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
