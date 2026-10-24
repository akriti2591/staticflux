# @staticflux/document — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core`, `@staticflux/worker`, `yjs` 13.6.33).
**Budget:** heavy-feature territory (studio declares the exemption). Loaded inside the document worker; the
main thread needs only `projection.ts` + `presence.ts` types (no Yjs). Keep `yjs` out of the main-thread chunk.

## Purpose
Long-lived document model for document workers (R11.8, R11.10, R18.12 co-editing): an ECS world
(entities, SoA component stores, queries, systems) materialized from a `DocumentCRDT` (Yjs text + LWW-per-property
structure), a `DocumentEngine` that is a replicable store (`ReplicableSource`), projections, presence, a
collaboration transport contract with an in-memory mock, and snapshot/restore for archive and respawn.

## Public API (by file)
- `ecs.ts` — `defineComponent(id, schema, defaults)` (fields `f64|i32|u8|bool|string|json`), `defineTextComponent(id)`,
  `createWorld` (SoA `StructStore` with typed columns), `query(components, { without })` (sorted ids), `defineSystem`,
  `createIdGenerator` (deterministic `<client36>-<n36>` ids), `keyBetween` (fractional ordering keys), `validateValues`.
- `crdt.ts` — `DocumentCRDT` interface (`applyLocal(ops)`, `applyRemote(update)`, `encodeStateVector`, `encodeUpdate(sv)`,
  `readEntity`, `observe`, `onLocalUpdate`), `DocumentOp`.
- `lww.ts` — `createLwwMap(actor)` (Lamport + actor tie-break, delta by state vector).
- `yjs-crdt.ts` — `createYjsDocumentCRDT({ clientId })`, `mergeDocumentUpdates`. The only file importing `yjs`.
- `engine.ts` — `createDocumentEngine({ clientId, components, systems })`: `createEntity([withComponent(C, v), withText(T, s)])`,
  `set`, `remove`, `destroy`, `insertText`, `deleteText`, `transact(tx => …)` (all-or-nothing), `observe(changeSet)`,
  `applyRemote`, `encodeUpdate`, `snapshot()` → `DocumentArchive`, `restore`, `restoreDocumentEngine`;
  `ReplicableSource<DocumentView>` with `DocumentIntents` (createEntity/set/remove/destroy/insertText/deleteText).
- `projection.ts` — `Projection { reset, apply }`, `bindProjection(engine)`, `projectReplica(replica)` (worker → main),
  `patchesToChanges`, `createViewProjection()` (reactive).
- `presence.ts` — `createPresenceStore({ localId, ttlMs })` (cursor/selection per participant; replicable), `PresenceReplica`.
- `collab.ts` — `CollaborationTransport` / `CollaborationSession` contract, `createMockCollaborationNetwork()`
  (`partition`/`heal`), `connectCollaboration({ engine, session, presence })`.
- `units.ts` — `documentEngineUnit`, `collaborationTransportUnit` (`CollaborationTransportToken`), `documentReplica(id)`.
- `errors.ts` — `SF-DOC-001` … `SF-DOC-007`.

## Typical topology (Studio)
Worker: `runWorker` → engine (rehydrated from `runtime.rehydrate` archive) → `runtime.publish(createPublisher({ definition:
documentReplica('studio/doc-42'), source: engine }))` + presence publisher; emits archives as events.
Main: `createReplica(DocReplica)` in the supervised worker's `replicas`, `projectReplica(replica, projection)`, edits via
`replica.intent('insertText', …)`, `rehydrate: () => lastArchive`.

## Rules
- No `Y.*` types outside `yjs-crdt.ts`; feature code uses the engine API.
- The world is a materialized view: only the engine writes it, always from CRDT state (convergence by construction).
- Presence and UI state never go into the CRDT.
- Component ids and field names are part of the persisted format: renaming needs an archive migration.
- Every peer needs a unique `clientId` (uint32); a respawned worker may reuse its id only after restoring its own archive.
- Transports must deliver each peer's updates in order (or the peer resyncs via state vector).

## Test
`pnpm vitest run packages/document` (convergence over the mock network; replication over in-memory ports; respawn recovery).
