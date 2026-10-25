# @staticflux/document — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core`, `@staticflux/worker`, `yjs` 13.6.33, `loro-crdt` 1.17.1).
**Entry points:** `.` (v1 ECS engine, Yjs; used by Studio), `./v2` (DocumentCRDT v2 port, DocumentRepo, components,
canonical parts; no engine), `./loro-crdt` (the Loro engine; worker only; Wasm in its own `wasm` budget category).
**Budget:** heavy-feature territory, worker only. The main thread needs only `projection.ts` + `presence.ts` types.
Keep `yjs` and `loro-crdt` out of main-thread chunks; load the Loro Wasm in the background while the shell paints.

## Purpose
- **v1** (R11.8, R11.10, R18.12): an ECS world (entities, SoA component stores, queries, systems) materialized from a
  `DocumentCRDT` (Yjs text + LWW-per-property structure), a `DocumentEngine` that is a replicable store, projections,
  presence, a collaboration transport contract with an in-memory mock, snapshot/restore for archive and respawn.
- **v2** (R11.8a–R11.8j; SF-Δ3–Δ6, D14): the document engine for Instaflow-class editors. A tree asset is split into
  **parts** — one CRDT document per page plus a small document-level part — each behind the engine-independent
  `DocumentCRDTv2` port; `DocumentRepo` persists parts as snapshots + one append-only commit log through a
  `DocumentStore` port; components are versioned with migrations and generate JSON Schema; milestones use canonical
  parts (RFC 8785). Undo services (SF-Δ9), stage layers (Δ7) and attribution (Δ10) build on top; v2 only carries `meta`.

## Public API (by file)
### v1 (`@staticflux/document`)
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
- `errors.ts` — `SF-DOC-001` … `SF-DOC-007` (v1), `SF-DOC-008` … `SF-DOC-019` (v2; field validation reuses `SF-DOC-003`).

### v2 (`@staticflux/document/v2`)
- `crdt-v2.ts` — **`DocumentCRDTv2`** (one part): `check(ops)`, `transact(meta, ops)` → `CommitInfo { update, inverse,
  before, after, change }` (one commit, all-or-nothing), `import(bytes)`; per-node reads `has`, `node`, `prop`,
  `children(parent | null)`, `text`, `list`, `subtree`, `forEachNode`, `size`; `anchor(node, path, offset, bias)` /
  `resolve(anchor)`; `frontier`, `version`, `compare`, `changedSince(base, scope)`; `exportUpdates(since)`,
  `exportSnapshot`, `exportShallowSnapshot`, `fork(peer, at?)`; `observe(change)`, `dispose`. Ops (`PartOp`): `create`
  (props, texts, lists), `move` (cycle-safe; `Position` after/before/index), `delete`, `set` (`null` removes),
  `text.insert|delete|mark` (offsets or anchors), `list.insert|delete|move|set`. `TransactionMeta { actor, label, txn?,
  via?, invocation?, changeSet? }`. `CrdtEngine { id, create, load, liveHandles }`, `randomPeerId()`, `isWritablePath`.
- `gesture.ts` — `createGesture(target, meta)`: `stage(ops)` per frame, `pending()`, `commit()` once, `abort()`;
  `coalesceOps` (last set per path / move per node win). Machine `GestureMachine` (`document/gesture`).
- `repo.ts` — **`createDocumentRepo({ store, engine, peer?, undoHorizon = 200, compactAfterBytes = 2 MiB, hooks, now })`**:
  `create(asset, { treeSchema, parts, app })`, `open(asset)` (single-flight), `get`, `openAssets`, `dispose`.
  `OpenDocument`: `part(id)` (lazy), `loadedPart`, `createPart`, `commit(meta, { [part]: ops })` → `{ record, durable,
  changes }`, `transact` (awaits durable), `moveAcross(meta, { node, from, to, parent, position })`, `gesture(meta, part)`,
  `applyRemote(record)`, `onCommit`, `flush`, `undoHistory(actor?)`, `compact({ history: 'keep' | 'shallow' })`,
  `evict(part)`, `stats()`, `close({ compact })`. Hooks: `onPartLoaded`, `onPartEvicted`, `onCompacted`, `onPersistError`.
  Machine `RepoDocumentMachine` (`document/repo-document`).
- `store.ts` — **`DocumentStore` port** (`readHead`, `writeHead(asset, head, expectedGeneration)` CAS, `putBlob`,
  `getBlob`, `appendLog`, `readLog`, `truncateLog`), `DocumentHead`, `BlobRef`, `createMemoryDocumentStore()`
  (`stats`, `failNext` fault injection). `@staticflux/blob` (A3) adapts its `BlobStore` to this port.
- `commit-record.ts` — `CommitRecord { seq?, peer, meta, updates: { [part]: bytes }, inverse: { [part]: ops } }`,
  `encodeCommitRecord`, `decodeCommitRecord`, `commitRecordSize`.
