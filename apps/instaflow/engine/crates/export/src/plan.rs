//! What each vector format draws from a raster patch (decision D21: the **per-feature rasterize list**), and the
//! patches themselves: a self-contained scene IR batch per node that the render module (Vello, the same compositor as
//! the canvas and PNG) renders headlessly; the writers embed the pixels where the node would be.
//!
//! The list is data, one row per (format, feature); a writer never asks which format it is.
//!
//! | Feature | SVG | PDF |
//! |---|---|---|
//! | drop shadow, inner shadow, layer blur | native filters | raster patch (PDF has no blur) |
//! | background blur (frosted glass) | native (the traversal redraws the backdrop under a blur filter) | raster patch |
//! | conic (sweep) gradient | pixel pattern (no conic gradient in SVG 1.1) | pixel pattern (PDF function shadings render unevenly) |
//!
//! Everything else — paths, rects, ellipses, every paint kind, stacked fills and strokes, dashes, clip, opacity,
//! blend modes, masks (clip, alpha, luminance, inverted), images, text — is vector in both.

use render::ir::{APPEND, Effect, Geometry, IrWriter, Node, Paint, ROOT, Scene};
use std::collections::{HashMap, HashSet};
use vello_common::kurbo::{Affine, BezPath, Rect};

use crate::record::PatchSite;

/// The vector formats (wire values in the Wasm ABI).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Format {
    Svg = 0,
    Pdf = 1,
}

impl Format {
    pub fn from_u8(v: u8) -> Option<Format> {
        match v {
            0 => Some(Format::Svg),
            1 => Some(Format::Pdf),
            _ => None,
        }
    }
}

/// IR features a format may not express natively.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Feature {
    DropShadow,
    InnerShadow,
    LayerBlur,
    BackgroundBlur,
    SweepGradient,
}

/// How a format draws a feature it cannot express as vectors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fallback {
    /// The whole node (and its subtree) becomes an image rendered by the render module.
    NodePatch,
    /// The paint becomes an image pattern computed by the writer (SVG conic gradients).
    PixelPattern,
}

/// D21: the rasterize list. A (format, feature) pair not listed is drawn natively.
pub const RASTERIZE: &[(Format, Feature, Fallback)] = &[
    (Format::Pdf, Feature::DropShadow, Fallback::NodePatch),
    (Format::Pdf, Feature::InnerShadow, Fallback::NodePatch),
    (Format::Pdf, Feature::LayerBlur, Fallback::NodePatch),
    (Format::Pdf, Feature::BackgroundBlur, Fallback::NodePatch),
    (Format::Svg, Feature::SweepGradient, Fallback::PixelPattern),
    (Format::Pdf, Feature::SweepGradient, Fallback::PixelPattern),
];

pub fn fallback(format: Format, feature: Feature) -> Option<Fallback> {
    RASTERIZE.iter().find(|(f, x, _)| *f == format && *x == feature).map(|(_, _, how)| *how)
}

fn features(node: &Node) -> impl Iterator<Item = Feature> + '_ {
    let effects = node.effects.iter().filter_map(|e| match e {
        Effect::DropShadow { .. } => Some(Feature::DropShadow),
        Effect::InnerShadow { .. } => Some(Feature::InnerShadow),
        Effect::LayerBlur { radius } if *radius > 0.0 => Some(Feature::LayerBlur),
        Effect::BackgroundBlur { radius } if *radius > 0.0 => Some(Feature::BackgroundBlur),
        _ => None,
    });
    let sweeps = node.fills.iter().map(|f| &f.paint).chain(node.strokes.iter().map(|s| &s.paint)).filter(|p| matches!(p, Paint::Sweep { .. })).map(|_| Feature::SweepGradient);
    effects.chain(sweeps)
}

/// One planned patch.
#[derive(Clone, Debug)]
pub struct Patch {
    pub node: u32,
    /// World rect the image covers (the node's subtree bounds, effects included).
    pub world: Rect,
    /// World-space outline the image is clipped to (background blur only), else None.
    pub clip: Option<BezPath>,
    /// The scene to render (a full batch: CLEAR, nodes, images, fonts).
    pub ir: Vec<u8>,
}

