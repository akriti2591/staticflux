# S9 Matte: BiRefNet-class matte on ORT Web (WebGPU) + licence sign-off

**Verdict: needs an owner-machine run for fps.** It is also **likely FALLBACK at 1024² BiRefNet.** The licence check passes: BiRefNet, MODNet, U²-Net and MediaPipe are all commercial-OK. The stock ONNX needs a bit-exact graph fix (`webgpu_safe.py`) before ORT WebGPU will even run it. However, the published BiRefNet-lite ONNX has a fixed 1024² input, needs 784 MB intermediate tensors and has a native working set of about 7 GB. It also has no WASM fallback, and on SwiftShader its single test frame crashed the renderer. That makes ≥ 5 fps on an iGPU unlikely. Run `npm run owner` on the Mac to settle it.

PLAN §1 row S9: *≥ 5 fps at 720p on the iGPU machine; temporally stable edges after smoothing; weights licensed for commercial use.
Kill → MediaPipe-quality matte for V1 + "Fix edges", revisit at M5.*

## What was built

- `web/matte-worker.js` is the **ML worker**: a module worker using `onnxruntime-web@1.30.0` (`ort.webgpu.min.mjs`) with the `webgpu` EP or the `wasm` EP (4 threads, SIMD, COOP/COEP). Frames go in as transferred `ImageBitmap`s at 1280×720. The worker then:
  1. resizes and normalises to the model input;
  2. runs the model;
  3. applies a sigmoid or min-max normalisation and bilinearly upsamples to 720p;
  4. smooths the result.
- `web/smooth.js` is the **temporal smoother**, a CPU reference implementation (the M1 version would be a WGSL compute shader). It applies a guided filter (He 2010, r = 6, ε = 1e-3), using the frame luma as the guide, then a **motion-gated EMA**: k = 0.3 + 0.7·clamp(max(|ΔRGB|max,box / 0.04, |Δα| / 0.5)). Static pixels average over time; moving pixels follow the new matte, so there is no ghosting. An EMA-only variant is reported alongside.
- `web/scene.js` generates the **test footage**: a synthetic 720p "person" (shaded head, 420 sub-pixel hair strands, shirt, arms) over a procedural room (window, bookshelf, plant), with per-frame sensor noise. **No third-party media is used.** Wikimedia, Openverse, Pexels and Unsplash were all unreachable from the container, so no CC0 portraits were used. The person is drawn on its own layer, so its alpha channel is an **exact ground-truth matte**. There are three sequences:
  - `static`: only noise changes;
  - `bgmotion`: the subject is static while a blurred passer-by and bokeh move behind;
  - `moving`: the subject sways ±140 px, up to 37 px/frame.
- `web/index.html` + `main.js` form the bench page. It reports fps (median, p95, end-to-end and inference-only), load time (fetch, session create, first run), flicker, accuracy against GT (MAE, edge-band MAE, IoU), adapter limits and previews (input, GT, raw, smoothed, cutout). It sets `window.__result`, which is the harness contract.
- MediaPipe `@mediapipe/tasks-vision@1.1.1` `selfie_segmenter` runs in the same page as the **fallback tier** baseline. Its GPU delegate is WebGL, not WebGPU.
- `scripts/`:
  - `setup.mjs` downloads the models with SHA-256 pins and builds the variants;
  - `webgpu_safe.py` is the graph fix (see Surprises);
  - `convert.py` (fp16) and `quant.py` (int8) build the reduced-precision variants;
  - `native_ref.py` measures native ORT CPU memory and latency;
  - `run.cjs` is the shared harness logic plus streamed page logs, /proc RSS sampling and `--chrome`;
  - `summarize.cjs` turns result JSON into tables.

## Licensing (done first; nothing non-commercial was downloaded)

Hugging Face was **unreachable** from the container (proxy 403 and DNS failure), and so was Google Drive. Primary sources are therefore the GitHub repos and releases. Hugging Face model-card fields come from web-search snippets and are marked *secondary*. **Re-verify those two cells on huggingface.co before shipping.**

