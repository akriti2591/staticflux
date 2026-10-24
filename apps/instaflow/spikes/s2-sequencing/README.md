# S2 (Sequencing): result

**Verdict: proceed with the split pipeline (main → editor worker → render worker). Two protocol rules are mandatory. Latency
needs an owner-machine run.** Correctness is a clean **PASS**: 0 snap-back, 0 double-draw, 0 torn frames and 0 camera
mismatches over 316k drawn frames in 33 saved runs (most at 10k gestures, ~54k input records each). The final state was identical to
a single-threaded oracle every time. Fault injection proves the detectors work. On latency, the sequencing itself costs
about 1 ms (input → frame submitted, p95 ≤ 1.7 ms). The budget is decided by **when the render worker draws, not by the
topology**: a render worker that draws only in its own rAF is **always 2 frames** (32.7 ms p95), whether split, fast path
or co-located. Drawing **on arrival** ("eager") gives **1 frame** (≈16.0 ms p95, budget 20.67 ms) in all three. Neither
fallback is needed when the editor is idle. Real raster and real present timing are INCONCLUSIVE here (SwiftShader).

## What was built (`web/`, `scripts/`)
- **Main thread** (`main.js`): real DOM `pointerdown/move/up`, `wheel` and `keydown` listeners on the canvas
  (`getCoalescedEvents` aware). They encode into a **binary SAB input ring** (`channels.js`: f64 ×8 records `seq, tAbs,
  type, x, y, dx, dy, flags`, lossless with per-reader cursors and a pending queue under back-pressure). The script
  dispatches synthetic events **inside main rAF**, as Chrome rAF-aligns pointermove and wheel (`align=raf`, default).
- **Editor worker** (`editor-worker.js`, `editor-core.js`, `model.js`): blocks in `Atomics.wait` and drains each batch. It
  runs the tool reducer: grid hit index for 10k elements (stand-in for rbush), drag overlays relative to committed state,
  one transaction at gesture end, and remote CRDT-style edits. It publishes **deltas first, then the view frame**.
  - Deltas are sequenced binary records `{docVersion, epoch, commits:[g], changes, deletes}` in an SAB ring.
  - The view frame is one SAB slot behind a **seqlock** plus checksum: `viewSeq, inputSeq, docVersion, gesture, Δ,
    targets[], selection[], marquee, camera, tWritten`.
- **Render worker** (`render-worker.js`, `render-core.js`, `gfx.js`): owns the transferred OffscreenCanvas. It rebuilds
  the display *independently* from deltas plus the view frame and draws 10k rects. Backends are WebGPU instanced quads,
  2D, or `none` (sequencing cost only). **Protocol rule:** read frame F, apply deltas only up to `F.docVersion`, and draw
  F only when committed state == `F.docVersion`; otherwise keep the last good frame. A gap requests a resnapshot (new
  epoch). Two draw policies:
  - `present=raf`: draw in worker rAF.
  - `present=eager`: `Atomics.waitAsync` wake-up on a new view frame or input, then a 1 ms coalesce, then draw. rAF is
    used only to timestamp presents.
- **Fallbacks:** `mode=fast` (camera fast path) has the render worker also read the input ring and apply wheel records
  newer than `F.inputSeq` to `F.camera`, using the same function, so the result is bit-identical. **Main cannot apply
  the camera itself because it no longer owns the canvas.** `mode=colo` puts editor and render in one worker behind the
  same SAB ports.
- **Oracle and checks** (`script.js`, `main.js analyze`): gestures are generated against a single-threaded oracle (the
  same reducer, no threads), which records the display hash and camera after every input seq. **Every drawn frame must
  equal the oracle at the seq it consumed, with (viewSeq, camSeq) strictly increasing.** Any snap-back, double draw,
  torn read, lost or reordered input breaks this. The final editor and render state must equal the oracle exactly.

**Gestures.** E-1…E-6 in ARCHITECTURE §4 are *sequencing invariants*, not gestures, so I defined the gestures as
**G-1…G-6** and tested the invariants separately:

