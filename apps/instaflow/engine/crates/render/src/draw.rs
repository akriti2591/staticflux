//! Drawing the scene IR through a backend-neutral `Painter` (Vello GPU's `Scene` and Vello CPU's
//! `RenderContext` have the same method names, so both map 1:1). One traversal for every output:
//! tiles, lifted layers, headless regions and the CPU reference. Every IR kind is matched
//! exhaustively here (IF-7.10).
//!
//! IR v2 (B1): effects (drop shadows under the fill, inner shadows over it, a layer blur around the node and its
//! subtree), per-corner rects, image fit, the even-odd fill rule and **masks**: a mask node masks the siblings after
//! it. The masked run is drawn into an isolated layer, then the mask is composited into it with `DestIn` (or
//! `DestOut` when inverted), drawn in its mode: clip (geometry only, opaque), alpha (as drawn) or luminance (colours
//! become alpha = a × luma).

use crate::ir::{Clip, Crop, Effect, Geometry, GlyphRun, Node, Paint, ROOT, Rgba8, Scene, StrokeStyle, fit, mask};
use std::collections::HashSet;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::filter_effects::{EdgeMode, Filter as Effects, FilterPrimitive};
use vello_common::kurbo::{Affine, BezPath, Cap, Ellipse, Join, Rect, RoundedRect, RoundedRectRadii, Shape, Stroke};
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
    /// A layer whose content goes through a filter (blur, drop shadow) at the current transform.
    fn push_filter_layer(&mut self, filter: Effects);
    fn pop_layer(&mut self);
    fn set_even_odd(&mut self, even_odd: bool);
    /// A glyph run's outline in local space (None: draw nothing). Default: the scene's glyph cache (`outlines`
    /// feature); the export crate brings its own (its PDF library already links a font scaler).
    fn glyph_outline(&mut self, scene: &Scene, run: &GlyphRun) -> Option<BezPath> {
        #[cfg(feature = "outlines")]
        return scene.glyph_path(run);
        #[cfg(not(feature = "outlines"))]
        {
            let _ = (scene, run);
            None
        }
    }
    /// Fill a glyph run whose outline is `outline` (local space) with the current paint. Raster backends fill the
    /// outline (the default); vector exports (C1: PDF) write the run as real text instead.
    fn fill_glyphs(&mut self, _run: &GlyphRun, outline: &BezPath) {
        self.fill_path(outline);
    }
    /// Vector exports draw some nodes from a raster patch (C1: effects the format cannot express). Return true when
    /// the painter drew `node` and its subtree itself (at `transform`, view × world); the traversal then skips both.
    /// Called for nodes drawn normally only (never while drawing a mask). Raster backends never replace (default).
    fn replace_node(&mut self, _node: &Node, _transform: Affine) -> bool {
        false
    }
}

/// Which nodes a pass draws.
pub enum Filter<'a> {
    /// Everything except these subtrees (tiles skip lifted nodes).
    Except(&'a HashSet<u32>),
    /// Only these subtrees, inside their ancestors' clips and opacity (a lifted layer).
    Only(&'a HashSet<u32>),
}

/// How a subtree is drawn: normally, or as a mask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Normal,
    /// Geometry only, opaque (vector mask).
    Clip,
    /// Colours mapped to alpha = a × luma (luminance mask).
    Luminance,
}

pub fn color(c: Rgba8) -> AlphaColor<Srgb> {
    AlphaColor::from_rgba8(c[0], c[1], c[2], c[3])
}

