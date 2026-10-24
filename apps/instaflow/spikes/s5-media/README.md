# S5 — Media: Mediabunny → WebCodecs → WebGPU, audio-master clock, export

**Verdict: proceed with the architecture, but the owner still has to run it on a real GPU machine.** Correctness held
everywhere: exact seek, the frame chosen for the clock, A/V sync logic, export frame exactness and muxing. Every
throughput criterion is INCONCLUSIVE here. This container has no GPU (WebGPU runs on SwiftShader), decode is software,
and 4 cores were shared with other spikes (load average 6–11 during the runs).

## What was built (`web/` + `scripts/`, ~1,100 lines)
- **`common.js`**: tick math (705,600,000/s: 30 fps = 23,520,000 ticks, 48 kHz = 14,700 ticks), Mediabunny `BlobSource`
  demux, keyframe index, `ForwardSession` (decoder + demux cursor + bounded output queue, `resync()` that skips whole
  GOPs) and a reader for the 16-bit frame barcode.
- **`render-worker.js`**: the GPU device and the VideoDecoders together in one worker, on a transferred OffscreenCanvas. It runs the decode,
  composite, exact-seek and playback tests.
- **`gpu.js`**: WebGPU compositor for 3 layers, with two modes: `importExternalTexture(VideoFrame)` and
  `copyExternalImageToTexture` (the fallback). It reads back the composited barcode.
- **`worklet.js` + `audio-worker.js`**: the media worker runs Mediabunny → AudioDecoder (Opus) and writes f32 into a SAB
  SPSC ring (1 s capacity, kept 250 ms ahead). The AudioWorklet pulls from the ring, advances a consumed-sample counter
  (a seqlock clock cell) and detects beep onsets. On underrun it outputs silence and the clock does not advance.
- **Clock**: main publishes `getOutputTimestamp()` and latencies through a seqlock. The render worker computes the heard
  media time at the predicted display moment (rAF + 1 vsync) and picks the frame on the 30 fps grid. Video is slaved;
  audio never waits.
- **`export-worker.js`**: a frame-counter clock, exact in-order decode of 3 layers, an optional GPU composite →
  `VideoEncoder`, an offline 3-layer mix → `AudioEncoder` (Opus), a Mediabunny mux (WebM or MP4), then a reopen to verify
  the barcodes.
- **Media** (`scripts/gen-media.sh`, ffmpeg, synthetic):
  - 3 × 60 s 1080p30 H.264 layers, 8 Mbps with grain, **0.5 s GOP**;
  - 540p proxies, plus VP9 and AV1 versions;
  - a **10-minute 1080p30 clip with Opus audio**, a white flash and a 1 kHz beep on every second.

  Every frame carries a pixel barcode of its own index.

## Criteria (cloud container: Chromium 153 headless, SwiftShader, 4 shared cores)

| Criterion | Result | Numbers / how measured |
|---|---|---|
| 3 × 1080p layers at 60 fps | **INCONCLUSIVE (needs real GPU)**. CPU decode alone FAILS the strict reading here. | **Decode only, 3 parallel 1080p H.264 streams:** 289 fps aggregate (96/stream) in an early quieter run (load 3, not saved to results/), 104 fps (35/stream) under load. One stream: 172 fps quiet, 89 fps loaded. 540p ×3: 930 fps quiet, 328 fps loaded. **Decode + composite on SwiftShader:** 1.1 fps with external textures, 0.6 fps with copy. A small canvas (480×270) still only reaches 2.2 fps, because uploading each *new* CPU frame costs about 400 ms. Re-importing a frame that is already uploaded takes 38 ms. So the cost is SwiftShader's upload of software-decoded frames, not compositing. All `importExternalTexture` readback checks were correct. |
| Exact seek on a 0.5 s-GOP proxy ≤ 60 ms | **INCONCLUSIVE (needs owner machine)**. Correctness **PASS**. | 150 random seeks per case: reset → keyframe ≤ t → decode → discard to target. **0 wrong frames in 1,350 seeks** (pixel barcode), and 0 wrong in 135 GPU readbacks. Time to the frame being ready, median/p95 in ms, measured at load ≈ 8 on 4 cores: **540p proxy:** 35/65 (Mediabunny `VideoSampleSink`), 44/79 (flush), 48/92 (feed + `optimizeForLatency`). **1080p 4 Mbps, no B-frames:** 52/83. **1080p 8 Mbps, B-frames:** 116–141/199–318. Presented-on-screen time adds about 350–600 ms of SwiftShader time, which is not meaningful. |
| A/V drift ≤ 16 ms over 10 min (wired) | **PASS for the timeline logic (headless)**. Real output device INCONCLUSIVE. | 598 s, headless audio sink, frame selection every rAF (`present=select`, no GPU draw). Out of 17,913 frames shown, **0 were wrong for the clock**, 16 were dropped and 0 were late. 0 underruns. All 598 beeps landed at exactly k·48000 + 4 samples. **Flash vs beep offset:** median 7.2 ms, mean 7.9, p95 14.7, p99 26.6, max 31.4. The p99 tail comes from late rAF ticks (tick max 233 ms) on the shared CPU. **Trend: +0.03 ms/min**, so no drift accumulates. The 0–16.7 ms spread is the 60 Hz display quantum. Meanwhile the audio device clock fell **351 ms behind wall time** over 10 min: a wall-clock-driven player would have drifted by that much. |
| A/V drift with Bluetooth | **INCONCLUSIVE (needs a human)** | Headless reports `outputLatency` = 32 ms. `currentTime − getOutputTimestamp` = 36 ms median, so Chrome's output timestamp already includes the device latency the design relies on. Real BT (100–300 ms) has to be checked with the flash/beep clip, by eye or with a camera. |
| 60 s 1080p30 export ≥ 3× real time | **INCONCLUSIVE (needs real GPU + HW encoder)**. Software here **FAILS**. | Real 60 s exports, 3 layers decoded exactly (0 inexact source frames) and muxed with Opus; barcodes verified after reopening. **Without the GPU composite:** H.264 **1.10×** real time, VP9 0.61×, AV1 0.35×. **Encoder only** (1080p, already decoded): H.264 57 fps (1.9×), VP9 26 fps, AV1 20 fps in quality mode and 26 fps in realtime mode. **With the GPU composite on SwiftShader:** 0.02–0.03× (10 s runs). Encode waits on the canvas readback (1.3–1.8 s per frame). |

