# @staticflux/blob — AGENTS.md

**Layer:** vertical (depends on `@staticflux/core`; `@staticflux/storage` for the `AsyncStore` catalog and
BroadcastChannel types). **Budgets:** store worker path (workspace store + Latest + leader) 12 KB, folder mirror
6.5 KB, zip 5 KB, full 21 KB brotli (none of it is on the boot path: it loads in the store worker or on export).
`createMemoryDirectory`, `createMemoryLocks` and `createMemoryObjectStore#corrupt` are test utilities.

## Purpose
The content-addressed **workspace store** (Instaflow SF-Δ1, SF-Δ2; IF-3.1–3.12; DOCUMENT-FORMAT §5, §6.5, §9):
immutable blobs by SHA-256, a few small mutable heads swapped atomically, an append-only journal, a leader that
owns the writers, a batched folder mirror, zip bundles, catalog-driven GC and quota helpers. It knows nothing
about documents: parts and records are opaque bytes (`DocumentRepo`, A4, builds on `LatestStore`).
Requirements R9.3a–R9.3m (docs/REQUIREMENTS.md). Evidence: `apps/instaflow/spikes/s6-store/README.md`.

## Public API (by file)
- `types.ts` — `Digest`, `BlobRef` (`chunked`, `encoding: 'deflate-raw'`), `ChunkManifest`, `BlobRange`,
  `BlobStore` (`put(stream|bytes, { signal, mime, encoding, onProgress })`, `putEncoded`, `get(digest|ref, { range })`,
  `stream`, `has`, `stat`, `verify`, `delete` (GC only), `list` (catalog rebuild only), `dispose`), `ObjectStore`
  (the backend port), `StoreChange`/`StoreObserver`, `WHOLE_BLOB_LIMIT` (8 MiB), `CHUNK_SIZE` (4 MiB).
- `blob-store.ts` — `createBlobStore(objects, { subtle, catalog, telemetry, now, limits })`: hashing, chunking,
  encoding, ranges, streaming, verify + quarantine, once for every backend. `parseChunkManifest`,
  `encodeChunkManifest`, `BlobMetrics` (`blob/bytes-written`, `objects-written`, `dedupe-hits`, `quarantined`).
- `memory.ts` — `createMemoryObjectStore`, `createMemoryBlobStore`.
- `directory.ts` — `createDirectoryObjectStore(root, { writeMode: 'auto'|'writable'|'sync', syncThreshold,
  syncAvailable, observer })` (`blobs/sha256/<2>/<64>`, quarantine under `quarantine/sha256/`, `sweepTemps`),
  `objectPath`, `chooseWriteMode`, `detectSyncAccessHandles`.
- `fs.ts` — the file system port (`DirectoryHandleLike`, `FileHandleLike`, `SyncAccessHandleLike`, …) and helpers:
  `publishFile` (temp + `move()`), `readFile` (retries `NotReadableError`), `writeHandle`, `statFile`, `fileExists`,
  `removeFile`, `removeTempFiles`, `listFiles`/`listDirectories`, `openDirectory`, `createDirectoryCache`,
  `tempNameFor`/`isTempName`, `checkName`, `asDirectoryHandle`.
- `memory-fs.ts` — `createMemoryDirectory({ syncHandles, move, quota, now })`: Chromium OPFS semantics in memory
  (move overwrites, exclusive sync handles, stale snapshots, permission, quota, `inject()` faults).
- `locks.ts` — `LockManagerLike`, `detectLocks`, `withExclusiveLock`, `createLocalLocks` (one realm only),
  `createMemoryLocks` (multi-tab fake with `crashTab`), `isLockFree`.
- `heads.ts` — `createHeadStore(root, { locks, lockPrefix, writeMode, observer })`: `read`, `cas(name, expected,
  body, { beforeMove })`, `update(name, fn)`, `replicate` (mirrors), `list`, `recover` (temps, under each head's
  lock); `encodeHead`/`decodeHead` (canonical JSON + CRC).
- `journal.ts` — `createJournal(root, { stream, peer, mode: 'append'|'segments' })`: `open(from)` (replay),
  `append` (ack point), `roll`, `dropBefore`, `close`; `frameRecord`/`parseFrames`, `segmentName`/`segmentNumber`,
  `comparePositions`, `MAX_RECORD_BYTES`.
- `latest.ts` — `createLatestStore({ blobs, heads, journal, name, snapshot, maxPartsPerSwap = 16, encoding,
  initialHead })`: `recover`, `append(records)` (dedupe by id), `compact({ maxParts, hooks })` (incremental),
  `updateHead`, `has`, `dirty`, `head`; `LatestHead` (`parts`, `logFrom`, `cover`), `encodeLatestRecord`/`decode…`.
- `leader.ts` — `createStoreLeader({ name, peer, locks, channels, idOf, lead, resendMs, retryMs })` →
  `commit(c)` resolves when durable; `StoreLeaderMachine`.
- `mirror.ts` — `createFolderMirror({ source, target, locks, lockPrefix, policy, clock })`: `notify` (pass as the
  workspace observer), `flush`, `fullSync`, `checkPermission`, `regrant`, `checkExternal`, `close`, `readOnly`;
  `FolderMirrorMachine`, `DEFAULT_MIRROR_POLICY` (idle 300 ms, ≥ 1000 ms between flushes, ≤ 5000 ms delay).
- `gc.ts` — `collectGarbage({ blobs, catalog, roots, graceMs = 30 days, dryRun })`, `createGcRoots`,
  `headRootSource`, `staticRootSource`, `collectBlobRefs`. `catalog.ts` — `BlobCatalog`, `createMemoryCatalog`,
  `createStoreCatalog(asyncStore)` (IndexedDB in production), `rebuildCatalog`. `pool.ts` — `runPool`.