fn visible_in(scene: &Scene, id: u32, region: Rect) -> Option<Rect> {
    let b = scene.bounds_of(id)?;
    let i = b.intersect(region);
    (i.width() > 0.0 && i.height() > 0.0).then_some(b)
}

/// Patches `format` needs to draw `region` (world) of the scene at `scale` patch px per world px; `only`: a
/// selection export draws just these subtrees. Nested features are covered by their outermost patched ancestor.
/// Each patch's world rect is snapped outwards to the patch pixel grid, so its image is exactly
/// `world × scale` pixels and lands on whole output pixels.
pub fn plan(scene: &Scene, format: Format, region: Rect, only: Option<&HashSet<u32>>, scale: f64) -> Vec<Patch> {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let snap = |r: Rect| Rect::new((r.x0 * scale).floor() / scale, (r.y0 * scale).floor() / scale, (r.x1 * scale).ceil() / scale, (r.y1 * scale).ceil() / scale);
    let mut out = Vec::new();
    let mut walk = vec![(ROOT, only.is_none())];
    // Depth first, paint order (a patch's prefix scene depends on what was painted before it).
    let mut order = Vec::new();
    while let Some((id, inside)) = walk.pop() {
        for &child in scene.children(id).iter().rev() {
            let within = inside || only.is_some_and(|m| m.contains(&child));
            walk.push((child, within));
        }
        if id != ROOT {
            order.push((id, inside));
        }
    }
    let mut covered: HashSet<u32> = HashSet::new();
    for (id, inside) in order {
        let Some(node) = scene.node(id) else { continue };
        if covered.contains(&node.parent) {
            covered.insert(id);
            continue;
        }
        if !inside || !node.visible {
            continue;
        }
        let wants = features(node).filter(|f| fallback(format, *f) == Some(Fallback::NodePatch)).collect::<Vec<_>>();
        if wants.is_empty() {
            continue;
        }
        let Some(world) = visible_in(scene, id, region).map(snap) else { continue };
        covered.insert(id);
        let backdrop = wants.contains(&Feature::BackgroundBlur);
        let ir = if backdrop { prefix_ir(scene, id) } else { subtree_ir(scene, id) };
        // Frosted glass alone: the image is the backdrop inside the outline (the outline clips it).
        let only_backdrop = wants.iter().all(|f| *f == Feature::BackgroundBlur) && node.effects.iter().all(|e| matches!(e, Effect::BackgroundBlur { .. }));
        let clip = if backdrop && only_backdrop { render::draw::outline(&node.geometry).map(|p| scene.world_transform(id) * p) } else { None };
        out.push(Patch { node: id, world, clip, ir });
    }
    out
}

/// The sites the recorder replaces (node → where the image goes).
pub fn sites(patches: &[Patch]) -> HashMap<u32, PatchSite> {
    patches.iter().map(|p| (p.node, PatchSite { world: p.world, clip: p.clip.clone() })).collect()
}

fn resources(scene: &Scene, nodes: &[&Node], w: &mut IrWriter) {
    let mut images: HashSet<u32> = HashSet::new();
    let mut fonts: HashSet<u32> = HashSet::new();
    for n in nodes {
        if let Geometry::Image { image, .. } = n.geometry {
            images.insert(image);
        }
        if let Geometry::Glyphs(run) = &n.geometry {
            fonts.insert(run.font);
        }
        for p in n.fills.iter().map(|f| &f.paint).chain(n.strokes.iter().map(|s| &s.paint)) {
            if let Some(image) = p.image_id() {
                images.insert(image);
            }
        }
    }
    let mut images: Vec<u32> = images.into_iter().collect();
    images.sort_unstable();
    for id in images {
        if let Some(px) = scene.image(id) {
            w.image(id, px.width() as u32, px.height() as u32, &straight(px));
        }
    }
    let mut fonts: Vec<u32> = fonts.into_iter().collect();
    fonts.sort_unstable();
    for id in fonts {
        if let (Some(hash), Some(face)) = (scene.font_hash(id), scene.font(id)) {
            w.font(id, hash, face.data.data());
        }
    }
}

