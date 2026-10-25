//! Render fixtures (host builds only): small scenes covering every IR kind, their encoded batches
//! (`fixtures/<name>.sfir`) and `vello_cpu` reference images (`fixtures/<name>.cpu.png`).
//!
//! The browser GPU test (`apps/instaflow/src/render/render.gpu.test.ts`) loads the same batches into
//! the Vello GPU engine and compares against the CPU images (GPU-vs-CPU parity, IF-7.4), and the
//! TypeScript encoder test rebuilds `shapes` byte for byte. Regenerate after an intended change with
//! `SF_UPDATE_GOLDENS=1 cargo test -p render fixtures` (CI never writes them).

use crate::ir::{APPEND, Clip, Effect, FillStyle, Geometry, IrWriter, Node, Paint, ROOT, StrokeStyle, fit, group, leaf, mask};
use std::path::PathBuf;
use vello_common::kurbo::{Affine, BezPath, Point, Rect, Shape};

pub struct Fixture {
    pub name: &'static str,
    pub batch: Vec<u8>,
    /// World rect shown by the reference image.
    pub world: Rect,
    pub width: u16,
    pub height: u16,
}

fn at(mut node: Node, x: f64, y: f64) -> Node {
    node.transform = Affine::translate((x, y));
    node
}

fn rect(id: u32, parent: u32, x: f64, y: f64, w: f64, h: f64, c: [u8; 4]) -> Node {
    at(leaf(id, parent, Geometry::Rect { w, h, radius: 0.0 }, Paint::Solid(c)), x, y)
}

fn stroke(width: f64, c: [u8; 4], join: u8, cap: u8) -> Vec<StrokeStyle> {
    vec![StrokeStyle::new(width, Paint::Solid(c), join, cap)]
}

/// Basic shapes, strokes and a rotation (the scene the TypeScript encoder test reproduces).
pub fn shapes() -> Vec<u8> {
    let mut w = IrWriter::new();
    w.upsert(&rect(1, ROOT, 8.0, 8.0, 48.0, 32.0, [220, 40, 40, 255]), APPEND);
    let mut rounded = at(leaf(2, ROOT, Geometry::Rect { w: 56.0, h: 32.0, radius: 8.0 }, Paint::Solid([40, 80, 220, 255])), 64.0, 8.0);
    rounded.strokes = stroke(3.0, [20, 20, 20, 255], 1, 0);
    w.upsert(&rounded, APPEND);
    w.upsert(&at(leaf(3, ROOT, Geometry::Ellipse { w: 48.0, h: 40.0 }, Paint::Solid([40, 180, 90, 200])), 8.0, 48.0), APPEND);
    let mut tri = BezPath::new();
    tri.move_to((88.0, 52.0));
    tri.line_to((120.0, 116.0));
    tri.line_to((56.0, 116.0));
    tri.close_path();
    let mut path = leaf(4, ROOT, Geometry::Path(tri), Paint::Solid([250, 200, 40, 255]));
    path.strokes = stroke(2.0, [120, 60, 0, 255], 2, 2);
    w.upsert(&path, APPEND);
    let mut turned = leaf(5, ROOT, Geometry::Rect { w: 24.0, h: 24.0, radius: 0.0 }, Paint::Solid([120, 40, 160, 255]));
    turned.transform = Affine::new([0.8, 0.6, -0.6, 0.8, 30.0, 90.0]);
    w.upsert(&turned, APPEND);
    w.finish()
}

/// 16×16 straight-RGBA checker with a translucent half.
pub fn checker() -> Vec<u8> {
    let mut px = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16u8 {
        for x in 0..16u8 {
            let on = ((x / 4) + (y / 4)) % 2 == 0;
            let alpha = if y < 8 { 255 } else { 160 };
            px.extend_from_slice(&if on { [250, 120, 20, alpha] } else { [20, 60, 140, alpha] });
        }
    }
    px
}

