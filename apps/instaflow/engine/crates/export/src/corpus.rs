//! The element-feature corpus and the parity measurements behind D21 (host tests only).
//!
//! Every scene is drawn by `vello_cpu` (the renderer's CI reference, IF-7.4) and by each export: the SVG writer's
//! output rasterized by resvg, the PDF writer's by poppler's cairo backend (`pdftocairo`, skipped when it is not installed). Raster
//! patches come from `vello_cpu` too (the browser renders them on Vello GPU). Scores are luma SSIM over white with the
//! reference Gaussian window (testkit's `ssim`), plus SSIM after a 3×3 box blur, the S7 metric.
//!
//! `SF_EXPORT_CORPUS=1 cargo test -p export corpus -- --nocapture` prints the table D21 records;
//! `SF_UPDATE_GOLDENS=1` rewrites `fixtures/<scene>.{sfir,cpu.png,svg}` (the GPU test renders the batches through
//! the PNG export path and Chrome's SVG rasterizer and compares them with the same references).

use crate::plan::{Format, plan, sites};
use crate::record::record;
use crate::svg::{PatchImage, SvgOptions};
use crate::wasm::view_of;
use render::cpu::{decode_png, encode_png, render_region};
use render::fixtures::{checker, text_font_batch};
use render::ir::{APPEND, Clip, Effect, FillStyle, Geometry, GlyphRun, IrWriter, Node, Paint, ROOT, Scene, StrokeStyle, fit, group, leaf, mask};
use std::collections::HashMap;
use std::path::PathBuf;
use vello_common::kurbo::{Affine, BezPath, Point, Rect, Shape};

pub const SIZE: u16 = 192;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn render_fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../render/fixtures")
}

fn update() -> bool {
    std::env::var("SF_UPDATE_GOLDENS").is_ok_and(|v| !v.is_empty() && v != "0")
}

// ---------------------------------------------------------------- scenes

fn at(mut node: Node, x: f64, y: f64) -> Node {
    node.transform = Affine::translate((x, y));
    node
}

fn solid(c: [u8; 4]) -> Paint {
    Paint::Solid(c)
}

fn star(cx: f64, cy: f64, r0: f64, r1: f64, n: usize) -> BezPath {
    let mut p = BezPath::new();
    for i in 0..n * 2 {
        let a = std::f64::consts::PI * i as f64 / n as f64 - std::f64::consts::FRAC_PI_2;
        let r = if i % 2 == 0 { r0 } else { r1 };
        let pt = Point::new(cx + r * a.cos(), cy + r * a.sin());
        if i == 0 { p.move_to(pt) } else { p.line_to(pt) }
    }
    p.close_path();
    p
}

/// An arrow pointing right (asymmetric: flips show).
fn arrow() -> BezPath {
    let mut p = BezPath::new();
    p.move_to((0.0, 10.0));
    p.line_to((28.0, 10.0));
    p.line_to((28.0, 0.0));
    p.line_to((48.0, 20.0));
    p.line_to((28.0, 40.0));
    p.line_to((28.0, 30.0));
    p.line_to((0.0, 30.0));
    p.close_path();
    p
}

fn stripes(w: &mut IrWriter, id: &mut u32, parent: u32, x: f64, y: f64, size: f64) {
    for i in 0..6 {
        *id += 1;
        let c = if i % 2 == 0 { [230, 70, 50, 255] } else { [40, 90, 210, 255] };
        w.upsert(&at(leaf(*id, parent, Geometry::Rect { w: size / 6.0, h: size, radius: 0.0 }, solid(c)), x + i as f64 * size / 6.0, y), APPEND);
    }
}

fn ring(w: f64, h: f64, inset: f64) -> BezPath {
    let mut p = Rect::new(0.0, 0.0, w, h).to_path(0.1);
    let inner = Rect::new(inset, inset, w - inset, h - inset);
    p.move_to((inner.x0, inner.y0));
    p.line_to((inner.x0, inner.y1));
    p.line_to((inner.x1, inner.y1));
    p.line_to((inner.x1, inner.y0));
    p.close_path();
    p
}

pub fn appearance() -> Vec<u8> {
    let mut w = IrWriter::new();
    let mut card = at(leaf(1, ROOT, Geometry::RRect { w: 80.0, h: 60.0, radii: [12.0, 4.0, 12.0, 4.0] }, solid([250, 90, 60, 255])), 10.0, 10.0);
    card.fills.push(FillStyle { paint: Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(0.0, 60.0), stops: vec![(0.0, [255, 255, 255, 180]), (1.0, [255, 255, 255, 0])] }, opacity: 0.8, blend: 0 });
    let mut dashed = StrokeStyle::new(3.0, solid([20, 20, 30, 255]), 2, 2);
    dashed.dash = vec![8.0, 4.0];
    dashed.dash_offset = 2.0;
    let mut inside = StrokeStyle::new(4.0, solid([255, 220, 60, 255]), 1, 0);
    inside.ring = Some(ring(80.0, 60.0, 4.0));
    card.strokes = vec![inside, dashed];
    w.upsert(&card, APPEND);
    let mut disc = at(leaf(2, ROOT, Geometry::Ellipse { w: 70.0, h: 70.0 }, Paint::Radial { center: Point::new(35.0, 35.0), radius: 35.0, stops: vec![(0.0, [255, 255, 255, 255]), (1.0, [40, 160, 120, 255])] }), 110.0, 6.0);
    disc.fills.push(FillStyle { paint: solid([200, 60, 200, 255]), opacity: 0.6, blend: 1 });
    disc.strokes = vec![StrokeStyle { opacity: 0.7, ..StrokeStyle::new(5.0, solid([10, 40, 120, 255]), 2, 0) }];
    w.upsert(&disc, APPEND);
    let mut s = leaf(3, ROOT, Geometry::Path(star(50.0, 140.0, 40.0, 18.0, 5)), solid([255, 200, 40, 255]));
    s.strokes = vec![StrokeStyle::new(4.0, solid([120, 50, 0, 255]), 0, 0)];
    w.upsert(&s, APPEND);
    let mut zig = BezPath::new();
    zig.move_to((110.0, 120.0));
    for i in 0..6 {
        zig.line_to((120.0 + i as f64 * 12.0, if i % 2 == 0 { 170.0 } else { 120.0 }));
    }
    let mut line = leaf(4, ROOT, Geometry::Path(zig), Paint::None);
    line.strokes = vec![StrokeStyle::new(6.0, Paint::Linear { start: Point::new(110.0, 0.0), end: Point::new(186.0, 0.0), stops: vec![(0.0, [255, 0, 80, 255]), (1.0, [0, 120, 255, 255])] }, 2, 2)];
    w.upsert(&line, APPEND);
    w.finish()
}