/// Rec. 709 luma of an sRGB colour times its alpha, as an alpha-only colour (luminance masks).
pub fn luma_alpha(c: Rgba8) -> Rgba8 {
    let y = 0.2126 * c[0] as f64 + 0.7152 * c[1] as f64 + 0.0722 * c[2] as f64;
    [0, 0, 0, (y * c[3] as f64 / 255.0).round().clamp(0.0, 255.0) as u8]
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

fn stops(list: &[(f32, Rgba8)], mode: Mode) -> ColorStops {
    let v: Vec<ColorStop> = list.iter().map(|(o, c)| ColorStop::from((*o, color(if mode == Mode::Luminance { luma_alpha(*c) } else { *c })))).collect();
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
        Geometry::RRect { w, h, radii } => {
            let cap = (w.min(*h) / 2.0).max(0.0);
            let r = radii.map(|v| v.clamp(0.0, cap));
            Some(RoundedRect::from_rect(Rect::new(0.0, 0.0, *w, *h), RoundedRectRadii::new(r[0], r[1], r[2], r[3])).to_path(0.1))
        }
        Geometry::Ellipse { w, h } => Some(Ellipse::from_rect(Rect::new(0.0, 0.0, *w, *h)).to_path(0.05)),
        Geometry::Path(p) => Some(p.clone()),
        Geometry::Image { w, h, .. } => Some(Rect::new(0.0, 0.0, *w, *h).to_path(0.1)),
    }
}

/// Set `paint` for a shape whose local box is `size`. Returns None when nothing should be drawn, or the rect the
/// fill must stay inside (image `contain`).
fn apply_paint<P: Painter>(p: &mut P, paint: &Paint, size: (f64, f64), mode: Mode) -> Option<Option<Rect>> {
    if mode == Mode::Clip {
        if *paint == Paint::None {
            return None;
        }
        p.reset_paint_transform();
        p.set_paint(color([0, 0, 0, 255]).into());
        return Some(None);
    }
    match paint {
        Paint::None => None,
        Paint::Solid(c) => {
            p.reset_paint_transform();
            p.set_paint(color(if mode == Mode::Luminance { luma_alpha(*c) } else { *c }).into());
            Some(None)
        }
        Paint::Linear { start, end, stops: s } => {
            p.reset_paint_transform();
            let g = Gradient::new_linear(*start, *end).with_stops(&stops(s, mode)).with_extend(Extend::Pad);
            p.set_paint(g.into());
            Some(None)
        }
        Paint::Radial { center, radius, stops: s } => {
            p.reset_paint_transform();
            let g = Gradient::new_radial(*center, *radius as f32).with_stops(&stops(s, mode)).with_extend(Extend::Pad);
            p.set_paint(g.into());
            Some(None)
        }
        Paint::Sweep { center, start, end, stops: st } => {
            p.reset_paint_transform();
            let g = Gradient::new_sweep(*center, *start as f32, *end as f32).with_stops(&stops(st, mode)).with_extend(Extend::Pad);
            p.set_paint(g.into());
            Some(None)
        }
        Paint::Image(id, how) => image_paint(p, *id, *how, Crop::DEFAULT, size),
        Paint::ImageCrop(id, how, crop) => image_paint(p, *id, *how, *crop, size),
    }
}

/// Image → box transform of an image paint (B12 A-3): turn by `crop.quarter`, fit, scale by `crop.scale`, place at
/// `crop.x, crop.y` of the free space. With `Crop::DEFAULT` this is B1's fit exactly (centred cover / contain,
/// stretch, tile at 1:1). Returns the transform and, for `contain`, the rect the picture covers.
pub fn image_transform(how: u8, crop: Crop, image: (f64, f64), size: (f64, f64)) -> (Affine, Option<Rect>) {
    let (w, h) = size;
    let q = crop.quarter % 4;
    // The picture turned clockwise by q quarter turns, back in the positive quadrant.
    let (iw, ih) = if q % 2 == 1 { (image.1, image.0) } else { image };
    let turn = match q {
        1 => Affine::new([0.0, 1.0, -1.0, 0.0, image.1, 0.0]),
        2 => Affine::new([-1.0, 0.0, 0.0, -1.0, image.0, image.1]),
        3 => Affine::new([0.0, -1.0, 1.0, 0.0, 0.0, image.0]),
        _ => Affine::IDENTITY,
    };
    let k = if crop.scale.is_finite() && crop.scale > 0.0 { crop.scale } else { 1.0 };
    let (sx, sy) = match how {
        fit::COVER => {
            let s = (w / iw).max(h / ih);
            (s, s)
        }
        fit::CONTAIN => {
            let s = (w / iw).min(h / ih);
            (s, s)
        }
        fit::TILE => (1.0, 1.0),
        _ => (w / iw, h / ih),
    };
    let (dw, dh) = (iw * sx * k, ih * sy * k);
    let (tx, ty) = if how == fit::TILE { (0.0, 0.0) } else { ((w - dw) * crop.x, (h - dh) * crop.y) };
    let t = Affine::translate((tx, ty)) * Affine::scale_non_uniform(sx * k, sy * k) * turn;
    let keep = (how == fit::CONTAIN).then(|| Rect::new(tx, ty, tx + dw, ty + dh));
    (t, keep)
}