/// Gradients and image paints.
pub fn paints() -> Vec<u8> {
    let mut w = IrWriter::new();
    w.image(1, 16, 16, &checker());
    let linear = Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(56.0, 40.0), stops: vec![(0.0, [255, 60, 60, 255]), (0.5, [255, 230, 80, 255]), (1.0, [40, 120, 255, 255])] };
    w.upsert(&at(leaf(1, ROOT, Geometry::Rect { w: 56.0, h: 40.0, radius: 6.0 }, linear), 4.0, 4.0), APPEND);
    let radial = Paint::Radial { center: Point::new(28.0, 20.0), radius: 28.0, stops: vec![(0.0, [255, 255, 255, 255]), (1.0, [120, 0, 160, 255])] };
    w.upsert(&at(leaf(2, ROOT, Geometry::Ellipse { w: 56.0, h: 40.0 }, radial), 68.0, 4.0), APPEND);
    w.upsert(&at(leaf(3, ROOT, Geometry::Image { image: 1, w: 48.0, h: 48.0 }, Paint::None), 4.0, 64.0), APPEND);
    let mut filled = at(leaf(4, ROOT, Geometry::Ellipse { w: 52.0, h: 52.0 }, Paint::Image(1, crate::ir::fit::STRETCH)), 68.0, 64.0);
    filled.strokes = stroke(2.0, [0, 0, 0, 255], 1, 0);
    w.upsert(&filled, APPEND);
    w.finish()
}

/// Clips, opacity, blend modes and nested transforms.
pub fn layers() -> Vec<u8> {
    let mut w = IrWriter::new();
    w.upsert(&rect(1, ROOT, 0.0, 0.0, 128.0, 64.0, [235, 235, 220, 255]), APPEND);
    let mut clipped = at(group(10, ROOT), 8.0, 8.0);
    clipped.clip = Clip::Rounded(Rect::new(0.0, 0.0, 48.0, 48.0), 12.0);
    w.upsert(&clipped, APPEND);
    w.upsert(&rect(11, 10, -10.0, -10.0, 40.0, 70.0, [200, 30, 60, 255]), APPEND);
    w.upsert(&rect(12, 10, 30.0, 20.0, 40.0, 40.0, [30, 160, 200, 255]), APPEND);
    let mut faded = at(group(20, ROOT), 64.0, 8.0);
    faded.opacity = 0.5;
    w.upsert(&faded, APPEND);
    w.upsert(&rect(21, 20, 0.0, 0.0, 32.0, 32.0, [20, 20, 20, 255]), APPEND);
    w.upsert(&rect(22, 20, 16.0, 16.0, 32.0, 32.0, [20, 20, 200, 255]), APPEND);
    let mut multiply = at(leaf(30, ROOT, Geometry::Ellipse { w: 64.0, h: 48.0 }, Paint::Solid([255, 200, 0, 255])), 32.0, 40.0);
    multiply.blend = 1;
    w.upsert(&multiply, APPEND);
    let mut scaled = group(40, ROOT);
    scaled.transform = Affine::new([2.0, 0.0, 0.0, 2.0, 8.0, 96.0]);
    w.upsert(&scaled, APPEND);
    let mut inner = group(41, 40);
    inner.transform = Affine::translate((4.0, 0.0));
    w.upsert(&inner, APPEND);
    w.upsert(&rect(42, 41, 0.0, 0.0, 10.0, 10.0, [90, 160, 40, 255]), APPEND);
    let mut hidden = rect(43, 41, 12.0, 0.0, 10.0, 10.0, [255, 0, 255, 255]);
    hidden.visible = false;
    w.upsert(&hidden, APPEND);
    w.finish()
}

