//! The render crate's one traversal (`render::draw::draw_scene`) recorded into a **display list** for the vector
//! writers (IF-7.10: every IR feature goes through the same code that draws the canvas, so the SVG and PDF writers
//! never interpret the IR themselves and cannot drift from the renderer).
//!
//! The list is a tree of items in output coordinates (each carries its full transform: rotation, scale, **skew and
//! flips** are just the matrix). Layers keep the transform they were pushed at (their clip and filter live in that
//! space). The traversal draws a mask as an isolated layer whose last child composites the mask with `DestIn`
//! (`DestOut` when inverted); the recorder folds that pair into one `Masked` item, which both formats have natively
//! (SVG `<mask>`, PDF soft masks).
//!
//! Nodes listed in the patch plan (`plan.rs`) are not traversed: the recorder emits a `Patch` (a raster image of the
//! node, rendered by the render module) in their place.

use render::draw::{Filter as Only, Painter, draw_scene};
use render::ir::{GlyphRun, Node, Scene};
use std::collections::{HashMap, HashSet};
use vello_common::filter_effects::Filter;
use vello_common::kurbo::{Affine, BezPath, Rect, Shape, Stroke};
use vello_common::paint::{ImageId, ImageSource, PaintType};
use vello_common::peniko::{BlendMode, Compose, Mix};

/// How an item is painted: its transform (local → output), the paint and the paint's own transform (gradient and
/// image coordinates → local).
#[derive(Clone, Debug)]
pub struct Draw {
    pub transform: Affine,
    pub paint: PaintType,
    pub paint_transform: Affine,
}

#[derive(Clone, Debug)]
pub enum Item {
    Fill { draw: Draw, path: BezPath, even_odd: bool },
    Stroke { draw: Draw, path: BezPath, stroke: Stroke },
    /// A glyph run: `outline` is its local-space path (what raster backends fill); `run` keeps glyph ids, font and
    /// text for formats with real text.
    Glyphs { draw: Draw, run: GlyphRun, outline: BezPath },
    Layer(Layer),
    /// `content` multiplied by the alpha of `mask` (or by 1 − alpha when `invert`).
    Masked { content: Vec<Item>, mask: Vec<Item>, invert: bool },
    /// A node drawn from a raster patch: `world` is the node's world rect the image covers, `view` maps world →
    /// output, `clip` (world space) bounds the image when set.
    Patch { node: u32, world: Rect, view: Affine, clip: Option<BezPath> },
}

#[derive(Clone, Debug)]
pub struct Layer {
    /// Output transform the clip and the filter are expressed in.
    pub transform: Affine,
    pub clip: Option<BezPath>,
    pub blend: Mix,
    pub opacity: f32,
    pub filter: Option<Filter>,
    pub items: Vec<Item>,
}

/// One node to draw from a raster patch (from the plan).
#[derive(Clone, Debug)]
pub struct PatchSite {
    pub world: Rect,
    pub clip: Option<BezPath>,
}

struct Open {
    transform: Affine,
    clip: Option<BezPath>,
    blend: BlendMode,
    opacity: f32,
    filter: Option<Filter>,
    items: Vec<Item>,
}

/// Records painter calls (see the module header).
pub struct Recorder<'a> {
    scene: &'a Scene,
    view: Affine,
    patches: &'a HashMap<u32, PatchSite>,
    transform: Affine,
    paint: PaintType,
    paint_transform: Affine,
    even_odd: bool,
    stack: Vec<Open>,
}

/// A layer the traversal pushed with `DestIn` / `DestOut`: the mask of its parent layer.
const MASK_MARK: f32 = -1.0;

