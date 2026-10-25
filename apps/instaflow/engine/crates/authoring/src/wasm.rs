//! Wasm exports: `TextEngine` over `text::Engine` (TypeScript: `apps/instaflow/src/text/authoring-module.ts`).
//! Rectangles come back as flat `[x0, y0, x1, y1, …]` arrays, positions as `[offset, upstream]`.
use crate::text::{Engine, Position, Rect};
use wasm_bindgen::prelude::*;

fn js(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn flat(rects: &[Rect]) -> Vec<f32> {
    rects.iter().flat_map(|r| [r.x0, r.y0, r.x1, r.y1]).collect()
}

fn pos(p: Position) -> Vec<f32> {
    vec![p.offset as f32, f32::from(u8::from(p.upstream))]
}

fn lines(families: &str) -> Vec<&str> {
    families.split('\n').map(str::trim).filter(|s| !s.is_empty()).collect()
}

#[wasm_bindgen]
pub struct TextEngine {
    inner: Engine,
}

impl Default for TextEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl TextEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> TextEngine {
        TextEngine { inner: Engine::new() }
    }

    /// Register font bytes; one font id per face.
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Result<Vec<u32>, JsValue> {
        self.inner.add_font(bytes).map_err(js)
    }

    /// Registered family names, one per line.
    pub fn family_names(&mut self) -> String {
        self.inner.family_names().join("\n")
    }

    /// `families`: one family name per line.
    pub fn set_fallbacks(&mut self, script: &str, families: &str) -> Result<(), JsValue> {
        self.inner.set_fallbacks(script, &lines(families)).map_err(js)
    }

    pub fn set_generic(&mut self, generic: &str, families: &str) -> Result<(), JsValue> {
        self.inner.set_generic(generic, &lines(families)).map_err(js)
    }

    /// Lay out and retain block `id`; returns the encoded layout (module docs of `text`).
    pub fn layout(&mut self, id: u32, spec: &[u8]) -> Result<Vec<f32>, JsValue> {
        self.inner.layout(id, spec).map(|b| b.encoded().to_vec()).map_err(js)
    }

    pub fn drop_block(&mut self, id: u32) -> bool {
        self.inner.drop_block(id)
    }

    pub fn block_count(&self) -> u32 {
        self.inner.block_count() as u32
    }

    pub fn hit_test(&self, id: u32, x: f32, y: f32) -> Result<Vec<f32>, JsValue> {
        Ok(pos(self.block(id)?.hit_test(x, y)))
    }

    pub fn caret(&self, id: u32, offset: u32, upstream: bool, width: f32) -> Result<Vec<f32>, JsValue> {
        Ok(flat(&[self.block(id)?.caret(offset, upstream, width)]))
    }

    pub fn selection_rects(&self, id: u32, a: u32, b: u32) -> Result<Vec<f32>, JsValue> {
        Ok(flat(&self.block(id)?.selection_rects(a, b)))
    }

    pub fn char_bounds(&self, id: u32, a: u32, b: u32) -> Result<Vec<f32>, JsValue> {
        Ok(flat(&self.block(id)?.char_bounds(a, b)))
    }

    pub fn word_at(&self, id: u32, offset: u32) -> Result<Vec<u32>, JsValue> {
        let (a, b) = self.block(id)?.word_at(offset);
        Ok(vec![a, b])
    }

    pub fn move_caret(&self, id: u32, offset: u32, upstream: bool, motion: u32, x_hint: f32) -> Result<Vec<f32>, JsValue> {
        Ok(pos(self.block(id)?.move_caret(Position { offset, upstream }, motion, x_hint)))
    }
}

impl TextEngine {
    fn block(&self, id: u32) -> Result<&crate::text::Block, JsValue> {
        self.inner.block(id).ok_or_else(|| js(format!("text block {id} is not laid out")))
    }
}
