# @staticflux/stage — AGENTS.md

**Layer:** vertical (on `@staticflux/core` and `@staticflux/document` v2). No engine import: works over any
`DocumentCRDTv2` engine through the v2 port. Worker-side (it lives next to the `DocumentRepo` in the editor worker);
the main thread only needs the types.
**Budget:** ≤ 9.5 KB brotli (excluding core and document).

## Purpose
- **Stage (SF-Δ7, IF-4.5–4.7):** the composed view an editor, renderer, inspector and agents read. A layer stack
  (`session` strongest, `proposal/*` seam for M2, `local` = the asset), arcs `variant` > `inherit` > `reference`
  under direct opinions, final paths and policy locks that win regardless of strength, `read(node)` with per-value
  provenance and `explain(node, path)`, incremental recomposition through a dependency index, and lock enforcement.
- **Attribution (SF-Δ10, IF-4.12):** actor records `{ kind: human | agent | flow, id, displayName, model?, via,
  invocationId?, onBehalfOf? }` from a capability `RunContext` (via the attribution port) into `transact(meta)`.
- **Undo service (SF-Δ9, IF-4.13, D9, D14):** per actor, transaction-grouped, inverse-op based, 200 steps, persisted
  through the repo's log and undo blob; undo over another actor's later overwrite is **flagged** as a typed conflict.

## Public API (by file)
- `actor.ts` — `Actor`, `ActorKind` (`ACTOR_KINDS`), `Via` (`VIAS`: hud bar chat webmcp flow shortcut direct),
  `isActor`, `actorRecord(actor)` (JSON `ActorRecord`), `actorOf(meta)`, `newTransactionId()`,
  `transactionMeta(actor, label, { txn?, changeSet? })` → `TransactionMeta` (actor, label, `txn`, `via`, `invocation`).
- `attribution.ts` — `AttributionPort { actorFor(run) }`, `RunSource` (structurally a capabilities `RunContext`),
  `createAttributionPort({ human, agent?, flow?, via? })` (subject → kind via `SUBJECT_KIND`, channel → via via
  `CHANNEL_VIA`; agents from `origin.details.agent` or the WebMCP client's `name`; agents and flows get
  `onBehalfOf`), `defaultAgentIdentity`, `metaForRun(port, run, label)`, `AttributionPortToken`.
- `source.ts` — `StageDocument` (per-node reads + change events), `createPartsDocument(key)` (`attach(part, { id })`
  for each loaded page part, detach on eviction), `StageAssets` resolver port (`resolve(ref)`, `subscribe`),
  `createStaticAssets(map)`, `AssetRef`, `refKey` (`as_…` following, `as_…@ms_…` pinned), `isAssetRef`, `isFollowing`.
- `layers.ts` — `StageLayer` (the proposal seam: `opinions(node)`, `subscribe`), `createSessionLayer({ selection })`
  (`set`, `clear`, `select(set, value)`, `selection`, `onSelection`), `LayerId`, `StageNodeId`.
- `rules.ts` — `StageRules` and `DEFAULT_STAGE_RULES` (paths of variant maps, instance ref/overrides, `style.inherit`,
  `policy.final`, `lock.scope` / `lock.policy`, position paths, never-inherited paths), `BRAND_CLASS_INHERIT`,
  `TokenRule`, `matchesPath`, `matchesAny`, `variantKey`, `LOCK_SCOPES`, `isLockScope`, `asJsonObject`.
- `stage.ts` — `createStage({ root, session, assets?, rules? })` → `Stage`: `read(node)` → `ComposedNode { values,
  provenance, flags, source, parent, kind }`, `value`, `explain(node, path)` → `{ value, winner, overridden, ignored }`,
  `children(parent)` (instance proxies `<instance>/<source>` included), `lockOf(node)`, `checkWrite(ops, { actor,
  confirmPolicyUnlock })`, `overrideOp(proxy, path, value)`, `addLayer(layer)`, `layers()`, `onInvalidate`, `stats()`,
  `dispose()`. `Opinion`, `Arc`, `StageFlag` (`ignored` | `cycle` | `missing`), `PROXY_SEPARATOR`.
- `undo.ts` — `createUndoService({ doc, limit = 200, guard? })` → `UndoService`: `commit(actor, label, changes)`,
  `gesture(actor, label, part)`, `applyRemote(record)`, `ingest(record)`, `canUndo/canRedo(actorId)`, `peek`,
  `history`, `actors`, `undo(actor, signal, { onConflict })` / `redo(...)` → `UndoOutcome` (`empty` | `conflict` with
  `UndoConflict[]` | `applied` with the record and the resolved conflicts), `dispose`. `UndoMeta` (`undoOf`, `redoOf`),
  `ConflictPolicy` (`flag` default, `overwrite`, `keep-theirs`), `WriteGuard`, `UndoTarget`, `DEFAULT_UNDO_LIMIT`.
