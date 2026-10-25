//! Drawing the scene IR through a backend-neutral `Painter` (Vello GPU's `Scene` and Vello CPU's
//! `RenderContext` have the same method names, so both map 1:1). One traversal for every output:
//! tiles, lifted layers, headless regions and the CPU reference. Every IR kind is matched
//! exhaustively here (IF-7.10). Glyph runs (B2) become one filled path per run (`glyphs.rs` outlines; synthetic
//! bold adds a stroke of the same paint), so every backend draws text through `fill_path`.

use crate::ir::{Clip, Geometry, Node, Paint, ROOT, Rgba8, Scene, StrokeStyle};
use std::collections::HashSet;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::kurbo::{Affine, BezPath, Cap, Ellipse, Join, Rect, RoundedRect, Shape, Stroke};
use vello_common::paint::{Image, ImageSource, PaintType};
use vello_common::peniko::{BlendMode, ColorStop, ColorStops, Compose, Extend, Gradient, ImageSampler, Mix};

/// What a backend must offer to draw the IR.
pub trait Painter {
    fn set_transform(&mut self, t: Affine);
    fn set_paint_transform(&mut self, t: Affine);
    fn reset_paint_transform(&mut self);
    fn set_paint(&mut self, paint: PaintType);
    /// The backend's handle for a retained image (GPU: atlas id, CPU: the pixmap), with its size.
    fn image_source(&self, image: u32) -> Option<(ImageSource, u32, u32)>;
    fn fill_path(&mut self, path: &BezPath);
    fn fill_rect(&mut self, rect: &Rect);
    fn stroke_path(&mut self, path: &BezPath, stroke: &Stroke);
    fn push_layer(&mut self, clip: Option<&BezPath>, blend: BlendMode, opacity: f32);
    fn pop_layer(&mut self);
}

