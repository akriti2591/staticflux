//! Instaflow render engine (IF-7.4, IF-7.5, IF-7.11): the retained scene IR, Vello GPU tiles and
//! lifted layers on wgpu/WebGPU, and our own WGSL compositor. TypeScript drives it through the
//! `RasterBackend` port of `@staticflux/surface/raster` (policy: which tiles, when, budgets, device
//! lifecycle); this crate owns the pixels.
//!
//! - `ir` — scene IR wire format and the retained CPU-side scene (all targets).
//! - `draw` — one traversal of the IR for every backend (`Painter`).
//! - `tiles` — tile / region geometry shared with the TypeScript planner.
//! - `gpu` — the Wasm exports: Vello GPU + compositor (wasm32 only).
//! - `cpu`, `fixtures` — `vello_cpu` reference renders and test fixtures (host only).
use wasm_bindgen::prelude::*;

pub mod draw;
pub mod ir;
pub mod tiles;

#[cfg(target_arch = "wasm32")]
pub mod gpu;

#[cfg(not(target_arch = "wasm32"))]
pub mod cpu;
#[cfg(not(target_arch = "wasm32"))]
pub mod fixtures;

/// ABI version of the render module's exports. Bump on any breaking export change.
/// 2: engine + GPU attach, tiles, layers, compositor, readback (A6). The scene IR wire version is separate
/// (`ir_version()`: 2 since B1 added effects, masks, per-corner rects and image fit).
#[wasm_bindgen]
pub fn abi_version() -> u32 {
    2
}

/// Scene IR wire version (`ir::VERSION`).
#[wasm_bindgen]
pub fn ir_version() -> u32 {
    ir::VERSION as u32
}

#[cfg(test)]
mod tests {
    #[test]
    fn abi_version_is_two() {
        assert_eq!(super::abi_version(), 2);
        assert_eq!(super::ir_version(), 2);
    }
}
