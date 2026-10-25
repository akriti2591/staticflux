//! Instaflow export engine (C1; IF-7.10, IF-29.x): the lazy export Wasm. It holds a scene (the same scene IR the
//! render module draws), records it through the render crate's one traversal (`record`), and writes **SVG** (`svg`)
//! and **PDF** (`pdf`, pdf-writer, real text). What a format cannot express comes from raster patches (`plan`, the D21
//! rasterize list) that the render module renders headlessly. PNG never comes here: it is the render module's
//! headless surface plus `@staticflux/surface/image`.
//!
//! - `record` — painter → display list (masks folded, patches in place of planned nodes).
//! - `plan` — the rasterize list, patch scenes, selection isolation.
//! - `svg`, `pdf`, `png` — the writers.
//! - `wasm` — the exports (`Exporter`, ABI 1).
//! - `corpus` (host tests) — the element-feature corpus and the parity measurements behind D21.

pub mod pdf;
pub mod pixels;
pub mod plan;
pub mod png;
pub mod record;
pub mod svg;
pub mod wasm;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod corpus;

/// ABI version of the export module's exports (`wasm.rs`). Bump on any breaking change; the TypeScript loader
/// (`apps/instaflow/src/export/export-module.ts`) checks it.
pub const ABI_VERSION: u32 = 1;
