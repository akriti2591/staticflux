//! Instaflow authoring engine: element geometry (`geometry`, B1: kurbo paths, linesweeper booleans, bounds, hit
//! tests) and text layout (Parley, B2).
use wasm_bindgen::prelude::*;

pub mod geometry;

/// ABI version of the authoring module's exports. Bump on any breaking export change.
#[wasm_bindgen]
pub fn abi_version() -> u32 {
    1
}

#[cfg(test)]
mod tests {
    #[test]
    fn abi_version_is_one() {
        assert_eq!(super::abi_version(), 1);
    }
}
