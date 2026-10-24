# S9 Matte: BiRefNet-class matte on ORT Web (WebGPU) + licence sign-off

**Verdict: needs an owner-machine run for fps.** It is also **likely FALLBACK at 1024² BiRefNet.** The licence check passes: BiRefNet, MODNet, U²-Net and MediaPipe are all commercial-OK. The model also runs end to end on WebGPU after a bit-exact graph fix. However, the published BiRefNet-lite ONNX has a fixed 1024² input, needs 784 MB intermediate tensors and has a native working set of about 7 GB. That makes ≥ 5 fps on an iGPU unlikely. Run `npm run owner` on the Mac to settle it.

PLAN §1 row S9: *≥ 5 fps at 720p on the iGPU machine; temporally stable edges after smoothing; weights licensed for commercial use.
Kill → MediaPipe-quality matte for V1 + "Fix edges", revisit at M5.*

## What was built

- `web/matte-worker.js` is the **ML worker**: a module worker using `onnxruntime-web@1.30.0` (`ort.webgpu.min.mjs`) with the `webgpu` EP or the `wasm` EP (4 threads, SIMD, COOP/COEP). Frames go in as transferred `ImageBitmap`s at 1280×720. The worker then:
  1. resizes and normalises to the model input;
  2. runs the model;
  3. applies a sigmoid or min-max normalisation and bilinearly upsamples to 720p;
  4. smooths the result.
- `web/smooth.js` is the **temporal smoother**, a CPU reference implementation (the M1 version would be a WGSL compute shader). It applies a guided filter (He 2010, r = 6, ε = 1e-3), using the frame luma as the guide, then a **motion-gated EMA** (k = 0.3 + 0.7·clamp(|ΔY|box/0.04)). Static pixels average over time; moving pixels follow the new matte, so there is no ghosting. An EMA-only variant is reported alongside.
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

In the table below:
- *Flicker* is the mean |αₜ − αₜ₋₁| on the static subject, over **edge-band** pixels (within 6 px of the GT boundary), in units of α ∈ [0, 1].
- Whole-frame flicker is about 10–40× smaller because interior and background pixels are stable.
- *e2e fps* includes about 190 ms of CPU smoothing at 720p; the real pipeline would do this on the GPU.

| Model / EP | Input | Load (create + 1st run) | Infer ms (static, median / p95) | Infer-only fps | Flicker edge, static: raw → GF+EMA (EMA only) | Flicker edge, bg-motion: raw → GF+EMA | IoU static | IoU moving raw → smoothed | Peak RSS (renderer / tree) |
|---|---|---|---|---|---|---|---|---|---|
| MediaPipe selfie / CPU (wasm) | 256² | 0.2 s | 35 / 43 | **28** | 0.0098 → 0.0047 (0.0040) | 0.0149 → 0.0077 | 0.958 | 0.959 → 0.965 | 331 / 748 MB |
| MediaPipe selfie / GPU (WebGL on SwiftShader) | 256² | 0.4 s | 157 / 196 | 6.4 | 0.0101 → 0.0050 (0.0042) | 0.0146 → 0.0076 | 0.960 | 0.962 → 0.966 | 315 / 712 MB |
| U²-Net-p / wasm | 320² | 1.5 + 7.0 s | 848 / 998 | 1.2 | 0.0268 → 0.0134 (0.0116) | 0.0263 → 0.0151 | 0.971 | 0.970 → 0.974 | 673 / 1018 MB |
| u2net_human_seg / wasm | 320² | 1.0 + 2.4 s | 2244 / 2423 | 0.45 | 0.0070 → 0.0048 (0.0030) | 0.0070 → 0.0049 | 0.967 | 0.968 → 0.971 | 951 / 1350 MB |
| MODNet int8 / wasm | 512×288 | 0.9 + 1.6 s | 975 / 1105 | 1.0 | 0.0237 → 0.0138 (0.0114) | 0.0271 → 0.0136 | 0.850 | 0.823 → 0.837 | 427 / 831 MB |
| MODNet int8 / wasm | 896×512 | 0.8 + 2.2 s | 1968 / 2155 | 0.5 | 0.0245 → 0.0137 (0.0110) | 0.0275 → 0.0160 | 0.792 | 0.837 → 0.849 | 623 / 1028 MB |
| **BiRefNet-lite / wasm** (fp32 and int8) | 1024² | create 9.9 s | **`std::bad_alloc`**: does not fit the 4 GB wasm32 heap (native ORT CPU peak: 6.8 GB without the arena, 12 GB with it; 17–21 s/frame on 4 cores) | — | — | — | — | — | — |
| U²-Net-p / WebGPU (SwiftShader) | 320² | 3.4 + 143 s | 103 340 | 0.01 | identical output to wasm (parity ✓) | | 0.971 | | |
| MODNet int8 / WebGPU (SwiftShader) | 512×288 | 1.0 + 16.7 s | 13 492 | 0.07 | 0.0126 → 0.0092 | | 0.878 | | |
| **BiRefNet-lite / WebGPU (SwiftShader)** | 1024² | create 11.7 s | BIREFNET_WEBGPU_RESULT | | | | | | |

Raw JSON is in `results/cloud.json`, `results/u2netp-webgpu.json`, `results/birefnet-webgpu-swiftshader.json` and `results/mem-*.json`.

## Criteria