impl<'a> Recorder<'a> {
    pub fn new(scene: &'a Scene, view: Affine, patches: &'a HashMap<u32, PatchSite>) -> Self {
        let root = Open { transform: Affine::IDENTITY, clip: None, blend: BlendMode::default(), opacity: 1.0, filter: None, items: Vec::new() };
        Recorder {
            scene,
            view,
            patches,
            transform: Affine::IDENTITY,
            paint: PaintType::Solid(vello_common::color::palette::css::BLACK),
            paint_transform: Affine::IDENTITY,
            even_odd: false,
            stack: vec![root],
        }
    }

    fn draw(&self) -> Draw {
        Draw { transform: self.transform, paint: self.paint.clone(), paint_transform: self.paint_transform }
    }

    fn push(&mut self, item: Item) {
        self.stack.last_mut().expect("root layer").items.push(item);
    }

    /// The recorded display list (the root layer's items).
    pub fn finish(mut self) -> Vec<Item> {
        while self.stack.len() > 1 {
            self.pop_layer();
        }
        self.stack.pop().map(|r| r.items).unwrap_or_default()
    }
}

/// A layer that only composites its mask: `compose` decides (DestIn keeps, DestOut removes).
fn mask_compose(blend: BlendMode) -> Option<bool> {
    match blend.compose {
        Compose::DestIn => Some(false),
        Compose::DestOut => Some(true),
        _ => None,
    }
}

impl Painter for Recorder<'_> {
    fn set_transform(&mut self, t: Affine) {
        self.transform = t;
    }
    fn set_paint_transform(&mut self, t: Affine) {
        self.paint_transform = t;
    }
    fn reset_paint_transform(&mut self) {
        self.paint_transform = Affine::IDENTITY;
    }
    fn set_paint(&mut self, paint: PaintType) {
        self.paint = paint;
    }
    fn image_source(&self, image: u32) -> Option<(ImageSource, u32, u32)> {
        let pixmap = self.scene.image(image)?;
        Some((ImageSource::OpaqueId { id: ImageId::new(image), may_have_transparency: true }, pixmap.width() as u32, pixmap.height() as u32))
    }
    fn fill_path(&mut self, path: &BezPath) {
        let item = Item::Fill { draw: self.draw(), path: path.clone(), even_odd: self.even_odd };
        self.push(item);
    }
    fn fill_rect(&mut self, rect: &Rect) {
        let item = Item::Fill { draw: self.draw(), path: rect.to_path(0.1), even_odd: false };
        self.push(item);
    }
    fn stroke_path(&mut self, path: &BezPath, stroke: &Stroke) {
        let item = Item::Stroke { draw: self.draw(), path: path.clone(), stroke: stroke.clone() };
        self.push(item);
    }
    fn fill_glyphs(&mut self, run: &GlyphRun, outline: &BezPath) {
        let item = Item::Glyphs { draw: self.draw(), run: run.clone(), outline: outline.clone() };
        self.push(item);
    }
    fn push_layer(&mut self, clip: Option<&BezPath>, blend: BlendMode, opacity: f32) {
        let opacity = if mask_compose(blend).is_some() { MASK_MARK } else { opacity };
        self.stack.push(Open { transform: self.transform, clip: clip.cloned(), blend, opacity, filter: None, items: Vec::new() });
    }
    fn push_filter_layer(&mut self, filter: Filter) {
        self.stack.push(Open { transform: self.transform, clip: None, blend: BlendMode::default(), opacity: 1.0, filter: Some(filter), items: Vec::new() });
    }
    fn pop_layer(&mut self) {
        if self.stack.len() <= 1 {
            return;
        }
        let open = self.stack.pop().expect("open layer");
        if open.opacity == MASK_MARK {
            // The mask of the parent layer: the parent's items so far are what it masks.
            let invert = mask_compose(open.blend).unwrap_or(false);
            let parent = self.stack.last_mut().expect("parent layer");
            let content = std::mem::take(&mut parent.items);
            parent.items.push(Item::Masked { content, mask: open.items, invert });
            return;
        }
        let layer = Layer { transform: open.transform, clip: open.clip, blend: open.blend.mix, opacity: open.opacity, filter: open.filter, items: open.items };
        // A plain layer around a single masked run adds nothing: keep the masked item.
        let plain = layer.clip.is_none() && layer.blend == Mix::Normal && layer.opacity >= 1.0 && layer.filter.is_none();
        if plain && layer.items.len() == 1 && matches!(layer.items[0], Item::Masked { .. }) {
            let item = layer.items.into_iter().next().expect("one item");
            self.push(item);
            return;
        }
        self.push(Item::Layer(layer));
    }
    fn set_even_odd(&mut self, even_odd: bool) {
        self.even_odd = even_odd;
    }
    fn replace_node(&mut self, node: &Node, _transform: Affine) -> bool {
        let Some(site) = self.patches.get(&node.id) else { return false };
        let item = Item::Patch { node: node.id, world: site.world, view: self.view, clip: site.clip.clone() };
        self.push(item);
        true
    }
}

