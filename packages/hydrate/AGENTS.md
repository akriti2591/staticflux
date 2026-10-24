# @staticflux/hydrate — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core`, `@staticflux/loader`, `@staticflux/data`, `@staticflux/storage`; never `ui`).
**Budget:** no size-limit entry yet. gzip of tsc output (unminified, with comments): islands boot path
(`hydrator` + `marker` + `replay` + `island` + `env` + `errors`) ≈ 14 KB (est. 5–6 KB minified); snapshot path
(`snapshot` + `sources`) ≈ 7 KB. `serialize.ts` is build-side (prerender/SSG) and tree-shakes away from the app.

## Purpose
R12.4 hydration: (1) **islands** — partial hydration of static/prerendered HTML, lazy by default (R12.12), triggered
by visibility/idle/interaction/eager, loaded through the loader (gated, I-8), with **event replay** and a
size-stable check (R12.19) and feature marks (R17.7); (2) **state rehydration** — store/resource snapshots persisted
to an `AsyncStore` and restored at boot before the network (instant UI), versioned, identity-bound, budgeted,
tagged as stale so SWR revalidates (R17.8 data source `snapshot`); (3) build-side marker/props serialization.

## Public API (by file)
- `marker.ts` — the marker format (`ISLAND_MARKER_FORMAT = 1`): `<sf-island chunk hydrate props island-id export reason size>`
  and `data-sf-island` / `data-sf-hydrate` / `data-sf-props` / `data-sf-island-id` / `data-sf-export` / `data-sf-reason` /
  `data-sf-size`; props alternatively in a direct child `<script type="application/sf-island-props+json">`.
  `HYDRATE_STRATEGIES` (`visible` default · `idle` · `interaction` · `eager` (needs `reason`, else → `idle` + SF-HYD-008) · `never`),
  `scanIslands(root, { idFor })`, `islandElements`, `readIslandMarker`, `parseIslandProps`, `closestIsland`, `parseIslandSize`,
  `ISLAND_STATE_ATTR` (`sf-island-state` reflects the machine state; CSS hook).
- `serialize.ts` (build side) — `serializeIslandProps(props)` (plain data only, `<>&` U+2028/9 → `\uXXXX`),
  `renderIslandMarker({ chunk, hydrate, reason, props, html, id, exportName, size, form, propsIn, attributes })`
  (`eager` requires `reason` at compile time; rejects `on*`/reserved attributes, void host tags), `escapeHtmlAttribute`, `escapeJsonForHtml`.
- `island.ts` — island module contract: chunk entry exports `hydrate(element, { props, signal, scope, island, injector })`
  (named), or `default`/named `defineIsland({ props: s.object(…), hydrate })`; `resolveIslandModule`, `isReplayedEvent`.
- `replay.ts` — `createEventReplay(island, { events, maxQueued, preventDefault })`, `REPLAY_EVENTS`
  (click/input/change/submit/keydown), `INTERACTION_EVENTS`, `WARM_EVENTS`, `cloneEvent`.
- `env.ts` — `IslandEnv` port (`whenVisible`, `idle`, `afterFrame`, `measure`, `now`), `browserIslandEnv`,
  `intersectionVisibility(IOCtor, rootMargin)` (one shared observer), `measureIsland`, `defaultAfterFrame`.
- `hydrator.ts` — `createIslandHydrator({ loader, gate, env, telemetry, marks, replay, sizeTolerancePx, onIssue, scope })`:
  `start(root, { injector, parent })`, `scan`, `islands`, `get`, `hydrate(id)`, `issues`, `violations`, `dispose`;
  `IslandHandle` (`state`, `error`, `queuedEvents`, `hydrate`, `retry`, `whenHydrated`, `dispose`); `islandMachine`;
  ports `IslandChunkLoader` (= `Pick<ChunkLoader,'load'> & Partial<Pick<…,'check'|'preload'>>`), `IslandGate`,
  `IslandMarksPort` (structurally = perf `FeatureMarks` subset).
- `snapshot.ts` — `createSnapshotRegistry({ store, sources, identity, epoch, clock, lifecycle, intervalMs, restoreTimeoutMs,
  defaultMaxBytes, prefix, telemetry, onIssue })`: `register`, `restore`, `restoreOne`, `save`, `start`, `provenance`,
  `clearIdentityBound`, `prune`, `issues`, `dispose`; `SnapshotSource` contract, `SnapshotEnvelope`, `RestoredMeta`,
  `migrateSnapshot`, `browserSnapshotLifecycle`, `snapshotRegistryMachine`.