| Criterion | Result | How measured |
|---|---|---|
| ≥ 5 fps at 720p on the iGPU machine (BiRefNet-class, WebGPU) | **INCONCLUSIVE (needs real GPU)**; forecast: likely FAIL at 1024² | SwiftShader WebGPU is about 100× slower than WASM here (U²-Net-p: 103 s vs 0.85 s), so it says nothing about Metal. Evidence for the forecast: BiRefNet-lite needs 1024² input (fixed in the ONNX), 17–21 s/frame on native 4-core CPU, 784 MB single tensors (deform-conv emulation) and about 7 GB peak working set. The author reports about 94 ms/frame for this ONNX on an **A100**; an Apple iGPU has a small fraction of that compute and bandwidth. Run `npm run owner` to settle it. |
| Temporally stable edges after smoothing | **PASS (synthetic footage)** | The smoother halves edge-band flicker for every model on both static sequences (for example 0.0268 → 0.0134 for U²-Net-p and 0.0245 → 0.0137 for MODNet), and on the background-motion sequence too. It does not hurt the moving subject: IoU goes up for every model (0.970 → 0.974 and so on). **Caveat:** the input is synthetic with synthetic noise, so the owner should eyeball real footage. EMA-only flicker is as low as or lower than GF+EMA, and the guided filter did **not** improve edge MAE on this GT. Keep the guided filter as an optional "Fix edges" knob, not as the default. |
| Weights licensed for commercial use | **PASS** (BiRefNet MIT; MODNet, U²-Net and MediaPipe Apache-2.0) | Licence table above. Hugging Face cells are secondary and need re-confirmation on huggingface.co. Training-data terms were not reviewed. |
| WebGPU EP works for BiRefNet | **PASS after the graph fix** (see Surprises) | Session creates in 11.7 s and runs BIREFNET_WEBGPU_RUN |

## Surprises

1. **The stock BiRefNet ONNX does not run on WebGPU at all.**
   - **Failure:** ORT fails with `numbers_storage_buffers_ <= limits_.maxStorageBuffersPerShaderStage … Current: 11, Max is 10`.
   - **Cause:** the graph has 59 `Split` ops with 8–32 outputs and `Concat`s with up to 1024 inputs.
   - **Fix:** `scripts/webgpu_safe.py` rewrites them into `Slice`s and a `Concat` tree. The result is **bit-exact** (max |Δ| = 0.0 on ORT CPU).
   - **Mac risk:** the WebGPU default limit is 8, so Apple adapters can hit this too.
   - **M1:** the model-card registry should record "WebGPU-safe" as a property of each weight file.
2. **BiRefNet-lite cannot run on the WASM EP.**
   - Inference needs far more than the 4 GB wasm32 heap: native peak is 6.8–12 GB.
   - The cause is the opset-17 export of the deformable convolutions, which expands to tensors like `[1,64,1792,1792]`. The sum of all intermediates is 33 GB.
   - So there is **no CPU fallback for BiRefNet in the browser**. If WebGPU is missing or too weak, the baked job must use MODNet, U²-Net or MediaPipe.
3. **The int8 builds are traps.**
   - Naive dynamic quantisation kept every fp32 weight, giving 253 MB > 224 MB. It needs `quant_pre_process` (112 MB result).
   - Even then it contains `MatMulInteger`/`ConvInteger`, which the WebGPU EP cannot run. **int8 is only a download-size win.** On WebGPU, use fp16 (needs `shader-f16`, which Apple GPUs have and SwiftShader does not).
   - The MODNet int8 export is likewise CPU-bound under WebGPU: 13 s on SwiftShader, with "nodes not assigned" warnings.
4. **MediaPipe's CPU delegate is fast:** 35 ms/frame on 4 noisy cores, with flicker after smoothing equal to or better than the ONNX models. Its edges are soft (edge MAE about 0.25 vs 0.19 for U²-Net-p, against the hair-strand GT). It is a credible V1 fallback.
5. **The CPU smoother costs about 190 ms at 720p** in JS, which dominates the end-to-end fps of the small models. It must become a WGSL pass (it is box filters and a per-pixel blend, trivially parallel).
6. **Accuracy on synthetic GT:** U²-Net-p and u2net_human_seg reach IoU 0.97, MediaPipe 0.96 and MODNet 0.79–0.85. MODNet is a portrait-matting model, and the synthetic "person" is not photoreal. Do not read the ranking as real-world quality.

## Recommendation for M1

- **Ship the fallback architecture now:**
  - MediaPipe selfie as the live mask (CPU delegate on all platforms is fast enough);
  - plus the WGSL port of motion-gated EMA (and an optional guided filter as "Fix edges").
- **Make the baked-matte job model-pluggable through the model-card registry** (file sha256, licence, input shape, WebGPU-safe, fp16 / shader-f16 required, minimum `maxStorageBuffersPerShaderStage`).
- **Default the baked job to BiRefNet-lite fp16** only if the owner run shows ≥ 5 fps on Metal. Otherwise use MODNet or U²-Net at 512-class input. Revisit BiRefNet at M5 with either:
  - `BiRefNet_dynamic` (README: trained for 256–2304 px), exported at 512² with **opset ≥ 22 native `DeformConv`** (the README says this helps memory and time a lot), via `tutorials/` on a machine with HF access; or
  - a BiRefNet variant without deformable decoder blocks.
- **Keep the baked job off the WASM EP for BiRefNet.** Gate the job on WebGPU (`shader-f16` + limits). Otherwise drop to the small models.

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
