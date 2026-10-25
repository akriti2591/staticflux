//! Instaflow render engine (Vello GPU on WebGPU). Stub so the Wasm pipeline builds; A6 fills it in.
use wasm_bindgen::prelude::*;

/// ABI version of the render module's exports. Bump on any breaking export change.
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