/// A scene straddling four 512 px tiles (world 384…640 at level 0) for tiled-vs-region parity.
pub fn tiles() -> Vec<u8> {
    let mut w = IrWriter::new();
    let mut id = 1;
    for row in 0..6 {
        for col in 0..6 {
            let c = [(40 * col + 30) as u8, (35 * row + 40) as u8, (200 - 25 * col) as u8, 255];
            let mut node = rect(id, ROOT, 392.0 + col as f64 * 42.0, 392.0 + row as f64 * 42.0, 34.0, 34.0, c);
            if (row + col) % 3 == 0 {
                node.geometry = Geometry::Rect { w: 34.0, h: 34.0, radius: 10.0 };
            }
            w.upsert(&node, APPEND);
            id += 1;
        }
    }
    let mut diagonal = BezPath::new();
    diagonal.move_to((400.0, 420.0));
    diagonal.curve_to((480.0, 380.0), (560.0, 660.0), (630.0, 600.0));
    let mut line = leaf(100, ROOT, Geometry::Path(diagonal), Paint::None);
    line.strokes = stroke(6.0, [10, 10, 10, 230], 2, 2);
    w.upsert(&line, APPEND);
    let mut ring = at(leaf(101, ROOT, Geometry::Ellipse { w: 80.0, h: 80.0 }, Paint::Solid([255, 255, 255, 120])), 472.0, 472.0);
    ring.strokes = stroke(4.0, [200, 0, 0, 255], 1, 0);
    w.upsert(&ring, APPEND);
    w.finish()
}

/// IR v2 (B1): per-corner rects, image fit, the even-odd rule, drop / inner shadows, a layer blur and the
/// three mask modes (clip, alpha, luminance; one inverted).
pub fn elements() -> Vec<u8> {
    let mut w = IrWriter::new();
    w.image(1, 16, 16, &checker());
    let mut card = at(leaf(1, ROOT, Geometry::RRect { w: 52.0, h: 32.0, radii: [12.0, 2.0, 12.0, 2.0] }, Paint::Solid([255, 92, 57, 255])), 6.0, 6.0);
    card.effects = vec![
        Effect::DropShadow { dx: 2.0, dy: 4.0, blur: 6.0, spread: 1.0, color: [0, 0, 0, 110] },
        Effect::InnerShadow { dx: 0.0, dy: 3.0, blur: 4.0, spread: 0.0, color: [120, 0, 0, 200] },
    ];
    w.upsert(&card, APPEND);
    let cover = at(leaf(2, ROOT, Geometry::Rect { w: 52.0, h: 26.0, radius: 6.0 }, Paint::Image(1, fit::COVER)), 70.0, 6.0);
    w.upsert(&cover, APPEND);
    let contain = at(leaf(3, ROOT, Geometry::Rect { w: 52.0, h: 20.0, radius: 0.0 }, Paint::Image(1, fit::CONTAIN)), 70.0, 36.0);
    w.upsert(&contain, APPEND);
    let mut ring = BezPath::new();
    ring.extend(Rect::new(0.0, 0.0, 28.0, 28.0).to_path(0.1));
    ring.extend(Rect::new(8.0, 8.0, 20.0, 20.0).to_path(0.1));
    let mut even_odd = at(leaf(4, ROOT, Geometry::Path(ring), Paint::Solid([61, 90, 254, 255])), 6.0, 48.0);
    even_odd.even_odd = true;
    w.upsert(&even_odd, APPEND);
    let mut blurred = at(leaf(5, ROOT, Geometry::Ellipse { w: 24.0, h: 24.0 }, Paint::Solid([0, 179, 126, 255])), 40.0, 50.0);
    blurred.effects = vec![Effect::LayerBlur { radius: 4.0 }];
    w.upsert(&blurred, APPEND);
    // Masks: each group holds [mask, content…].
    let masked = |w: &mut IrWriter, id: u32, x: f64, mode: u8, mask_paint: Paint| {
        w.upsert(&at(group(id, ROOT), x, 84.0), APPEND);
        let mut m = leaf(id + 1, id, Geometry::Ellipse { w: 36.0, h: 36.0 }, mask_paint);
        m.mask = mode;
        w.upsert(&m, APPEND);
        w.upsert(&rect(id + 2, id, -4.0, -4.0, 22.0, 44.0, [255, 194, 61, 255]), APPEND);
        w.upsert(&rect(id + 3, id, 18.0, -4.0, 22.0, 44.0, [214, 38, 95, 255]), APPEND);
    };
    masked(&mut w, 10, 4.0, mask::CLIP, Paint::None);
    let fade = Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(36.0, 0.0), stops: vec![(0.0, [0, 0, 0, 255]), (1.0, [0, 0, 0, 0])] };
    masked(&mut w, 20, 46.0, mask::ALPHA, fade);
    let luma = Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(0.0, 36.0), stops: vec![(0.0, [255, 255, 255, 255]), (1.0, [0, 0, 0, 255])] };
    masked(&mut w, 30, 88.0, mask::LUMINANCE | mask::INVERT, luma);
    w.finish()
}