pub fn gradients() -> Vec<u8> {
    let mut w = IrWriter::new();
    let stops = vec![(0.0, [255, 60, 60, 255]), (0.4, [255, 230, 80, 255]), (1.0, [40, 120, 255, 255])];
    w.upsert(&at(leaf(1, ROOT, Geometry::Rect { w: 84.0, h: 84.0, radius: 10.0 }, Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(84.0, 84.0), stops: stops.clone() }), 6.0, 6.0), APPEND);
    w.upsert(&at(leaf(2, ROOT, Geometry::Ellipse { w: 84.0, h: 84.0 }, Paint::Radial { center: Point::new(30.0, 30.0), radius: 60.0, stops: stops.clone() }), 100.0, 6.0), APPEND);
    w.upsert(&at(leaf(3, ROOT, Geometry::Ellipse { w: 84.0, h: 84.0 }, Paint::Sweep { center: Point::new(42.0, 42.0), start: 0.0, end: std::f64::consts::TAU, stops: stops.clone() }), 6.0, 100.0), APPEND);
    let translucent = vec![(0.0, [20, 20, 200, 255]), (1.0, [20, 20, 200, 0])];
    w.upsert(&at(leaf(4, ROOT, Geometry::Rect { w: 84.0, h: 84.0, radius: 0.0 }, solid([250, 200, 60, 255])), 100.0, 100.0), APPEND);
    w.upsert(&at(leaf(5, ROOT, Geometry::Rect { w: 84.0, h: 84.0, radius: 0.0 }, Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(84.0, 0.0), stops: translucent }), 100.0, 100.0), APPEND);
    w.finish()
}

pub fn effects() -> Vec<u8> {
    let mut w = IrWriter::new();
    let mut id = 100;
    stripes(&mut w, &mut id, ROOT, 96.0, 96.0, 96.0);
    let mut card = at(leaf(1, ROOT, Geometry::Rect { w: 70.0, h: 50.0, radius: 8.0 }, solid([255, 255, 255, 255])), 12.0, 12.0);
    card.effects = vec![Effect::DropShadow { dx: 4.0, dy: 6.0, blur: 10.0, spread: 2.0, color: [0, 0, 0, 120] }];
    w.upsert(&card, APPEND);
    let mut well = at(leaf(2, ROOT, Geometry::Ellipse { w: 60.0, h: 60.0 }, solid([120, 200, 255, 255])), 112.0, 10.0);
    well.effects = vec![Effect::InnerShadow { dx: 3.0, dy: 3.0, blur: 6.0, spread: 0.0, color: [0, 0, 60, 200] }];
    w.upsert(&well, APPEND);
    let mut blurred = at(group(3, ROOT), 14.0, 100.0);
    blurred.effects = vec![Effect::LayerBlur { radius: 6.0 }];
    w.upsert(&blurred, APPEND);
    w.upsert(&at(leaf(4, 3, Geometry::Path(star(36.0, 36.0, 34.0, 14.0, 6)), solid([200, 40, 120, 255])), 0.0, 0.0), APPEND);
    let mut frosted = at(leaf(5, ROOT, Geometry::Rect { w: 60.0, h: 60.0, radius: 10.0 }, solid([255, 255, 255, 90])), 114.0, 114.0);
    frosted.effects = vec![Effect::BackgroundBlur { radius: 8.0 }];
    w.upsert(&frosted, APPEND);
    w.finish()
}

pub fn masks() -> Vec<u8> {
    let mut w = IrWriter::new();
    let quads = [(1, mask::CLIP, 4.0, 4.0), (2, mask::ALPHA, 100.0, 4.0), (3, mask::LUMINANCE, 4.0, 100.0), (4, mask::CLIP | mask::INVERT, 100.0, 100.0)];
    let mut id = 1000;
    for (g, mode, x, y) in quads {
        w.upsert(&at(group(g, ROOT), x, y), APPEND);
        id += 1;
        let paint = match mode & !mask::INVERT {
            mask::ALPHA => Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(88.0, 0.0), stops: vec![(0.0, [0, 0, 0, 255]), (1.0, [0, 0, 0, 0])] },
            mask::LUMINANCE => Paint::Radial { center: Point::new(44.0, 44.0), radius: 44.0, stops: vec![(0.0, [255, 255, 255, 255]), (1.0, [0, 0, 0, 255])] },
            _ => solid([0, 0, 0, 255]),
        };
        let mut m = at(leaf(id, g, Geometry::Ellipse { w: 76.0, h: 76.0 }, paint), 6.0, 6.0);
        m.mask = mode;
        w.upsert(&m, APPEND);
        stripes(&mut w, &mut id, g, 0.0, 0.0, 88.0);
    }
    w.finish()
}

