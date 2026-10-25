//! Instaflow authoring engine, loaded in the editor worker.
//!
//! - `text` — Parley text layout (B2; IF-7.6, IF-21.x): fonts, blocks, glyph runs, clusters/words/lines,
//!   caret, selection and character bounds. Exported to TypeScript as `TextEngine` (`wasm.rs`).
//! - B1 adds geometry and booleans here (separate modules).
//!
//! Two builds (sf-wasm.json): `authoring` (≤ 350 KB brotli, IF-15.1) and the lazy `authoring-complex` chunk with
//! Parley's `complex-scripts` feature (ICU4X dictionary segmenters for Thai, Lao, Khmer, Myanmar; S3: +1.9 MB).
use wasm_bindgen::prelude::*;

pub mod text;
pub mod wasm;

/// ABI version of the authoring module's exports. Bump on any breaking export change.
/// 2: `TextEngine` (fonts, layout, caret/selection/char bounds, layout v1 encoding) (B2).
#[wasm_bindgen]
pub fn abi_version() -> u32 {
    2
}

/// True in the `authoring-complex` build (dictionary line breaking for Thai, Lao, Khmer, Myanmar).
#[wasm_bindgen]
pub fn complex_scripts() -> bool {
    cfg!(feature = "complex-scripts")
}

#[cfg(test)]
mod tests {
    #[test]
    fn abi_version_is_two() {
        assert_eq!(super::abi_version(), 2);
        assert_eq!(super::complex_scripts(), cfg!(feature = "complex-scripts"));
    }
}