/// Which nodes a pass draws.
pub enum Filter<'a> {
    /// Everything except these subtrees (tiles skip lifted nodes).
    Except(&'a HashSet<u32>),
    /// Only these subtrees, inside their ancestors' clips and opacity (a lifted layer).
    Only(&'a HashSet<u32>),
}

pub fn color(c: Rgba8) -> AlphaColor<Srgb> {
    AlphaColor::from_rgba8(c[0], c[1], c[2], c[3])
}

pub fn blend_mode(blend: u8) -> BlendMode {
    let mix = match blend {
        1 => Mix::Multiply,
        2 => Mix::Screen,
        3 => Mix::Overlay,
        4 => Mix::Darken,
        5 => Mix::Lighten,
        6 => Mix::ColorDodge,
        7 => Mix::ColorBurn,
        8 => Mix::HardLight,
        9 => Mix::SoftLight,
        10 => Mix::Difference,
        11 => Mix::Exclusion,
        12 => Mix::Hue,
        13 => Mix::Saturation,
        14 => Mix::Color,
        15 => Mix::Luminosity,
        _ => Mix::Normal,
    };
    BlendMode::new(mix, Compose::SrcOver)
}

fn stops(list: &[(f32, Rgba8)]) -> ColorStops {
    let v: Vec<ColorStop> = list.iter().map(|(o, c)| ColorStop::from((*o, color(*c)))).collect();
    ColorStops::from(v.as_slice())
}

/// Shape outline in local coordinates (None for groups and glyph runs).
pub fn outline(geometry: &Geometry) -> Option<BezPath> {
    match geometry {
        Geometry::Group | Geometry::Glyphs(_) => None,
        Geometry::Rect { w, h, radius } => Some(if *radius > 0.0 {
            RoundedRect::new(0.0, 0.0, *w, *h, *radius).to_path(0.1)
        } else {
            Rect::new(0.0, 0.0, *w, *h).to_path(0.1)
        }),
        Geometry::Ellipse { w, h } => Some(Ellipse::from_rect(Rect::new(0.0, 0.0, *w, *h)).to_path(0.05)),
        Geometry::Path(p) => Some(p.clone()),
        Geometry::Image { w, h, .. } => Some(Rect::new(0.0, 0.0, *w, *h).to_path(0.1)),
    }
}

/// Set `paint` for a shape whose local box is `size`. Returns false when nothing should be drawn.
fn apply_paint<P: Painter>(p: &mut P, paint: &Paint, size: (f64, f64)) -> bool {
    match paint {
        Paint::None => false,
        Paint::Solid(c) => {
            p.reset_paint_transform();
            p.set_paint(color(*c).into());
            true
        }
        Paint::Linear { start, end, stops: s } => {
            p.reset_paint_transform();
            let g = Gradient::new_linear(*start, *end).with_stops(&stops(s)).with_extend(Extend::Pad);
            p.set_paint(g.into());
            true
        }
        Paint::Radial { center, radius, stops: s } => {
            p.reset_paint_transform();
            let g = Gradient::new_radial(*center, *radius as f32).with_stops(&stops(s)).with_extend(Extend::Pad);
            p.set_paint(g.into());
            true
        }
        Paint::Image(id) => {
            let Some((source, iw, ih)) = p.image_source(*id) else { return false };
            p.set_paint_transform(Affine::scale_non_uniform(size.0 / iw as f64, size.1 / ih as f64));
            p.set_paint(Image { image: source, sampler: ImageSampler::default() }.into());
            true
        }
    }
}

fn stroke_of(s: &StrokeStyle) -> Stroke {
    let join = match s.join {
        0 => Join::Bevel,
        2 => Join::Round,
        _ => Join::Miter,
    };
    let cap = match s.cap {
        1 => Cap::Square,
        2 => Cap::Round,
        _ => Cap::Butt,
    };
    Stroke::new(s.width).with_join(join).with_caps(cap)
}

fn box_size(node: &Node) -> (f64, f64) {
    match &node.geometry {
        Geometry::Rect { w, h, .. } | Geometry::Ellipse { w, h } | Geometry::Image { w, h, .. } => (*w, *h),
        Geometry::Path(p) => {
            let b = p.bounding_box();
            (b.x1.max(1.0), b.y1.max(1.0))
        }
        Geometry::Group | Geometry::Glyphs(_) => (1.0, 1.0),
    }
}

fn draw_leaf<P: Painter>(p: &mut P, scene: &Scene, node: &Node, transform: Affine) {
    p.set_transform(transform);
    match &node.geometry {
        Geometry::Group => {}
        Geometry::Glyphs(run) => {
            // A font id the scene does not hold draws nothing (the editor sends FONT before first use).
            if let Some(path) = scene.glyph_path(run) {
                if !path.elements().is_empty() && apply_paint(p, &node.fill, (1.0, 1.0)) {
                    p.fill_path(&path);
                    if run.embolden {
                        // Synthetic bold: grow the outline by 1/48 em on each side.
                        p.stroke_path(&path, &Stroke::new((run.size as f64 / 24.0).max(0.5)).with_join(Join::Round));
                    }
                }
            }
        }
        Geometry::Image { image, w, h } => {
            if apply_paint(p, &Paint::Image(*image), (*w, *h)) {
                p.fill_rect(&Rect::new(0.0, 0.0, *w, *h));
            }
        }
        Geometry::Rect { w, h, radius } if *radius <= 0.0 => {
            if apply_paint(p, &node.fill, (*w, *h)) {
                p.fill_rect(&Rect::new(0.0, 0.0, *w, *h));
            }
        }
        Geometry::Rect { .. } | Geometry::Ellipse { .. } | Geometry::Path(_) => {
            if let Some(path) = outline(&node.geometry) {
                if apply_paint(p, &node.fill, box_size(node)) {
                    p.fill_path(&path);
                }
            }
        }
    }
    if let (Some(s), Some(path)) = (&node.stroke, outline(&node.geometry)) {
        if apply_paint(p, &s.paint, box_size(node)) {
            p.stroke_path(&path, &stroke_of(s));
        }
    }
}

/// Draw the scene with `view` (world → target pixels), skipping subtrees outside `cull` (target pixels).
pub fn draw_scene<P: Painter>(p: &mut P, scene: &Scene, view: Affine, cull: Rect, filter: &Filter<'_>) {
    let ancestors: HashSet<u32> = match filter {
        Filter::Except(_) => HashSet::new(),
        Filter::Only(members) => {
            let mut set = HashSet::new();
            for &m in members.iter() {
                let mut at = scene.node(m).map_or(ROOT, |n| n.parent);
                while at != ROOT && set.insert(at) {
                    at = scene.node(at).map_or(ROOT, |n| n.parent);
                }
            }
            set
        }
    };
    for &id in scene.children(ROOT) {
        visit(p, scene, id, view, cull, filter, &ancestors, false);
    }
}

#[allow(clippy::too_many_arguments)]
fn visit<P: Painter>(p: &mut P, scene: &Scene, id: u32, view: Affine, cull: Rect, filter: &Filter<'_>, ancestors: &HashSet<u32>, inside: bool) {
    let Some(node) = scene.node(id) else { return };
    if !node.visible {
        return;
    }
    let inside = match filter {
        Filter::Except(skip) => {
            if skip.contains(&id) {
                return;
            }
            true
        }
        Filter::Only(members) => {
            if inside || members.contains(&id) {
                true
            } else if ancestors.contains(&id) {
                false
            } else {
                return;
            }
        }
    };
    let Some(bounds) = scene.bounds_of(id) else { return };
    let device = view.transform_rect_bbox(bounds);
    if device.x1 <= cull.x0 || device.y1 <= cull.y0 || device.x0 >= cull.x1 || device.y0 >= cull.y1 {
        return;
    }
    let transform = view * scene.world_transform(id);
    let layered = node.needs_layer();
    if layered {
        p.set_transform(transform);
        let clip = match &node.clip {
            Clip::None => None,
            other => other.path(),
        };
        p.push_layer(clip.as_ref(), blend_mode(node.blend), node.opacity);
    }
    if inside {
        draw_leaf(p, scene, node, transform);
    }
    for &kid in scene.children(id) {
        visit(p, scene, kid, view, cull, filter, ancestors, inside);
    }
    if layered {
        p.pop_layer();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{APPEND, GlyphRun, IrWriter, group, leaf};

    /// Records calls instead of drawing.
    #[derive(Default)]
    struct Recorder {
        calls: Vec<String>,
    }

    impl Painter for Recorder {
        fn set_transform(&mut self, t: Affine) {
            let c = t.as_coeffs();
            self.calls.push(format!("transform {} {}", c[4], c[5]));
        }
        fn set_paint_transform(&mut self, _t: Affine) {
            self.calls.push("paint-transform".into());
        }
        fn reset_paint_transform(&mut self) {}
        fn set_paint(&mut self, _paint: PaintType) {
            self.calls.push("paint".into());
        }
        fn image_source(&self, image: u32) -> Option<(ImageSource, u32, u32)> {
            (image == 1).then(|| (ImageSource::OpaqueId { id: vello_common::paint::ImageId::new(0), may_have_transparency: false }, 4, 4))
        }
        fn fill_path(&mut self, _path: &BezPath) {
            self.calls.push("fill-path".into());
        }
        fn fill_rect(&mut self, _rect: &Rect) {
            self.calls.push("fill-rect".into());
        }
        fn stroke_path(&mut self, _path: &BezPath, _stroke: &Stroke) {
            self.calls.push("stroke".into());
        }
        fn push_layer(&mut self, clip: Option<&BezPath>, _blend: BlendMode, opacity: f32) {
            self.calls.push(format!("push clip={} opacity={opacity}", clip.is_some()));
        }
        fn pop_layer(&mut self) {
            self.calls.push("pop".into());
        }
    }

    fn scene() -> Scene {
        let mut s = Scene::new();
        let mut g = group(1, ROOT);
        g.opacity = 0.5;
        g.clip = Clip::Rect(Rect::new(0.0, 0.0, 50.0, 50.0));
        let mut a = leaf(2, 1, Geometry::Rect { w: 10.0, h: 10.0, radius: 0.0 }, Paint::Solid([1, 2, 3, 255]));
        a.transform = Affine::translate((5.0, 5.0));
        let mut b = leaf(3, ROOT, Geometry::Ellipse { w: 10.0, h: 10.0 }, Paint::Solid([0, 0, 0, 255]));
        b.transform = Affine::translate((100.0, 0.0));
        b.stroke = Some(StrokeStyle { width: 1.0, paint: Paint::Solid([9, 9, 9, 255]), join: 1, cap: 0 });
        let mut img = leaf(4, ROOT, Geometry::Image { image: 1, w: 8.0, h: 8.0 }, Paint::None);
        img.transform = Affine::translate((200.0, 0.0));
        let missing = leaf(5, ROOT, Geometry::Image { image: 99, w: 8.0, h: 8.0 }, Paint::None);
        let mut hidden = leaf(6, ROOT, Geometry::Rect { w: 1.0, h: 1.0, radius: 0.0 }, Paint::Solid([0, 0, 0, 255]));
        hidden.visible = false;
        let glyphs = leaf(7, ROOT, Geometry::Glyphs(GlyphRun::new(0, 10.0, vec![(1, 0.0, 10.0)])), Paint::Solid([0, 0, 0, 255]));
        let font = std::fs::read(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fonts/NotoSans-Latin.wght.ttf")).unwrap();
        let mut run = GlyphRun::new(1, 10.0, vec![(40, 0.0, 10.0), (41, 6.0, 10.0)]);
        run.embolden = true;
        let mut text = leaf(8, ROOT, Geometry::Glyphs(run), Paint::Solid([0, 0, 0, 255]));
        text.transform = Affine::translate((300.0, 0.0));
        let mut w = IrWriter::new();
        w.font(1, &[3; 32], &font);
        for n in [g, a, b, img, missing, hidden, glyphs, text] {
            w.upsert(&n, APPEND);
        }
        s.apply(&w.finish()).unwrap();
        s
    }

    #[test]
    fn draws_layers_leaves_and_strokes_in_order() {
        let s = scene();
        let mut r = Recorder::default();
        draw_scene(&mut r, &s, Affine::IDENTITY, Rect::new(-1e9, -1e9, 1e9, 1e9), &Filter::Except(&HashSet::new()));
        let calls = r.calls.join("|");
        assert!(calls.starts_with("transform 0 0|push clip=true opacity=0.5|transform 0 0|transform 5 5|paint|fill-rect|pop"), "{calls}");
        assert!(calls.contains("transform 100 0|paint|fill-path|paint|stroke"), "{calls}");
        assert!(calls.contains("transform 200 0|paint-transform|paint|fill-rect"), "{calls}");
        // glyph run with a retained font: painted; with an unknown font (7): transform only
        assert!(calls.ends_with("transform 0 0|transform 300 0|paint|fill-path|stroke"), "glyph run = one path (+ bold stroke): {calls}");
        // unknown image: nothing drawn; hidden node: skipped
        assert_eq!(r.calls.iter().filter(|c| *c == "fill-rect").count(), 2);
    }

    #[test]
    fn culls_by_bounds_and_filters_lifted_nodes() {
        let s = scene();
        let mut r = Recorder::default();
        draw_scene(&mut r, &s, Affine::IDENTITY, Rect::new(90.0, 0.0, 120.0, 20.0), &Filter::Except(&HashSet::new()));
        assert_eq!(r.calls, vec!["transform 100 0", "paint", "fill-path", "paint", "stroke"]);

        let lifted: HashSet<u32> = [2].into();
        let mut except = Recorder::default();
        draw_scene(&mut except, &s, Affine::IDENTITY, Rect::new(0.0, 0.0, 50.0, 50.0), &Filter::Except(&lifted));
        // group layer without its lifted child; then the unresolved image (5) and the glyph run without a
        // font (7) set a transform and draw nothing
        assert_eq!(except.calls, vec!["transform 0 0", "push clip=true opacity=0.5", "transform 0 0", "pop", "transform 0 0", "transform 0 0"]);

        // Only: the member inside its ancestor's layer, nothing else
        let mut only = Recorder::default();
        draw_scene(&mut only, &s, Affine::translate((-5.0, -5.0)), Rect::new(-1e9, -1e9, 1e9, 1e9), &Filter::Only(&lifted));
        assert_eq!(only.calls, vec!["transform -5 -5", "push clip=true opacity=0.5", "transform 0 0", "paint", "fill-rect", "pop"]);
    }

    #[test]
    fn maps_every_blend_mode() {
        assert_eq!(blend_mode(0).mix, Mix::Normal);
        assert_eq!(blend_mode(1).mix, Mix::Multiply);
        assert_eq!(blend_mode(15).mix, Mix::Luminosity);
        assert_eq!(blend_mode(200).mix, Mix::Normal);
        assert!(outline(&Geometry::Group).is_none());
        assert!(outline(&Geometry::Rect { w: 1.0, h: 1.0, radius: 0.5 }).is_some());
    }
}
