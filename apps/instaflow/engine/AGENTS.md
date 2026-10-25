# Instaflow engine (Rust/Wasm) — AGENTS.md

**Area:** app (`apps/instaflow`). Rust only; no TypeScript here. Never imported by framework packages.
**Budgets (IF-15.1, `/.size-limit.wasm.json`, brotli):** render Wasm ≤ 300 KB · authoring Wasm ≤ 350 KB.
Both are `ratchet: false` requirement ceilings; C4 turns ratcheting on.
**Measured (2026-10-25, A6):** render Wasm **185.7 KB brotli** (511.7 KB raw, 226.8 KB gzip): `vello_gpu` 0.3.0 +
wgpu 30.0.1 (WebGPU only) + scene IR + compositor; S1's bare Vello module was 158 KB. Authoring is still a stub.

## Purpose
The one Rust workspace for Instaflow engines (IF-2.10, SF-Δ32). Each crate is a `cdylib` loaded in a worker
through `@staticflux/wasm` (or the app's loader, `apps/instaflow/src/render/render-module.ts`).

| Crate | Owner WP | Contents |
|---|---|---|
| `crates/render` | A6 | Scene IR + retained scene, Vello GPU tiles and lifted layers, our WGSL compositor, readback (ABI 2) |
| `crates/authoring` | B2 | Parley text layout (stub: `abi_version()`) |

## `crates/render` (A6; IF-7.4, 7.5, 7.10, 7.11)
- `ir.rs` — scene IR wire format v1 (header and grammar in the module docs; the TypeScript writer is
  `apps/instaflow/src/render/scene-ir.ts`, byte-identical on the `shapes` fixture), `Scene` (node tree, world
  transforms and bounds, retained images, dirty rects per batch), `IrWriter`, `warm_up_batch`.
- `draw.rs` — `Painter` (Vello GPU `Scene` and Vello CPU `RenderContext` map 1:1) and the one traversal for tiles,
  lifted layers (`Filter::Only`, ancestors' clips and opacity kept) and regions. Exhaustive matches over geometry,
  paint and clip kinds: a new IR kind does not compile until every backend handles it. Glyph runs are decoded and
  drawn as nothing until B2.
- `tiles.rs` — tile/region/layer geometry mirroring `@staticflux/surface/raster` (`TILE` = 512, level scale 2^(k/2)).
- `gpu.rs` (wasm32) — `Engine` (retained scene, layer membership; survives device loss) and `Gpu` (device, Vello
  renderer with a lazily allocated 2048² image atlas instead of the default 4096², tile/layer/frame/snapshot
  textures, compositor pipelines, canvas configuration). `create_gpu(canvas | null, w, h)` → `engine.install_gpu`
  re-uploads images; `drop_gpu` after a loss. One submit per Vello render (S1). Premultiplied textures, straight-alpha
  readback. `take_errors()` drains uncaptured wgpu errors.
- `cpu.rs`, `fixtures.rs` (host only) — `vello_cpu` reference renders and the fixture scenes (`shapes`, `paints`,
  `layers`, `tiles`). `fixtures/<name>.sfir` + `<name>.cpu.png` are committed; `cargo test` checks they are current.
  Regenerate after an intended change: `SF_UPDATE_GOLDENS=1 cargo test -p render fixtures`.

## Build
`pnpm build` runs `sf wasm build apps/instaflow/engine` after `tsc -b`:

1. `cargo build --target wasm32-unknown-unknown --release -p <crate>…` with `RUSTFLAGS=-C target-feature=+simd128`
   (S1: 4.6–7× faster strip prep and smaller modules). Profile: `opt-level = "z"`, LTO, 1 CGU, `panic = "abort"`.
2. `wasm-bindgen --target web --no-typescript`, CLI version = the `wasm-bindgen` version in `Cargo.lock`
   (installed into `.tools/` with `cargo install --locked` when PATH has a different version).
3. `wasm-opt` from the root `binaryen` devDependency (`sf-wasm.json#wasmOpt`, default `-Oz` + rustc's features + SIMD).
4. Content-hashed `dist/<crate>.<hash16>.wasm` and `.js` (the glue's default URL points at the hashed file), plus
   `dist/sf-wasm-manifest.json` (`sf-wasm-manifest/1`: hashes, raw/gzip/brotli sizes, tool versions). Loaders read
   the manifest; never hard-code a hashed name.

The manifest's `inputsHash` covers every file here except `target/`, `dist/`, `.tools/` and `*.md`, plus rustc,
wasm-opt and the flags; an unchanged hash skips the build. `--force` rebuilds.

**No Rust installed:** the build is skipped with a warning (TypeScript-only work needs no Rust). CI sets
`SF_REQUIRE_RUST=1`, which makes a missing toolchain or unbuilt artifact an error (SF-TOOL-008, SF-TOOL-010).

## Rules
- Toolchain pinned in `rust-toolchain.toml` (1.97.0 + `wasm32-unknown-unknown`). Change it in its own PR.
- Dependencies are exact pins (`=x.y.z`) in `[workspace.dependencies]`; `Cargo.lock` is committed. CI builds with
  `--locked`, so run `cargo build` locally after changing dependencies and commit the lockfile.
- GPU-only dependencies (`vello_gpu`, `wgpu`, `web-sys`, `js-sys`) are `cfg(target_arch = "wasm32")`; CPU reference
  and PNG (`vello_cpu`, `png`) are host-only. Nothing test-only ships in the Wasm.
- Every Wasm crate depends on `wasm-bindgen` (the build reads its locked version).
- Every crate dependency must pass `pnpm licenses:check` (no GPL/AGPL/LGPL, non-commercial or watermark licenses).
- New crate: add it to `members`, to `sf-wasm.json#crates`, and give it a budget category in `/.size-limit.wasm.json`.
- Keep exports behind a versioned ABI (`abi_version()`, render = 2; the TS side checks it); bump it on breaking
  changes, and bump `ir::VERSION` on any wire-format change (update `scene-ir.ts` in the same change).

## Test
`cargo test --locked` here (host target: IR round trips, scene bounds and dirty rects, the draw traversal with a
recording painter, tile math, fixtures vs `vello_cpu`) · `pnpm build:wasm` · `pnpm size:wasm` · GPU paths:
`pnpm build && NODE_PATH=/opt/node-tools/node_modules pnpm test:gpu` (`apps/instaflow/src/render/render.gpu.test.ts`).