/// Straight-alpha RGBA of a retained pixmap (pixmaps are premultiplied; the IR carries straight alpha).
pub fn straight(px: &vello_common::pixmap::Pixmap) -> Vec<u8> {
    let mut out = px.data_as_u8_slice().to_vec();
    vello_common::pixmap::unpremultiply_rgba8(&mut out);
    out
}

/// The node and its subtree alone, at its world transform (ancestors' clips and opacity stay with the vector
/// layers around the patch).
pub fn subtree_ir(scene: &Scene, id: u32) -> Vec<u8> {
    let mut nodes: Vec<Node> = Vec::new();
    let Some(top) = scene.node(id) else { return IrWriter::new().finish() };
    let mut root = top.clone();
    root.parent = ROOT;
    root.transform = scene.world_transform(id);
    nodes.push(root);
    let mut stack: Vec<u32> = scene.children(id).iter().rev().copied().collect();
    while let Some(c) = stack.pop() {
        if let Some(n) = scene.node(c) {
            nodes.push(n.clone());
            stack.extend(scene.children(c).iter().rev().copied());
        }
    }
    let mut w = IrWriter::new();
    w.clear();
    let refs: Vec<&Node> = nodes.iter().collect();
    resources(scene, &refs, &mut w);
    for n in &nodes {
        w.upsert(n, APPEND);
    }
    w.finish()
}

/// Everything painted up to and including the node's subtree (later nodes hidden): what a background blur needs.
pub fn prefix_ir(scene: &Scene, id: u32) -> Vec<u8> {
    // Paint order: pre-order, children after their parent.
    let mut order: Vec<u32> = Vec::new();
    let mut stack: Vec<u32> = scene.children(ROOT).iter().rev().copied().collect();
    while let Some(c) = stack.pop() {
        order.push(c);
        stack.extend(scene.children(c).iter().rev().copied());
    }
    let mut subtree: HashSet<u32> = HashSet::new();
    let mut s = vec![id];
    while let Some(c) = s.pop() {
        subtree.insert(c);
        s.extend(scene.children(c).iter().copied());
    }
    let mut ancestors: HashSet<u32> = HashSet::new();
    let mut at = scene.node(id).map_or(ROOT, |n| n.parent);
    while at != ROOT {
        ancestors.insert(at);
        at = scene.node(at).map_or(ROOT, |n| n.parent);
    }
    let end = order.iter().rposition(|n| subtree.contains(n)).unwrap_or(0);
    let mut nodes: Vec<Node> = Vec::new();
    for (i, n) in order.iter().enumerate() {
        let Some(node) = scene.node(*n) else { continue };
        let mut node = node.clone();
        // After the node's subtree: hidden (ancestors stay: they hold it).
        if i > end && !ancestors.contains(n) {
            node.visible = false;
        }
        nodes.push(node);
    }
    let mut w = IrWriter::new();
    w.clear();
    let refs: Vec<&Node> = nodes.iter().filter(|n| n.visible).collect();
    resources(scene, &refs, &mut w);
    for n in &nodes {
        w.upsert(n, APPEND);
    }
    w.finish()
}

/// Pixel size of a patch at `scale` (its world rect is on the grid, so this is exact).
pub fn patch_size(world: Rect, scale: f64) -> (u32, u32) {
    (((world.width() * scale).round() as u32).max(1), ((world.height() * scale).round() as u32).max(1))
}

/// Encode a plan for the Wasm ABI: `count:u32 (node:u32 x0 y0 x1 y1:f64 len:u32 ir[len])*`.
pub fn encode(patches: &[Patch]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(patches.len() as u32).to_le_bytes());
    for p in patches {
        out.extend_from_slice(&p.node.to_le_bytes());
        for v in [p.world.x0, p.world.y0, p.world.x1, p.world.y1] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&(p.ir.len() as u32).to_le_bytes());
        out.extend_from_slice(&p.ir);
    }
    out
}

