//! Web font decoding (B12, T-7): WOFF2 (Brotli, transformed `glyf` / `loca` / `hmtx`) and WOFF (zlib) uploads become
//! plain OpenType bytes before the font library hashes, stores and registers them, so every other part of the app
//! (the layout engine, the render scene's font table, exports) only ever sees OpenType. Pure Rust (`wuff`), built
//! only into the lazy `authoring-webfont` Wasm (sf-wasm.json): the Brotli dictionary stays out of the text build.
use wasm_bindgen::prelude::*;

/// The web font container of `bytes`, by its signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebFont {
    Woff,
    Woff2,
}

/// `wOFF` / `wOF2` at the start of the file (None: not a web font).
pub fn web_font_kind(bytes: &[u8]) -> Option<WebFont> {
    match bytes.get(0..4)? {
        b"wOFF" => Some(WebFont::Woff),
        b"wOF2" => Some(WebFont::Woff2),
        _ => None,
    }
}

/// Decode a WOFF2 or WOFF file to OpenType (`Err` with a readable reason for anything else or a broken file).
pub fn decode(bytes: &[u8]) -> Result<Vec<u8>, String> {
    match web_font_kind(bytes) {
        Some(WebFont::Woff2) => wuff::decompress_woff2(bytes).map_err(|e| format!("WOFF2: {e:?}")),
        Some(WebFont::Woff) => wuff::decompress_woff1(bytes).map_err(|e| format!("WOFF: {e:?}")),
        None => Err("not a WOFF or WOFF2 file".into()),
    }
}

/// `decode` for TypeScript (`text/fonts.ts` through `loadWebfontDecoder`): OpenType bytes, or throws the reason.
#[wasm_bindgen]
pub fn decode_webfont(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    decode(bytes).map_err(|e| JsError::new(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fonts").join(name)).unwrap()
    }

    #[test]
    fn decodes_woff2_and_woff_to_opentype() {
        for name in ["NotoSans-Hello.woff2", "NotoSans-Hello.woff"] {
            let bytes = fixture(name);
            assert!(web_font_kind(&bytes).is_some(), "{name}");
            let otf = decode(&bytes).unwrap();
            assert_eq!(&otf[0..4], &[0, 1, 0, 0], "{name}: a TrueType sfnt");
            // the reconstructed font has its glyf table back (the TS test registers it with the layout engine)
            let font = has_glyf(&otf);
            assert!(font, "{name}");
        }
    }

    #[test]
    fn refuses_other_and_broken_files() {
        assert!(decode(b"OTTO....").is_err());
        assert!(decode(b"wOF2 truncated").is_err());
        assert_eq!(web_font_kind(b"wO"), None);
    }

    /// The decoded bytes parse as an sfnt with a `glyf` table (host check without pulling a font crate in).
    fn has_glyf(otf: &[u8]) -> bool {
        let tables = u16::from_be_bytes([otf[4], otf[5]]) as usize;
        (0..tables).any(|i| &otf[12 + i * 16..16 + i * 16] == b"glyf")
    }
}
