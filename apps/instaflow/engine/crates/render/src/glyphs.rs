//! Glyph outlines for scene IR glyph runs (B2, IF-7.6): skrifa, unhinted (any zoom), with variation coordinates
//! (S3: variable CJK fonts default to weight 100 without them) and synthetic italic. Synthetic bold is a stroke
//! added by `draw.rs`. The same paths feed every backend, so GPU, CPU reference and export draw identical text.
//!
//! Why not Vello's glyph-run API (`glifo`): it links skrifa's TrueType hinter and autohinter (B2 measured the render
//! Wasm at 346.6 KB brotli with it, over the 300 KB IF-15.1 budget; 185.7 KB before text). Outlines here are
//! cached in font units per (face, coordinates, glyph) and scaled per run, so zooming never re-extracts.
//! Limitation: colour glyphs (COLR, CBDT emoji) draw only their outline fallback, if any.

use crate::ir::GlyphRun;
use skrifa::instance::{LocationRef, NormalizedCoord, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::TableProvider;
use skrifa::{FontRef, GlyphId, MetadataProvider};
use std::collections::HashMap;
use std::sync::Arc;
use vello_common::kurbo::{Affine, BezPath};
use vello_common::peniko::FontData;

/// Entries before the cache is cleared (a crude bound; fonts × glyphs × variation instances in view).
pub const MAX_CACHED_GLYPHS: usize = 16_384;

#[derive(Hash, PartialEq, Eq, Clone)]
struct Key {
    blob: u64,
    index: u32,
    coords: Vec<i16>,
    glyph: u32,
}

struct Pen(BezPath);

impl OutlinePen for Pen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to((x as f64, y as f64));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to((x as f64, y as f64));
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.0.quad_to((cx0 as f64, cy0 as f64), (x as f64, y as f64));
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.0.curve_to((cx0 as f64, cy0 as f64), (cx1 as f64, cy1 as f64), (x as f64, y as f64));
    }
    fn close(&mut self) {
        self.0.close_path();
    }
}

/// Outline cache shared by every draw of a scene.
#[derive(Default)]
pub struct GlyphCache {
    paths: HashMap<Key, Option<Arc<BezPath>>>,
    upem: HashMap<(u64, u32), f32>,
}

impl GlyphCache {
    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    pub fn clear(&mut self) {
        self.paths.clear();
        self.upem.clear();
    }

    /// The run as one path in the node's local space (y down, pen positions on the baseline), or None when the
    /// face cannot be read. Glyphs without an outline (spaces, colour-only glyphs) contribute nothing.
    pub fn run_path(&mut self, font: &FontData, run: &GlyphRun) -> Option<BezPath> {
        let face = FontRef::from_index(font.data.data(), font.index).ok()?;
        if self.paths.len() > MAX_CACHED_GLYPHS {
            self.paths.clear();
        }
        let blob = font.data.id();
        let upem = *self.upem.entry((blob, font.index)).or_insert_with(|| face.head().map_or(1000, |h| h.units_per_em()).max(1) as f32);
        let coords: Vec<NormalizedCoord> = run.coords.iter().map(|c| NormalizedCoord::from_bits(*c)).collect();
        let outlines = face.outline_glyphs();
        let scale = (run.size / upem) as f64;
        let shear = if run.skew != 0.0 { Affine::skew(-(run.skew as f64).to_radians().tan(), 0.0) } else { Affine::IDENTITY };
        let mut out = BezPath::new();
        for &(glyph, x, y) in &run.glyphs {
            let key = Key { blob, index: font.index, coords: run.coords.clone(), glyph };
            let path = self
                .paths
                .entry(key)
                .or_insert_with(|| {
                    let outline = outlines.get(GlyphId::new(glyph))?;
                    let mut pen = Pen(BezPath::new());
                    outline.draw(DrawSettings::unhinted(Size::unscaled(), LocationRef::new(&coords)), &mut pen).ok()?;
                    (!pen.0.elements().is_empty()).then(|| Arc::new(pen.0))
                })
                .clone();
            let Some(path) = path else { continue };
            // font units (y up) → local px (y down) at the pen position, sheared around the baseline
            let t = Affine::translate((x as f64, y as f64)) * shear * Affine::new([scale, 0.0, 0.0, -scale, 0.0, 0.0]);
            out.extend(path.iter().map(|el| t * el));
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vello_common::kurbo::Shape;
    use vello_common::peniko::Blob;

    fn noto() -> FontData {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fonts/NotoSans-Latin.wght.ttf");
        FontData::new(Blob::new(Arc::new(std::fs::read(path).unwrap())), 0)
    }

    fn gid(font: &FontData, c: char) -> u32 {
        FontRef::from_index(font.data.data(), 0).unwrap().charmap().map(c).unwrap().to_u32()
    }

    #[test]
    fn builds_scaled_cached_paths() {
        let font = noto();
        let h = gid(&font, 'H');
        let space = gid(&font, ' ');
        let mut cache = GlyphCache::default();
        let path = cache.run_path(&font, &GlyphRun::new(1, 100.0, vec![(h, 10.0, 100.0), (space, 80.0, 100.0)])).unwrap();
        let b = path.bounding_box();
        // cap height of Noto Sans ≈ 0.714 em, above the baseline (y down)
        assert!(b.y1 <= 100.5 && b.y0 > 20.0 && b.y0 < 35.0, "{b:?}");
        assert!(b.x0 >= 10.0 && b.x1 < 90.0);
        assert_eq!(cache.len(), 2, "the space is cached as 'no outline'");
        // a second run at another size reuses the outline
        let small = cache.run_path(&font, &GlyphRun::new(1, 10.0, vec![(h, 0.0, 10.0)])).unwrap();
        assert_eq!(cache.len(), 2);
        assert!((small.bounding_box().height() - b.height() / 10.0).abs() < 0.01);
    }

    #[test]
    fn coordinates_and_skew_change_the_outline() {
        let font = noto();
        let h = gid(&font, 'l');
        let mut cache = GlyphCache::default();
        let regular = cache.run_path(&font, &GlyphRun::new(1, 100.0, vec![(h, 0.0, 100.0)])).unwrap().bounding_box();
        let mut bold = GlyphRun::new(1, 100.0, vec![(h, 0.0, 100.0)]);
        bold.coords = vec![16384]; // wght max
        let bold = cache.run_path(&font, &bold).unwrap().bounding_box();
        assert!(bold.width() > regular.width() * 1.3, "{regular:?} vs {bold:?}");
        let mut slanted = GlyphRun::new(1, 100.0, vec![(h, 0.0, 100.0)]);
        slanted.skew = 14.0;
        let slanted = cache.run_path(&font, &slanted).unwrap().bounding_box();
        assert!(slanted.width() > regular.width() + 10.0);
        assert_eq!(cache.len(), 2);
        cache.clear();
        assert!(cache.is_empty());
    }

    #[test]
    fn unreadable_faces_and_missing_glyphs() {
        let bad = FontData::new(Blob::new(Arc::new(b"OTTOjunk".to_vec())), 0);
        let mut cache = GlyphCache::default();
        assert!(cache.run_path(&bad, &GlyphRun::new(1, 10.0, vec![(1, 0.0, 0.0)])).is_none());
        let path = cache.run_path(&noto(), &GlyphRun::new(1, 10.0, vec![(60_000, 0.0, 0.0)])).unwrap();
        assert!(path.elements().is_empty());
    }
}
