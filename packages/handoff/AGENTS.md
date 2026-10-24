# @staticflux/handoff — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core` and `@staticflux/storage` for the R9.0d adapter).
**Budget:** full surface ≤ 5.5 KB brotli (measured 5.1 KB minified, core external).

## Purpose
State that survives boundaries — reload, deep link, login redirect, tab/window,
host↔embed, sub-route/view and mode changes — with declared lifetimes
(REQUIREMENTS §19 R19.1–R19.4, R7.13, R6.4, R9.11). Defines the shared
**snapshot envelope** also used for feature archives (R5.3).

## Public API (by file)
- `envelope.ts` — `SnapshotEnvelope<T>` = `{ v: 1, key, version, createdAt, expiresAt?, data }`, `createEnvelope`, `isEnvelope`, `parseEnvelope(raw, { key, version, schema, migrations, now })`,
  `validateWith`, `HandoffSchema<T>` (type guard or `{ parse(): Result }`), `Migrations` (`{ n: vN => vN+1 }`); errors `SF-HANDOFF-001…005`.
- `slot.ts` — `defineHandoff<T>({ key, version, lifetime: 'one-shot'|'session'|{ttlMs}, scope: 'memory'|'tab'|'origin', schema?, migrations?, maxAgeMs? })`, `lifetimeKind`, `effectiveTtl`.
- `storage.ts` — `HandoffStorage` port (async; IndexedDB/OPFS adapters implement the same interface), `createMemoryStorage`, `createWebStorage`, `probeWebStorage`,
  `detectHandoffStorages()` (degrades to memory; reports `degraded`), `memoryHandoffStorages()`, `STORAGE_PREFIX`; `SF-HANDOFF-006`.
- `async-store.ts` (R9.0d) — `handoffStorageFromStore(asyncStore, { kind, durable })` (the port over any `@staticflux/storage` `AsyncStore`;
  errors → `SF-HANDOFF-006` with `details.code`; undecodable `SF-STORE-003` entries read as non-envelopes and are discarded), `handoffStoragesFromStores({ memory?, tab?, origin?, degraded? })`
  (missing scopes → memory, reported degraded). The storage `envelopeCodec` writes this package's envelope format, so both sides read each other.
- `store.ts` — `createHandoffStore({ storages, slots, now, telemetry })` → `register`, `put`, `take` (consume), `peek`, `peekEnvelope`, `discard`, `clear({ lifetime, scope })`, `sweep`, `isDegraded`, `inspect`;
  machine `HandoffEntryMachine` (`handoff/entry`); `HandoffMetrics`; `SF-HANDOFF-007` slot key collision.
- `redirect.ts` — `prepareLoginRedirect(store, { returnTo, carry: [carry(slot, data)], nonce? })` / `completeLoginRedirect(store, { nonce, slots })`, `LoginReturnSlot`, `isSafeReturnPath`;
  guest migration `GuestMigrationSlot`, `stageGuestMigration`, `takeGuestMigration`; `createSlotHold(store, slot)` (implements urlstate's `IntentHoldPort`); `SF-HANDOFF-008…010`.
- `view.ts` — `createViewStateHandoff(store, { key, version, scope?, schema? })` → `remember/recall/forget` (per view) and `pass/receive` (one-shot to the next view/variant); `persistOnHide({ document, window }, scope, save)`.
- `units.ts` — tokens `HandoffStoragesToken`, `HandoffSlotsToken` (multi), `HandoffStoreToken`; units `browserHandoffStoragesUnit`, `memoryHandoffStoragesUnit`, `registryHandoffStoragesUnit` (storage registry: session scope → tab, device scope → origin, namespace `handoff`), `handoffSlotUnit(slot)`, `handoffStoreUnit` (sweeps on init).

## Rules
- Payloads are small and serializable (ids, drafts, scroll) — documents go to an IndexedDB-backed storage.
- Bump `version` on any payload shape change and add a migration; unreadable entries are discarded and reported, never thrown.
- One-shot entries are read only via `take()`; operations per key are serialized (consume-once even under concurrency).
- Carried-through-redirect slots must use `tab`/`origin` scope; `returnTo` must be a same-origin path; the nonce must match. These are UX guards — the server validates OAuth state (client gating is not security).
- Embedded hosts may have no storage: check `isDegraded('tab')` / `prepared.degraded` and use a popup flow.
- Flush on `visibilitychange: hidden` / `pagehide` (`persistOnHide`), never `unload`.
- Lifecycle machines above must stay mirrored in `docs/LIFECYCLES.md`.

## Test
`pnpm vitest run packages/handoff`