- `zip.ts` — `createZipWriter(sink, { modified })` (`addStored`, `addCompressed`, `addDeflated`, `addStoredParts`,
  `finish`), `openZip(file)` (`entries`, `read`, `readStored`, `readRange`), `writeBundleMimetype`,
  `checkBundleMimetype`, `addBlobToZip`, `importZipBlob`, `createArraySink`.
- `quota.ts` — `requestPersistence`, `estimateStorage`, `checkQuota`, `detectStorageManager`.
- `opfs.ts` — `detectOpfs`, `openOpfsDirectory(path)`, `createWorkspaceStore(root, { lockPrefix, peer, locks,
  catalog, observer, writeMode, journalMode })` (blobs + heads + journals of one workspace directory).
- `units.ts` — `BlobStoreToken`, `WorkspaceOpenerToken`, `createWorkspaceOpener`, `memoryBlobStoreUnit`,
  `opfsWorkspaceOpenerUnit({ path, … })`.
- `errors.ts` — `SF-BLOB-001` quota · `002` digest mismatch (quarantined) · `003` head CAS conflict · `004` folder
  permission lost (read-only) · `005` not found · `006` aborted · `007` I/O · `008` invalid input · `009` API missing ·
  `010` torn head · `011` bad zip/bundle · `012` unsupported zip feature · `013` disposed · `014` not the leader;
  `toBlobError`, `isQuotaExceeded`, `abortedError`. Instaflow maps these to `IF-STORE-*`/`IF-BUNDLE-*`.

## Semantics (from S6; do not regress)
- **Acks come from the journal only:** `append` resolves after `flush()` (sync handle) or `close()` + `move()`.
  The folder mirror is never on the ack path (a real folder swap is ≈113 ms vs 0.8 ms in OPFS).
- **Heads:** temp file + `move()` under the Web Lock `<prefix>:head:<name>`, compare `generation`. Without the lock
  16 of 16 racers "won"; with it exactly 1 does (tested in Node and Chromium). Never keep a sync handle open on a head.
- **Write path:** `createWritable` for small immutable objects (faster than opening a sync handle); sync handles for
  the journal and for objects ≥ 1 MiB in a dedicated worker (`writeMode: 'auto'`).
- **Compaction is incremental** (≤ 16 parts per head swap) and `logFrom` advances only when no dirty part has an
  uncovered record in an older segment; the head's `cover` lets recovery mark only truly uncovered parts dirty.
  `snapshot(part)` must reflect every record already passed to `append()`. Replay is at-least-once: apply idempotently.
- **Recovery:** temp heads removed (under each head's lock), torn log tails dropped, a reopened journal never
  appends to an old segment, stale segments (< `logFrom`) deleted. A torn head is reported (`SF-BLOB-010`), not
  overwritten.
- **GC sweeps from the catalog**, never a directory listing (listing only rebuilds the catalog); a dedupe hit
  refreshes the catalog `at`, so reuse inside the grace period protects an object; a failing root aborts the run.
- **Chunking:** whole up to 8 MiB, 4 MiB chunks above, boundaries independent of input piece sizes. The manifest
  includes the mime, so the same bytes under another mime are another blob (sharing every chunk).
- **Zip:** deflate-raw blobs go in as method 8 byte for byte (no recompression); `putEncoded` adopts them on
  import after hashing the decoded content. No zip64.

## Lifecycles (mirrored in docs/LIFECYCLES.md)
- `blob/store-leader`: waiting → recovering → leading; recovering → waiting (lead failed, retried); any → disposed.
- `blob/folder-mirror`: idle → scheduled → flushing → idle | scheduled; idle|scheduled|flushing → paused
  (permission lapsed: read-only); paused → flushing (regrant: full sync); any → disposed.

## Rules
- Everything returns `Result`; nothing throws for expected failures. Every async API takes an `AbortSignal`.
- Only the leader opens journals and swaps Latest heads; any context may read blobs by range.
- New errors via `defineError('SF-BLOB-NNN', …)` with a fix; run `pnpm errors`.
- Browser-only tests live in `src/browser-tests/` (excluded from the build and from Vitest).

## Test
`npx vitest run packages/blob` (Node: memory FS fake, multi-tab lock fake) · contract suite:
`packages/testkit/src/blob-store-contract.ts` · real Chromium (OPFS, sync handles in a worker, fault injection,
leader kills): `pnpm test:browser --only=blob` (`SF_KILLS=100` for the full S6 run).

<!-- sf:generated:start -->
<!-- Generated by `sf agents` from package.json and .size-limit.json. Do not edit between these markers. -->

## Budgets

| Check | Limit | Measures |
|---|---|---|
| @staticflux/blob (store worker: workspace store + Latest + leader) | 12 KB | packages/blob/dist/index.js · import `{ openOpfsDirectory, createWorkspaceStore, createLatestStore, createStoreLeader }` |
| @staticflux/blob (folder mirror) | 6.5 KB | packages/blob/dist/index.js · import `{ createFolderMirror }` |
| @staticflux/blob (zip bundle) | 5 KB | packages/blob/dist/index.js · import `{ createZipWriter, openZip, addBlobToZip, importZipBlob }` |
| @staticflux/blob (full) | 21 KB | packages/blob/dist/index.js |

Budgets ratchet (R12.8): `sf budgets` proposes tightening; raising one needs a reviewed reason.

## Allowed dependencies

**Layer:** vertical

- Internal: `@staticflux/core`, `@staticflux/storage`

Anything else is a boundary violation (`pnpm lint:boundaries`). Adding a dependency needs a reviewed reason.
<!-- sf:generated:end -->
