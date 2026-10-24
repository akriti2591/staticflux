# S6: Store (OPFS writer, folder backend, `.iflow` zip, head CAS, leader-tab failover)

**Verdict: proceed with OPFS as the primary store.** The design in DOCUMENT-FORMAT §5/§6/§9 works as written:
immutable content-addressed blobs, a few heads replaced by temp-file + `move()`, CAS under a Web Lock, and a
leader tab chosen by Web Locks. Atomicity of the real-folder head swap **needs a human run** on a real folder (steps
below). GC over 10k blobs meets 2 s at the median but not at p95 in this container. Use a catalog inventory (below).

Machine: 4 cores, a shared container (load average 5 to 9 while these ran, because other spike agents used the
CPU at the same time), Chromium 153.0.8010.12 headless. **All timings are noisy.** Each figure is a median over all
samples, with the worst p95 from 3 fresh-browser runs (`results/bench-run{1,2,3}.json`, pooled in
`results/summary.json`). Correctness results are exact.

## What was built (≈1,200 lines including runners, no deps)
- `web/core.js` has a `Backend` over any `FileSystemDirectoryHandle`, with two write paths:
  - **`sync`**: OPFS primary. Writes go through `createSyncAccessHandle` + `flush()` in a dedicated worker.
  - **`async`**: the folder backend. Writes go through `createWritable()` + `close()`, so it uses only APIs that exist
    on a real picked folder. Headless, it runs on an OPFS directory handle, which has the same interface.

  Both backends publish a file atomically the same way: write `name.tmp-<rnd>` in full, then `fileHandle.move(dir, name)`.
  `core.js` also holds SHA-256 (Web Crypto), RFC 8785-style canonical JSON, deflate-raw (Compression Streams), the
  head codec (canonical JSON plus a CRC field so a torn head is detectable), `casHead` (Web Lock + generation),
  log framing (`len|crc|payload`) and a ~120-line streaming zip writer and in-place reader.
- `web/latest.js`: the Latest store for one asset. It appends durable log batches: on OPFS that is one open sync
  handle with `write`+`flush`, and only then an ack. On a folder it writes one immutable segment file per batch,
  because `createWritable` cannot append and copies the file. Compaction is incremental: at most 16 parts per head
  swap, and `logFrom` advances only when no part is left dirty. Recovery handles torn log tails, stale segments and
  temp heads.
- `web/milestone.js`: milestone creation (canonicalize → hash → write only missing digests → record → head CAS),
  mark-and-sweep GC, and `.iflow` export and import.
- `web/store-worker.js` + `leader.html`: one store worker per tab. The leader holds `iflow:<ws>:leader`. Followers
  send commits over BroadcastChannel and resend until acked. The leader dedupes by commit id. Every tab also runs
  an unlocked head reader every 20 ms that checks for a torn or regressed head.
- `run-kills.cjs` (failover torture), `run-bench.cjs` + `index.html` (everything else), `web/folder-check.js` (the
  human run on a real folder).