/// Record the scene as seen through `view` (world → output), culled to `cull` (output space); `only`: draw just
/// these subtrees (a selection export), inside their ancestors' clips and opacity.
pub fn record(scene: &Scene, view: Affine, cull: Rect, only: Option<&HashSet<u32>>, patches: &HashMap<u32, PatchSite>) -> Vec<Item> {
    let mut recorder = Recorder::new(scene, view, patches);
    let none = HashSet::new();
    let filter = match only {
        Some(members) => Only::Only(members),
        None => Only::Except(&none),
    };
    draw_scene(&mut recorder, scene, view, cull, &filter);
    recorder.finish()
}

/// Output-space bounds of what an item draws (strokes and filters grown conservatively; None: draws nothing).
pub fn bounds(item: &Item) -> Option<Rect> {
    match item {
        Item::Fill { draw, path, .. } | Item::Glyphs { draw, outline: path, .. } => nonempty(draw.transform.transform_rect_bbox(path.bounding_box())),
        Item::Stroke { draw, path, stroke } => {
            let pad = stroke.width * stroke.miter_limit.max(1.0) * 0.5 + 1.0;
            nonempty(draw.transform.transform_rect_bbox(path.bounding_box().inflate(pad, pad)))
        }
        Item::Layer(layer) => {
            let inner = union(layer.items.iter().filter_map(bounds))?;
            let grown = match &layer.filter {
                Some(f) => {
                    let e = f.filter_expansion(&layer.transform);
                    Rect::new(inner.x0 + e.x0.min(0.0), inner.y0 + e.y0.min(0.0), inner.x1 + e.x1.max(0.0), inner.y1 + e.y1.max(0.0))
                }
                None => inner,
            };
            match &layer.clip {
                Some(clip) => nonempty(grown.intersect(layer.transform.transform_rect_bbox(clip.bounding_box()))),
                None => Some(grown),
            }
        }
        Item::Masked { content, mask, invert } => {
            let c = union(content.iter().filter_map(bounds))?;
            if *invert { Some(c) } else { nonempty(c.intersect(union(mask.iter().filter_map(bounds))?)) }
        }
        Item::Patch { world, view, .. } => nonempty(view.transform_rect_bbox(*world)),
    }
}

fn nonempty(r: Rect) -> Option<Rect> {
    (r.width() > 0.0 && r.height() > 0.0).then_some(r)
}