pub fn booleans() -> Vec<u8> {
    let mut w = IrWriter::new();
    let mut donut = Rect::new(0.0, 0.0, 80.0, 80.0).to_ellipse().to_path(0.05);
    donut.extend(Rect::new(20.0, 20.0, 60.0, 60.0).to_ellipse().to_path(0.05));
    let mut d = at(leaf(1, ROOT, Geometry::Path(donut), solid([60, 130, 220, 255])), 8.0, 8.0);
    d.even_odd = true;
    w.upsert(&d, APPEND);
    let crossing = star(40.0, 40.0, 38.0, 38.0, 5); // a pentagram: self-intersecting
    let mut five = BezPath::new();
    for (i, el) in crossing.elements().iter().enumerate() {
        if i % 2 == 0 || matches!(el, vello_common::kurbo::PathEl::ClosePath) {
            five.push(*el);
        }
    }
    let mut pentagram = BezPath::new();
    let pts: Vec<Point> = (0..5).map(|i| {
        let a = std::f64::consts::TAU * (i as f64 * 2.0) / 5.0 - std::f64::consts::FRAC_PI_2;
        Point::new(40.0 + 38.0 * a.cos(), 40.0 + 38.0 * a.sin())
    }).collect();
    pentagram.move_to(pts[0]);
    for p in &pts[1..] {
        pentagram.line_to(*p);
    }
    pentagram.close_path();
    let nonzero = at(leaf(2, ROOT, Geometry::Path(pentagram.clone()), solid([230, 80, 60, 255])), 104.0, 8.0);
    w.upsert(&nonzero, APPEND);
    let mut evenodd = at(leaf(3, ROOT, Geometry::Path(pentagram), solid([230, 80, 60, 255])), 8.0, 104.0);
    evenodd.even_odd = true;
    w.upsert(&evenodd, APPEND);
    let mut blob = BezPath::new();
    blob.move_to((0.0, 40.0));
    blob.quad_to((0.0, 0.0), (40.0, 0.0));
    blob.curve_to((90.0, 0.0), (60.0, 50.0), (80.0, 80.0));
    blob.quad_to((20.0, 90.0), (0.0, 40.0));
    blob.close_path();
    let mut b = at(leaf(4, ROOT, Geometry::Path(blob), solid([90, 200, 120, 255])), 104.0, 104.0);
    b.strokes = vec![StrokeStyle::new(2.0, solid([10, 60, 30, 255]), 2, 2)];
    w.upsert(&b, APPEND);
    let _ = five;
    w.finish()
}