## Pass criteria
| Criterion | Result | Numbers / how measured |
|---|---|---|
| Milestone of a 200-page doc ≤ 1 s, writing only changed parts | **PASS** | Doc: 201 parts, 3.85 MB canonical JSON (60 nodes/page). 5 pages changed: **254 ms median / 347 ms p95** (sync), 226 / 306 ms (async). It writes exactly 5 new blobs plus the record and head: **56 KB** written, against 776 KB for a full write. 1 page changed: 223 ms, 42.5 KB. 0 changed: 235 ms, 39 KB. 20 changed: 403 / 631 ms, 113 KB. Breakdown at k=5: canonicalize 121 ms, SHA-256 of 3.85 MB 13 ms, exists checks + writes 87 ms, record + head CAS 21 ms. Outside the criterion: a first milestone, or one where all 200 pages changed, takes 1.2–2.4 s, because each small-file create costs 3–6 ms in OPFS. |
| GC over 10k blobs ≤ 2 s | **PASS at median, FAIL at p95 (here)** | 10,000 blobs = 7,000 live (5 heads × 7 milestone records × 200 parts) + 3,000 garbage, across 256 shard dirs. Directory-listing sweep with 16 in flight: **1.42 s median / 2.37 s worst p95** (sync), 1.91 / 2.48 s (async). Split: mark 150 ms, list 10k names 570 ms, delete 3,000 files 700 ms. A sequential sweep takes 3.7–5.2 s. Sweeping from a catalog inventory, with no listing: **0.86 s / 1.47 s**. Every run checked: 0 live blobs lost, 0 garbage left. The grace path (blobs newer than mark start survive, via `lastModified`) works: 3,000 young blobs kept. |
| 100 forced leader kills lose no acknowledged commit | **PASS** | 4 tabs in one Playwright context, each committing every ~10 ms (≈400 commits/s in total). Compaction runs every 50 ms. 100 leader kills: 50 `page.close()` and 50 renderer crashes via CDP `Page.crash`, at a random 100–600 ms into each leadership. A fresh verifier tab then recovered the store. **sync: 36,979 commits acked, 0 missing. async (folder API): 36,721 acked, 0 missing.** The head was never torn or regressed: **0 torn and 0 regressed in 10,328 / 10,341 unlocked concurrent head reads**, and 0 torn heads, missing parts or bad digests in all 200 recoveries. Generation increased monotonically to 85 / 112. The kills landed mid-write: 6 (sync) and 3 (async) kills left a written-but-unmoved head temp file, which recovery cleaned up. 30 / 728 stale segments were cleared after kills between the head swap and segment deletion. Unit fault injection (crash after blobs, before the move, after the head; a torn log tail; a torn in-place head) passes on both backends in all 3 runs. |
| Folder head swap is atomic | **INCONCLUSIVE (needs human, real folder)** | The logic passes on an OPFS handle through the identical async API: CAS, fault injection and 100 kills, above. The real-folder picker cannot run headless. Steps are below. |

Failover in the stress run: **lock handoff after a kill 47 ms median / 127 ms p95.** Total kill-to-new-leader-ready
is 654 / 1,035 ms. Almost all of that is the new leader reading 200 part snapshots (525 ms), which a real leader
does not need to do (see the recommendations). In a calmer run (one commit per 100 ms per tab, 20 kills):
**commit→ack 7.5 ms median**, failover 144 / 324 ms, 0 acked commits lost
(`results/kills-sync-calm.json`).

## Atomic head-swap strategy and what Chromium 153 does (probed, `results/bench-run*.json → probe`)
1. CAS lock: take the Web Lock `iflow:<ws>:head:<asset>`.
2. Re-read the head and compare `generation`. On a mismatch, return `IF-STORE-003`.
3. Write `heads/<asset>.json.tmp-<rnd>` in full. A sync handle is flushed and closed; a writable is closed.
4. Run `tmp.move(headsDir, '<asset>.json')`.
5. On recovery, delete any `*.tmp-*` files.

- `move()` is defined on **`FileSystemFileHandle.prototype`**, not `FileSystemHandle.prototype`. So
  `'move' in FileSystemHandle.prototype` is `false`, but the method works. Feature-detect on the file handle.
- `move()` **overwrites an existing target** in OPFS, and the source disappears.
- Two `move()` calls onto the same target at the same time throw `NoModificationAllowedError`. A move onto, or of,
  a file with an open sync handle throws the same error. Never keep a sync handle open on a head.
- A `File` snapshot taken before the swap throws `NotReadableError` when read afterwards. Readers must retry; the
  probe readers did and never saw a torn head.
- **The Web Lock is required.** Without it, 16 racing CAS writers all "won" on the sync path (lost updates). On the
  async path 2–3 won and the rest hit move errors. With the lock, exactly 1 of 16 won every time.
- On a real folder, Chromium's `createWritable()` already writes to a `.crswap` file and renames it on `close()`.
  The explicit temp + `move()` keeps the strategy uniform and does not depend on that implementation detail.
- `FileSystemObserver` exists in 153. It is useful for the "folder as synced mirror" fallback.
- Other findings: `createSyncAccessHandle({mode:'readwrite-unsafe'})` is supported, and `FileSystemHandle.remove()` exists.

### Human run: real-folder atomicity (Chrome desktop)
1. `cd apps/instaflow/spikes/s6-store && node ../_harness/serve-and-run.cjs . index.html --serve-only`, then open
   the printed URL in Chrome.
