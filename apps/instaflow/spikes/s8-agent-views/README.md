# S8 — Agent views (layout, timeline and graph codecs, change sets, eval harness)

**Versions:** `loro-crdt` 1.17.1, `fast-check` 4.10.2, `gpt-tokenizer` 4.1.0 (o200k, a proxy: no Claude tokenizer offline). Node 22.22, Node only (this spike is about representation, not rendering; no browser involved).
**Machine:** 4-core container, shared with other spike agents (load average 4.6–6.8 during the final benchmark runs), so CPU timings are noisy and the p95s are inflated. Each benchmark sample set runs in a fresh child process (5 processes × 300 iterations, 2 runs). Numbers are pooled **median / p95**.

## What was built
- **Real stage on Loro** (`src/store.js`, `src/stage.js`). One CRDT doc per page and per flow, plus a root doc for page order, tokens and asset facts (D14). Every actor is its own peer, and the agent session's replica is linked to Latest. Element kinds: page, frame/group, rect/ellipse, text, image, track, video/audio clips and text captions, with time in ticks at 705,600,000/s. There are also flow steps and edges.
  - The composed stage is a JS mirror per part. It is built once (reading one page tree), then refreshed from `findIdSpansBetween` + `exportJsonInIdSpan`: property, text and tree ops (create, move, delete) are applied incrementally. It never calls `doc.toJSON()`, and every handle is freed.
  - The same primitive gives `changedSince(base)` for stale fields. A world-cache restore (S4 recommendation) is included.
- **Seeds** (`src/seeds.js`):
  - a flyer (19 nodes, float geometry, a locked background, a template-final legal line, a clipped sponsor frame);
  - a 5-slide deck (5 page docs);
  - a 20 s 9:16 reel with 3 tracks (5 clips, 5 captions, a song with a 104 BPM beat grid);
  - a caption flow;
  - a 200-element catalog page for the budget.
- **One codec declaration** (`src/schema.js`). One attribute table drives projection, parsing, unrounding, validation and the generated prompt vocabulary (IF-6.4).
- **Views** (`src/views.js`, `src/codec.js`):
  - **layout markup**: closed vocabulary, page-relative integer px, defaults omitted, `@tokens`, `locked`/`from` annotations, lints;
  - **layout JSON**: the same model with a second serializer;
  - **timeline JSON**: OTIO-shaped, seconds only, `mediaDur`, beats in timeline time;
  - **graph JSON**: steps with typed ports, edges as records, a one-line outline;
  - **raw canonical JSON**, for comparison.

  Every view has `base`, `viewHash`, a `changed-since` section from the second read on, and a memo by (scope, frontier).
- **Change sets** (`src/compile.js`, `src/session.js`, `src/fragment.js`).
  - **Ops:**
    - plain: `set`, `text` (value or find/replace), `insert`, `delete`, `move`, `reorder`;
    - relational: `align`, `distribute`, `stack`, `place relativeTo` (including inside page corners);
    - timeline: `trim`, `place`, `split`, `delete`/`trim` with ripple;
    - graph: `step`, `connect` (replaces a bound input), `disconnect`.
  - **Fragments:** markup or JSON upserts, diffed against the **base view**.
  - **Compile pipeline:** compile → validate (`IF-CS-001…013`, each with a fix) → stale check per agent op (`IF-CS-010` with theirs/yours) → proposal fork → accept, which re-checks at accept time and applies **one commit per part = one undo step**, also across pages.
  - **Whole-text edits are rebased three-way.** The agent's change is turned into a splice of the base text. Loro cursors taken at `base` map that splice onto the current text.
- **Tests** (`tests/`, `node --test`): 41 tests.
  - 18 round-trip and mirror tests, including 2 fast-check properties × 150 runs and an incremental-mirror fuzz (100 × 6 structural edits, 0 rebuilds).
  - 12 change-set tests.
  - 11 concurrency tests, including a 300-round fuzz and a naive baseline.
