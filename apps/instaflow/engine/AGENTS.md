# Instaflow engine (Rust/Wasm) — AGENTS.md

**Area:** app (`apps/instaflow`). Rust only; no TypeScript here. Never imported by framework packages.
**Budgets (IF-15.1, `/.size-limit.wasm.json`, brotli):** render Wasm ≤ 300 KB · authoring Wasm ≤ 350 KB.
Both are `ratchet: false` requirement ceilings while the crates are stubs; C4 turns ratcheting on.

## Purpose
The one Rust workspace for Instaflow engines (IF-2.10, SF-Δ32). Each crate is a `cdylib` loaded in a worker
through `@staticflux/wasm`.

| Crate | Owner WP | Contents |
|---|---|---|
| `crates/render` | A6 | Vello GPU raster backend (stub: `abi_version()`) |
| `crates/authoring` | B2 | Parley text layout (stub: `abi_version()`) |

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
- Every Wasm crate depends on `wasm-bindgen` (the build reads its locked version).
- Every crate dependency must pass `pnpm licenses:check` (no GPL/AGPL/LGPL, non-commercial or watermark licenses).
- New crate: add it to `members`, to `sf-wasm.json#crates`, and give it a budget category in `/.size-limit.wasm.json`.
- Keep exports behind a versioned ABI (`abi_version()`); bump it on breaking changes.
- Build outputs (`target/`, `dist/`, `.tools/`) are gitignored.

## Test
`cargo test --locked` here (host target; CI runs it) · `pnpm build:wasm` · `pnpm size:wasm`.