fn image_paint<P: Painter>(p: &mut P, id: u32, how: u8, crop: Crop, size: (f64, f64)) -> Option<Option<Rect>> {
    let (source, iw, ih) = p.image_source(id)?;
    let mut sampler = ImageSampler::default();
    if how == fit::TILE {
        sampler.x_extend = Extend::Repeat;
        sampler.y_extend = Extend::Repeat;
    }
    let (t, keep) = image_transform(how, crop, (iw as f64, ih as f64), size);
    p.set_paint_transform(t);
    p.set_paint(Image { image: source, sampler }.into());
    Some(keep)
}

#[cfg(test)]
mod crop_tests {
    use super::*;
    use vello_common::kurbo::Point;

    #[test]
    fn the_default_crop_is_b1s_fit() {
        let (t, keep) = image_transform(fit::COVER, Crop::DEFAULT, (100.0, 50.0), (40.0, 40.0));
        // cover: scale 0.8, centred horizontally (100 × 0.8 = 80 wide in a 40 box: −20)
        assert_eq!(t, Affine::translate((-20.0, 0.0)) * Affine::scale(0.8));
        assert!(keep.is_none());
        let (_, keep) = image_transform(fit::CONTAIN, Crop::DEFAULT, (100.0, 50.0), (40.0, 40.0));
        assert_eq!(keep, Some(Rect::new(0.0, 10.0, 40.0, 30.0)));
        let (t, _) = image_transform(fit::STRETCH, Crop::DEFAULT, (100.0, 50.0), (40.0, 40.0));
        assert_eq!(t, Affine::scale_non_uniform(0.4, 0.8));
    }

