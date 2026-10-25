# Brief for Phase 0 spike agents

You run ONE (or a pair of) Instaflow Phase 0 spike(s). Read first:
- `docs/instaflow/DECISIONS.md` (locked decisions — authoritative)
- `docs/instaflow/PLAN.md` §1 (your spike's row: pass criteria and kill/fallback)
- the relevant sections of `docs/instaflow/ARCHITECTURE.md`, `DOCUMENT-FORMAT.md`, and the research report your spike comes from in `docs/instaflow/research/`
- `apps/instaflow/spikes/README.md` and `_harness/serve-and-run.cjs` (serves a folder with COOP/COEP and runs a page in Chromium; the page sets `window.__result = {...}` when done)

## Machine facts (measured)
- 4 CPU cores, 15 GB RAM, **no GPU**. Chromium 153 headless.
- With the harness flags, WebGPU works via **SwiftShader (CPU Vulkan)**: correctness is real, GPU timings are NOT representative.
- Presenting WebGPU to a canvas needs `--use-angle=swiftshader --enable-unsafe-swiftshader` (now in the harness; found by S1). Without them the device is lost on the first present.
- WebCodecs: decode H.264/VP9/AV1; encode VP9/AV1 (no H.264 encode in Chromium builds — real Chrome has it); AudioEncoder present.
- OPFS, SharedArrayBuffer (cross-origin isolated), EditContext, File System Access API objects exist (the folder picker needs a user gesture — not automatable headless).
- Rust 1.97 + `wasm32-unknown-unknown` target installed (`cargo`). No wasm-pack/wasm-bindgen CLI preinstalled — `cargo install wasm-bindgen-cli` (match the crate version) or use `cargo` + manual bindings. npm registry reachable.
- Playwright: `require('playwright')` works via `NODE_PATH=/opt/node-tools/node_modules`. Do not install browsers.
- Other spike agents run concurrently (3 at a time): CPU timings are noisy — repeat runs, report medians and p95, and say so.

## Rules
- Work ONLY inside your spike folder `apps/instaflow/spikes/<your-spike>/` (create it). Do not edit packages/, docs/, root files or other spikes. Install deps locally in your folder (`npm install` there; it is outside the pnpm workspace). Do not commit or push.
- Keep it a spike: minimal code that answers the questions. No production polish.
- Make the harness re-runnable by the owner on a real Chrome desktop with a real GPU (`--real-gpu --headed` or `--serve-only` + open in Chrome) and say exactly how in your README.
- Never claim a pass on a criterion you could not actually measure. Mark each criterion **PASS / FAIL / INCONCLUSIVE (needs real GPU / human / API key)** with the number and how it was measured.

## Deliverable
`apps/instaflow/spikes/<spike>/README.md` — one page: what was built, each pass criterion with result + numbers, verdict (proceed / fallback / needs owner-machine run), surprises or exciting findings, recommendation for M1, and exact rerun steps. Final message to the coordinator ≤ 300 words.
