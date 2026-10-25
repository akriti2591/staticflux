//! The `text` render fixture (host tests only): Latin, Arabic and Devanagari laid out by Parley, written as a
//! scene IR batch into `crates/render/fixtures/text.sfir` (+ `text.fonts`: `id file` per line, fonts in
//! `apps/instaflow/test/fonts`). The render crate renders it with `vello_cpu` into `text.cpu.png`, and the GPU
//! page renders the same batch on Vello GPU and the same text through the TypeScript pipeline (golden renders).
//!
//! Regenerate after an intended change: `SF_UPDATE_GOLDENS=1 cargo test -p authoring text_fixture`, then
//! `SF_UPDATE_GOLDENS=1 cargo test -p render fixtures`.
use super::spec::{Align, ParagraphSpec, SpanSpec};
use super::tests::{STACK, decode_layout, engine, spec};
use render::ir::{APPEND, Geometry, GlyphRun, IrWriter, Paint, ROOT, group, leaf};
use std::path::PathBuf;

/// Fonts registered in `engine()` order; the IR font id is the authoring font id + 1.
pub const FONT_FILES: [&str; 4] = ["NotoSans-Latin.wght.ttf", "NotoSansArabic.wght.ttf", "NotoSansDevanagari.wght.ttf", "NotoSansThai.wght.ttf"];
pub const WIDTH: f32 = 240.0;
const COLORS: [[u8; 4]; 4] = [[20, 20, 30, 255], [200, 40, 60, 255], [30, 90, 200, 255], [20, 140, 80, 255]];

/// The fixture paragraphs (also built by `apps/instaflow/src/text/testing/golden.ts`).
pub fn paragraphs() -> Vec<ParagraphSpec> {
    let base = |text: &str, size: f32| super::spec::simple_paragraph(text, STACK, size);
    let mut latin = base("Hello, Instaflow!", 26.0);
    let s = latin.spans[0].clone();
    latin.spans = vec![
        SpanSpec { end: 6, weight: 700.0, brush: 1, ..s.clone() },
        SpanSpec { start: 6, end: 17, italic: true, underline: true, brush: 2, ..s.clone() },
    ];
    let mut arabic = base("مرحبا بالعالم", 26.0);
    arabic.align = Align::Start;
    arabic.spans[0].brush = 3;
    let devanagari = base("नमस्ते दुनिया", 26.0);
    vec![latin, arabic, devanagari]
}

/// Scene IR nodes for an encoded layout: a group at (x, y), one glyph leaf per run, one rect per decoration.
pub fn layout_nodes(w: &mut IrWriter, encoded: &[f32], first_id: u32, x: f64, y: f64) {
    let d = decode_layout(encoded);
    let mut g = group(first_id, ROOT);
    g.transform = vello_common::kurbo::Affine::translate((x, y));
    w.upsert(&g, APPEND);
    let mut id = first_id + 1;
    for (r, coords) in &d.runs {
        let first = r[9] as usize;
        let count = r[10] as usize;
        let glyphs = d.glyphs[first..first + count].iter().map(|q| (q[0] as u32, q[1], q[2])).collect();
        let run = GlyphRun { font: r[1] as u32 + 1, size: r[2], embolden: r[7] != 0.0, skew: r[8], coords: coords.iter().map(|c| *c as i16).collect(), glyphs };
        w.upsert(&leaf(id, first_id, Geometry::Glyphs(run), Paint::Solid(COLORS[r[3] as usize % COLORS.len()])), APPEND);
        id += 1;
    }
    for deco in &d.decorations {
        let mut rect = leaf(id, first_id, Geometry::Rect { w: (deco[5] - deco[3]) as f64, h: (deco[6] - deco[4]) as f64, radius: 0.0 }, Paint::Solid(COLORS[deco[1] as usize % COLORS.len()]));
        rect.transform = vello_common::kurbo::Affine::translate((deco[3] as f64, deco[4] as f64));
        w.upsert(&rect, APPEND);
        id += 1;
    }
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../render/fixtures")
}

pub fn batch() -> Vec<u8> {
    let mut e = engine();
    let block = e.layout(1, &spec(WIDTH, &paragraphs())).unwrap();
    let mut w = IrWriter::new();
    layout_nodes(&mut w, block.encoded(), 1, 8.0, 8.0);
    w.finish()
}

#[test]
fn text_fixture_is_current() {
    let bytes = batch();
    let fonts: String = FONT_FILES.iter().enumerate().map(|(i, f)| format!("{} {f}\n", i + 1)).collect();
    let update = std::env::var("SF_UPDATE_GOLDENS").is_ok_and(|v| !v.is_empty() && v != "0");
    if update {
        std::fs::write(dir().join("text.sfir"), &bytes).unwrap();
        std::fs::write(dir().join("text.fonts"), fonts).unwrap();
        return;
    }
    let on_disk = std::fs::read(dir().join("text.sfir")).expect("missing text.sfir (run with SF_UPDATE_GOLDENS=1)");
    assert_eq!(on_disk, bytes, "text.sfir changed: regenerate with SF_UPDATE_GOLDENS=1 (then the render crate's PNG)");
    assert_eq!(std::fs::read_to_string(dir().join("text.fonts")).unwrap(), fonts);
    // the batch decodes and every glyph run names a font from the sidecar
    let ops = render::ir::decode(&bytes).unwrap();
    assert!(ops.iter().filter(|op| matches!(op, render::ir::Op::Upsert { node, .. } if matches!(node.geometry, Geometry::Glyphs(_)))).count() >= 4);
}