    #[test]
    fn offset_scale_and_quarter_turns_place_the_picture() {
        // 2 × the cover size, aligned top-left: the picture's origin stays at the box origin.
        let (t, _) = image_transform(fit::COVER, Crop { x: 0.0, y: 0.0, scale: 2.0, quarter: 0 }, (100.0, 50.0), (40.0, 40.0));
        assert_eq!(t * Point::new(0.0, 0.0), Point::new(0.0, 0.0));
        assert_eq!(t * Point::new(100.0, 50.0), Point::new(160.0, 80.0));
        // bottom-right: the far corner meets the box's far corner
        let (t, _) = image_transform(fit::COVER, Crop { x: 1.0, y: 1.0, scale: 2.0, quarter: 0 }, (100.0, 50.0), (40.0, 40.0));
        assert_eq!(t * Point::new(100.0, 50.0), Point::new(40.0, 40.0));
        // a quarter turn makes a landscape picture portrait: it covers a tall box at its width
        let (t, _) = image_transform(fit::COVER, Crop { quarter: 1, ..Crop::DEFAULT }, (100.0, 50.0), (50.0, 100.0));
        let a = t * Point::new(0.0, 0.0);
        let b = t * Point::new(100.0, 50.0);
        let (x0, x1, y0, y1) = (a.x.min(b.x), a.x.max(b.x), a.y.min(b.y), a.y.max(b.y));
        assert!((x0 - 0.0).abs() < 1e-9 && (x1 - 50.0).abs() < 1e-9 && (y0 - 0.0).abs() < 1e-9 && (y1 - 100.0).abs() < 1e-9, "{a:?} {b:?}");
        // the top-left pixel of the picture lands top-right after a clockwise turn
        assert!((a.x - 50.0).abs() < 1e-9 && a.y.abs() < 1e-9, "{a:?}");
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
    let stroke = Stroke::new(s.width).with_join(join).with_caps(cap).with_miter_limit(s.miter as f64);
    if s.dash.iter().any(|d| *d > 0.0) {
        stroke.with_dashes(s.dash_offset as f64, s.dash.iter().map(|d| *d as f64))
    } else {
        stroke
    }
}

fn box_size(node: &Node) -> (f64, f64) {
    match &node.geometry {
        Geometry::Rect { w, h, .. } | Geometry::RRect { w, h, .. } | Geometry::Ellipse { w, h } | Geometry::Image { w, h, .. } => (*w, *h),
        Geometry::Path(p) => {
            let b = p.bounding_box();
            (b.x1.max(1.0), b.y1.max(1.0))
        }
        Geometry::Group | Geometry::Glyphs(_) => (1.0, 1.0),
    }
}

/// Fill `path` with `paint`, inside `keep` when the paint asks for it.
fn fill_with<P: Painter>(p: &mut P, paint: &Paint, size: (f64, f64), mode: Mode, path: &BezPath) {
    match apply_paint(p, paint, size, mode) {
        None => {}
        Some(None) => p.fill_path(path),
        Some(Some(keep)) => {
            p.push_layer(Some(&keep.to_path(0.1)), BlendMode::default(), 1.0);
            p.fill_path(path);
            p.pop_layer();
        }
    }
}

fn shadow_filter(dx: f32, dy: f32, blur: f32, color_: Rgba8) -> Effects {
    Effects::from_primitive(FilterPrimitive::DropShadowOnly { dx, dy, std_deviation: blur / 2.0, color: color(color_), edge_mode: EdgeMode::None })
}

/// Run `draw` inside a layer when an item has its own opacity or blend (fills and strokes stack).
fn with_layer<P: Painter>(p: &mut P, opacity: f32, blend: u8, mode: Mode, draw: impl FnOnce(&mut P)) {
    let own = mode != Mode::Clip && (opacity < 1.0 || blend != 0);
    if own {
        p.push_layer(None, blend_mode(blend), opacity);
    }
    draw(p);
    if own {
        p.pop_layer();
    }
}

/// The node's silhouette (filled area, strokes and a spread ring) in an opaque paint: the source of its shadows.
fn silhouette<P: Painter>(p: &mut P, node: &Node, path: &BezPath, spread: f32) {
    p.reset_paint_transform();
    p.set_paint(color([0, 0, 0, 255]).into());
    if !node.fills.is_empty() {
        p.fill_path(path);
    }
    for s in &node.strokes {
        match &s.ring {
            Some(ring) => p.fill_path(ring),
            None => p.stroke_path(path, &stroke_of(s)),
        }
    }
    if spread > 0.0 {
        p.stroke_path(path, &Stroke::new(2.0 * spread as f64).with_join(Join::Round));
    }
}

fn draw_leaf<P: Painter>(p: &mut P, scene: &Scene, node: &Node, transform: Affine, mode: Mode) {
    p.set_transform(transform);
    p.set_even_odd(node.even_odd);
    let size = box_size(node);
    let path = outline(&node.geometry);
    // Drop shadows under the fills (leaves: from the silhouette, so spread works).
    if mode == Mode::Normal {
        if let Some(path) = &path {
            for e in &node.effects {
                if let Effect::DropShadow { dx, dy, blur, spread, color } = e {
                    p.push_filter_layer(shadow_filter(*dx, *dy, *blur, *color));
                    silhouette(p, node, path, *spread);
                    p.pop_layer();
                }
            }
        }
    }
    match &node.geometry {
        Geometry::Group => {}
        Geometry::Glyphs(run) => {
            // B2: the run becomes one path (`glyphs.rs` outlines) filled with the node's fill stack; synthetic bold
            // adds a 1/24 em round-joined stroke in the same paint. Unknown font ids draw nothing.
            if let Some(glyphs) = p.glyph_outline(scene, run).filter(|g| !g.elements().is_empty()) {
                let fills: Vec<(Paint, f32, u8)> =
                    if mode == Mode::Clip { vec![(Paint::Solid([0, 0, 0, 255]), 1.0, 0)] } else { node.fills.iter().map(|f| (f.paint.clone(), f.opacity, f.blend)).collect() };
                for (paint, opacity, blend) in fills {
                    with_layer(p, opacity, blend, mode, |p| {
                        match apply_paint(p, &paint, size, mode) {
                            None => {}
                            Some(None) => p.fill_glyphs(run, &glyphs),
                            Some(Some(keep)) => {
                                p.push_layer(Some(&keep.to_path(0.1)), BlendMode::default(), 1.0);
                                p.fill_glyphs(run, &glyphs);
                                p.pop_layer();
                            }
                        }
                        if run.embolden && apply_paint(p, &paint, size, mode).is_some() {
                            p.stroke_path(&glyphs, &Stroke::new((run.size as f64 / 24.0).max(0.5)).with_join(Join::Round));
                        }
                    });
                }
            }
        }
        Geometry::Image { image, w, h } => {
            if apply_paint(p, &Paint::Image(*image, fit::STRETCH), (*w, *h), mode).is_some() {
                p.fill_rect(&Rect::new(0.0, 0.0, *w, *h));
            }
        }
        Geometry::Rect { .. } | Geometry::RRect { .. } | Geometry::Ellipse { .. } | Geometry::Path(_) => {
            if let Some(path) = &path {
                if mode == Mode::Clip {
                    // A vector mask is the shape's geometry, whatever its paints.
                    fill_with(p, &Paint::Solid([0, 0, 0, 255]), size, mode, path);
                } else {
                    let plain_rect = matches!(node.geometry, Geometry::Rect { radius, .. } if radius <= 0.0);
                    for f in &node.fills {
                        with_layer(p, f.opacity, f.blend, mode, |p| {
                            if plain_rect {
                                match apply_paint(p, &f.paint, size, mode) {
                                    None => {}
                                    Some(None) => p.fill_rect(&Rect::new(0.0, 0.0, size.0, size.1)),
                                    Some(Some(keep)) => p.fill_rect(&keep.intersect(Rect::new(0.0, 0.0, size.0, size.1))),
                                }
                            } else {
                                fill_with(p, &f.paint, size, mode, path);
                            }
                        });
                    }
                }
            }
        }
    }
    // Inner shadows over the fills, clipped to the shape: the shadow of everything outside it.
    if mode == Mode::Normal {
        if let Some(path) = &path {
            for e in &node.effects {
                if let Effect::InnerShadow { dx, dy, blur, spread, color } = e {
                    let reach = (dx.abs().max(dy.abs()) + 1.5 * blur + spread.max(0.0) + 2.0) as f64;
                    let mut outside = path.bounding_box().inflate(reach, reach).to_path(0.1);
                    for el in path.elements() {
                        outside.push(*el);
                    }
                    p.push_layer(Some(path), BlendMode::default(), 1.0);
                    p.push_filter_layer(shadow_filter(*dx, *dy, *blur, *color));
                    p.reset_paint_transform();
                    p.set_paint(self::color([0, 0, 0, 255]).into());
                    p.set_even_odd(true);
                    p.fill_path(&outside);
                    p.set_even_odd(node.even_odd);
                    if *spread > 0.0 {
                        p.stroke_path(path, &Stroke::new(2.0 * *spread as f64).with_join(Join::Round));
                    }
                    p.pop_layer();
                    p.pop_layer();
                }
            }
        }
    }
    if let Some(path) = &path {
        for s in &node.strokes {
            with_layer(p, s.opacity, s.blend, mode, |p| {
                if apply_paint(p, &s.paint, size, mode).is_some() {
                    match &s.ring {
                        Some(ring) => {
                            p.set_even_odd(false);
                            p.fill_path(ring);
                        }
                        None => p.stroke_path(path, &stroke_of(s)),
                    }
                }
            });
        }
    }
    p.set_even_odd(false);
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
    let pass = Pass { scene, view, cull, filter, ancestors: &ancestors, stop: None, stopped: std::cell::Cell::new(false) };
    pass.children(p, scene.children(ROOT), false, Mode::Normal, false);
}

struct Pass<'a> {
    scene: &'a Scene,
    view: Affine,
    cull: Rect,
    filter: &'a Filter<'a>,
    ancestors: &'a HashSet<u32>,
    /// Backdrop pass: draw everything painted before this node, then stop.
    stop: Option<u32>,
    stopped: std::cell::Cell<bool>,
}