pub fn transforms() -> Vec<u8> {
    let mut w = IrWriter::new();
    let a = |id: u32, t: Affine, c: [u8; 4]| {
        let mut n = leaf(id, ROOT, Geometry::Path(arrow()), solid(c));
        n.transform = t;
        n.strokes = vec![StrokeStyle::new(1.5, solid([0, 0, 0, 255]), 1, 0)];
        n
    };
    // skew X, skew Y, flip H, flip V (around their own boxes), rotation with non-uniform scale
    w.upsert(&a(1, Affine::translate((10.0, 10.0)) * Affine::skew(0.5, 0.0), [230, 80, 60, 255]), APPEND);
    w.upsert(&a(2, Affine::translate((110.0, 6.0)) * Affine::skew(0.0, 0.4), [60, 160, 90, 255]), APPEND);
    w.upsert(&a(3, Affine::translate((60.0, 70.0)) * Affine::new([-1.0, 0.0, 0.0, 1.0, 0.0, 0.0]), [60, 110, 230, 255]), APPEND);
    w.upsert(&a(4, Affine::translate((110.0, 110.0)) * Affine::new([1.0, 0.0, 0.0, -1.0, 0.0, 0.0]), [220, 180, 40, 255]), APPEND);
    w.upsert(&a(5, Affine::translate((150.0, 70.0)) * Affine::rotate(0.5) * Affine::scale_non_uniform(1.0, 0.6), [170, 70, 200, 255]), APPEND);
    // a flipped, clipped group holding a skewed child and a rect filled with an image
    let mut g = group(6, ROOT);
    g.transform = Affine::translate((90.0, 120.0)) * Affine::new([-1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    g.clip = Clip::Rounded(Rect::new(0.0, 0.0, 80.0, 64.0), 12.0);
    w.upsert(&g, APPEND);
    let mut skewed = leaf(7, 6, Geometry::Path(arrow()), solid([20, 20, 30, 255]));
    skewed.transform = Affine::translate((6.0, 10.0)) * Affine::skew(-0.4, 0.2);
    w.upsert(&skewed, APPEND);
    w.image(1, 16, 16, &checker());
    let mut pic = leaf(8, ROOT, Geometry::Rect { w: 48.0, h: 40.0, radius: 6.0 }, Paint::Image(1, fit::COVER));
    pic.transform = Affine::translate((140.0, 140.0)) * Affine::skew(0.3, 0.0) * Affine::new([1.0, 0.0, 0.0, -1.0, 0.0, 0.0]) * Affine::translate((0.0, -40.0));
    w.upsert(&pic, APPEND);
    w.finish()
}

pub fn repeats() -> Vec<u8> {
    let mut w = IrWriter::new();
    // radial repeat: 12 petals around (60, 60), each rotated (what B7 expands into instances)
    let mut petal = BezPath::new();
    petal.move_to((0.0, 0.0));
    petal.curve_to((10.0, -14.0), (30.0, -14.0), (44.0, 0.0));
    petal.curve_to((30.0, 14.0), (10.0, 14.0), (0.0, 0.0));
    petal.close_path();
    for i in 0..12 {
        let mut n = leaf(1 + i, ROOT, Geometry::Path(petal.clone()), solid([(60 + i * 15) as u8, 80, (220 - i * 12) as u8, 220]));
        n.transform = Affine::translate((60.0, 60.0)) * Affine::rotate(std::f64::consts::TAU * i as f64 / 12.0) * Affine::translate((8.0, 0.0));
        w.upsert(&n, APPEND);
    }
    // grid with mirror: 4 × 3 cells, odd columns flipped horizontally
    for r in 0..3u32 {
        for c in 0..4u32 {
            let id = 100 + r * 4 + c;
            let mut n = leaf(id, ROOT, Geometry::Path(arrow()), solid([40, (120 + r * 40) as u8, 120, 255]));
            let flip = if c % 2 == 1 { Affine::new([-1.0, 0.0, 0.0, 1.0, 48.0, 0.0]) } else { Affine::IDENTITY };
            n.transform = Affine::translate((4.0 + c as f64 * 46.0, 124.0 + r as f64 * 22.0)) * Affine::scale(0.8) * flip * Affine::scale_non_uniform(1.0, 0.5);
            w.upsert(&n, APPEND);
        }
    }
    // a mirrored star pair (mirror repeat around x = 150)
    for (i, t) in [Affine::IDENTITY, Affine::new([-1.0, 0.0, 0.0, 1.0, 300.0, 0.0])].into_iter().enumerate() {
        let mut n = leaf(200 + i as u32, ROOT, Geometry::Path(star(130.0, 50.0, 24.0, 10.0, 5)), solid([250, 170, 30, 255]));
        n.transform = t * Affine::skew(0.25, 0.0);
        w.upsert(&n, APPEND);
    }
    w.finish()
}

pub fn images() -> Vec<u8> {
    let mut w = IrWriter::new();
    w.image(1, 16, 16, &checker());
    w.upsert(&at(leaf(1, ROOT, Geometry::Image { image: 1, w: 80.0, h: 60.0 }, Paint::None), 8.0, 8.0), APPEND);
    w.upsert(&at(leaf(2, ROOT, Geometry::Ellipse { w: 80.0, h: 60.0 }, Paint::Image(1, fit::COVER)), 104.0, 8.0), APPEND);
    let mut contain = at(leaf(3, ROOT, Geometry::Rect { w: 80.0, h: 50.0, radius: 0.0 }, Paint::Image(1, fit::CONTAIN)), 8.0, 104.0);
    contain.strokes = vec![StrokeStyle::new(1.0, solid([0, 0, 0, 255]), 1, 0)];
    w.upsert(&contain, APPEND);
    w.upsert(&at(leaf(4, ROOT, Geometry::Rect { w: 80.0, h: 80.0, radius: 16.0 }, Paint::Image(1, fit::TILE)), 104.0, 104.0), APPEND);
    w.finish()
}

pub fn layers() -> Vec<u8> {
    let mut w = IrWriter::new();
    let mut g = at(group(1, ROOT), 8.0, 8.0);
    g.opacity = 0.5;
    w.upsert(&g, APPEND);
    w.upsert(&at(leaf(2, 1, Geometry::Rect { w: 50.0, h: 50.0, radius: 0.0 }, solid([230, 60, 60, 255])), 0.0, 0.0), APPEND);
    w.upsert(&at(leaf(3, 1, Geometry::Rect { w: 50.0, h: 50.0, radius: 0.0 }, solid([60, 60, 230, 255])), 25.0, 25.0), APPEND);
    w.upsert(&at(leaf(4, ROOT, Geometry::Rect { w: 80.0, h: 80.0, radius: 0.0 }, Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(80.0, 80.0), stops: vec![(0.0, [255, 200, 0, 255]), (1.0, [0, 160, 200, 255])] }), 104.0, 8.0), APPEND);
    for (i, blend) in [1u8, 2, 10].iter().enumerate() {
        let mut b = at(leaf(5 + i as u32, ROOT, Geometry::Ellipse { w: 40.0, h: 40.0 }, solid([200, 40, 160, 255])), 104.0 + i as f64 * 20.0, 20.0 + i as f64 * 18.0);
        b.blend = *blend;
        w.upsert(&b, APPEND);
    }
    let mut outer = at(group(10, ROOT), 20.0, 104.0);
    outer.clip = Clip::Rect(Rect::new(0.0, 0.0, 150.0, 70.0));
    w.upsert(&outer, APPEND);
    let mut inner = group(11, 10);
    inner.clip = Clip::Rounded(Rect::new(10.0, 10.0, 120.0, 80.0), 20.0);
    inner.opacity = 0.8;
    w.upsert(&inner, APPEND);
    let mut id = 300;
    stripes(&mut w, &mut id, 11, 0.0, 0.0, 150.0);
    w.finish()
}

/// Latin text with its text (scene IR v4), laid out from the font's advances (no shaping needed for Latin).
pub fn latin_run(font: &[u8], font_id: u32, text: &str, size: f32, x: f32, y: f32) -> GlyphRun {
    use skrifa::MetadataProvider;
    use skrifa::raw::TableProvider;
    let face = skrifa::FontRef::new(font).unwrap();
    let upem = face.head().unwrap().units_per_em() as f32;
    let metrics = face.glyph_metrics(skrifa::instance::Size::unscaled(), skrifa::instance::LocationRef::default());
    let mut pen = x;
    let mut glyphs = Vec::new();
    let mut clusters = Vec::new();
    for (start, ch) in text.char_indices() {
        let gid = face.charmap().map(ch).map_or(0, |g| g.to_u32());
        glyphs.push((gid, pen, y));
        clusters.push((start as u32, (start + ch.len_utf8()) as u32));
        pen += metrics.advance_width(skrifa::GlyphId::new(gid)).unwrap_or(0.0) / upem * size;
    }
    GlyphRun::new(font_id, size, glyphs).with_text(text, clusters)
}

pub const LATIN_TEXT: &str = "Instaflow exports real text: Ünïcödé, fi & 42%";

pub fn noto_latin() -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fonts/NotoSans-Latin.wght.ttf")).unwrap()
}