/// IR v2 appearance stacks (B1): several fills with their own opacity and blend, a conic gradient, dashed and
/// ringed (outside) strokes, a glow, and a background blur (frosted glass) over stripes.
pub fn appearance() -> Vec<u8> {
    let mut w = IrWriter::new();
    let mut stacked = at(leaf(1, ROOT, Geometry::Rect { w: 56.0, h: 36.0, radius: 6.0 }, Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(56.0, 0.0), stops: vec![(0.0, [61, 90, 254, 255]), (1.0, [0, 179, 126, 255])] }), 6.0, 6.0);
    stacked.fills.push(FillStyle { paint: Paint::Solid([255, 194, 61, 255]), opacity: 0.5, blend: 1 });
    w.upsert(&stacked, APPEND);
    let sweep = Paint::Sweep { center: Point::new(18.0, 18.0), start: 0.0, end: std::f64::consts::TAU, stops: vec![(0.0, [255, 92, 57, 255]), (0.5, [61, 90, 254, 255]), (1.0, [255, 92, 57, 255])] };
    w.upsert(&at(leaf(2, ROOT, Geometry::Ellipse { w: 36.0, h: 36.0 }, sweep), 76.0, 6.0), APPEND);
    let mut dashed = at(leaf(3, ROOT, Geometry::Rect { w: 40.0, h: 28.0, radius: 0.0 }, Paint::Solid([240, 240, 245, 255])), 10.0, 54.0);
    let mut dash = StrokeStyle::new(3.0, Paint::Solid([22, 21, 26, 255]), 1, 2);
    dash.dash = vec![6.0, 4.0];
    let mut ring = BezPath::new();
    ring.extend(Rect::new(-4.0, -4.0, 44.0, 32.0).to_path(0.1));
    // The inner edge runs the other way, so the ring is a non-zero hole.
    ring.move_to((0.0, 0.0));
    ring.line_to((0.0, 28.0));
    ring.line_to((40.0, 28.0));
    ring.line_to((40.0, 0.0));
    ring.close_path();
    let mut outside = StrokeStyle::new(4.0, Paint::Solid([214, 38, 95, 255]), 1, 0);
    outside.ring = Some(ring);
    outside.opacity = 0.7;
    dashed.strokes = vec![dash, outside];
    w.upsert(&dashed, APPEND);
    let mut glow = at(leaf(4, ROOT, Geometry::Ellipse { w: 20.0, h: 20.0 }, Paint::Solid([255, 194, 61, 255])), 92.0, 58.0);
    glow.effects = vec![Effect::DropShadow { dx: 0.0, dy: 0.0, blur: 8.0, spread: 2.0, color: [255, 92, 57, 220] }];
    w.upsert(&glow, APPEND);
    for i in 0..8 {
        let c = if i % 2 == 0 { [22, 21, 26, 255] } else { [255, 255, 255, 255] };
        w.upsert(&rect(10 + i, ROOT, 6.0 + i as f64 * 14.0, 96.0, 14.0, 28.0, c), APPEND);
    }
    let mut glass = at(leaf(30, ROOT, Geometry::Rect { w: 70.0, h: 20.0, radius: 8.0 }, Paint::Solid([255, 255, 255, 90])), 28.0, 100.0);
    glass.effects = vec![Effect::BackgroundBlur { radius: 6.0 }];
    w.upsert(&glass, APPEND);
    w.finish()
}

