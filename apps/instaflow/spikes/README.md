# Instaflow — Phase 0 spikes

Each `sN-*` folder is a self-contained experiment from `docs/instaflow/PLAN.md` §1 with its own `README.md`
(result one-pager: criteria, numbers, verdict, recommendation). Spikes are throwaway (deleted at M1 end) and are
**not** part of the pnpm workspace — each installs its own dependencies with `npm install` inside its folder.

Run any browser spike: `node ../_harness/serve-and-run.cjs . index.html` from inside the spike folder.

**Cloud vs your machine.** Results here come from a 4-core container whose WebGPU is SwiftShader (CPU). Correctness
results are real; GPU timings are not. To get real numbers, run the same harness on your Chrome desktop with
`--real-gpu --headed`, or `--serve-only` and open the URL in Chrome.