/// The B2 text fixture (Latin, Arabic, Devanagari shaped by Parley) plus a Latin run carrying its text, a
/// synthetic italic, a bold instance (variation coordinates) and a gradient-filled run.
pub fn text() -> Vec<u8> {
    let font = noto_latin();
    let mut w = IrWriter::new();
    w.clear();
    for op in [text_font_batch(&render_fixtures())] {
        let mut scene = Scene::new();
        scene.apply(&op).unwrap();
        // re-encode the fonts into this batch (one self-contained batch)
        for id in 1..=4u32 {
            if let (Some(h), Some(f)) = (scene.font_hash(id), scene.font(id)) {
                w.font(id, h, f.data.data());
            }
        }
    }
    w.font(9, &[9; 32], &font);
    // the shaped fixture, scaled into the top half
    let mut shaped = Scene::new();
    shaped.apply(&text_font_batch(&render_fixtures())).unwrap();
    shaped.apply(&std::fs::read(render_fixtures().join("text.sfir")).unwrap()).unwrap();
    let mut g = group(1, ROOT);
    g.transform = Affine::scale(0.7);
    w.upsert(&g, APPEND);
    let mut stack: Vec<u32> = shaped.children(ROOT).iter().rev().copied().collect();
    while let Some(id) = stack.pop() {
        let mut n = shaped.node(id).unwrap().clone();
        n.id += 1000;
        n.parent = if n.parent == ROOT { 1 } else { n.parent + 1000 };
        w.upsert(&n, APPEND);
        stack.extend(shaped.children(id).iter().rev().copied());
    }
    let run = latin_run(&font, 9, LATIN_TEXT, 11.0, 4.0, 128.0);
    w.upsert(&leaf(2, ROOT, Geometry::Glyphs(run), solid([20, 20, 30, 255])), APPEND);
    let mut italic = latin_run(&font, 9, "Synthetic italic", 14.0, 4.0, 150.0);
    italic.skew = 12.0;
    w.upsert(&leaf(3, ROOT, Geometry::Glyphs(italic), solid([200, 40, 60, 255])), APPEND);
    let mut bold = latin_run(&font, 9, "Bold 700", 14.0, 4.0, 172.0);
    bold.coords = vec![9830]; // wght 700 (normalized 0.6)
    w.upsert(&leaf(4, ROOT, Geometry::Glyphs(bold), solid([30, 90, 200, 255])), APPEND);
    let gradient = latin_run(&font, 9, "Gradient", 18.0, 96.0, 172.0);
    w.upsert(&leaf(5, ROOT, Geometry::Glyphs(gradient), Paint::Linear { start: Point::new(96.0, 0.0), end: Point::new(180.0, 0.0), stops: vec![(0.0, [255, 60, 60, 255]), (1.0, [60, 60, 255, 255])] }), APPEND);
    w.finish()
}

pub struct CorpusScene {
    pub name: &'static str,
    pub batch: Vec<u8>,
    /// Features it exercises (the D21 table's rows).
    pub features: &'static str,
}

pub fn corpus() -> Vec<CorpusScene> {
    let s = |name, batch, features| CorpusScene { name, batch, features };
    vec![
        s("appearance", appearance(), "stacked fills and strokes, dashes, rings, multiply, gradient stroke"),
        s("gradients", gradients(), "linear, radial, conic, translucent stops"),
        s("effects", effects(), "drop / inner shadow, layer blur, background blur"),
        s("masks", masks(), "clip, alpha, luminance, inverted masks"),
        s("booleans", booleans(), "even-odd, self-intersecting, quads + cubics"),
        s("transforms", transforms(), "skew X / Y, flips H / V, rotate + scale, flipped clipped group, skewed image"),
        s("repeats", repeats(), "radial, mirrored grid and mirror pair (expanded instances)"),
        s("images", images(), "image node, cover, contain, tile"),
        s("layers", layers(), "group opacity, blend modes, nested clips"),
        s("text", text(), "Latin, Arabic, Devanagari, italic, variable weight, gradient text"),
    ]
}

// ---------------------------------------------------------------- rasterizing the outputs

pub fn reference(scene: &Scene) -> Vec<u8> {
    reference_at(scene, 1)
}

/// The reference at `k` output px per world px.
pub fn reference_at(scene: &Scene, k: u16) -> Vec<u8> {
    render_region(scene, Rect::new(0.0, 0.0, SIZE as f64, SIZE as f64), SIZE * k, SIZE * k, [255, 255, 255, 255])
}

