//! Instaflow authoring engine, loaded in the editor worker.
//!
//! - `geometry` (B1): kurbo paths, linesweeper booleans, bounds, hit tests.
//! - `text` (B2; IF-7.6, IF-21.x): Parley text layout — fonts, blocks, glyph runs, clusters/words/lines, caret,
//!   selection and character bounds. Exported to TypeScript as `TextEngine` (`wasm.rs`).
//!
//! Three Wasm builds by feature (sf-wasm.json), each within its IF-15.1 budget: `authoring` (`geometry`, B1),
//! `authoring-text` (`text`, B2) and the lazy `authoring-text-complex` chunk (`complex-scripts`: ICU4X dictionary
//! segmenters for Thai, Lao, Khmer, Myanmar; S3: +1.9 MB), plus the lazy `authoring-webfont` decoder (`webfont`, B12
//! T-7: WOFF2 / WOFF uploads → OpenType). Host builds and tests enable everything.
use wasm_bindgen::prelude::*;

#[cfg(feature = "geometry")]
pub mod geometry;
#[cfg(feature = "text")]
pub mod text;
#[cfg(feature = "text")]
pub mod wasm;
#[cfg(feature = "webfont")]
pub mod webfont;

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