- `sources.ts` — `storeSnapshotSource(owner, { sensitivity, migrations, maxBytes, maxAgeMs, onRestored })`,
  `resourceSnapshotSource(resources, resource, { id, version, sensitivity, input })`.
- `tokens.ts` / `units.ts` — `islandUnits` (`islandEnvUnit`, `allowAllIslandGateUnit`, `islandHydratorConfigUnit`,
  `islandHydratorUnit`; requires loader `ChunkLoaderToken`), `snapshotUnits(level)` (`anonymousSnapshotIdentityUnit`,
  `snapshotRegistryConfigUnit`, `snapshotRegistryUnitAt(level)` — critical, requires data `EpochSourceToken`),
  `storeSnapshotUnit({ unitId, store, sensitivity, … })` (contribution); ports `IslandEnvToken`, `IslandGateToken`,
  `IslandMarksToken` (multi), `IslandHydratorConfigToken`, `SnapshotStoreToken`, `SnapshotSourcesToken` (multi),
  `SnapshotIdentityToken`, `SnapshotRegistryConfigToken`; services `IslandHydratorToken`, `SnapshotRegistryToken`.
- `errors.ts` — `SF-HYD-001…008` (islands), `020…028` (snapshots), `030` (props serialization).
  `telemetry.ts` — `HYDRATE_SUBSYSTEMS` (`hydrate/island|snapshot`), `hydrateMetrics`.

## Semantics to know
- Island order: trigger → island gate → `loader.check(chunk)` (chunk gate + profile; `forbidden` → `skipped`) → size
  measured → `loader.load(chunk, { origin: eager ? 'boot' : 'demand', parent: span })` → module resolved → props parsed
  + validated → `hydrate()` in a fresh child scope (+ `feature`-level child injector if `start` got one) → `hydrated`
  → queued events replayed → `renderDepsResolved` mark → next-frame size re-check. **Denied chunks are never fetched.**
- `interaction` islands preload (not execute) on pointerover/focusin (`origin: 'speculative'`, R12.3).
- Event replay: capture phase on the island; `submit` is `preventDefault()`ed while queued; replay = cloned events on
  original targets (dropped if the target left the island); nested islands own their events; failure drops the queue.
- Static markup = first render (`hydrate/island-static`, marks `start` + `renderCommitted`); `hydrated` =
  interactive (`hydrate/island-interactive`, `renderDepsResolved`). Size mismatch → `SF-HYD-007` + `layoutShift`.
- Snapshot envelope `sf-hydrate-snapshot/1`: `{ format, id, version, identity, savedAt, epoch, bytes, data }` under
  `sf-snap/<id>`; store sources put data's `StoreSnapshot` (STORE_FORMAT 1) in `data`.
- Restore never bumps the epoch (old-epoch responses are still discarded, I-10); an epoch change during the restore
  skips the snapshot (`staleEpoch`); a target written before the snapshot arrived is `superseded` (never overwritten);
  restored resources are `setData` + `invalidate` (SWR); everything is time-boxed (`restoreTimeoutMs`, default 200 ms).
- Saves are refused until a restore ran; one `batch` per save; unchanged revisions skipped; identity-bound sources are
  not saved without an identity and dropped (deleted) on mismatch.

## Lifecycles (mirror into docs/LIFECYCLES.md — not yet there)
- `hydrate/island`: idle → loading (trigger) | skipped (skip: `never`); loading → hydrating (loaded) | failed (fail) |
  skipped (deny); hydrating → hydrated (succeed) | failed (fail); failed|skipped → loading (retry); any → disposed.
- `hydrate/snapshots`: idle → restoring → ready; ready → saving → ready; ready → restoring; any → disposed.

## Rules
- Browser APIs only through `IslandEnv` / `SnapshotLifecycle` (feature-detected defaults; no IntersectionObserver →
  `visible` hydrates now; no requestIdleCallback → timeout).
- Island code must keep the prerendered DOM (no re-render from scratch) and register everything in `context.scope`.
- Client gating is UX, not security (R6.16). Identity keys are opaque hashes, never raw user ids or tokens.
- Snapshot failures never fail boot: reported via `onIssue`/telemetry, app boots without them.
- New errors via `defineError('SF-HYD-NNN', …)` with a concrete `fix`.

## Test
`npx vitest run packages/hydrate` · `npx tsc -p packages/hydrate --noEmit`

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/hydrate (islands) | 7 KB | packages/hydrate/dist/index.js · import `{ createIslandHydrator }` |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`, `@staticflux/data`, `@staticflux/loader`, `@staticflux/storage`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