/// Patches for `format`, rendered by vello_cpu at `scale` px per world px.
pub fn patches(scene: &Scene, format: Format, region: Rect, scale: f64) -> (HashMap<u32, crate::record::PatchSite>, HashMap<u32, PatchImage>) {
    let planned = plan(scene, format, region, None, scale);
    let mut images = HashMap::new();
    for p in &planned {
        let mut s = Scene::new();
        s.apply(&p.ir).unwrap();
        let (w, h) = crate::plan::patch_size(p.world, scale);
        let (w, h) = (w as u16, h as u16);
        let rgba = render_region(&s, p.world, w, h, [0, 0, 0, 0]);
        images.insert(p.node, PatchImage { width: w as u32, height: h as u32, rgba });
    }
    (sites(&planned), images)
}

pub fn svg_of(scene: &Scene) -> String {
    let region = Rect::new(0.0, 0.0, SIZE as f64, SIZE as f64);
    let (sites, images) = patches(scene, Format::Svg, region, 2.0);
    let view = view_of(region, SIZE as f64, SIZE as f64);
    let items = record(scene, view, Rect::new(-2.0, -2.0, SIZE as f64 + 2.0, SIZE as f64 + 2.0), None, &sites);
    crate::svg::write(scene, &items, &images, &SvgOptions { width: SIZE as f64, height: SIZE as f64, background: None, title: String::new() }).unwrap()
}

pub fn pdf_of(scene: &Scene) -> Vec<u8> {
    let region = Rect::new(0.0, 0.0, SIZE as f64, SIZE as f64);
    let (sites, images) = patches(scene, Format::Pdf, region, 2.0);
    let view = view_of(region, SIZE as f64, SIZE as f64);
    let items = record(scene, view, Rect::new(-2.0, -2.0, SIZE as f64 + 2.0, SIZE as f64 + 2.0), None, &sites);
    let mut w = crate::pdf::PdfWriter::new();
    w.page(scene, &items, &images, SIZE as f64, SIZE as f64, None).unwrap();
    w.finish("corpus").unwrap()
}

/// resvg's raster of an SVG over white (straight RGBA).
pub fn resvg_raster(svg: &str) -> Vec<u8> {
    let tree = resvg::usvg::Tree::from_str(svg, &resvg::usvg::Options::default()).expect("valid SVG");
    let mut pixmap = resvg::tiny_skia::Pixmap::new(SIZE as u32, SIZE as u32).unwrap();
    pixmap.fill(resvg::tiny_skia::Color::WHITE);
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    let mut out = pixmap.data().to_vec();
    vello_common::pixmap::unpremultiply_rgba8(&mut out);
    out
}

pub fn has_tool(name: &str) -> bool {
    std::process::Command::new(name).arg("-v").output().is_ok()
}

/// poppler's (cairo) raster of page 1 at 1 px per output px (None when `pdftocairo` is missing).
pub fn poppler_raster(pdf: &[u8], tag: &str) -> Option<Vec<u8>> {
    poppler_raster_at(pdf, tag, 1)
}