| Gesture | Mix | What it does |
|---|---|---|
| G-1 pan | 18% | 3–6 wheels |
| G-2 zoom | 14% | 2–4 ctrl-wheels about a point |
| G-3 drag one | 26% | down on an element, 3–8 moves, up |
| G-4 drag 100 | 10% | alt+down drags the element's group of 100 |
| G-5 marquee | 12% | down on empty space, 3–6 moves, up; live selection |
| G-6 nudge | 20% | 1–3 arrow keydowns, shift ×10, one transaction each |

Interleaved with these: ~3.2k remote moves (810 of them on a target mid-drag), ~150 remote deletes (71 mid-drag →
`IF-ENG-001` cancel) and 186 Esc cancels. One run is about 54k records and 6.9k commits at 250 events/s (`pace=4`),
about 4 events per frame.

## Criteria
| Criterion | Result | Numbers, and how they were measured |
|---|---|---|
| Input-to-present p95 ≤ 1 frame + 4 ms (20.67 ms @ 60 Hz) | **INCONCLUSIVE (needs real GPU)** for the full pipeline. Sequencing part: **PASS with eager draw, FAIL with rAF-only draw** | Present = first worker-rAF vsync timestamp ≥ the frame's submit (an estimate, see caveats). `gfx=none`, 3 seeds × 10k gestures, p50/p95 ms. **rAF draw:** split 32.4/32.8, fast 32.4/32.8, colo 32.3/32.8 (= 1.95 frames). **Eager:** split 15.7/**15.9–16.0**, fast 15.7/**15.9–16.1**, colo 15.7/**15.9–16.1** (≈0.95 frame). Input → submit (eager): 1.2 / ≤1.7 ms. Input → view frame written: 0.1 / ≤0.6 ms. `gfx=2d` eager: colo 15.9/16.2, fast 15.7/16.2, split 15.7/**32.6** (2D raster p95 5.6 ms under contention pushes the tail over a vsync). `gfx=webgpu` on SwiftShader: rAF interval 117–350 ms and GPU-done p50 ≈ 580 ms, **not representative**. |
| No snap-back or double draw across 10k scripted gestures | **PASS** | 33 saved runs (`results/full/`: none/2d/webgpu × split/fast/colo × raf/eager at 10k gestures, 2 extra seeds, 3 busy-editor runs at 2k), 316k frames. A first pass of the 18 eager runs, superseded by the present-estimate fix, gave the same zeros: **0** frames ≠ oracle, **0** camera mismatches, **0** non-monotonic generations, **0** torn frames accepted, **0** delta order violations. Final editor and render state equal the oracle in every run, including commits (6864 = 6864) and cancels. This also holds under WebGPU back-pressure (one frame per 117–350 ms, so huge batches). |
| Detector validation (the zeros are not vacuous) | **PASS** | `naive=1` (deltas and frames consumed independently), eager: **3 snap-back + 8 double-draw frames caught**. With rAF draw, naive shows 0, so the race needs eager timing. `seqlock=0`: **325 torn reads caught**, 48 bad frames. `gapEvery=25` (a lost delta): 41 gaps → 41 resnapshots, last good frame kept (190 held frames), final state correct. Files: `results/validation/`. |

**Invariants (IF-7.3).**
- **E-1 ordered apply: PASS.** Strictly increasing `docVersion`, plus the gap → resnapshot/epoch path under fault
  injection.
- **E-2 atomic supersede: PASS.** It is enforced by the "draw F only at `F.docVersion`" rule, and naive mode shows it is
  necessary.
- **E-3 relative overlays: PASS.** 810 mid-drag remote moves composed and 71 target deletes cancelled with
  `IF-ENG-001`. Oracle equality covers both.
- **E-4 one camera: PASS.** Hit tests use the camera at the event's seq, so they equal the oracle. I also measured
  exposure: 25% of scripted pointerdowns (eager) and 40% (rAF) happened while the *displayed* camera lagged an
  already-sent wheel. The script fires downs within 4 ms of wheels, so this is a worst case.
- **E-5 commit at end: PASS.** Commits match the oracle count, with one transaction per gesture.
- **E-6: N/A.** There is no playback path in S2.

## Surprises and findings
1. **The extra frame comes from rAF phase, not thread hops.** Main rAF callbacks run about 0.7 ms after the frame
   timestamp. The worker rAF fires at the same point, *before* the editor has seen that frame's input, so a rAF-only
   renderer always draws it one frame later. A "latch" (render waits up to 4 ms in rAF for the editor) does nothing:
   input is not in the ring yet when the worker rAF runs (`validation/latch4-raf`). Co-location does not help either.
   The fix is to draw on arrival.