/// Only these subtrees and the ancestors that hold them: a selection export as its own scene (a full batch).
/// Ancestors keep their transform, clip, opacity and blend but draw nothing themselves; mask siblings that mask a
/// member are kept (they are part of how it looks).
pub fn isolate_ir(scene: &Scene, members: &HashSet<u32>) -> Vec<u8> {
    let mut keep: HashSet<u32> = HashSet::new();
    let mut holders: HashSet<u32> = HashSet::new();
    for &m in members {
        let mut s = vec![m];
        if scene.node(m).is_none() {
            continue;
        }
        while let Some(c) = s.pop() {
            keep.insert(c);
            s.extend(scene.children(c).iter().copied());
        }
        let mut at = scene.node(m).map_or(ROOT, |n| n.parent);
        while at != ROOT {
            holders.insert(at);
            at = scene.node(at).map_or(ROOT, |n| n.parent);
        }
    }
    // Masks before a kept sibling.
    let mut masks: HashSet<u32> = HashSet::new();
    for parent in std::iter::once(ROOT).chain(holders.iter().copied()) {
        let kids = scene.children(parent);
        for (i, k) in kids.iter().enumerate() {
            let is_mask = scene.node(*k).is_some_and(|n| n.mask & !render::ir::mask::INVERT != render::ir::mask::NONE);
            if is_mask && kids[i + 1..].iter().any(|s| keep.contains(s) || holders.contains(s)) {
                let mut s = vec![*k];
                while let Some(c) = s.pop() {
                    masks.insert(c);
                    s.extend(scene.children(c).iter().copied());
                }
            }
        }
    }
    let mut nodes: Vec<Node> = Vec::new();
    let mut stack: Vec<u32> = scene.children(ROOT).iter().rev().copied().collect();
    while let Some(c) = stack.pop() {
        let Some(node) = scene.node(c) else { continue };
        if keep.contains(&c) || masks.contains(&c) {
            nodes.push(node.clone());
        } else if holders.contains(&c) {
            let mut g = node.clone();
            g.geometry = Geometry::Group;
            g.fills.clear();
            g.strokes.clear();
            g.effects.clear();
            g.mask = render::ir::mask::NONE;
            nodes.push(g);
        } else {
            continue;
        }
        stack.extend(scene.children(c).iter().rev().copied());
    }
    let mut w = IrWriter::new();
    w.clear();
    let refs: Vec<&Node> = nodes.iter().collect();
    resources(scene, &refs, &mut w);
    for n in &nodes {
        w.upsert(n, APPEND);
    }
    w.finish()
}

/// World bounds of what a selection export draws.
pub fn members_bounds(scene: &Scene, members: &HashSet<u32>) -> Option<Rect> {
    members.iter().filter_map(|m| scene.bounds_of(*m)).reduce(|a, b| a.union(b))
}

/// `true` when an affine has no inverse (a zero scale): such nodes draw nothing.
pub fn degenerate(t: &Affine) -> bool {
    t.determinant().abs() < 1e-12
}

#[cfg(test)]
mod tests {
    use super::*;
    use render::ir::{Clip, leaf, group, mask};

    fn scene(nodes: &[Node]) -> Scene {
        let mut w = IrWriter::new();
        w.image(9, 1, 1, &[1, 2, 3, 255]);
        for n in nodes {
            w.upsert(n, APPEND);
        }
        let mut s = Scene::new();
        s.apply(&w.finish()).unwrap();
        s
    }

    fn rect(id: u32, parent: u32, x: f64) -> Node {
        let mut n = leaf(id, parent, Geometry::Rect { w: 10.0, h: 10.0, radius: 0.0 }, Paint::Solid([200, 0, 0, 255]));
        n.transform = Affine::translate((x, 0.0));
        n
    }

    #[test]
    fn the_rasterize_list_is_per_format() {
        assert_eq!(fallback(Format::Pdf, Feature::DropShadow), Some(Fallback::NodePatch));
        assert_eq!(fallback(Format::Svg, Feature::DropShadow), None);
        assert_eq!(fallback(Format::Svg, Feature::SweepGradient), Some(Fallback::PixelPattern));
        assert_eq!(fallback(Format::Pdf, Feature::SweepGradient), Some(Fallback::PixelPattern));
        assert_eq!(fallback(Format::Svg, Feature::BackgroundBlur), None);
        assert_eq!(fallback(Format::Pdf, Feature::BackgroundBlur), Some(Fallback::NodePatch));
        assert_eq!(Format::from_u8(1), Some(Format::Pdf));
        assert_eq!(Format::from_u8(7), None);
    }

