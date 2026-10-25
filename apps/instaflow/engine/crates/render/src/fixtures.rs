//! Render fixtures (host builds only): small scenes covering every IR kind, their encoded batches
//! (`fixtures/<name>.sfir`) and `vello_cpu` reference images (`fixtures/<name>.cpu.png`).
//!
//! The browser GPU test (`apps/instaflow/src/render/render.gpu.test.ts`) loads the same batches into
//! the Vello GPU engine and compares against the CPU images (GPU-vs-CPU parity, IF-7.4), and the
//! TypeScript encoder test rebuilds `shapes` byte for byte. Regenerate after an intended change with
//! `SF_UPDATE_GOLDENS=1 cargo test -p render fixtures` (CI never writes them).

use crate::ir::{APPEND, Clip, Geometry, IrWriter, Node, Paint, ROOT, StrokeStyle, group, leaf};
use vello_common::kurbo::{Affine, BezPath, Point, Rect};

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

fn stroke(width: f64, c: [u8; 4], join: u8, cap: u8) -> Option<StrokeStyle> {
    Some(StrokeStyle { width, paint: Paint::Solid(c), join, cap })
}

/// Basic shapes, strokes and a rotation (the scene the TypeScript encoder test reproduces).
pub fn shapes() -> Vec<u8> {
    let mut w = IrWriter::new();
    w.upsert(&rect(1, ROOT, 8.0, 8.0, 48.0, 32.0, [220, 40, 40, 255]), APPEND);
    let mut rounded = at(leaf(2, ROOT, Geometry::Rect { w: 56.0, h: 32.0, radius: 8.0 }, Paint::Solid([40, 80, 220, 255])), 64.0, 8.0);
    rounded.stroke = stroke(3.0, [20, 20, 20, 255], 1, 0);
    w.upsert(&rounded, APPEND);
    w.upsert(&at(leaf(3, ROOT, Geometry::Ellipse { w: 48.0, h: 40.0 }, Paint::Solid([40, 180, 90, 200])), 8.0, 48.0), APPEND);
    let mut tri = BezPath::new();
    tri.move_to((88.0, 52.0));
    tri.line_to((120.0, 116.0));
    tri.line_to((56.0, 116.0));
    tri.close_path();
    let mut path = leaf(4, ROOT, Geometry::Path(tri), Paint::Solid([250, 200, 40, 255]));
    path.stroke = stroke(2.0, [120, 60, 0, 255], 2, 2);
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
    let mut filled = at(leaf(4, ROOT, Geometry::Ellipse { w: 52.0, h: 52.0 }, Paint::Image(1)), 68.0, 64.0);
    filled.stroke = stroke(2.0, [0, 0, 0, 255], 1, 0);
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
    line.stroke = stroke(6.0, [10, 10, 10, 230], 2, 2);
    w.upsert(&line, APPEND);
    let mut ring = at(leaf(101, ROOT, Geometry::Ellipse { w: 80.0, h: 80.0 }, Paint::Solid([255, 255, 255, 120])), 472.0, 472.0);
    ring.stroke = stroke(4.0, [200, 0, 0, 255], 1, 0);
    w.upsert(&ring, APPEND);
    w.finish()
}

pub fn all() -> Vec<Fixture> {
    let square = |name, batch| Fixture { name, batch, world: Rect::new(0.0, 0.0, 128.0, 128.0), width: 128, height: 128 };
    vec![
        square("shapes", shapes()),
        square("paints", paints()),
        square("layers", layers()),
        Fixture { name: "tiles", batch: tiles(), world: Rect::new(384.0, 384.0, 640.0, 640.0), width: 256, height: 256 },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cpu::{decode_png, encode_png, render_region};
    use crate::ir::Scene;
    use std::path::PathBuf;

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