pub fn union(rects: impl Iterator<Item = Rect>) -> Option<Rect> {
    rects.reduce(|a, b| a.union(b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use render::ir::{APPEND, Clip, Effect, Geometry, IrWriter, Paint, ROOT, group, leaf, mask};

    fn scene(nodes: &[Node]) -> Scene {
        let mut w = IrWriter::new();
        for n in nodes {
            w.upsert(n, APPEND);
        }
        let mut s = Scene::new();
        s.apply(&w.finish()).unwrap();
        s
    }

    fn everything() -> Rect {
        Rect::new(-1e9, -1e9, 1e9, 1e9)
    }

    #[test]
    fn records_fills_strokes_layers_with_full_matrices() {
        let mut g = group(1, ROOT);
        g.opacity = 0.5;
        g.clip = Clip::Rect(Rect::new(0.0, 0.0, 50.0, 50.0));
        let mut r = leaf(2, 1, Geometry::Rect { w: 10.0, h: 10.0, radius: 2.0 }, Paint::Solid([255, 0, 0, 255]));
        // skew and a horizontal flip are just the matrix
        r.transform = Affine::new([-1.0, 0.0, 0.3, 1.0, 20.0, 5.0]);
        r.strokes = vec![render::ir::StrokeStyle::new(2.0, Paint::Solid([0, 0, 0, 255]), 1, 0)];
        let s = scene(&[g, r]);
        let items = record(&s, Affine::translate((-1.0, 0.0)), everything(), None, &HashMap::new());
        assert_eq!(items.len(), 1);
        let Item::Layer(layer) = &items[0] else { panic!("layer expected: {items:?}") };
        assert_eq!(layer.opacity, 0.5);
        assert!(layer.clip.is_some());
        assert_eq!(layer.items.len(), 2);
        let Item::Fill { draw, .. } = &layer.items[0] else { panic!("fill") };
        assert_eq!(draw.transform.as_coeffs(), [-1.0, 0.0, 0.3, 1.0, 19.0, 5.0]);
        assert!(matches!(layer.items[1], Item::Stroke { .. }));
        assert!(bounds(&items[0]).is_some());
    }

    #[test]
    fn folds_mask_runs_into_masked_items() {
        let mut m = leaf(1, ROOT, Geometry::Ellipse { w: 10.0, h: 10.0 }, Paint::Solid([0, 0, 0, 255]));
        m.mask = mask::ALPHA | mask::INVERT;
        let a = leaf(2, ROOT, Geometry::Rect { w: 20.0, h: 20.0, radius: 0.0 }, Paint::Solid([0, 255, 0, 255]));
        let s = scene(&[m, a]);
        let items = record(&s, Affine::IDENTITY, everything(), None, &HashMap::new());
        assert_eq!(items.len(), 1, "{items:?}");
        let Item::Masked { content, mask, invert } = &items[0] else { panic!("masked expected: {items:?}") };
        assert!(*invert);
        assert_eq!(content.len(), 1);
        assert_eq!(mask.len(), 1);
    }

    #[test]
    fn patches_replace_planned_nodes_and_only_draws_a_selection() {
        let mut shadowed = leaf(1, ROOT, Geometry::Rect { w: 10.0, h: 10.0, radius: 0.0 }, Paint::Solid([0, 0, 255, 255]));
        shadowed.effects = vec![Effect::DropShadow { dx: 2.0, dy: 2.0, blur: 4.0, spread: 0.0, color: [0, 0, 0, 128] }];
        let mut other = leaf(2, ROOT, Geometry::Ellipse { w: 5.0, h: 5.0 }, Paint::Solid([0, 0, 0, 255]));
        other.transform = Affine::translate((30.0, 0.0));
        let s = scene(&[shadowed, other]);
        let mut plan = HashMap::new();
        plan.insert(1, PatchSite { world: s.bounds_of(1).unwrap(), clip: None });
        let items = record(&s, Affine::IDENTITY, everything(), None, &plan);
        assert!(matches!(items[0], Item::Patch { node: 1, .. }));
        assert!(matches!(items[1], Item::Fill { .. }));
        let only: HashSet<u32> = [2].into();
        let selected = record(&s, Affine::IDENTITY, everything(), Some(&only), &HashMap::new());
        assert_eq!(selected.len(), 1);
        // without a plan the shadow is a filter layer
        let plain = record(&s, Affine::IDENTITY, everything(), None, &HashMap::new());
        assert!(matches!(&plain[0], Item::Layer(l) if l.filter.is_some()));
    }
}