    #[test]
    fn plans_outermost_patches_with_self_contained_scenes() {
        let mut g = group(1, ROOT);
        g.transform = Affine::translate((100.0, 0.0));
        g.effects = vec![Effect::LayerBlur { radius: 3.0 }];
        let mut child = rect(2, 1, 0.0);
        child.effects = vec![Effect::DropShadow { dx: 1.0, dy: 1.0, blur: 2.0, spread: 0.0, color: [0, 0, 0, 255] }];
        child.fills.push(render::ir::FillStyle::of(Paint::Image(9, 0)));
        let mut frosted = rect(3, ROOT, 0.0);
        frosted.effects = vec![Effect::BackgroundBlur { radius: 4.0 }];
        let later = rect(4, ROOT, 0.0);
        let s = scene(&[g, child, frosted, later]);
        let everywhere = Rect::new(-1e6, -1e6, 1e6, 1e6);
        let pdf = plan(&s, Format::Pdf, everywhere, None, 2.0);
        assert_eq!(pdf.iter().map(|p| p.node).collect::<Vec<_>>(), vec![1, 3], "the child is covered by its group");
        let mut sub = Scene::new();
        sub.apply(&pdf[0].ir).unwrap();
        assert_eq!(sub.len(), 2);
        assert_eq!(sub.world_transform(1), Affine::translate((100.0, 0.0)));
        assert!(sub.image(9).is_some(), "images travel with the patch");
        // background blur: everything before is visible, later nodes are hidden, the outline clips the image
        let mut prefix = Scene::new();
        prefix.apply(&pdf[1].ir).unwrap();
        assert!(prefix.node(1).unwrap().visible && !prefix.node(4).unwrap().visible);
        assert!(pdf[1].clip.is_some());
        // SVG draws every effect natively; a region away from a node skips it
        assert!(plan(&s, Format::Svg, everywhere, None, 2.0).is_empty());
        assert!(plan(&s, Format::Pdf, Rect::new(500.0, 500.0, 600.0, 600.0), None, 2.0).is_empty());
        let only: HashSet<u32> = [4].into();
        assert!(plan(&s, Format::Pdf, everywhere, Some(&only), 2.0).is_empty());
        for p in &pdf {
            let (w, h) = patch_size(p.world, 2.0);
            assert!(((p.world.width() * 2.0) - w as f64).abs() < 1e-9 && ((p.world.height() * 2.0) - h as f64).abs() < 1e-9, "snapped: {:?}", p.world);
        }
        let bytes = encode(&pdf);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 2);
    }

    #[test]
    fn isolates_a_selection_with_its_holders_and_masks() {
        let mut frame = group(1, ROOT);
        frame.clip = Clip::Rect(Rect::new(0.0, 0.0, 50.0, 50.0));
        frame.fills.push(render::ir::FillStyle::of(Paint::Solid([0, 0, 0, 255])));
        let mut m = rect(2, 1, 0.0);
        m.mask = mask::CLIP;
        let a = rect(3, 1, 0.0);
        let b = rect(4, 1, 20.0);
        let other = rect(5, ROOT, 0.0);
        let s = scene(&[frame, m, a, b, other]);
        let only: HashSet<u32> = [3].into();
        let mut iso = Scene::new();
        iso.apply(&isolate_ir(&s, &only)).unwrap();
        assert_eq!(iso.children(ROOT), &[1]);
        assert_eq!(iso.children(1), &[2, 3], "the mask before the member stays, the sibling after it goes");
        let holder = iso.node(1).unwrap();
        assert!(holder.fills.is_empty() && holder.clip != Clip::None);
        assert_eq!(members_bounds(&s, &only), s.bounds_of(3));
        assert!(degenerate(&Affine::scale(0.0)) && !degenerate(&Affine::IDENTITY));
    }
}