2. Click **"Pick a folder and run the folder checks"** and choose an empty local folder. The page records whether
   `move()` overwrites on a real folder, the CAS swap time, and a milestone of the 200-page doc (k=5) on the folder.
   It then swaps the head in a loop for 60 s.
3. During the loop, kill Chrome hard (`kill -9 <chrome browser pid>`, or Task Manager → End process). For a stronger
   test, pull the power or hard-reset a VM.
4. Reopen the URL, click again and pick the same folder. `previousLoopHead.status` must be `"ok"`, and `leftovers`
   lists any `*.tmp-*` or `.crswap` files. Also check `instaflow-s6-check/heads/` in a terminal.
5. Repeat on a network drive or a cloud-synced folder (Dropbox, iCloud, OneDrive) and on NTFS/APFS. If `move()`
   throws or overwrite is unsupported there, the fallback is in the plan: OPFS primary, with the folder as a
   continuously synced mirror.

## Surprises / findings
- **Small-file creation dominates, not hashing.** SHA-256 runs at ~250 MB/s and takes 13 ms per milestone. Each OPFS
  file create costs 3–6 ms (setup of 10k blobs took 31–47 s). On this workload the **async path was faster than sync
  handles for small immutable files**, because opening a sync handle costs more than the writes it saves.
- **Compaction starvation.** Under kills every ~0.4 s, an all-dirty compaction never finished, the log grew without
  bound and recovery slowed. The fix is in place: incremental compaction (≤16 parts per swap), and recovery marks
  a part dirty only for log records missing from its snapshot.
- **Parts can be copied into `.iflow` without recompressing.** They are stored as deflate-raw, so they go into the
  zip as method 8 entries unchanged. Export only inflates them to verify the SHA-256 and compute the CRC. The
  bundle (821 KB, 204 entries) passes `unzip -t` and Python `zipfile`. Re-import dedupes all 201 blobs and writes
  none. A non-bundle input returns `IF-BUNDLE-001`. Export takes 1.7 s and import 2.1 s, again bound by file creation.
- About 38 KB of a k=5 milestone's 56 KB is the milestone record itself (201 part refs).

## Recommendations for M1
1. Keep the design: OPFS primary (D8), temp + `move()` heads, CAS = Web Lock + `generation`, a leader per
   workspace chosen by Web Locks, and resend-until-ack with dedupe by commit or op id. Ack only after `flush()`.
2. Use **sync handles only for the hot append log and large blobs**. Use `createWritable` for small immutable objects.
   Batch and parallelize object creates (8–16 in flight).
3. **GC sweeps from the IndexedDB catalog inventory** (DOCUMENT-FORMAT §5.1 already keeps GC marks there). Use a full
   directory listing only to rebuild the catalog, and run it incrementally per shard in the background.
4. Cache each part's digest by CRDT version. Canonicalizing 3.85 MB takes 120 ms, which is half of milestone time.
5. On takeover, the leader should read only the head and the log tail, with idempotent CRDT import, and not every
   part. That brings failover close to the ~50 ms lock handoff.
6. Store-worker error codes as used here: `IF-STORE-002/003/006`, `IF-MS-001`, `IF-BUNDLE-001/002`.
7. Durability against power loss is not tested here: OPFS `flush()` against an OS crash is outside a container's reach.

## Rerun
```sh
cd apps/instaflow/spikes/s6-store
export NODE_PATH=/opt/node-tools/node_modules     # or any dir with playwright installed
node run-kills.cjs --kills=100 --compact=50                   # → results/kills-sync.json
node run-kills.cjs --kills=100 --compact=50 --backend=async   # → results/kills-async.json
node run-kills.cjs --kills=20 --rate=100 --compact=200 --tag=-calm
node run-bench.cjs --runs=3 --iters=20 --gcRuns=5 && node summarize.cjs   # → results/bench-run*.json, summary.json
node ../_harness/serve-and-run.cjs . "index.html?iters=10&gcRuns=3" --timeout=1200   # single run, prints JSON
```
On your machine, add `--headed` to any runner, or use `--serve-only` and open `index.html` or several
`leader.html?ws=x` tabs in Chrome. Kill a leader tab and watch another tab report `leader`. No GPU is involved, so
`--real-gpu` is irrelevant here.
