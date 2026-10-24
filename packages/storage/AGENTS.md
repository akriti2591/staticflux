# @staticflux/storage — AGENTS.md

**Layer:** vertical (depends only on `@staticflux/core`).
**Budget:** boot path = `types` + `base` + one adapter (+ `namespaced`) ≈ 3–4 KB brotli. Every adapter and
middleware is its own module; `sideEffects: false`, so unused ones tree-shake away. Fakes (`fake-idb`,
`createFakeCookieDocument`, `createFakeOpfsRoot`, `createBroadcastHub`, mock remote) and `contract.ts` are test
utilities — never import them from app code.

## Purpose
One **async** key-value interface over any backend (REQUIREMENTS §9.0, R9.0a–R9.0d), so persistence can be
swapped per layer without touching consumers. Consumers (`@staticflux/data` slices, `@staticflux/handoff`,
`@staticflux/runtime` archives) accept an `AsyncStore` via their `*FromStore` adapters.

## Public API (by file)
- `types.ts` — `AsyncStore<V>` (`get/set/delete/has/clear/seek/batch/watch/dispose`, all `Promise<Result>`),
  `StoreCapabilities { atomicBatch, ordered, crossTabEvents, persistent, ttl, maxValueBytes? }`, `SeekOptions`
  (`prefix/gte/lt/limit/reverse`), `StoreCursor` (async-iterable, never throws; `error`, `toArray()`, `keys()`),
  `BatchOp`, `StoreChange` (`origin: local|external`), `StoreMiddleware`, `BroadcastChannelLike`, `globalBroadcastFactory`.
- `errors.ts` — `SF-STORE-001` quota · `002` unavailable · `003` corrupt · `004` aborted · `005` unsupported ·
  `006` invalid key/value · `007` disposed · `008` I/O failure; `toStoreError`, `isQuotaError`.
- `base.ts` — `storeFromDriver(driver)` (the contract on top of a tiny `StoreDriver`), `createCursor`,
  `createWatchers`, `filterEntries`, `effectiveBounds`, `prefixUpperBound`, `guard`, `validateKey/Value/Batch`, `cloneValue`, `utf8Bytes`.
- Adapters (all globals injectable, feature-detected; unavailable → `err(SF-STORE-002)`):
  `memory.ts` `createMemoryStore` (ordered, atomic, native TTL) · `web-storage.ts` `createWebStorageStore` /
  `createLocalStorageStore` / `createSessionStorageStore` (prefix, codec, write probe, atomic batch via rollback,
  `storage` events cross-tab) · `cookie.ts` `createCookieStore` (path/domain/sameSite/secure/maxAge, 4 KB + count
  limits, TTL = Max-Age) · `indexeddb.ts` `createIndexedDbStore` (object store per namespace, key-range cursors, one
  transaction per batch, `IdbConnectionMachine`, BroadcastChannel) against `Idb*Like` shapes; `fake-idb.ts`
  `createFakeIndexedDb` · `opfs.ts` `createOpfsStore` (file per key, `createFakeOpfsRoot`) · `remote.ts`
  `createRemoteStore(RemoteStoreTransport)` + `createMockRemoteTransport`.
- Middleware: `namespaced(prefix)` · `withTtl({ now, defaultTtlMs })` → `purgeExpired()` · `codec.ts`
  `withCodec(codec)`, `jsonCodec`, `envelopeCodec` (handoff `SnapshotEnvelope` format `{v:1,key,version,createdAt,expiresAt?,data}`
  with migrations/validation), `binaryCodec`, `mapValues` · `encrypted(keyProvider, { subtle })` (AES-GCM-256,
  random IV, store key as AAD, `kid` rotation; `staticKeyProvider`, `generateStoreKey`) · `withBudget({ maxBytes,
  maxEntries })` → `usage()` · `withTelemetry(telemetry, subsystem)` (`StorageMetrics`) · `tiered({ local, remote,
  mode: 'write-through'|'write-back', flushIntervalMs })` (`TieredFlushMachine`, `flush()`, `pending`) ·
  `fallback([candidates])` (create-time skip + runtime failover on `SF-STORE-002`, `reports`, `onFallback`).
- `create.ts` — `createStore({ backend, namespace, middleware })`, `detectLocalStore` (IndexedDB → localStorage →
  memory, reported), `detectStorageSupport`, `borrowed(store)`.
- `units.ts` — `STORE_SCOPES` (`device|user|workspace|session`), `StoreFactoryToken` (multi), `StoreRegistryToken`,
  `createStoreRegistry`, `storeRegistryUnit`, `storeFactoryUnit`, `indexedDbStoreFactory`, `webStorageStoreFactory`,
  `memoryStoreFactory`, `browserStoreFactoryUnits()`, `memoryStoreFactoryUnits()`, `namespacedStoreUnit({ id, provides, storeScope, namespace, wrap })`.
- `contract.ts` — `runStoreContract(name, factory, { describe, it }, { advanceTime })`, `storeContractCases`.

## Semantics
- `seek` always yields key-sorted entries (UTF-16 code-unit order = IndexedDB order); `ordered` only says it is native.
- `set(key, undefined)` is invalid (use `delete`). `ttlMs` on a store without `capabilities.ttl` → `SF-STORE-005`.
- Middleware owns its inner store (`dispose` cascades); share a backend with `borrowed()` (the registry does).
- Change events carry values only when cheap; encrypted stores and BroadcastChannel/IDB events never carry them.
- Middleware order in `createStore`: namespace first (closest to the backend), then `middleware[]` left → right.

## Lifecycles (mirror into docs/LIFECYCLES.md)
- `storage/idb-connection`: closed → opening → open | failed; open → closed (versionchange); failed → opening; any → disposed.
- `storage/tiered-flush`: idle → flushing → idle | failed; failed → flushing; any → disposed.

## Rules
- No synchronous storage API anywhere: everything is `Promise<Result>`; nothing throws for expected failures.
- Never store tokens/secrets in cookies or Web Storage; encryption at rest is not protection from page script.
- Adapters never retry (remote transports own retries). New errors via `defineError('SF-STORE-NNN', …)` with a fix.

## Test
`npx vitest run packages/storage` · `npx tsc -p packages/storage --noEmit` · consumers typecheck against `dist`: run `npx tsc -b packages/storage` after API changes.

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/storage (boot: createStore + IndexedDB + memory) | 6 KB | packages/storage/dist/index.js · import `{ createStore, createMemoryStore, createIndexedDbStore }` |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** runtime

- Internal: `@staticflux/core`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