- **Eval harness** (`evals/`):
  - 30 tasks (10 flyer, 10 deck, 10 reel). Each has a machine-checkable predicate on the final canonical state and an injected concurrent human edit; two of those edits hit the same field on purpose.
  - 140 prompt files: `evals/prompts/<view>.<style>-<task>.md`.
  - A file-based model adapter: `evals/responses/<view>.<style>-<task>.txt`.
  - Three mock models: scripted, noisy (a negative control) and empty (a vacuity control).

## Criteria (PLAN.md §1, S8 row)

| Criterion | Result | Numbers and how they were measured |
|---|---|---|
| **Round-trip suite green** | **PASS** | 18 tests. For 11 view × scope cases across 4 seeds and all 4 codecs: `parse(project(s))` equals the model; re-projection gives an identical hash; the whole view sent back as a fragment compiles to **0 canonical ops**; canonical state stays byte-identical. Property tests (300 random pages with hostile text such as `<`, `&`, quotes, newlines and emoji, up to 3 levels deep): the same holds for markup and JSON, and a random `set` is reflected by the next projection without touching any other node. Unrounding: setting `x` writes only `spatial.x`, and `y = 196.73` keeps full precision. World-cache restore equals a fresh build. The incremental mirror equals a fresh build after 600 random structural edits by agent and human. |
| **Page projection ≤ 2 ms** (200 elements) | **PASS at the median; p95 over budget on this contended machine → owner-machine rerun** | Projecting from the composed-stage mirror, which the editor worker keeps anyway (per-node caches warm, view memo off): **1.11 ms median**, p95 2.1–2.7 ms. Unchanged page (memo hit): 0.07 / 0.15 ms. After one property change: 1.65 / 3.7–5.7 ms. After a structural change: 1.62 / 4.3–5.4 ms. Parts of a full projection: model 0.52, markup 0.40, JSON 0.46, sha256 0.14 ms. **Page open (mirror not built yet):** from Loro 14–16 / 39–44 ms; from the world cache 4.8–5.1 / 14.5–17.7 ms. Raw canonical JSON serializer: 7.7–8.8 ms. Two runs × 5 fresh processes × 300 iterations (`results/bench-run{1,2}.json`). |
| **≥ 80% task success, best view/edit combination** | **PASS (one model family, provisional)** | Real-model run by the coordinator: fresh Claude Sonnet agents answered the 140 prompt files blind (prompt files only), scored with `npm run eval:score -- --dir=evals/responses-sonnet` (`results/eval-sonnet.txt`). **markup.rel 100% (20/20)**, timeline.ops/fragment 100% (10/10 each), markup.ops, markup.fragment, json.ops, json.rel, json.fragment 95%. 0 parse errors, 0 clobbered human edits. Pipeline controls: scripted mock 100%, noisy mock 70–85%, empty 0%. Caveats: one model family, 20 tasks per combination, tasks authored with the harness; rerun with OpenAI/Gemini before the M2 format lock (IF-6.16). |
| **Zero clobbered concurrent edits** | **PASS** | Fuzz, 300 rounds (flyer and the whole deck): human and agent edit the same 3 elements. Out of 521 human writes, **0 clobbered**. 0 human text inserts lost, 0 agent ops reported as applied but missing, and **180 agent ops flagged stale** (IF-CS-010). The naive baseline (stale copies diffed against *current* state) **clobbered 237 writes and lost 9 text inserts** on the same script, so the detector works. Targeted tests: different fields on the same element; same field (flagged with theirs/yours, the rest applies); find/replace and whole-value text merges; overlapping text edit (flagged); deletes both ways; relational op over a moved element (the whole op is flagged, never a partial align); stale fragment copy; accept-time conflict in Ask mode; undo after a later human edit; delayed sync (truly concurrent same-field writes are all detectable after merge). In the eval, 0 clobbers over 140 runs, and the 2 designed conflicts (D03, R04) were flagged in every combination. |