| Candidate | Code licence (verbatim, source) | Weights licence (verbatim, source) | Commercial? | Attribution / obligations |
|---|---|---|---|---|
| **BiRefNet** (general, lite / Swin-T, portrait), ZhengPeng7 | "MIT License / Copyright (c) 2024 ZhengPeng / Permission is hereby granted, free of charge, to any person obtaining a copy of this software … to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies…" ([LICENSE](https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE)) | The ONNX weights we use are assets of the same repo's [GitHub release v1](https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1) (README: "We uploaded the ONNX model files of all weights in the GitHub release"). The HF cards `ZhengPeng7/BiRefNet*` declare `license: mit` (*secondary*: search snippet; HF unreachable). | **Yes** | "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software." Ship the MIT notice in the app's third-party notices and the model-card registry. **Caveat for legal:** the weights were trained on public research datasets (DIS5K, DUTS, HRSOD, UHRSD, P3M-10k, …, per the README model-zoo table). Their dataset terms were **not** reviewed here. |
| **MODNet**, ZHKKKe | Apache-2.0 ([LICENSE](https://github.com/ZHKKKe/MODNet/blob/master/LICENSE)) | "The code, models, and demos in this repository (excluding GIF files under the folder `doc/gif`) are released under the [Apache License 2.0] license." ([README §License](https://github.com/ZHKKKe/MODNet#license)) | **Yes** | Apache-2.0 §4: include the licence, keep notices and state changes. **Provenance caveat:** the official checkpoint is on Google Drive (blocked). We measured the `Xenova/modnet` int8 ONNX taken from an **unofficial npm re-host** (`sts-rmbg-modnet@1.0.0`, Apache-2.0 per package.json, sha256 `92e4…fee3a`). For shipping, export from the official checkpoint or take the file from HF `Xenova/modnet`. |
| **U²-Net / U²-Net-p / u2net_human_seg**, xuebinqin | Apache-2.0 ([LICENSE](https://github.com/xuebinqin/U-2-Net/blob/master/LICENSE)) | No separate weights statement in the [README](https://github.com/xuebinqin/U-2-Net). The weights are distributed from the Apache-2.0 repo. We used the [rembg](https://github.com/danielgatis/rembg) release mirror (rembg itself: "MIT License / Copyright (c) 2020 Daniel Gatis"). | **Probably yes** (implicit, via the repo licence) | Apache-2.0 notices. Ask legal whether an implicit weights licence is acceptable. |
| **MediaPipe Selfie Segmentation** (fallback), Google | `@mediapipe/tasks-vision` 1.1.1: `"license": "Apache-2.0"` (npm). Repo: Apache-2.0 ([LICENSE](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE)) | Model card PDF: "LICENSED UNDER … Apache License, Version 2.0 … DATE May 6, 2021" ([model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf)) | **Yes** | Apache-2.0 notices. |
| **RMBG-1.4**, BRIA | n/a | Card `license: bria-rmbg-1.4`; LICENSE titled "BRIA AI on Hugging Face Model License Agreement for Non-Commercial Use"; "commercial use is subject to a commercial agreement with BRIA" (*secondary*: search snippets of [the HF card](https://huggingface.co/briaai/RMBG-1.4) and [its LICENSE](https://huggingface.co/briaai/RMBG-1.4/blob/6d2eb76d224897fe0b68b5fb37a2c39db49b880e/LICENSE)) | **NO** | Not downloaded, not measured. |
| **RMBG-2.0**, BRIA (a BiRefNet architecture trained on private data) | n/a | CC BY-NC 4.0 / `bria-rmbg-2.0` (*secondary*: [HF card](https://huggingface.co/briaai/RMBG-2.0) mirrors). BiRefNet's own README (primary) says: "Note that their weights are for only **non-commercial use**". | **NO** | Not downloaded, not measured. |
| Runtime: `onnxruntime-web` 1.30.0 | MIT (npm) | n/a | Yes | MIT notice |

**Licence verdict: PASS.** BiRefNet weights are MIT, from the author's own release, and the code is MIT. Before shipping: confirm the HF card fields, review the training-dataset terms, and pin the exact files in the model-card registry (sha256 values are in `scripts/setup.mjs`).

## Results (cloud: 4 noisy cores shared with other spike agents; WebGPU = SwiftShader; medians, p95 where shown)

The sizes are **raw fp32 / fp16 / int8**:

| Model | fp32 | fp16 | int8 |
|---|---|---|---|
| BiRefNet-lite (Swin-T, 1024²) | 224 MB | 114 MB (local) | 112 MB (local dynamic quant) |
| BiRefNet-portrait (Swin-L) | 973 MB | 488 MB | — |
| MODNet | — | — | 6.6 MB |
| U²-Net-p | 4.6 MB | 2.3 MB | — |
| u2net_human_seg | 176 MB | — | — |
| MediaPipe selfie | — | 0.25 MB (tflite) | — |

Metric definitions:
- **Flicker** is the mean |αₜ − αₜ₋₁| with α ∈ [0, 1], over the **edge band** (pixels within 6 px of the GT boundary). Whole-frame flicker is about 10–40× smaller.
- **Ghost** is the mean alpha the smoother adds above the raw matte on true-background pixels in the moving sequence.
- **e2e fps** includes about 200 ms of CPU smoothing at 720p in JS; in the real pipeline this would run on the GPU.
- **Smoothing** default: GF+EMA. EMA-only is shown after the "/".

| Model / EP | Input | Load: create + 1st run | Infer ms static (median / p95) | Infer-only fps | Flicker edge, static: raw → GF+EMA / EMA | Flicker edge, bg-motion: raw → GF+EMA | IoU static | IoU moving raw → GF+EMA | Edge MAE moving: raw → GF+EMA / EMA | Ghost GF+EMA / EMA | Peak RSS renderer / tree |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MediaPipe selfie / CPU | 256² | 0.3 s | 40 / 59 | **25** | 0.0098 → 0.0047 / 0.0041 | 0.0149 → 0.0080 | 0.958 | 0.959 → 0.968 | 0.264 → 0.246 / 0.260 | 0.0025 / 0.0005 | 331 / 748 MB |
| MediaPipe selfie / GPU (WebGL, SwiftShader) | 256² | 0.5 s | 174 / 221 | 5.7 | 0.0101 → 0.0050 / 0.0043 | 0.0146 → 0.0079 | 0.960 | 0.962 → 0.968 | 0.257 → 0.242 / 0.252 | 0.0025 / 0.0005 | 315 / 712 MB |
| U²-Net-p / wasm | 320² | 1.8 + 4.4 s | 1059 / 1280 | 0.9 | 0.0268 → 0.0135 / 0.0118 | 0.0263 → 0.0154 | 0.971 | 0.970 → 0.975 | 0.193 → 0.185 / 0.189 | 0.0020 / 0.0004 | 673 / 1018 MB |
| u2net_human_seg / wasm | 320² | 0.9 + 3.3 s | 2850 / 3303 | 0.35 | 0.0070 → 0.0048 / 0.0030 | 0.0070 → 0.0049 | 0.967 | 0.968 → 0.972 | 0.235 → 0.230 / 0.232 | 0.0021 / 0.0002 | 951 / 1350 MB |
| MODNet int8 / wasm | 512×288 | 0.8 + 1.4 s | 1043 / 1220 | 1.0 | 0.0237 → 0.0152 / 0.0131 | 0.0271 → 0.0155 | 0.850 | 0.823 → 0.827 | 0.123 → 0.130 / 0.122 | 0.0016 / 0.0001 | 427 / 831 MB |
| MODNet int8 / wasm | 896×512 | 1.1 + 2.5 s | 2106 / 2285 | 0.5 | 0.0245 → 0.0177 / 0.0168 | 0.0275 → 0.0203 | 0.792 | 0.837 → 0.839 | 0.229 → 0.243 / 0.228 | 0.0012 / 0.0001 | 623 / 1028 MB |
| **BiRefNet-lite / wasm** (fp32 and int8) | 1024² | create 9.9 s | **`std::bad_alloc`** on the first run; the renderer grows to 4.6 GB (wasm32 heap limit). Native ORT CPU: peak 6.8 GB without the arena (12 GB with it), 17–21 s/frame on 4 cores. | — | — | — | — | — | — | — | 4578 / 5042 MB |
| U²-Net-p / WebGPU (SwiftShader) | 320² | 3.4 + 143 s | 103 340 | 0.01 | output identical to wasm (**parity ✓**) | | 0.971 | | | | |
| MODNet int8 / WebGPU (SwiftShader) | 512×288 | 0.9 + 17 s | 13 906 | 0.07 | 0.0126 → 0.0092 / 0.0063 | | 0.878 | | | | |
| **BiRefNet-lite (WebGPU-safe) / WebGPU (SwiftShader)** | 1024² | **create 11.7 s ✓** | the single frame ran for about 28 min, the GPU process grew past 4.5 GB RSS, then the **renderer crashed** (cause not determined; no OOM-killer trace). Output **not verified**. | — | — | — | — | — | — | — | GPU process ≥ 4.5 GB |

Raw data:
- JSON: `results/cloud.json`, `results/u2netp-webgpu.json`, `results/mem-*.json`;
- log: `results/birefnet-webgpu-swiftshader-crash.log`;
- previews of input, GT, raw, smoothed and cutout: `results/preview.png` (add `--screenshot` to `scripts/run.cjs` for any run).

## Criteria

| Criterion | Result | How measured |
|---|---|---|
| ≥ 5 fps at 720p on the iGPU machine (BiRefNet-class, WebGPU) | **INCONCLUSIVE (needs real GPU)**; my forecast is **likely FAIL at 1024²** | SwiftShader WebGPU is about 100× slower than WASM here (U²-Net-p: 103 s vs 1.06 s), so it says nothing about Metal. Evidence for the forecast: BiRefNet-lite has a fixed 1024² input, takes 17–21 s/frame on a native 4-core CPU, has 784 MB single tensors (deform-conv emulation), 33 GB of intermediates in total, and a working set of at least 6.8 GB. The author reports about 94 ms for this ONNX on an **A100**. Run `npm run owner` to settle it. |
| Temporally stable edges after smoothing | **PASS (synthetic footage)** | Edge-band flicker drops 30–55 % for every model and sequence (for example U²-Net-p 0.0268 → 0.0135, MediaPipe 0.0098 → 0.0047). IoU on the moving subject does not get worse. Ghosting stays ≤ 0.0025 mean alpha. **Caveat:** the footage is synthetic with synthetic noise, so check real footage on the owner run. **EMA-only** has the lowest flicker and about 5× less ghosting. The guided filter improves edge MAE for MediaPipe and U²-Net (0.264 → 0.246) but makes it worse for MODNet and leaves a faint halo. Recommendation: EMA by default, guided filter as "Fix edges". |
| Weights licensed for commercial use | **PASS** (BiRefNet MIT; MODNet, U²-Net and MediaPipe Apache-2.0) | Licence table above. The Hugging Face cells are secondary and must be re-confirmed. Training-data terms were not reviewed. |
| (extra) BiRefNet runs on ORT WebGPU | **Partial**: the stock ONNX **fails**; after the bit-exact `webgpu_safe.py` fix the session creates, but no frame completed on SwiftShader | See Surprises 1. Needs the owner run. |

## Surprises

1. **The stock BiRefNet ONNX cannot run on WebGPU.**
   - **Failure:** `numbers_storage_buffers_ <= limits_.maxStorageBuffersPerShaderStage … Current: 11, Max is 10`.
   - **Cause:** 59 `Split` ops with 8–32 outputs, and `Concat`s with up to 1024 inputs.
   - **Fix:** `scripts/webgpu_safe.py` rewrites them into `Slice`s and a `Concat` tree (≤ 8 bindings). It is **bit-exact** (max |Δ| = 0.0 on ORT CPU).
   - The WebGPU default for this limit is 8, so Apple adapters can hit the same error. The page logs `maxStorageBuffersPerShaderStage`.
   - **M1:** the model-card registry should record "WebGPU-safe" per weight file.
2. **There is no CPU or WASM fallback for BiRefNet in the browser.** The opset-17 export emulates the deformable convolutions with tensors like `[1,64,1792,1792]` (784 MB each). That blows the 4 GB wasm32 heap: the renderer reaches 4.6 GB and then hits `bad_alloc`. The BiRefNet README itself says the opset-22 native `DeformConv` "has a large improvement on memory / inference-time cost".
3. **The int8 builds are traps.**
   - Naive dynamic quantisation keeps all fp32 weights (253 MB > 224 MB). It needs `quant_pre_process`, which gives 112 MB.
   - Even then the result is `MatMulInteger`/`ConvInteger`, which the WebGPU EP cannot run, so **int8 is only a download-size win**.
   - On WebGPU use fp16. It needs `shader-f16`, which Apple GPUs have and SwiftShader does not.
   - The MODNet int8 export is likewise CPU-bound under WebGPU, with "nodes not assigned" warnings.
4. **MediaPipe's CPU delegate is fast:** 40 ms/frame on noisy shared cores, and its smoothed flicker is the lowest of all models. Its edges are soft (edge MAE about 0.26 vs 0.19 for U²-Net-p, against hair-strand GT). It is a credible V1 fallback.
5. **A luma-only motion gate ghosts where the foreground and background have similar luma** (skin against a beige wall); I caught this in the preview. The fix: gate on the max-RGB difference **and** on alpha jumps over 0.5. The CPU smoother costs about 200 ms at 720p in JS and must become a WGSL pass (box filters plus a per-pixel blend).
6. **Accuracy on synthetic GT:** U²-Net-p and u2net_human_seg reach IoU 0.97, MediaPipe 0.96 and MODNet 0.79–0.85. The synthetic "person" is not photoreal, so do not read the ranking as real-world quality.
7. **Environment:** Hugging Face, Google Drive and all CC0 image hosts were blocked. BiRefNet came from its official GitHub release; MODNet only from an npm re-host.

## Recommendation for M1

- **Ship the fallback architecture now:**
  - MediaPipe selfie as the live mask (the CPU delegate is fast enough everywhere);
  - plus a WGSL motion-gated EMA (RGB + α-jump gate);
  - and an optional guided filter as "Fix edges".
- **Make the baked-matte job model-pluggable through the model-card registry.** Each entry records the file sha256, the licence, the input shape, whether it is WebGPU-safe, whether it needs fp16/`shader-f16`, the minimum `maxStorageBuffersPerShaderStage`, and the peak memory.
- **Default the baked job to BiRefNet-lite fp16 only if the owner run shows ≥ 5 fps on Metal and stable memory.** Otherwise default to MODNet fp32 or U²-Net at 512-class input. Then revisit BiRefNet at M5 with either:
  - `BiRefNet_dynamic` (README: trained on 256–2304 px), exported at 512² with **opset ≥ 22 native `DeformConv`**; or
  - a variant without deformable decoder blocks.
- **Never route BiRefNet to the WASM EP.** Gate the job on WebGPU (`shader-f16` + limits) and drop to the small models otherwise.

## Rerun

Cloud or Linux, from `apps/instaflow/spikes/s9-matte/`:

```sh
npm install                      # onnxruntime-web 1.30.0, @mediapipe/tasks-vision 1.1.1 (+ playwright, no browsers)
npm run setup                    # ~1.4 GB of models into models/ (gitignored), sha256-checked; python3 for fp16/WebGPU-safe variants (~5 min)
NODE_PATH=/opt/node-tools/node_modules npm run bench:cloud       # → results/cloud.json
node scripts/summarize.cjs results/cloud.json
```

**Owner's Mac (Metal, Chrome 155), one command** (installs playwright, uses your installed Chrome, headed, real GPU, about 10–20 min):

```sh
cd apps/instaflow/spikes/s9-matte && npm install && npm run owner   # → results/owner-gpu.json (memory column needs Chrome Task Manager on macOS)
```

**Or no automation** (prebuilt page, nothing to build):

```sh
npm install && npm run setup && npm run serve      # or: node ../_harness/serve-and-run.cjs . web/index.html --serve-only
# open http://localhost:5299/web/index.html in Chrome 155, then click "Run owner preset" (or "Quick: BiRefNet-lite WebGPU only").
# Read the table on the page; copy the "Result JSON" block. Use Chrome Task Manager (GPU process) for memory.
```

You can also run a single configuration, for example `…/web/index.html?runs=birefnet_lite_fp16:webgpu:30:static+moving`. Model ids are in `web/models.js`. Smoothing knobs: `&ema=0.3&motion=0.04&gfR=6&gfEps=0.001&guided=0`.

**What to read:**
- `fps infer` for `birefnet_lite` and `birefnet_lite_fp16` on webgpu (criterion: ≥ 5);
- `env.adapter.maxStorageBuffersPerShaderStage` and `f16`;
- any `error` column.