- `guard.ts` — `stageWriteGuard(stage)`: a `WriteGuard` running `stage.checkWrite` per part.
- `units.ts` — `StageToken`, `UndoServiceToken`, `attributionPortUnit({ id, port })`.
- `errors.ts` — `SF-STAGE-001` locked (↔ IF-CS-004), `002` policy lock, `003` final path (↔ IF-CS-013), `004` no actor,
  `005` disposed, `006` undo inverse unrepairable.

## Semantics
- **Strength:** direct opinions (session > proposal/* newest first > local) > variant (selection order) > inherit >
  reference. A final path (`policy.final` on the class or kit node) wins over everything; a node's own policy lock keeps
  its local value against session and proposal opinions. Beaten opinions are `ignored` and flagged.
- **Storage shapes** (one LWW register per entry): `variants.opinions.<set>=<value>` → `{ path: value }`;
  `instance.ref` → `AssetRef`; `instance.overrides.<sourceNode>` → `{ path: value }`; `style.inherit` →
  `{ kit?, class }` (class = node id in the kit, or in the same asset without `kit`). B1 can replace any rule.
- **Instances:** an instance shows the referenced asset's root children as proxies; nested instances nest proxy ids
  (`inst/nested/dot`). Pinned refs resolve to the milestone document, following ones to Latest; a change in a followed
  asset recomposes exactly the proxies and inheritors that read it.
- **Locks** cover the node and its subtree. `position` covers `spatial.{x,y,w,h,rotation,scale*,anchor*,flip*}`,
  `temporal.*` and moves; `content` everything else plus creating children, moving in or out, text and lists; any lock
  blocks delete. A UX lock (`lock.scope`) is removable by anyone; a policy lock (`lock.policy`) only by a human with
  `confirmPolicyUnlock`. **Client gating is UX, not security.**
- **Undo steps:** keyed by `meta.actor.id`; only commits with a `txn` are undoable. Consecutive commits with the same
  `invocation` or `changeSet` are one step. A new edit clears the actor's redo. Undo/redo commits carry
  `undoOf` / `redoOf`, so the stacks rebuild from `doc.undoHistory()` on open; the repo's undo horizon (default 200
  records per actor) bounds what survives compaction, and undo/redo commits count toward it.
- **Conflict detection:** for every target of the inverse (property, list, move, created subtree, recreated node),
  `changedSince(after)` from the commit record's per-part `after` frontier, then a fork at `after` to compare the value
  the step left with the current one. Text edits are anchored and merge (no conflict). A target that cannot be checked
  (history trimmed by shallow compaction) is `history-unavailable`. An inverse op that no longer validates is
  `invalid`; under `overwrite`/`keep-theirs` a stale sibling position is dropped (repair) or the op is dropped and
  reported. Redo reverts the undo commit (it restores what was there before the undo).

## Rules
- Write through the undo service (`commit`, `gesture`) or with `transactionMeta(actor, label)` meta, so every commit
  has an actor record and a `txn`. Relay remote records through `undo.applyRemote` (or `ingest` after `doc.applyRemote`).
- Never apply an undo silently over a flagged conflict: show it and let the user choose `overwrite` or `keep-theirs`.
- The stage is read-only; write with `PartOp`s through the repo (`overrideOp` builds instance-override writes) and
  check them with `checkWrite` / `stageWriteGuard` first.
- Never materialize a whole part: the stage reads per node; `createPartsDocument.attach` walks a part once.
- Proposal layers (M2) plug in with `addLayer`; they only add opinions (structure edits in proposals are M2's work).

## Lifecycle
`stage/undo-step` (docs/LIFECYCLES.md §18): done ⇄ undone (applied undo/redo); done → dropped (beyond the limit);
undone → dropped (a new edit by the actor). A `conflict` outcome leaves the step where it is.

## Test
`pnpm vitest run packages/stage` (unit) · `pnpm vitest run packages/testkit/src/undo-service-contract.test.ts`
(`runUndoServiceContract`, including the fast-check properties: two humans and an agent on three peers).

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/stage (stage, attribution, undo service; excl. framework) | 9.5 KB | packages/stage/dist/index.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`, `@staticflux/document`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