Sub-budgets from IF-6.5 / IF-6.8, same benchmark:
- **compile ≤ 1 ms: PASS.** 0.32 / 0.6 ms for a `set` plus a 5-element `align`, including validation and the stale check.
- **Validate 500 ops ≤ 50 ms: PASS.** 15.8–16.7 / 34–38 ms.
- **Re-project after a one-node change ≤ 0.5 ms: FAIL.** 1.65 ms median. Per-node caches cut it from 3.6 ms, but the page is still re-joined, re-hashed and re-indexed in full. Next steps: cache subtree strings per container with dirty propagation, and compute `viewHash` lazily.
- A full propose + accept round in the eval scenarios (Loro fork for the preview, commit, sync to Latest) takes 6.4 ms median.

## Prompt tokens per view (o200k tokens; chars/4 in brackets)

| Scope | Layout markup | Layout JSON | Timeline JSON | Graph JSON | Raw canonical JSON |
|---|---|---|---|---|---|
| Flyer page (19 nodes) | 1,000 (656) | 1,057 (743) | — | — | 1,899 (1,466) |
| Deck, whole doc (5 pages, 29 nodes) | 1,319 (849) | 1,411 (985) | — | — | 2,758 (2,096) |
| Deck, one slide | 262 (163) | 271 (185) | — | — | 588 (435) |
| Reel page | 916 (561) | 969 (632) | **807 (514)** | — | 2,035 (1,526) |
| Caption flow | — | — | — | 341 (254) | — |
| 200-element page | 10,304 (6,816) | 11,058 (7,663) | — | — | 19,718 (15,160) |

**Full eval prompts** (system + generated vocabulary + view + task), average o200k tokens:

| View | ops | rel | fragment |
|---|---|---|---|
| markup | 1,815 | 2,098 | 1,707 |
| json | 1,863 | 2,146 | 1,723 |
| timeline | 1,774 | — | 1,594 |

Mock response size: 36–52 tokens with ops, 93–116 with fragments.

## Verdict
**Proceed** with the projection + change-set design. The representation criteria that can be measured here pass: round-trip and zero clobbers. The 2 ms projection budget passes at the median (1.1 ms). Its p95 (2.1–2.7 ms) and the 0.5 ms re-projection sub-budget miss on this shared 4-core box, so they need an owner-machine rerun and the subtree cache described above. **The format decision (≥ 80% success) needs an owner/coordinator run with real models.** Everything for it is generated, and scoring is a single command.

## Real-model eval findings (Claude Sonnet, 2026-10-24)
- **Relational ops win on arithmetic.** F10 ("space the logos evenly") failed in every ops/fragment combination and passed in both `rel` ones: views round geometry to integer px, so hand-computed spacing from the rounded numbers lands 1.1 px off (stored x = 120.4, 760.7). `distribute`/`stack`/`align` compute on exact values. Recommendation: ship relational ops, and keep integer px in views (readable, fewer tokens).
- **Fragment codec bug, not a model error.** F02 ("make the headline fit") failed in both fragment styles: the model wrote `<text id="n4" size="70"/>` (or JSON without `text`), which the codec read as "empty text" and erased the wording. Fix: in fragments an omitted text body means *unchanged*; an explicit empty body clears it. With that fix both fragment styles are 100%.
- **One genuine model mistake:** json.rel-D02 referenced ids `n15`/`n16`, which do not exist (screenshots are `n3`/`n4`); the change set was rejected with unknown-id errors, nothing applied. Validation did its job.
- **Coordinator note:** the first markup.fragment run misfiled five answers under neighbouring task ids (75%); it was discarded and rerun one prompt at a time (95%). Harness lesson: name responses by a hash echoed in the prompt, not by file order.
- Response cost is tiny: 36–59 tokens per change set; prompts 1.6–2.1k tokens.

