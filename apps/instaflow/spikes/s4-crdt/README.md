# S4 — CRDT: Loro behind `DocumentCRDT` v2 (vs Yjs)

**Versions:** `loro-crdt` **1.17.1** (latest on npm, published 2026-10-22, 2 days before this run), `yjs` 13.6.33 (the version the repo already pins).
**Machine:** 4-core cloud container, Node 22.22, headless Chromium 153. Up to 3 other spike agents were running at the same time, so CPU timings are noisy.
**Method:** every sample runs in a **fresh Node process or a fresh module worker**. The reason is under "Surprises": a long-lived instance gets slower over time. Numbers are **median / p95**. n = 3 for open and merge; n = 5 repeats inside open; n = 3 for gestures. Where the two environments differ, the cell says **Node | Browser**.

## What was built
- `src/model.js`: a deterministic synthetic part with **50,051 nodes**: composition, then 50 pages, then 1,000 groups, then 49k elements. Each node has about 11 typed properties. About 15% of nodes are rich text with a bold mark. The same file generates a mixed op stream: 60% property sets, 15% moves, 10% text inserts, 5% marks, 5% creates, 5% deletes.
- `src/loro-part.js`: the part in Loro.
  - A `LoroTree` (movable tree, native fractional `order`).
  - Each node's `data` map holds per-property last-writer-wins values keyed by property path (`spatial.x` and so on).
  - Text nodes hold a `LoroText` under `text.content`.
  - The `NodeId` is stored as an `id` property, so it survives "New document from milestone".
- `src/yjs-part.js`: the same part in Yjs. Nodes are a `Y.Map` with `parent` and `order` stored as properties, and text is a `Y.Text`.
- `src/phases.js`: the open, gesture, merge, history and milestone benchmarks.
- `src/correctness.js`: per-actor undo, proposals, and canonical-part encode and rebuild.
- `node/*`: the Node driver. `index.html` with `browser/worker.js` runs every phase in a module worker. `mem.html` is a main-thread heap probe (workers expose no heap API in Chromium).
- Raw results: `results/node.json`, `results/browser.json`, `results/browser-mem.jsonl`.

## Criteria