/// Font files of the `text` fixture (`text.fonts`: `id file` per line; files in `apps/instaflow/test/fonts`).
pub fn text_fonts(dir: &std::path::Path) -> Vec<(u32, Vec<u8>)> {
    let fonts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fonts");
    let list = std::fs::read_to_string(dir.join("text.fonts")).expect("text.fonts (generated by the authoring crate)");
    list.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let (id, file) = l.split_once(' ').expect("`id file`");
            (id.parse().expect("font id"), std::fs::read(fonts.join(file)).unwrap_or_else(|e| panic!("{file}: {e}")))
        })
        .collect()
}

/// A batch registering the `text` fixture's fonts (hash = font id repeated: any stable key works here).
pub fn text_font_batch(dir: &std::path::Path) -> Vec<u8> {
    let mut w = IrWriter::new();
    for (id, bytes) in text_fonts(dir) {
        w.font(id, &[id as u8; 32], &bytes);
    }
    w.finish()
}

pub fn all() -> Vec<Fixture> {
    let square = |name, batch| Fixture { name, batch, world: Rect::new(0.0, 0.0, 128.0, 128.0), width: 128, height: 128 };
    vec![
        square("shapes", shapes()),
        square("paints", paints()),
        square("layers", layers()),
        square("elements", elements()),
        square("appearance", appearance()),
        Fixture { name: "tiles", batch: tiles(), world: Rect::new(384.0, 384.0, 640.0, 640.0), width: 256, height: 256 },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cpu::{decode_png, encode_png, render_region};
    use crate::ir::Scene;

    fn dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
    }

    fn update() -> bool {
        std::env::var("SF_UPDATE_GOLDENS").is_ok_and(|v| !v.is_empty() && v != "0")
    }

    /// Rendering is deterministic: same batch, same pixels.
    #[test]
    fn cpu_render_is_deterministic() {
        let mut scene = Scene::new();
        scene.apply(&layers()).unwrap();
        let a = render_region(&scene, Rect::new(0.0, 0.0, 128.0, 128.0), 128, 128, [255, 255, 255, 255]);
        let b = render_region(&scene, Rect::new(0.0, 0.0, 128.0, 128.0), 128, 128, [255, 255, 255, 255]);
        assert_eq!(a, b);
        let px = |x: usize, y: usize| a[(y * 128 + x) * 4..(y * 128 + x) * 4 + 4].to_vec();
        assert_eq!(px(1, 1), vec![235, 235, 220, 255]); // backdrop rect, clip keeps (1, 1) free
        assert_eq!(px(127, 127), vec![255, 255, 255, 255]); // background
    }

    /// The element pipeline's scene (B1: stage → render projection → scene IR, written by
    /// `apps/instaflow/src/elements/projection.test.ts`) renders on vello_cpu like its committed reference; the GPU
    /// test compares the Vello GPU output with the same reference.
    #[test]
    fn element_scene_matches_its_cpu_reference() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../src/elements/__fixtures__");
        let (Ok(images), Ok(scene_bytes)) = (std::fs::read(dir.join("elements-images.sfir")), std::fs::read(dir.join("elements-scene.sfir"))) else {
            panic!("missing element scene fixtures in {} (run the projection test)", dir.display());
        };
        let mut scene = Scene::new();
        // The scene batch starts with CLEAR (a full encode), so images go after it.
        scene.apply(&scene_bytes).unwrap();
        scene.apply(&images).unwrap();
        let image = render_region(&scene, Rect::new(0.0, 0.0, 128.0, 128.0), 128, 128, [255, 255, 255, 255]);
        let png_path = dir.join("elements-scene.cpu.png");
        if update() || !png_path.exists() {
            std::fs::write(&png_path, encode_png(&image, 128, 128)).unwrap();
            return;
        }
        let (golden, _, _) = decode_png(&std::fs::read(&png_path).unwrap());
        let max = golden.iter().zip(&image).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap_or(0);
        assert!(max <= 1, "element scene: CPU render differs from the golden by {max}");
    }

    /// The `text` fixture (glyph runs from the authoring crate, B2): `vello_cpu` renders Latin, Arabic and
    /// Devanagari with the retained fonts; the PNG is the golden the GPU page is compared with.
    #[test]
    fn text_fixture_renders_glyphs() {
        let mut scene = Scene::new();
        scene.apply(&text_font_batch(&dir())).unwrap();
        scene.apply(&std::fs::read(dir().join("text.sfir")).expect("text.sfir (SF_UPDATE_GOLDENS=1 cargo test -p authoring)")).unwrap();
        assert_eq!(scene.font_files(), 4);
        let image = render_region(&scene, Rect::new(0.0, 0.0, 256.0, 160.0), 256, 160, [255, 255, 255, 255]);
        // ink on each of the three lines (Latin, Arabic, Devanagari)
        for band in [(8, 44), (46, 84), (88, 140)] {
            let dark = (band.0..band.1).flat_map(|y| (0..256).map(move |x| (x, y))).filter(|&(x, y)| image[(y * 256 + x) * 4] < 128).count();
            assert!(dark > 150, "band {band:?} has {dark} dark pixels");
        }
        // Inspect by eye: SF_DEBUG_TEXT_PNG=/path/out.png writes a 3× render.
        if let Ok(out) = std::env::var("SF_DEBUG_TEXT_PNG") {
            let big = render_region(&scene, Rect::new(0.0, 0.0, 256.0, 160.0), 768, 480, [255, 255, 255, 255]);
            std::fs::write(out, encode_png(&big, 768, 480)).unwrap();
        }
        let png_path = dir().join("text.cpu.png");
        if update() {
            std::fs::write(&png_path, encode_png(&image, 256, 160)).unwrap();
            return;
        }
        let (golden, w, h) = decode_png(&std::fs::read(&png_path).expect("text.cpu.png (SF_UPDATE_GOLDENS=1)"));
        assert_eq!((w, h), (256, 160));
        let max = golden.iter().zip(&image).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap_or(0);
        assert!(max <= 1, "text: CPU render differs from the golden by {max}");
    }

    /// Batches and CPU reference images on disk match the definitions here.
    #[test]
    fn fixtures_are_current() {
        std::fs::create_dir_all(dir()).unwrap();
        for fixture in all() {
            let mut scene = Scene::new();
            scene.apply(&fixture.batch).unwrap();
            let image = render_region(&scene, fixture.world, fixture.width, fixture.height, [255, 255, 255, 255]);
            let batch_path = dir().join(format!("{}.sfir", fixture.name));
            let png_path = dir().join(format!("{}.cpu.png", fixture.name));
            if update() {
                std::fs::write(&batch_path, &fixture.batch).unwrap();
                std::fs::write(&png_path, encode_png(&image, fixture.width as u32, fixture.height as u32)).unwrap();
                continue;
            }
            let on_disk = std::fs::read(&batch_path).unwrap_or_else(|_| panic!("missing {} (run with SF_UPDATE_GOLDENS=1)", batch_path.display()));
            assert_eq!(on_disk, fixture.batch, "{} changed: regenerate with SF_UPDATE_GOLDENS=1", batch_path.display());
            let (golden, w, h) = decode_png(&std::fs::read(&png_path).unwrap());
            assert_eq!((w, h), (fixture.width as u32, fixture.height as u32));
            let max = golden.iter().zip(&image).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap_or(0);
            assert!(max <= 1, "{}: CPU render differs from the golden by {max}", fixture.name);
        }
    }
}