## Surprises and findings
1. **Reading Loro, not projecting, is the cost.** `tree.toJSON()` on one 201-node page takes **5–11 ms** (about 30–55 µs per node at the JS↔Wasm boundary, the same as S4). Lazy handles (`getNodes()`) only look cheap: reading each node's map costs the same. Projection from the JS mirror takes about 1 ms. Rule: views read the editor worker's mirror (or the world cache), never Loro. Keeping the mirror fresh costs **0.02 ms** after a property edit. Before tree ops were applied incrementally, a structural edit cost 12.5 ms because the mirror was rebuilt; now it costs 1.6 ms.
2. **Before caching, lints cost more than serialization.** Text-fit lints took 1.3 ms of a 3 ms projection. A per-node cache keyed by composed version (attrs object → markup line and lint result) cut model + markup from 2.1 + 0.9 ms to 0.52 + 0.40 ms in the benchmark.
3. **Fragments need a three-way text merge.** A fragment naturally carries whole text values. With a concurrent human edit elsewhere in the same string, the edit is either flagged (and the task fails: D04 failed in both fragment combinations) or would clobber. The fix compiles the agent's base → new text into a splice and maps it onto current text with **Loro cursors taken on `forkAt(base)`**. Now only edits inside the same range are flagged. The same fix helps `text {value}` ops.
4. **Relational ops make stale handling cleaner.** An `align` touching an element the human just moved is flagged as one unit. Applying it partially would leave a misaligned row.
5. **Markup vs JSON is a small difference** (+3–7% o200k tokens for JSON). Raw canonical JSON is **1.9–2.2×** the markup, not the research's 5×, because our canonical form already omits CRDT bookkeeping. The relational-op docs cost about 280 prompt tokens.
6. Both empty and noisy controls are needed. Without them a predicate can pass vacuously (F10) or be too lenient (F05's first regex).

## Recommendation for M2 (Δ34 `@staticflux/agentview`)
- Build the codec from one attribute table, as here. Generate vocabulary, validation and unrounding from it.
- Keep the per-node cache keyed by composed version, the `(scope, frontier)` memo, and the id-span refresh. Never read Loro on the projection path.
- Default to **id-addressed ops, with relational ops on**. Allow fragments; diff them against `base`, and rebase text three-way with cursors at `base`.
- Treat stale checks as **per agent op, atomic within the op**, at compile time and again at accept time.
- Before locking defaults, run `evals/` on 2–3 model tiers. Then grow it to the ~100-task IF-6.16 benchmark (add transcript and graph tasks and screenshot variants).
- If the best combination scores < 70%, the PLAN fallback (JSON serializer + relational ops) is already implemented here: `json.rel`.

## Rerun
```bash
cd apps/instaflow/spikes/s8-agent-views
npm install                       # local, outside the pnpm workspace
npm test                          # 41 tests: round-trip, change sets, concurrency (writes results/concurrency.json)
npm run bench                     # 5 fresh processes × 300 iterations → results/bench.json (~3–6 min)
npm run eval:prompts              # 140 prompts → evals/prompts/ (+ index.json with view hashes and token counts)
npm run eval:mock                 # scripted, noisy and empty mock responses, scored → evals/results/
npm run eval:score                # scores every evals/responses/<view>.<style>-<task>.txt present
npm run eval:score -- --dir=evals/responses-mock   # score any other response folder
```
**Real models (coordinator):** for each `evals/prompts/<key>.md`, send the whole file as the user message (it contains the system section) and save the raw reply as `evals/responses/<key>.txt`. Then run `npm run eval:score`. The scorer re-creates the scenario deterministically, checks that the view hash matches the prompt, injects the concurrent human edit, parses the last fenced block, compiles, applies, and checks the predicate plus clobbers. Results go to `evals/results/responses.json`, with a table per view × style. Nothing here needs a GPU or a browser: `--real-gpu`/`--headed` do not apply, and an owner-machine rerun only gives less noisy timings.