2. **Eager draw needs coalescing, not a hard cap.** With unlimited eager draws there are 1.6 draws per vsync. A 1 ms
   coalesce gives **1.00–1.03 draws per vsync** at the same latency. A cap of 1 draw per vsync regresses p95 to 2 frames
   (the first event of a burst takes the slot). Frames drawn outside rAF do reach the screen: with WebGPU and rAF
   drawing disabled, screenshots change (`results/shot-webgpu-eager-only.png`). 2D screenshots time out in headless
   even in rAF mode, which is a harness issue.
3. **Busy editor (8 ms per batch, 2k gestures).** Split eager p95 is 32.5 ms, because a 4-event burst becomes two
   8 ms batches. The fast path keeps **pan/zoom at 16.0 ms** but pointer stays at 32.5. **Co-located stays 15.95 ms**,
   because its 1 ms coalesce makes one batch per frame. The lesson is that the **editor should coalesce input per frame
   too**; this matters more than topology. The camera fast path is cheap and correct (bit-identical replay), so keep it
   in reserve for a busy editor.
4. Seqlock reader retries are frequent (up to ~1M spins per run in eager mode, because the reader wakes exactly while
   the writer publishes), but they cost microseconds, and torn reads stayed at 0. A triple buffer would avoid spinning.
5. Measurement bug found and fixed. The first eager runs credited a frame submitted just after a vsync timestamp to that
   vsync, which gave negative latencies. Present is now the first vsync ≥ submit, and all eager configurations were
   rerun.

**Caveats.** Events are synthetic, so OS → browser input latency is excluded. "Present" is the next vsync timestamp, a
lower bound: Chrome's compositor and display usually add about one frame. Four noisy cores are shared with other
spikes; the no-raster CPU numbers were stable across 3 seeds (spread ≤ 0.2 ms).

## Recommendation for M1
- Keep the split topology. Spec in `@staticflux/worker` / `surface` (SF-Δ18, Δ22):
  1. Deltas are published before the frame, and the render applies them up to `F.docVersion` and draws only at
     equality. Otherwise keep the last good frame (E-1/E-2).
  2. The render worker wakes on frame arrival (`Atomics.waitAsync`) with about 1 ms coalescing. rAF is only for
     pacing and metrics.
  3. The editor drains input once per burst, with the same coalesce.
- Turn the oracle-equality check into the IF-7.3 contract suite in testkit. It is cheap (additive hash) and caught every
  injected fault.
- No fast path or co-location for now. Re-decide after the owner run with real Vello raster in the eager draw.

## Rerun (real Chrome with a GPU)
```bash
cd apps/instaflow/spikes/s2-sequencing        # no npm deps; needs Playwright (+ `npx playwright install chromium` locally)
export NODE_PATH=$(npm root -g)               # or wherever `playwright` is installed (/opt/node-tools/node_modules here)
# one config (~4 min for 10k gestures; result JSON → results/<name>.json, one-line summary printed)
bash scripts/run.sh gpu-split-eager 'mode=split&gfx=webgpu&present=eager&eagerDelay=1' --real-gpu --headed
# full matrix (none/2d/webgpu × split/fast/colo × raf/eager, seeds, busy editor) → results/realgpu/SUMMARY.txt
bash scripts/matrix.sh results/realgpu --real-gpu --headed
# or by hand in desktop Chrome (prints the summary and full JSON on the page when done):
node ../_harness/serve-and-run.cjs web index.html --serve-only
#   open http://localhost:<port>/index.html?mode=split&gfx=webgpu&present=eager&eagerDelay=1&gestures=10000
```
Params: `mode=split|fast|colo`, `gfx=webgpu|2d|none`, `present=raf|eager`, `eagerDelay`, `eagerCap`, `gestures`,
`pace`, `align=raf|none`, `seed`, `editorLoad`, `latch`, and validation flags `naive`, `seqlock=0`, `gapEvery`,
`rafDraw=0`. On a 120 Hz display the budget is computed from the measured rAF interval. For true photon latency, record
a `chrome://tracing` trace (viz, gpu) of one run and compare the `tPresent` estimates.