- `components.ts` — **`defineComponent(id, schema, { version, migrations, defaults })`** (v2; plain identifier ids),
  field types `f64 i32 u8 bool string json ticks color vec2 richtext` + `field.enum([...])`, `field.ref('node' | 'asset')`,
  `field.map(spec)`, `field.list(spec)`; `isFieldValueV2`, `fieldStorage`, `fieldJsonSchema`, `componentJsonSchema`,
  `migrateComponentValues`; `createComponentRegistry({ version, components, roles, kinds })` → `resolve(path)`,
  `validate(path, value, kind)`, `validateOps(ops, kindOf)`, `versions()`, `jsonSchema()`, `pathSchema({ kind, nullable })`.
  `role` and `name` are first-class node fields.
- `canonical.ts` — `encodeCanonicalPart(crdt, { part, schema, registry, treeSchema })` → `{ part, bytes }` (RFC 8785),
  `canonicalPartDigest`, `parseCanonicalPart`, `migrateCanonicalPart`, `buildPartFromCanonical(engine, part, { peer,
  registry, meta })` ("new document from milestone"), `rankKeys`.
- `json.ts` — `JsonValue`, `isJsonValue`, `canonicalJson` / `canonicalJsonBytes` (RFC 8785), `sha256Digest`.

### Loro engine (`@staticflux/document/loro-crdt`)
- `loro-crdt.ts` — `createLoroEngine({ marks })` → `CrdtEngine` (`loro/1`); `loroLiveHandles()`, `loroWasmMemoryBytes()`.
  **The only file importing `loro-crdt`.**

## Typical topology
- **Studio (v1):** worker `runWorker` → engine (rehydrated from `runtime.rehydrate` archive) → `runtime.publish(createPublisher({
  definition: documentReplica('studio/doc-42'), source: engine }))` + presence publisher; main `createReplica(DocReplica)`,
  `projectReplica(replica, projection)`, edits via `replica.intent('insertText', …)`.
- **Instaflow (v2):** each tab's editor worker owns a `DocumentRepo` over the workspace store port, opens the asset, loads the
  document-level part and the visible pages, and commits gestures through `doc.gesture()` / `doc.commit()`. Local commit
  records go to the store worker (log + fan-out); records from other tabs arrive via `doc.applyRemote()`. Agents get
  their own peer (their own open document or part fork), so undo and attribution stay per actor.

## Rules
- No `Y.*` types outside `yjs-crdt.ts`, no Loro types outside `loro-crdt.ts`; feature code uses the ports.
- **Loro adapter (D14, S4):** never materialize a whole doc (`toJSON` on 50k nodes: 3–12.5 s) — reads are per node and
  walks are explicit (`forEachNode`, compaction and milestones only); detect changes with id spans
  (`findIdSpansBetween` + `exportJsonInIdSpan`), never `doc.diff` (6–9 s); free every handle (`Lease`/`finally`; one
  leaked handle kept ~28 MB alive and slowed merges to 48–150 s) — `liveHandles()` must return to its baseline; never
  query the fractional-index flag on load (it materializes the lazily imported tree).
- **One commit per gesture.** Stage frames in a gesture; commit once (S4: 12.8 KB vs 146 KB per-frame for 1k moves).
- **Each session is its own peer.** A repo gives every opened document a fresh peer; never reuse a peer across
  concurrent sessions. Every peer must use the same mark-expand table (`createLoroEngine({ marks })`).
- **Write through the repo.** Edits to a repo part go through `doc.commit` / `doc.gesture`, never `part.transact`
  directly, or they are not persisted. A cross-page move is `doc.moveAcross` (one record, both parts).
- Inverse ops are anchored (text cursors, `after` siblings) so concurrent edits survive an undo. Whether an undo over
  another actor's later overwrite is applied, skipped or flagged is the undo service's policy (D14: flagged; SF-Δ9).
- Compaction `history: 'shallow'` makes older bases unavailable (`SF-DOC-010`); use it only when no peer may hold
  unsynced edits from before it (e.g. on close of the last tab).
- The world (v1) and any v2 index are materialized views: only the engine writes them, always from CRDT state.
- Presence and UI state never go into the CRDT.
- Component ids and field names are part of the persisted format (IF-4.14): additive changes, or a version bump with a
  migration. `defineComponent` throws at definition time for malformed definitions (a programmer error, like `token()`).
- Transports must deliver each peer's updates in order (v1), or resync by version vector (v2 imports are idempotent).

## Test
`pnpm vitest run packages/document` (v1 convergence, replication and respawn; v2 adapter, gestures, components, canonical
parts, commit records, repo). Contract suites live in testkit (`runDocumentStoreContract`, `runDocumentRepoContract`,
`runDocumentCrdtContract` with the N-peer convergence property). S4's measurements are a bench, not tests:
`pnpm vitest bench --run --reporter=verbose packages/document/src/loro-crdt.bench.ts`.

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/document (excl. yjs) | 13.5 KB | packages/document/dist/index.js |
| @staticflux/document/v2 (DocumentRepo, components, canonical parts; no engine) | 12 KB | packages/document/dist/v2.js |
| @staticflux/document/loro-crdt (adapter glue, excl. loro-crdt) | 9 KB | packages/document/dist/loro-crdt.js |
| loro-crdt Wasm [wasm budget category; worker only, IF-15.1 ≤ 1.25 MB gzip] | 1.21 MB | packages/document/node_modules/loro-crdt/bundler/loro_wasm_bg.wasm |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`, `@staticflux/worker`
- External: `loro-crdt` (1.17.1), `yjs` (13.6.33)

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