impl Pass<'_> {
    /// Redraw everything painted before `node`, blurred and clipped to its outline.
    fn backdrop<P: Painter>(&self, p: &mut P, node: u32, transform: Affine, path: &BezPath, radius: f32) {
        let none = HashSet::new();
        let everything = Filter::Except(&none);
        let behind = Pass { scene: self.scene, view: self.view, cull: self.cull, filter: &everything, ancestors: self.ancestors, stop: Some(node), stopped: std::cell::Cell::new(false) };
        p.set_transform(transform);
        p.push_layer(Some(path), BlendMode::default(), 1.0);
        p.push_filter_layer(Effects::from_primitive(FilterPrimitive::GaussianBlur { std_deviation: radius / 2.0, edge_mode: EdgeMode::Duplicate }));
        behind.children(p, self.scene.children(ROOT), false, Mode::Normal, false);
        p.pop_layer();
        p.pop_layer();
    }

    /// Siblings in paint order; a visible mask node masks the rest of the run.
    fn children<P: Painter>(&self, p: &mut P, ids: &[u32], inside: bool, mode: Mode, force: bool) {
        for (i, &id) in ids.iter().enumerate() {
            if self.stopped.get() || self.stop == Some(id) {
                self.stopped.set(true);
                return;
            }
            let Some(node) = self.scene.node(id) else { continue };
            let kind = node.mask & !mask::INVERT;
            if kind != mask::NONE && node.visible {
                let rest = &ids[i + 1..];
                if rest.is_empty() {
                    return;
                }
                let mask_mode = match kind {
                    mask::CLIP => Mode::Clip,
                    mask::LUMINANCE => Mode::Luminance,
                    _ => Mode::Normal,
                };
                let compose = if node.mask & mask::INVERT != 0 { Compose::DestOut } else { Compose::DestIn };
                p.set_transform(self.view);
                p.push_layer(None, BlendMode::default(), 1.0);
                self.children(p, rest, inside, mode, force);
                p.set_transform(self.view);
                p.push_layer(None, BlendMode::new(Mix::Normal, compose), 1.0);
                self.visit(p, id, true, mask_mode, true);
                p.pop_layer();
                p.pop_layer();
                return;
            }
            self.visit(p, id, inside, mode, force);
        }
    }

    fn visit<P: Painter>(&self, p: &mut P, id: u32, inside: bool, mode: Mode, force: bool) {
        let Some(node) = self.scene.node(id) else { return };
        if !node.visible {
            return;
        }
        let inside = if force {
            true
        } else {
            match self.filter {
                Filter::Except(skip) => {
                    if skip.contains(&id) {
                        return;
                    }
                    true
                }
                Filter::Only(members) => {
                    if inside || members.contains(&id) {
                        true
                    } else if self.ancestors.contains(&id) {
                        false
                    } else {
                        return;
                    }
                }
            }
        };
        let Some(bounds) = self.scene.bounds_of(id) else { return };
        let device = self.view.transform_rect_bbox(bounds);
        let c = self.cull;
        if device.x1 <= c.x0 || device.y1 <= c.y0 || device.x0 >= c.x1 || device.y0 >= c.y1 {
            return;
        }
        let transform = self.view * self.scene.world_transform(id);
        if mode == Mode::Normal && inside && p.replace_node(node, transform) {
            return;
        }
        let clip_mode = mode == Mode::Clip;
        let layered = node.needs_layer() && !(clip_mode && node.clip == Clip::None);
        if layered {
            p.set_transform(transform);
            let clip = match &node.clip {
                Clip::None => None,
                other => other.path(),
            };
            let (blend, opacity) = if clip_mode { (BlendMode::default(), 1.0) } else { (blend_mode(node.blend), node.opacity) };
            p.push_layer(clip.as_ref(), blend, opacity);
        }
        let blur = if clip_mode { None } else { node.layer_blur() };
        if let Some(radius) = blur {
            p.set_transform(transform);
            p.push_filter_layer(Effects::from_primitive(FilterPrimitive::GaussianBlur { std_deviation: radius / 2.0, edge_mode: EdgeMode::None }));
        }
        // Groups and frames cast the shadow of their composite (no spread); leaves draw theirs in `draw_leaf`.
        let group_shadows: Vec<Effects> = if mode == Mode::Normal && outline(&node.geometry).is_none() {
            node.effects.iter().filter_map(|e| match e {
                Effect::DropShadow { dx, dy, blur, color, .. } => {
                    Some(Effects::from_primitive(FilterPrimitive::DropShadow { dx: *dx, dy: *dy, std_deviation: blur / 2.0, color: self::color(*color), edge_mode: EdgeMode::None }))
                }
                _ => None,
            }).collect()
        } else {
            Vec::new()
        };
        for f in &group_shadows {
            p.set_transform(transform);
            p.push_filter_layer(f.clone());
        }
        if inside {
            // Background blur (frosted glass): what is behind the node, blurred, inside its outline.
            if mode == Mode::Normal && self.stop.is_none() {
                if let (Some(radius), Some(path)) = (node.effects.iter().find_map(|e| match e {
                    Effect::BackgroundBlur { radius } if *radius > 0.0 => Some(*radius),
                    _ => None,
                }), outline(&node.geometry))
                {
                    self.backdrop(p, id, transform, &path, radius);
                }
            }
            draw_leaf(p, self.scene, node, transform, mode);
        }
        self.children(p, self.scene.children(id), inside, mode, force);
        for _ in &group_shadows {
            p.pop_layer();
        }
        if blur.is_some() {
            p.pop_layer();
        }
        if layered {
            p.pop_layer();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{APPEND, IrWriter, group, leaf};

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
        fn push_filter_layer(&mut self, _filter: Effects) {
            self.calls.push("filter".into());
        }
        fn set_even_odd(&mut self, even_odd: bool) {
            if even_odd {
                self.calls.push("even-odd".into());
            }
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
        b.strokes = vec![StrokeStyle::new(1.0, Paint::Solid([9, 9, 9, 255]), 1, 0)];
        let mut img = leaf(4, ROOT, Geometry::Image { image: 1, w: 8.0, h: 8.0 }, Paint::None);
        img.transform = Affine::translate((200.0, 0.0));
        let missing = leaf(5, ROOT, Geometry::Image { image: 99, w: 8.0, h: 8.0 }, Paint::None);
        let mut hidden = leaf(6, ROOT, Geometry::Rect { w: 1.0, h: 1.0, radius: 0.0 }, Paint::Solid([0, 0, 0, 255]));
        hidden.visible = false;
        let glyphs = leaf(7, ROOT, Geometry::Glyphs(crate::ir::GlyphRun::new(0, 10.0, vec![(1, 0.0, 10.0)])), Paint::Solid([0, 0, 0, 255]));
        let font = std::fs::read(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fonts/NotoSans-Latin.wght.ttf")).unwrap();
        let mut run = crate::ir::GlyphRun::new(1, 10.0, vec![(40, 0.0, 10.0), (41, 6.0, 10.0)]);
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
        // glyph run with a retained font: one path (+ bold stroke); with an unknown font (7): transform only
        assert!(calls.ends_with("transform 0 0|transform 300 0|paint|fill-path|paint|stroke"), "glyph run: {calls}");
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