The SwiftShader playback with GPU present (`results/drift-60-gpu.json`) behaved as follows:
- The render loop ran at about 2 fps.
- With the **catch-up policy** (skip to the next keyframe once more than one GOP behind), the A/V offset stayed bounded:
  median 149 ms, max 477 ms, 29 resyncs.
- **Without it, video fell 25 s behind audio in 60 s.**

## Surprises
1. **H.264 encode works in this Chromium** (`avc1.640028`, 1.9× real time in software), which contradicts the brief.
   AAC *encode* is unsupported. Opus encode, Opus decode and AAC decode all work.
2. **The audio clock and the wall clock diverge** by 160–350 ms in 10 min, in steps, on the headless sink. This makes a
   strong case for audio-master (R: research 02 §1.4).
3. **Slaving alone is not enough.** A slow render or decode loop makes video fall behind without bound. The `DecoderPool`
   needs a "behind by more than a GOP → reset and jump to the next keyframe" rule, and the `stalled` clock state.
4. **Mediabunny's `VideoSampleSink.getSample()` was the fastest exact seek on the proxy.** A hand-rolled reset/feed path
   gains nothing for cold seeks. It is still worth having for `reset()` cancellation and warm cursor reuse.
5. **Demux is not the bottleneck.** Mediabunny over a Blob reads 14k packets/s (481 MB/s) and builds the keyframe index of
   a 60 s clip in 27 ms.
6. **The proxy encode shape matters as much as resolution.** 1080p without B-frames at 4 Mbps seeks in half the time of
   1080p with B-frames at 8 Mbps.

## Recommendation for M1/M3
- Keep the design: Mediabunny as the only container port, WebCodecs, `importExternalTexture`, a SAB ring with an
  audio-master clock cell, and a frame-counter export clock.
- **Proxies:** H.264, 540p (or 720p), 0.5 s GOP, **no B-frames**. Use `optimizeForLatency` for scrub/seek sessions.
- `MediaClock` must include `stalled` plus GOP-skip catch-up. Count drops, lates and resyncs in metrics.
- **Default export codec:** H.264 (MP4) where `isConfigSupported` says yes; otherwise AV1 in `realtime` mode, which beat
  VP9 here.
- Out-of-order or parallel export is the lever to reach ≥ 3×, if a real GPU plus HW encode falls short.
- Do not trust any headless GPU timing. The owner run below decides the throughput criteria and whether the 540p-preview
  fallback is needed.

## Rerun
Cloud/headless:
```sh
cd apps/instaflow/spikes/s5-media
npm install
bash scripts/gen-media.sh                   # ffmpeg with libx264/libvpx/libsvtav1/libopus; ~6 min
bash scripts/run-all.sh                     # writes results/*.json (~75 min)
```

Owner machine with a real GPU and Chrome stable (needs Node, ffmpeg and Playwright: `npm i -D playwright`):
```sh
bash scripts/run-all.sh --real-gpu --headed --chrome   # 300-frame composite, 60 s GPU export, 10-min drift presented on the GPU
```

Manual alternative:
1. Run `node scripts/run.cjs . web/index.html --serve-only`.
2. Open the printed URL in Chrome and click the test links (probe, decode, composite, seek, `drift&dur=600`, export).
3. Drift needs a click to start audio. Results appear on the page and in `window.__result`.

Bluetooth check: open `?test=drift&dur=600` with BT headphones on and watch the white square against the beep. To check
`outputLatency` compensation, compare with `&lead=0`.

Single-test parameters:
- composite: `frames=`, `small=WxH`;
- seek: `n=`;
- drift: `dur=`, `present=gpu|select`, `catchup=0`, `canvas=WxH`, `lead=ms`, `latency=playback`;
- export: `seconds=`, `gpuSeconds=`, `codecs=vp9,av1,h264`, `composites=none,gpu`, `latencyMode=realtime`.

Known reader quirk: on VP9-decoded output, barcode bit 15 reads as set. The lower 15 bits matched on every check.
