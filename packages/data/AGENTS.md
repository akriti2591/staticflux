# @staticflux/data — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`; no MobX import — reactivity goes through core's port).
**Budget:** counts toward the ≤ 45 KB framework boot budget (R12.7). Boot path = `client` + `resources` + one transport
(≈ 17 KB gzip unminified with comments, est. 7–8 KB minified). SSE/WS/IndexedDB/mock adapters are separate modules and tree-shake away.

## Purpose
Transports, endpoint calls, resource kinds with an SWR cache, DataLoader batching, schema-first stores with
patches/snapshots (the replication format `@staticflux/worker` uses), and persistent user-data slices.
Requirements: R9.1–R9.12, R4.3/R4.6/R4.7 (epoch, pause, SWR on refresh), R10.1–R10.3, invariants I-9, I-10.

## Public API (by file)
- `transport.ts` — the transport contract (`Transport.request` / `Transport.stream`), `defineEndpoint`, `defineStreamEndpoint`,
  `transportSlot`/`DefaultTransport`, `buildRequest`, `parseRetryAfter`.
- `client.ts` — `createDataClient`: the ONLY retry layer. Per call: `data/request` span + `traceparent` → breaker (per endpoint,
  reactive `breakerState`/`breakers`/`onBreakerChange`) → `retry` (full jitter, idempotent endpoints by default) → per attempt:
  pause gate → `timeout` → transport → schema decode → epoch check (stale → `SF-DATA-001`).
- `fetch-transport.ts` (JSON + NDJSON streams), `sse-transport.ts` (injectable EventSource), `ws-transport.ts` (injectable socket,
  multiplexed frames), `mock-transport.ts` (`route`, `routeStream`, latency, `failNext`, `failureRate`, `setOffline`, call log).
- `pause.ts` — `PauseControl` port (`pause`/`resume`/`whenResumed`), `effectivePausePolicy` (mutations never queue unless idempotent).
- `epoch.ts` — `EpochSource` port, `createEpochSource`.
- `resource-defs.ts` — `defineResource` (single), `definePaginatedResource` + `cursorPagination`/`offsetPagination`,
  `defineBatchedResource`, `defineStreamResource`, `defineSubscription`.
- `resources.ts` — `createResources`: `query`, `paginated`, `stream`, `subscribe`, `fetch` (SWR), `getData`/`setData`,
  `invalidate`, `mutate` + `optimistic(...)` (rollback on failure). Handles are reactive: `status` (`idle|loading|ready|refreshing|error`), `data`, `error`.
- `batch.ts` — `createBatcher` (microtask or ms window, `maxBatchSize`, per-key `Result`s).
- `schema.ts` — `s.*` schema DSL, `Infer<>`, `schemaAt`. `clone.ts` — `clonePlain` (plain-data only), `deepFreeze`, `stableStringify`, `byteSize`.
- `patches.ts` — `PatchOp`, `createTransaction`, `applyPatchOps`, `produceWithPatches`, `PATCH_FORMAT_VERSION`.
- `store.ts` — `defineStore({ id, version, schema, initial, actions })` → `.create()` (owner) / `.replica({ sink })`.
- `slices.ts` — `defineSlice`, `SliceMachine` (LIFECYCLES §10), `migrateRecord`. `storage.ts` — memory / IndexedDB backends,
  `detectLocalBackend`, `RemoteSyncPort` + `createMockRemoteSync`. `user-data.ts` — `createUserData` (slice handles, flush, sync,
  `setIdentity`, `logout`, `document()`).
- `units.ts` — tokens `DataTransportToken`, `EpochSourceToken`, `PauseControlToken`, `DataClientToken`, `ResourcesToken`
  (session scope), `UserDataConfigToken`, `UserDataToken`; units `epochSourceUnit`, `pauseControlUnit`, `dataClientUnit`/`dataClientUnitWith`,
  `resourcesUnit`, `userDataUnit`, `mockTransportUnit(configure)`, `storeUnit({ store, provides, scope })`.
- `metrics.ts` — `DATA_SUBSYSTEMS` (`data/request|cache|store|slice|transport`), `DataMetrics` (request duration/failure,
  cache hit/stale-hit/miss, stale-epoch discards, breaker state, batch size, store patches, slice bytes).

## Stable formats (do not change without bumping the format number)
Patch ops (`PATCH_FORMAT_VERSION = 1`): `{op:'replace',path,value}` (existing key/index; `path: []` = root),
`{op:'add',path,value}` (new key, or array INSERT), `{op:'remove',path}`. `path` = keys (string) / indices (number).
Store messages (`STORE_FORMAT = 1`):
- `StoreSnapshot { format, storeId, schemaVersion, epoch, version, state }`
- `PatchMessage { format, storeId, schemaVersion, epoch, version, action, patches, traceparent? }` — one per outermost
  action; `version` = owner version after applying; contiguous. Replica: duplicate → ignored, gap → `SF-DATA-041`,
  epoch change → `SF-DATA-042`; both mean "resnapshot". `owner.patchesSince(v)` serves the handshake (ring buffer, `SF-DATA-047` if expired).
- `StoreIntent { format, storeId, action, args, baseVersion, traceparent? }` — replica writes; `owner.dispatch(intent)`.
Slice records: `{ v, value, updatedAt }` under `sf-ud/<scope>/<owner>/<slice key>`.

## Rules
- Transports never retry; resources never retry requests. The client is the single retry layer (subscription reconnect is the only stream retry).
- An open circuit is never retried (breaker wraps retry). Pause rejections and epoch discards never trip breakers.
- Store actions are synchronous and only touch the draft; a throw rolls the whole outermost action back. State is frozen.
  Drafts are path-addressed: don't hold an element draft across a splice/sort of its array in the same action.
- Replicas never mutate (I-9, `SF-WK-002` without a sink). Values are plain data (`SF-DATA-031` otherwise).
- Slice failures never crash: migration/IO errors → defaults + reported error; writes stay dirty and retry on the next flush.
- Errors (`SF-DATA-001…056`, `SF-WK-002`) are declared in `errors.ts`; HTTP statuses map via `errorForStatus`.

## Lifecycle notes (mirror into docs/LIFECYCLES.md §10)
Slice machine adds two transitions not drawn in §10: `saving → ready` on `saveFailed` (value stays dirty), and
`cleared → loading` (reload after logout / identity switch). `conflicted` is transient (resolved synchronously by LWW or `merge`).

## Test
`npx vitest run packages/data` · typecheck `npx tsc -p packages/data --noEmit`