/// poppler's raster at `k` px per output px.
pub fn poppler_raster_at(pdf: &[u8], tag: &str, k: u16) -> Option<Vec<u8>> {
    if !has_tool("pdftocairo") {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("sf-export-{}-{tag}-{k}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    let input = dir.join("in.pdf");
    std::fs::write(&input, pdf).ok()?;
    let out = dir.join("out");
    let dpi = (96 * k).to_string();
    // poppler's cairo backend: its Splash backend snaps Type 3 glyphs to whole pixels (mean error 7.1 vs 1.2 per
    // channel on the text scene), which says more about Splash than about the file.
    let status = std::process::Command::new("pdftocairo").args(["-png", "-r", &dpi, "-singlefile"]).arg(&input).arg(&out).status().ok()?;
    if !status.success() {
        return None;
    }
    let (rgba, w, h) = decode_png(&std::fs::read(dir.join("out.png")).ok()?);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!((w, h), ((SIZE * k) as u32, (SIZE * k) as u32), "pdftocairo page size");
    Some(to_rgba(&rgba, w, h))
}

fn to_rgba(px: &[u8], w: u32, h: u32) -> Vec<u8> {
    if px.len() == (w * h * 4) as usize {
        return px.to_vec();
    }
    px.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect()
}

/// `pdftotext` of a PDF (None when the tool is missing).
pub fn pdf_text(pdf: &[u8], tag: &str) -> Option<String> {
    if !has_tool("pdftotext") {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("sf-export-text-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    let input = dir.join("in.pdf");
    std::fs::write(&input, pdf).ok()?;
    let out = std::process::Command::new("pdftotext").args(["-enc", "UTF-8"]).arg(&input).arg("-").output().ok()?;
    let _ = std::fs::remove_dir_all(&dir);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

// ---------------------------------------------------------------- SSIM (testkit's definition)

fn luma(px: &[u8]) -> Vec<f64> {
    px.chunks_exact(4)
        .map(|p| {
            let a = p[3] as f64 / 255.0;
            let c = |v: u8| v as f64 * a + 255.0 * (1.0 - a);
            0.299 * c(p[0]) + 0.587 * c(p[1]) + 0.114 * c(p[2])
        })
        .collect()
}

fn box_blur(img: &[f64], w: usize, h: usize) -> Vec<f64> {
    let mut out = vec![0.0; img.len()];
    for y in 0..h {
        for x in 0..w {
            let (mut s, mut n) = (0.0, 0.0);
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let (xx, yy) = (x as i64 + dx, y as i64 + dy);
                    if xx >= 0 && yy >= 0 && (xx as usize) < w && (yy as usize) < h {
                        s += img[yy as usize * w + xx as usize];
                        n += 1.0;
                    }
                }
            }
            out[y * w + x] = s / n;
        }
    }
    out
}

/// Mean SSIM (11×11 Gaussian window, σ = 1.5, valid positions) of two luma images.
pub fn ssim_luma(a: &[f64], b: &[f64], w: usize, h: usize) -> f64 {
    let size = 11usize;
    let sigma = 1.5f64;
    let half = (size - 1) / 2;
    let mut k: Vec<f64> = (0..size).map(|i| (-((i as f64 - half as f64).powi(2)) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f64 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    let (c1, c2) = ((0.01f64 * 255.0).powi(2), (0.03f64 * 255.0).powi(2));
    let mut total = 0.0;
    let mut count = 0.0;
    for y in 0..=h - size {
        for x in 0..=w - size {
            let (mut ma, mut mb, mut aa, mut bb, mut ab) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for j in 0..size {
                for i in 0..size {
                    let wgt = k[i] * k[j];
                    let (va, vb) = (a[(y + j) * w + x + i], b[(y + j) * w + x + i]);
                    ma += wgt * va;
                    mb += wgt * vb;
                    aa += wgt * va * va;
                    bb += wgt * vb * vb;
                    ab += wgt * va * vb;
                }
            }
            let (sa, sb, sab) = (aa - ma * ma, bb - mb * mb, ab - ma * mb);
            total += ((2.0 * ma * mb + c1) * (2.0 * sab + c2)) / ((ma * ma + mb * mb + c1) * (sa + sb + c2));
            count += 1.0;
        }
    }
    total / count
}

#[derive(Clone, Copy, Debug)]
pub struct Score {
    pub ssim: f64,
    pub blurred: f64,
    /// Fraction of pixels whose luma differs by more than 64 after the blur (missing or extra content).
    pub missing: f64,
}

pub fn score(actual: &[u8], expected: &[u8]) -> Score {
    score_at(actual, expected, 1)
}

pub fn score_at(actual: &[u8], expected: &[u8], k: u16) -> Score {
    let (w, h) = ((SIZE * k) as usize, (SIZE * k) as usize);
    let (a, e) = (luma(actual), luma(expected));
    let (ab, eb) = (box_blur(&a, w, h), box_blur(&e, w, h));
    let missing = ab.iter().zip(&eb).filter(|(x, y)| (*x - *y).abs() > 64.0).count() as f64 / (w * h) as f64;
    Score { ssim: ssim_luma(&a, &e, w, h), blurred: ssim_luma(&ab, &eb, w, h), missing }
}

/// D21: the SVG (and PDF) parity rule, after the per-feature rasterize list: SSIM ≥ 0.98, SSIM after a 3×3 blur
/// ≥ 0.99, and no missing content (< 0.5 % of pixels off by more than a quarter of the range after the blur).
pub const RULE: (f64, f64, f64) = (0.98, 0.99, 0.005);

pub fn passes(s: &Score) -> bool {
    s.ssim >= RULE.0 && s.blurred >= RULE.1 && s.missing <= RULE.2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene_of(batch: &[u8]) -> Scene {
        let mut s = Scene::new();
        s.apply(batch).unwrap();
        s
    }

    /// The batches and references on disk match the corpus (the GPU test reads them).
    #[test]
    fn corpus_fixtures_are_current() {
        std::fs::create_dir_all(fixtures()).unwrap();
        for c in corpus() {
            let scene = scene_of(&c.batch);
            let image = reference(&scene);
            let svg = svg_of(&scene);
            let (b, p, s) = (fixtures().join(format!("{}.sfir", c.name)), fixtures().join(format!("{}.cpu.png", c.name)), fixtures().join(format!("{}.svg", c.name)));
            if update() {
                std::fs::write(&b, &c.batch).unwrap();
                std::fs::write(&p, encode_png(&image, SIZE as u32, SIZE as u32)).unwrap();
                std::fs::write(&s, &svg).unwrap();
                continue;
            }
            assert_eq!(std::fs::read(&b).unwrap_or_default(), c.batch, "{} changed: SF_UPDATE_GOLDENS=1 cargo test -p export corpus", c.name);
            let (golden, _, _) = decode_png(&std::fs::read(&p).unwrap());
            let max = golden.iter().zip(&image).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap_or(0);
            assert!(max <= 1, "{}: CPU render differs from the golden by {max}", c.name);
            assert_eq!(std::fs::read_to_string(&s).unwrap_or_default(), svg, "{}.svg changed: SF_UPDATE_GOLDENS=1 cargo test -p export corpus", c.name);
        }
    }

    /// D21 on the corpus: every scene passes the rule in SVG (resvg, 1 px per design px) and PDF (poppler's cairo
    /// backend at 2 px per design px, when installed: at 1× the viewer's stroke adjustment and pattern sampling
    /// dominate). With `SF_EXPORT_CORPUS=1` the scores are printed (the numbers DECISIONS.md records).
    // A 4-core container: ten scenes × three rasterizers plus SSIM takes a few seconds in debug.
    #[test]
    fn corpus_meets_the_parity_rule() {
        let print = std::env::var("SF_EXPORT_CORPUS").is_ok_and(|v| v == "1");
        let mut failures = Vec::new();
        let mut rows = Vec::new();
        for c in corpus() {
            let scene = scene_of(&c.batch);
            let expected = reference(&scene);
            let svg_raster = resvg_raster(&svg_of(&scene));
            let pdf_raster = poppler_raster(&pdf_of(&scene), c.name);
            // Inspect by eye: SF_EXPORT_DUMP=/dir writes the reference and both rasters (and the SVG and PDF).
            if let Ok(dir) = std::env::var("SF_EXPORT_DUMP") {
                let dir = PathBuf::from(dir);
                let _ = std::fs::create_dir_all(&dir);
                let png = |px: &[u8]| encode_png(px, SIZE as u32, SIZE as u32);
                let _ = std::fs::write(dir.join(format!("{}.ref.png", c.name)), png(&expected));
                let _ = std::fs::write(dir.join(format!("{}.svg.png", c.name)), png(&svg_raster));
                let _ = std::fs::write(dir.join(format!("{}.svg", c.name)), svg_of(&scene));
                let _ = std::fs::write(dir.join(format!("{}.pdf", c.name)), pdf_of(&scene));
                if let Some(px) = &pdf_raster {
                    let _ = std::fs::write(dir.join(format!("{}.pdf.png", c.name)), png(px));
                }
            }
            let svg = score(&svg_raster, &expected);
            let pdf = pdf_raster.map(|px| score(&px, &expected));
            let pdf2 = poppler_raster_at(&pdf_of(&scene), c.name, 2).map(|px| score_at(&px, &reference_at(&scene, 2), 2));
            if !passes(&svg) {
                failures.push(format!("{} SVG {svg:?}", c.name));
            }
            if let Some(p) = &pdf2 {
                if !passes(p) {
                    failures.push(format!("{} PDF {p:?}", c.name));
                }
            }
            rows.push((c.name, c.features, svg, pdf, pdf2));
        }
        if print {
            println!("| scene | features | SVG, resvg 1× | PDF, poppler-cairo 1× | PDF, poppler-cairo 2× |");
            let f = |p: &Option<Score>| p.map_or("n/a".to_string(), |p| format!("{:.4} / {:.4} / {:.4}", p.ssim, p.blurred, p.missing));
            for (name, features, s, p, p2) in &rows {
                println!("| {name} | {features} | {:.4} / {:.4} / {:.4} | {} | {} |", s.ssim, s.blurred, s.missing, f(p), f(p2));
            }
        }
        assert!(failures.is_empty(), "parity rule failures: {failures:#?}");
    }

    /// The rasterize list is what makes the rule hold for PDF: without patches, shadows and blurs go missing.
    #[test]
    fn without_the_rasterize_list_pdf_loses_effects() {
        let scene = scene_of(&effects());
        let expected = reference_at(&scene, 2);
        let view = view_of(Rect::new(0.0, 0.0, SIZE as f64, SIZE as f64), SIZE as f64, SIZE as f64);
        let items = record(&scene, view, Rect::new(-2.0, -2.0, 1e4, 1e4), None, &HashMap::new());
        let mut w = crate::pdf::PdfWriter::new();
        w.page(&scene, &items, &HashMap::new(), SIZE as f64, SIZE as f64, None).unwrap();
        let native = w.finish("").unwrap();
        let (Some(with), Some(without)) = (poppler_raster_at(&pdf_of(&scene), "with", 2), poppler_raster_at(&native, "without", 2)) else { return };
        let (with, without) = (score_at(&with, &expected, 2), score_at(&without, &expected, 2));
        assert!(passes(&with) && !passes(&without), "patched {with:?} vs native {without:?}");
    }

    #[test]
    fn pdf_text_is_real_and_extracts_as_written() {
        let scene = scene_of(&text());
        let pdf = pdf_of(&scene);
        // the run's text is in the file as ActualText (UTF-16BE) and the fonts carry ToUnicode maps
        let raw = String::from_utf8_lossy(&pdf);
        assert!(raw.contains("/Type3") && raw.contains("/ToUnicode"), "Type 3 fonts with ToUnicode");
        let Some(text) = pdf_text(&pdf, "text") else { return };
        let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(flat.contains(LATIN_TEXT), "pdftotext: {flat}");
        for phrase in ["Synthetic italic", "Bold 700", "Gradient"] {
            assert!(flat.contains(phrase), "{phrase} in {flat}");
        }
    }

    /// Skew and flips: the transforms scene in every vector format against the renderer, per quadrant (a mirrored
    /// or unskewed item moves ink between quadrants).
    #[test]
    fn skew_and_flips_match_the_renderer() {
        let scene = scene_of(&transforms());
        let expected = reference(&scene);
        let ink = |px: &[u8]| -> [f64; 4] {
            let mut q = [0.0; 4];
            for (i, p) in px.chunks_exact(4).enumerate() {
                let (x, y) = (i % SIZE as usize, i / SIZE as usize);
                let k = (x * 2 / SIZE as usize) + 2 * (y * 2 / SIZE as usize);
                q[k] += 255.0 * 3.0 - (p[0] as f64 + p[1] as f64 + p[2] as f64);
            }
            q
        };
        let want = ink(&expected);
        let check = |name: &str, px: &[u8]| {
            let got = ink(px);
            for k in 0..4 {
                let rel = (got[k] - want[k]).abs() / want[k].max(1.0);
                assert!(rel < 0.05, "{name}: quadrant {k} ink {:.0} vs {:.0}", got[k], want[k]);
            }
            assert!(passes(&score(px, &expected)), "{name}: {:?}", score(px, &expected));
        };
        check("svg", &resvg_raster(&svg_of(&scene)));
        if let Some(px) = poppler_raster(&pdf_of(&scene), "transforms") {
            check("pdf", &px);
        }
    }
}