| Criterion | Result | Numbers (Node \| Browser), median / p95 |
|---|---|---|
| **Open a 50k-node Latest ≤ 1 s** | **PASS with conditions; FAIL if every node is materialized** | Lazy `import()` alone: 61 / 62 \| 30 / 50 ms. Import plus a world cache stored beside the snapshot (JSON, 13 MB), plus the first edit and commit: 348 + 473 \| 180 + 263 ms, so **about 0.8 \| 0.45 s**. **50 page parts** (about 1k nodes each), importing all 50 and materializing the visible page: 108 / 116 \| 115 / 148 ms. Materializing **all 50k nodes into JS** (`doc.toJSON()`): **12.5 s on first call, 3.7 s repeated \| 2.9–3.2 s**. **Yjs:** `applyUpdate` alone takes 2.6 s \| 1.7–3.7 s (FAIL). |
| **Heap ≤ 200 MB** | **PASS** | Loro, lazy import plus cache: JS heap 27 MB + Wasm 61 MB \| 40 + 61 MB (page baseline 26 MB). Loro, fully materialized: 46 + 127 \| 50 + 127 = **about 177 MB**. Yjs: 322 MB \| 168 MB JS heap. |
| **A 1k-move drag commits ≤ 20 KB** | **PASS** (if commits are coalesced per gesture) | Reparent 1k nodes in one commit: **12.8 KB** (Yjs 33.8). Reorder 1k: 9.8 KB. 1k updates of one node in one gesture: 7.0 KB (Yjs 8.8). `spatial.x` on 1k nodes: 15.8 KB (Yjs 18.5). x and y on 1k nodes (2k updates): 28.6 KB. With one commit per frame (1k commits with attribution messages), the per-commit log totals **146 KB**, against 10.3 KB when exported coalesced. |
| **10k-op divergent merge between two peers ≤ 200 ms** | **FAIL** as stated; **PASS per part** | 10k ops per peer, import of the other peer's update, single 50k part. **Cold** (first concurrent import after open, which is the reconnect case): **5.7 s \| 1.35 s**. **Warm**: 1.5 s \| 0.66 s. **Partitioned into 50 page parts: total 2.0 s \| 0.72 s, worst part 124 / 167 \| 24 / 27 ms**. Yjs, single part: 1.7 s \| 1.5 s. For 1k ops: Loro cold 3.6 s \| 0.72 s, warm 412 \| 111 ms, Yjs 180 \| 142 ms. Every run converged. |
| **Wasm instantiate ≤ 150 ms warm** | **PASS** | Instantiate from a compiled module: **2.9 / 6.1 ms** (browser, module posted to a new worker) and 2–7 ms (Node). Cold path: `compileStreaming` 72 / 106 ms + instantiate 9 / 14 ms in a fresh worker (cache disabled by the harness's `no-store`). Node compile 18–28 ms. |
| **Per-actor undo via commit metadata** | **PASS** (two working designs, one broken) | **One peer per actor.** The agent session gets its own `LoroDoc` peer in the same worker, synced with `subscribeLocalUpdates`, and each peer has an `UndoManager`. The agent undid 5 steps and all human edits survived (same-node property, move, interleaved text). Full undo by both restores the original state, and the peers converge. **One doc, two origin-filtered UndoManagers:** broken (the human stack picks up the agent's undo commits, 10 steps instead of 5, and re-applies agent edits). It works if the other manager is `pause()`d during each undo. |
| **Proposal accept per op under concurrent edits** | **PASS** (re-apply design) | The proposal is a `fork()` with one commit per op (`message = {cs, op}`). The human edits Latest concurrently. Accept {1, 2, 4, 5 + dependency 3} re-applies the canonical ops onto Latest as **one commit**. Results: op 1 flagged as a stale field (`IF-CS-010`, current value kept), op 2 flagged because the target was deleted, the create plus its dependent update applied, the text splice landed correctly ("Hey alpha NEW beta gamma") through a Loro `Cursor` taken on the fork, and one undo reverts exactly the accept. See below for what failed. |
| **Fork from a snapshot ("New document from milestone")** | **PASS per page part; slow for one 50k part** | The canonical part (§6.2) is rebuilt into a new doc with a fresh peer and 1 commit of history, and round-trips (order keys normalized). **Page part (1k nodes):** canonical JSON 275 KB / 38 KB deflated, encode 147 \| 76 ms, rebuild 66 \| 45 ms. **50k part:** 13.9 MB / 1.9 MB deflated, encode 7.8 \| 3.9 s, rebuild 17.5 \| 2.9 s. A shallow snapshot used as the baseline is 7.6 MB (export 3.1 \| 2.3 s, import 200 \| 172 ms), but it keeps the source's peer ids in its version vector, so it is not a structurally detached baseline. |
| **Costs scale with size, not age** | **Mostly** | After 0, 10k, 50k, 100k and 200k size-neutral edits (sets and moves), the full snapshot grows 11.1 → 11.4 → 12.3 → 13.2 → **14.8 MB (+34%)**. The shallow snapshot grows 7.3 → **8.3 MB (+13%)**, because moves lengthen fractional indexes. Yjs grows 16.1 → 18.6 MB (+15%). Lazy import stays flat (19–27 \| 17–49 ms). Open plus first edit stays flat (270–340 \| 214–308 ms). Compacting Latest into shallow snapshots is what keeps cost tied to size. |

**Bundle** (`node/sizes.mjs`): `loro_wasm_bg.wasm` is **3,511 KB raw, 1,171 KB gzip, 822 KB brotli**. The minified Loro JS glue is 90 KB raw / 13 KB gzip. For comparison, Yjs minified is 91 KB raw / 28 KB gzip.

### Proposal methods that failed (correctness tests, identical results in Node and the browser)
- **Cherry-picking CRDT diffs** (`fork.diff(before_i, after_i)` followed by `Latest.applyDiff`): the text insert landed at a stale index ("Hey alNEW pha…"). The dependent update failed because a container created in the fork is not found in Latest.
- **Merging the whole fork, then reverting the rejected ops with inverse diffs**: the revert brought back a node the human had deleted and overwrote the human's concurrent value with the base value.
- **Undo after reload** (D9 requires undo to persist; Loro's `UndoManager` is memory-only): rebuilding the inverse from history (the commit message identifies the actor, then `diff(after, before)` followed by `applyDiff`) is correct for properties but corrupts text when concurrent inserts came before it ("Hey alENT beta gamma"). A persisted undo needs our own inverse ops with Cursor-anchored text positions (Δ9 already says "inverse-op based").

## Verdict
**Proceed with Loro behind `DocumentCRDT` v2, but only partitioned per page and only with the adapter rules below. The merge criterion fails as written and needs an owner decision plus an owner-machine rerun.** Yjs is not a better fallback: on the same workload it misses open (1.7–2.7 s), memory in Node, and merge too. LWW v2 was not measured in this spike.

## Surprises
1. **The JS↔Wasm boundary is the bottleneck, not the CRDT.**
   - Importing a snapshot is lazy and fast (30–60 ms).
   - Reading values out is slow. `doc.toJSON()` on 50k nodes takes 3–12.5 s. A profile showed about 40% in GC and `Reflect.set`.
   - Building 50k nodes takes 5.9 s, against 1.7 s for Yjs.
   - `toJSON` on 1.10.0 measured about 2× faster than on 1.17 (noisy; worth an upstream issue).
2. **Lazy loading moves cost to the first touch.** The first `getNodeByID` builds the tree (0.3–1 s on 50k nodes). The first *concurrent* import loads the history DAG (cold vs warm: 1–4 s).
3. **One forgotten handle leaks the whole doc.** A single unfreed `LoroMap` kept about 28 MB of Wasm memory alive per opened doc, even after `doc.free()` and `gc()`. Long-lived benchmark instances grew to 1.9 GB and imports degraded to **48–150 s**. In fresh processes the same imports took 2–5 s.
4. **`doc.diff(base, now)` scans the whole doc:** 9 s \| 6 s on a 50k part for 1k ops. `findIdSpansBetween` plus `exportJsonInIdSpan` returns the ops since base in 11–125 ms, which makes it the right primitive for stale-field detection (`IF-CS-010`).
5. Loro's undo restores the actor's earlier value even when another actor overwrote it later (agent sets `x=20` after the human set `x=10`; the human's undo gives `x=0`). This needs a policy: skip, flag, or accept.

## Recommendation for M1
- **Partitioning per page is mandatory** (DOCUMENT-FORMAT §5.2 already says this). It keeps open, merge, milestone and fork costs at the size of one part.
- Write a world/index cache with each part snapshot, stamped with frontiers. Never bulk-`toJSON` a part; materialize incrementally from events.
- In `loro-crdt.ts`, free every handle with `try/finally` or `using`, and add a leak test that checks Wasm memory stays flat over N open/close cycles.
- Use one Loro peer per actor (tab editor, each agent session) and one `UndoManager` each. Keep our own persisted inverse-op undo (Δ9) for reloads.
- Proposals: fork plus one commit per op, accept by re-applying canonical ops, Cursor-anchored text, stale-field detection via id spans.
- Coalesce commits per gesture. Per-frame commits cost about 146 B each in the log.
- **Owner decision:** restate the merge criterion as "≤ 200 ms per part, total off the main thread" (now 24–167 ms per part), or run a 2-day LWW v2 (pure JS) micro-benchmark on this same harness before locking the engine.

## Rerun
```bash
cd apps/instaflow/spikes/s4-crdt
npm install                      # local, outside the pnpm workspace
node --expose-gc node/bench.mjs fixtures   # ~1 min, writes fixtures/ (51 MB)
node node/run.mjs --runs=3 --reps=5        # Node suite → results/node.json (~25 min)
node build.mjs                             # bundles dist/worker.js + dist/mem.js
NODE_PATH=/opt/node-tools/node_modules node ../_harness/serve-and-run.cjs . "index.html?runs=3&reps=5" --timeout=6000 > results/browser.json
for e in loro yjs; do node ../_harness/serve-and-run.cjs . "mem.html?engine=$e" >> results/browser-mem.jsonl; done
node node/summarize.mjs                    # medians / p95 tables
```
On a desktop, add `--headed` (no GPU is involved; `--real-gpu` is irrelevant), or use `--serve-only` and open the printed URL in Chrome. Results render on the page and in `window.__result`. In real Chrome, `performance.measureUserAgentSpecificMemory()` also works (headless reports it as unavailable). Query options: `phases=boot,open,gestures,merge,history,milestone,correctness`, `mergeN=1000,10000`, `runs`, `reps`.
