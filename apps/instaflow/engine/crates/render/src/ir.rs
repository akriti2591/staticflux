//! Scene IR (IF-7.10): the retained, CPU-side scene every render backend draws from.
//!
//! The editor sends **batches** (snapshot or delta) in a small binary format; the scene keeps the
//! node tree, world transforms, world bounds and image pixels, so a GPU device loss rebuilds every
//! texture from here without touching the document (IF-7.11).
//!
//! # Wire format (version 1, little-endian)
//!
//! ```text
//! batch   = "SFIR" version:u16 reserved:u16 op_count:u32 op*
//! op      = CLEAR(1)
//!         | UPSERT(2) id:u32 parent:u32 index:u32 transform:f64×6 opacity:f32 blend:u8 flags:u8
//!                     clip geometry fill:paint stroke
//!         | REMOVE(3) id:u32                         (the node and its subtree)
//!         | IMAGE(4)  image:u32 width:u32 height:u32 alpha:u8 rgba8[width·height·4]
//!         | DROP_IMAGE(5) image:u32
//! clip     = NONE(0) | RECT(1) x0 y0 x1 y1:f64 | ROUNDED(2) x0 y0 x1 y1 radius:f64 | PATH(3) path
//! geometry = GROUP(0) | RECT(1) w h radius:f64 | ELLIPSE(2) w h:f64 | PATH(3) path
//!          | IMAGE(4) image:u32 w h:f64 | GLYPHS(5) font:u32 size:f32 count:u32 (glyph:u32 x:f32 y:f32)*
//! path     = verbs:u32 verb:u8* points:u32 (x:f64 y:f64)*     verbs: move 0, line 1, quad 2, cubic 3, close 4
//! paint    = NONE(0) | SOLID(1) rgba8 | LINEAR(2) x0 y0 x1 y1:f64 stops | RADIAL(3) cx cy r:f64 stops | IMAGE(4) image:u32
//! stops    = count:u8 (offset:f32 rgba8)*
//! stroke   = width:f32 [paint join:u8 cap:u8 when width > 0]
//! ```
//!
//! `parent` 0 is the root; `index` is the position among the parent's children (`u32::MAX` appends).
//! `flags` bit 0 = visible. Colors are straight-alpha sRGB. Image paint maps the image onto the
//! shape's `w × h` box. `blend` is a `peniko::Mix` value (0 normal … 15 luminosity).
//! Every geometry, paint and clip kind must be handled by every backend (exhaustive matches).

use std::collections::HashMap;
use std::sync::Arc;
use vello_common::kurbo::{Affine, BezPath, Point, Rect, Shape};
use vello_common::peniko::ImageAlphaType;
use vello_common::pixmap::{PixelMetadata, Pixmap};

pub const MAGIC: [u8; 4] = *b"SFIR";
pub const VERSION: u16 = 1;
pub const ROOT: u32 = 0;
pub const APPEND: u32 = u32::MAX;

pub mod op {
    pub const CLEAR: u8 = 1;
    pub const UPSERT: u8 = 2;
    pub const REMOVE: u8 = 3;
    pub const IMAGE: u8 = 4;
    pub const DROP_IMAGE: u8 = 5;
}

pub type Rgba8 = [u8; 4];

#[derive(Clone, Debug, PartialEq)]
pub struct GlyphRun {
    pub font: u32,
    pub size: f32,
    pub glyphs: Vec<(u32, f32, f32)>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Geometry {
    Group,
    Rect { w: f64, h: f64, radius: f64 },
    Ellipse { w: f64, h: f64 },
    Path(BezPath),
    Image { image: u32, w: f64, h: f64 },
    /// Positioned glyphs from the authoring module (B2). Drawn as nothing until fonts land.
    Glyphs(GlyphRun),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    None,
    Solid(Rgba8),
    Linear { start: Point, end: Point, stops: Vec<(f32, Rgba8)> },
    Radial { center: Point, radius: f64, stops: Vec<(f32, Rgba8)> },
    Image(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Clip {
    None,
    Rect(Rect),
    Rounded(Rect, f64),
    Path(BezPath),
}

impl Clip {
    pub fn path(&self) -> Option<BezPath> {
        match self {
            Clip::None => None,
            Clip::Rect(r) => Some(r.to_path(0.1)),
            Clip::Rounded(r, radius) => Some(r.to_rounded_rect(*radius).to_path(0.1)),
            Clip::Path(p) => Some(p.clone()),
        }
    }

    fn bounds(&self) -> Option<Rect> {
        match self {
            Clip::None => None,
            Clip::Rect(r) | Clip::Rounded(r, _) => Some(*r),
            Clip::Path(p) => Some(p.bounding_box()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StrokeStyle {
    pub width: f64,
    pub paint: Paint,
    /// 0 bevel, 1 miter, 2 round.
    pub join: u8,
    /// 0 butt, 1 square, 2 round.
    pub cap: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: u32,
    pub parent: u32,
    pub transform: Affine,
    pub opacity: f32,
    pub blend: u8,
    pub visible: bool,
    pub clip: Clip,
    pub geometry: Geometry,
    pub fill: Paint,
    pub stroke: Option<StrokeStyle>,
}

impl Node {
    /// True when drawing needs its own layer (clip, opacity or a non-normal blend).
    pub fn needs_layer(&self) -> bool {
        self.clip != Clip::None || self.opacity < 1.0 || self.blend != 0
    }

    /// Local-space bounds of the geometry itself, stroke included (None for groups).
    pub fn local_bounds(&self) -> Option<Rect> {
        let base = match &self.geometry {
            Geometry::Group => return None,
            Geometry::Rect { w, h, .. } | Geometry::Ellipse { w, h } | Geometry::Image { w, h, .. } => Rect::new(0.0, 0.0, *w, *h),
            Geometry::Path(p) => p.bounding_box(),
            Geometry::Glyphs(run) => {
                let mut r: Option<Rect> = None;
                let s = run.size as f64;
                for &(_, x, y) in &run.glyphs {
                    let g = Rect::new(x as f64, y as f64 - s, x as f64 + s, y as f64 + s * 0.3);
                    r = Some(r.map_or(g, |a| a.union(g)));
                }
                r?
            }
        };
        let pad = self.stroke.as_ref().map_or(0.0, |s| s.width);
        Some(base.inflate(pad, pad))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct IrError(pub String);

impl std::fmt::Display for IrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn fail<T>(msg: impl Into<String>) -> Result<T, IrError> {
    Err(IrError(msg.into()))
}

// ---------------------------------------------------------------- reader

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], IrError> {
        if self.pos + n > self.buf.len() {
            return fail(format!("truncated batch at byte {} (need {n} more)", self.pos));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, IrError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, IrError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, IrError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, IrError> {
        let v = f32::from_le_bytes(self.take(4)?.try_into().unwrap());
        if v.is_finite() { Ok(v) } else { fail("non-finite f32") }
    }
    fn f64(&mut self) -> Result<f64, IrError> {
        let v = f64::from_le_bytes(self.take(8)?.try_into().unwrap());
        if v.is_finite() { Ok(v) } else { fail("non-finite f64") }
    }
    fn rgba(&mut self) -> Result<Rgba8, IrError> {
        Ok(self.take(4)?.try_into().unwrap())
    }
    fn rect(&mut self) -> Result<Rect, IrError> {
        Ok(Rect::new(self.f64()?, self.f64()?, self.f64()?, self.f64()?))
    }
    fn path(&mut self) -> Result<BezPath, IrError> {
        let verbs = self.u32()? as usize;
        let verb_bytes = self.take(verbs)?.to_vec();
        let count = self.u32()? as usize;
        let mut pts = Vec::with_capacity(count.min(1 << 20));
        for _ in 0..count {
            pts.push(Point::new(self.f64()?, self.f64()?));
        }
        let mut path = BezPath::new();
        let mut i = 0usize;
        let need = |n: usize, i: &mut usize| -> Result<usize, IrError> {
            if *i + n > pts.len() {
                return fail("path verbs use more points than given");
            }
            let at = *i;
            *i += n;
            Ok(at)
        };
        for v in verb_bytes {
            match v {
                0 => {
                    let a = need(1, &mut i)?;
                    path.move_to(pts[a]);
                }
                1 => {
                    let a = need(1, &mut i)?;
                    path.line_to(pts[a]);
                }
                2 => {
                    let a = need(2, &mut i)?;
                    path.quad_to(pts[a], pts[a + 1]);
                }
                3 => {
                    let a = need(3, &mut i)?;
                    path.curve_to(pts[a], pts[a + 1], pts[a + 2]);
                }
                4 => path.close_path(),
                other => return fail(format!("unknown path verb {other}")),
            }
        }
        if i != pts.len() {
            return fail("path has unused points");
        }
        Ok(path)
    }
    fn stops(&mut self) -> Result<Vec<(f32, Rgba8)>, IrError> {
        let n = self.u8()? as usize;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push((self.f32()?, self.rgba()?));
        }
        Ok(out)
    }
    fn paint(&mut self) -> Result<Paint, IrError> {
        Ok(match self.u8()? {
            0 => Paint::None,
            1 => Paint::Solid(self.rgba()?),
            2 => Paint::Linear { start: Point::new(self.f64()?, self.f64()?), end: Point::new(self.f64()?, self.f64()?), stops: self.stops()? },
            3 => Paint::Radial { center: Point::new(self.f64()?, self.f64()?), radius: self.f64()?, stops: self.stops()? },
            4 => Paint::Image(self.u32()?),
            other => return fail(format!("unknown paint kind {other}")),
        })
    }
    fn clip(&mut self) -> Result<Clip, IrError> {
        Ok(match self.u8()? {
            0 => Clip::None,
            1 => Clip::Rect(self.rect()?),
            2 => Clip::Rounded(self.rect()?, self.f64()?),
            3 => Clip::Path(self.path()?),
            other => return fail(format!("unknown clip kind {other}")),
        })
    }
    fn geometry(&mut self) -> Result<Geometry, IrError> {
        Ok(match self.u8()? {
            0 => Geometry::Group,
            1 => Geometry::Rect { w: self.f64()?, h: self.f64()?, radius: self.f64()? },
            2 => Geometry::Ellipse { w: self.f64()?, h: self.f64()? },
            3 => Geometry::Path(self.path()?),
            4 => Geometry::Image { image: self.u32()?, w: self.f64()?, h: self.f64()? },
            5 => {
                let font = self.u32()?;
                let size = self.f32()?;
                let n = self.u32()? as usize;
                let mut glyphs = Vec::with_capacity(n.min(1 << 20));
                for _ in 0..n {
                    glyphs.push((self.u32()?, self.f32()?, self.f32()?));
                }
                Geometry::Glyphs(GlyphRun { font, size, glyphs })
            }
            other => return fail(format!("unknown geometry kind {other}")),
        })
    }
}

/// One decoded op.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Clear,
    Upsert { node: Node, index: u32 },
    Remove(u32),
    Image { image: u32, width: u32, height: u32, premultiplied: bool, rgba: Vec<u8> },
    DropImage(u32),
}

/// Decode a whole batch (validates structure; semantics are checked while applying).
pub fn decode(bytes: &[u8]) -> Result<Vec<Op>, IrError> {
    let mut r = Reader { buf: bytes, pos: 0 };
    if r.take(4)? != MAGIC {
        return fail("not a scene batch (bad magic)");
    }
    let version = r.u16()?;
    if version != VERSION {
        return fail(format!("unsupported scene IR version {version} (expected {VERSION})"));
    }
    r.u16()?;
    let count = r.u32()? as usize;
    let mut ops = Vec::with_capacity(count.min(1 << 20));
    for _ in 0..count {
        let tag = r.u8()?;
        ops.push(match tag {
            op::CLEAR => Op::Clear,
            op::UPSERT => {
                let id = r.u32()?;
                if id == ROOT {
                    return fail("node id 0 is the root and cannot be upserted");
                }
                let parent = r.u32()?;
                let index = r.u32()?;
                let mut t = [0.0f64; 6];
                for v in &mut t {
                    *v = r.f64()?;
                }
                let opacity = r.f32()?.clamp(0.0, 1.0);
                let blend = r.u8()?;
                if blend > 15 {
                    return fail(format!("unknown blend mode {blend}"));
                }
                let flags = r.u8()?;
                let clip = r.clip()?;
                let geometry = r.geometry()?;
                let fill = r.paint()?;
                let width = r.f32()? as f64;
                let stroke = if width > 0.0 { Some(StrokeStyle { width, paint: r.paint()?, join: r.u8()?, cap: r.u8()? }) } else { None };
                Op::Upsert { node: Node { id, parent, transform: Affine::new(t), opacity, blend, visible: flags & 1 == 1, clip, geometry, fill, stroke }, index }
            }
            op::REMOVE => Op::Remove(r.u32()?),
            op::IMAGE => {
                let image = r.u32()?;
                let width = r.u32()?;
                let height = r.u32()?;
                if width == 0 || height == 0 || width > u16::MAX as u32 || height > u16::MAX as u32 {
                    return fail(format!("image {image} has invalid size {width}×{height}"));
                }
                let premultiplied = r.u8()? == 1;
                let rgba = r.take((width * height * 4) as usize)?.to_vec();
                Op::Image { image, width, height, premultiplied, rgba }
            }
            op::DROP_IMAGE => Op::DropImage(r.u32()?),
            other => return fail(format!("unknown op {other} at byte {}", r.pos - 1)),
        });
    }
    if r.pos != bytes.len() {
        return fail(format!("{} trailing bytes after the last op", bytes.len() - r.pos));
    }
    Ok(ops)
}

// ---------------------------------------------------------------- scene

/// What a batch changed.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Applied {
    /// World rects whose pixels may have changed (old and new bounds of every touched node).
    pub dirty: Vec<Rect>,
    /// Images added or replaced (GPU backends upload these).
    pub images_set: Vec<u32>,
    pub images_dropped: Vec<u32>,
    pub cleared: bool,
}

#[derive(Default)]
pub struct Scene {
    nodes: HashMap<u32, Node>,
    children: HashMap<u32, Vec<u32>>,
    world: HashMap<u32, Affine>,
    bounds: HashMap<u32, Rect>,
    images: HashMap<u32, Arc<Pixmap>>,
}

impl Scene {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn node(&self, id: u32) -> Option<&Node> {
        self.nodes.get(&id)
    }

    /// Children of `id` in paint order (root = 0).
    pub fn children(&self, id: u32) -> &[u32] {
        self.children.get(&id).map_or(&[], |v| v.as_slice())
    }

    pub fn world_transform(&self, id: u32) -> Affine {
        self.world.get(&id).copied().unwrap_or(Affine::IDENTITY)
    }

    /// World bounds of a node's subtree (stroke included, clip applied).
    pub fn bounds_of(&self, id: u32) -> Option<Rect> {
        self.bounds.get(&id).copied()
    }

    /// Bounds of everything (None when empty).
    pub fn bounds(&self) -> Option<Rect> {
        self.children(ROOT).iter().filter_map(|c| self.bounds_of(*c)).reduce(|a, b| a.union(b))
    }

    pub fn image(&self, id: u32) -> Option<&Arc<Pixmap>> {
        self.images.get(&id)
    }

    pub fn images(&self) -> impl Iterator<Item = (&u32, &Arc<Pixmap>)> {
        self.images.iter()
    }

    /// Apply one batch. On error the batch stops at the failing op (earlier ops stay applied):
    /// the sender must resnapshot (CLEAR + full scene), as for any delta-stream gap.
    pub fn apply(&mut self, bytes: &[u8]) -> Result<Applied, IrError> {
        let ops = decode(bytes)?;
        let mut out = Applied::default();
        let mut touched: Vec<u32> = Vec::new();
        for op in ops {
            match op {
                Op::Clear => {
                    out.dirty.extend(self.bounds());
                    out.images_dropped.extend(self.images.keys().copied());
                    self.nodes.clear();
                    self.children.clear();
                    self.world.clear();
                    self.bounds.clear();
                    self.images.clear();
                    touched.clear();
                    out.cleared = true;
                }
                Op::Upsert { node, index } => {
                    if node.parent != ROOT && !self.nodes.contains_key(&node.parent) {
                        return fail(format!("node {} names unknown parent {}", node.id, node.parent));
                    }
                    // A node may not become its own ancestor.
                    let mut p = node.parent;
                    while p != ROOT {
                        if p == node.id {
                            return fail(format!("node {} would be its own ancestor", node.id));
                        }
                        p = self.nodes.get(&p).map_or(ROOT, |n| n.parent);
                    }
                    if let Some(b) = self.bounds.get(&node.id) {
                        out.dirty.push(*b);
                    }
                    if let Some(old) = self.nodes.get(&node.id) {
                        let old_parent = old.parent;
                        if let Some(list) = self.children.get_mut(&old_parent) {
                            list.retain(|c| *c != node.id);
                        }
                    }
                    let list = self.children.entry(node.parent).or_default();
                    let at = if index == APPEND { list.len() } else { (index as usize).min(list.len()) };
                    list.insert(at, node.id);
                    touched.push(node.id);
                    self.nodes.insert(node.id, node);
                }
                Op::Remove(id) => {
                    let Some(node) = self.nodes.get(&id) else { continue };
                    if let Some(b) = self.bounds.get(&id) {
                        out.dirty.push(*b);
                    }
                    let parent = node.parent;
                    if let Some(list) = self.children.get_mut(&parent) {
                        list.retain(|c| *c != id);
                    }
                    let mut stack = vec![id];
                    while let Some(n) = stack.pop() {
                        self.nodes.remove(&n);
                        self.world.remove(&n);
                        self.bounds.remove(&n);
                        if let Some(kids) = self.children.remove(&n) {
                            stack.extend(kids);
                        }
                    }
                }
                Op::Image { image, width, height, premultiplied, rgba } => {
                    let meta = PixelMetadata {
                        may_have_transparency: rgba.chunks_exact(4).any(|p| p[3] != 255),
                        alpha_type: if premultiplied { ImageAlphaType::AlphaPremultiplied } else { ImageAlphaType::Alpha },
                    };
                    self.images.insert(image, Arc::new(Pixmap::from_parts(rgba, width as u16, height as u16, meta)));
                    out.images_set.push(image);
                    self.dirty_users_of(image, &mut out.dirty);
                }
                Op::DropImage(image) => {
                    if self.images.remove(&image).is_some() {
                        out.images_dropped.push(image);
                        self.dirty_users_of(image, &mut out.dirty);
                    }
                }
            }
        }
        self.recompute();
        for id in touched {
            if let Some(b) = self.bounds.get(&id) {
                out.dirty.push(*b);
            }
        }
        Ok(out)
    }

    fn dirty_users_of(&self, image: u32, dirty: &mut Vec<Rect>) {
        for node in self.nodes.values() {
            let uses = matches!(node.geometry, Geometry::Image { image: i, .. } if i == image)
                || node.fill == Paint::Image(image)
                || node.stroke.as_ref().is_some_and(|s| s.paint == Paint::Image(image));
            if uses {
                if let Some(b) = self.bounds.get(&node.id) {
                    dirty.push(*b);
                }
            }
        }
    }

    /// World transforms and subtree bounds, root down (O(n); batches are per gesture, not per frame).
    fn recompute(&mut self) {
        self.world.clear();
        self.bounds.clear();
        let roots: Vec<u32> = self.children(ROOT).to_vec();
        for id in roots {
            self.visit(id, Affine::IDENTITY);
        }
    }

    fn visit(&mut self, id: u32, parent_world: Affine) -> Option<Rect> {
        let node = self.nodes.get(&id)?;
        let world = parent_world * node.transform;
        let own = node.local_bounds().map(|b| world.transform_rect_bbox(b));
        let clip = node.clip.bounds().map(|c| world.transform_rect_bbox(c));
        let kids: Vec<u32> = self.children(id).to_vec();
        self.world.insert(id, world);
        let mut bounds = own;
        for kid in kids {
            if let Some(b) = self.visit(kid, world) {
                bounds = Some(bounds.map_or(b, |a| a.union(b)));
            }
        }
        let bounds = match (bounds, clip) {
            (Some(b), Some(c)) => Some(b.intersect(c)),
            (b, _) => b,
        };
        if let Some(b) = bounds {
            self.bounds.insert(id, b);
        }
        bounds
    }
}

// ---------------------------------------------------------------- writer (fixtures, tests)

/// Builds batches (the TypeScript encoder in `apps/instaflow/src/render/scene-ir.ts` writes the same bytes).
pub struct IrWriter {
    buf: Vec<u8>,
    ops: u32,
}

impl Default for IrWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl IrWriter {
    pub fn new() -> Self {
        let mut buf = Vec::new();
        buf.extend_from_slice(&MAGIC);
        buf.extend_from_slice(&VERSION.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        Self { buf, ops: 0 }
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.buf[8..12].copy_from_slice(&self.ops.to_le_bytes());
        self.buf
    }

    fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn rgba(&mut self, c: Rgba8) {
        self.buf.extend_from_slice(&c);
    }
    fn rect(&mut self, r: Rect) {
        for v in [r.x0, r.y0, r.x1, r.y1] {
            self.f64(v);
        }
    }
    fn path(&mut self, p: &BezPath) {
        use vello_common::kurbo::PathEl;
        let mut verbs = Vec::new();
        let mut pts = Vec::new();
        for el in p.elements() {
            match *el {
                PathEl::MoveTo(a) => {
                    verbs.push(0);
                    pts.push(a);
                }
                PathEl::LineTo(a) => {
                    verbs.push(1);
                    pts.push(a);
                }
                PathEl::QuadTo(a, b) => {
                    verbs.push(2);
                    pts.extend([a, b]);
                }
                PathEl::CurveTo(a, b, c) => {
                    verbs.push(3);
                    pts.extend([a, b, c]);
                }
                PathEl::ClosePath => verbs.push(4),
            }
        }
        self.u32(verbs.len() as u32);
        self.buf.extend_from_slice(&verbs);
        self.u32(pts.len() as u32);
        for pt in pts {
            self.f64(pt.x);
            self.f64(pt.y);
        }
    }
    fn stops(&mut self, stops: &[(f32, Rgba8)]) {
        self.u8(stops.len() as u8);
        for (o, c) in stops {
            self.f32(*o);
            self.rgba(*c);
        }
    }
    fn paint(&mut self, p: &Paint) {
        match p {
            Paint::None => self.u8(0),
            Paint::Solid(c) => {
                self.u8(1);
                self.rgba(*c);
            }
            Paint::Linear { start, end, stops } => {
                self.u8(2);
                for v in [start.x, start.y, end.x, end.y] {
                    self.f64(v);
                }
                self.stops(stops);
            }
            Paint::Radial { center, radius, stops } => {
                self.u8(3);
                for v in [center.x, center.y, *radius] {
                    self.f64(v);
                }
                self.stops(stops);
            }
            Paint::Image(i) => {
                self.u8(4);
                self.u32(*i);
            }
        }
    }

    pub fn clear(&mut self) -> &mut Self {
        self.ops += 1;
        self.u8(op::CLEAR);
        self
    }

    pub fn upsert(&mut self, node: &Node, index: u32) -> &mut Self {
        self.ops += 1;
        self.u8(op::UPSERT);
        self.u32(node.id);
        self.u32(node.parent);
        self.u32(index);
        for v in node.transform.as_coeffs() {
            self.f64(v);
        }
        self.f32(node.opacity);
        self.u8(node.blend);
        self.u8(u8::from(node.visible));
        match &node.clip {
            Clip::None => self.u8(0),
            Clip::Rect(r) => {
                self.u8(1);
                self.rect(*r);
            }
            Clip::Rounded(r, radius) => {
                self.u8(2);
                self.rect(*r);
                self.f64(*radius);
            }
            Clip::Path(p) => {
                self.u8(3);
                self.path(p);
            }
        }
        match &node.geometry {
            Geometry::Group => self.u8(0),
            Geometry::Rect { w, h, radius } => {
                self.u8(1);
                for v in [*w, *h, *radius] {
                    self.f64(v);
                }
            }
            Geometry::Ellipse { w, h } => {
                self.u8(2);
                self.f64(*w);
                self.f64(*h);
            }
            Geometry::Path(p) => {
                self.u8(3);
                self.path(p);
            }
            Geometry::Image { image, w, h } => {
                self.u8(4);
                self.u32(*image);
                self.f64(*w);
                self.f64(*h);
            }
            Geometry::Glyphs(run) => {
                self.u8(5);
                self.u32(run.font);
                self.f32(run.size);
                self.u32(run.glyphs.len() as u32);
                for &(g, x, y) in &run.glyphs {
                    self.u32(g);
                    self.f32(x);
                    self.f32(y);
                }
            }
        }
        self.paint(&node.fill);
        match &node.stroke {
            None => self.f32(0.0),
            Some(s) => {
                self.f32(s.width as f32);
                self.paint(&s.paint);
                self.u8(s.join);
                self.u8(s.cap);
            }
        }
        self
    }

    pub fn remove(&mut self, id: u32) -> &mut Self {
        self.ops += 1;
        self.u8(op::REMOVE);
        self.u32(id);
        self
    }

    pub fn image(&mut self, image: u32, width: u32, height: u32, rgba: &[u8]) -> &mut Self {
        self.ops += 1;
        self.u8(op::IMAGE);
        self.u32(image);
        self.u32(width);
        self.u32(height);
        self.u8(0);
        self.buf.extend_from_slice(rgba);
        self
    }

    pub fn drop_image(&mut self, image: u32) -> &mut Self {
        self.ops += 1;
        self.u8(op::DROP_IMAGE);
        self.u32(image);
        self
    }
}

/// A leaf node with defaults (identity transform, opaque, normal blend, visible, no clip, no stroke).
pub fn leaf(id: u32, parent: u32, geometry: Geometry, fill: Paint) -> Node {
    Node { id, parent, transform: Affine::IDENTITY, opacity: 1.0, blend: 0, visible: true, clip: Clip::None, geometry, fill, stroke: None }
}

/// A group with defaults.
pub fn group(id: u32, parent: u32) -> Node {
    leaf(id, parent, Geometry::Group, Paint::None)
}

/// A 64 px scene that touches every Vello pipeline the editor uses (fills, strokes, both
/// gradients, clip / opacity / blend layers, and an image paint when `image` names an uploaded one).
/// Rendered once during boot so the first real frame does not compile shaders (S1: ≈ 1 s cold).
pub fn warm_up_batch(image: Option<u32>) -> Vec<u8> {
    let mut w = IrWriter::new();
    let mut layer = group(1, ROOT);
    layer.clip = Clip::Rounded(Rect::new(2.0, 2.0, 62.0, 62.0), 6.0);
    layer.opacity = 0.9;
    layer.blend = 1;
    w.upsert(&layer, APPEND);
    let mut solid = leaf(2, 1, Geometry::Rect { w: 30.0, h: 30.0, radius: 4.0 }, Paint::Solid([200, 40, 40, 255]));
    solid.stroke = Some(StrokeStyle { width: 2.0, paint: Paint::Solid([0, 0, 0, 255]), join: 2, cap: 2 });
    w.upsert(&solid, APPEND);
    let stops = vec![(0.0, [255, 0, 0, 255]), (1.0, [0, 0, 255, 128])];
    let mut linear = leaf(3, 1, Geometry::Ellipse { w: 30.0, h: 30.0 }, Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(30.0, 30.0), stops: stops.clone() });
    linear.transform = Affine::translate((32.0, 0.0));
    w.upsert(&linear, APPEND);
    let mut radial = leaf(4, ROOT, Geometry::Rect { w: 30.0, h: 30.0, radius: 0.0 }, Paint::Radial { center: Point::new(15.0, 15.0), radius: 15.0, stops });
    radial.transform = Affine::new([0.8, 0.6, -0.6, 0.8, 20.0, 30.0]);
    w.upsert(&radial, APPEND);
    if let Some(image) = image {
        let mut img = leaf(5, ROOT, Geometry::Image { image, w: 16.0, h: 16.0 }, Paint::None);
        img.transform = Affine::translate((44.0, 44.0));
        w.upsert(&img, APPEND);
    }
    w.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warm_up_batch_is_valid() {
        let mut scene = Scene::new();
        assert_eq!(scene.apply(&warm_up_batch(None)).unwrap().dirty.len(), 4);
        let mut with_image = Scene::new();
        assert_eq!(with_image.apply(&warm_up_batch(Some(3))).unwrap().dirty.len(), 5);
    }

    fn rect(id: u32, x: f64, y: f64, w: f64, h: f64) -> Node {
        let mut n = leaf(id, ROOT, Geometry::Rect { w, h, radius: 0.0 }, Paint::Solid([255, 0, 0, 255]));
        n.transform = Affine::translate((x, y));
        n
    }

    #[test]
    fn round_trips_every_kind() {
        let mut star = BezPath::new();
        star.move_to((0.0, 0.0));
        star.line_to((10.0, 0.0));
        star.quad_to((12.0, 5.0), (10.0, 10.0));
        star.curve_to((8.0, 12.0), (2.0, 12.0), (0.0, 10.0));
        star.close_path();
        let mut g = group(1, ROOT);
        g.clip = Clip::Rounded(Rect::new(0.0, 0.0, 50.0, 50.0), 4.0);
        g.opacity = 0.5;
        g.blend = 1;
        let mut p = leaf(2, 1, Geometry::Path(star.clone()), Paint::Linear { start: Point::new(0.0, 0.0), end: Point::new(10.0, 10.0), stops: vec![(0.0, [1, 2, 3, 4]), (1.0, [5, 6, 7, 8])] });
        p.stroke = Some(StrokeStyle { width: 2.0, paint: Paint::Solid([0, 0, 0, 255]), join: 2, cap: 1 });
        let nodes = vec![
            g,
            p,
            leaf(3, 1, Geometry::Ellipse { w: 4.0, h: 6.0 }, Paint::Radial { center: Point::new(2.0, 3.0), radius: 3.0, stops: vec![] }),
            leaf(4, ROOT, Geometry::Image { image: 9, w: 8.0, h: 8.0 }, Paint::Image(9)),
            leaf(5, ROOT, Geometry::Glyphs(GlyphRun { font: 3, size: 12.0, glyphs: vec![(65, 0.0, 12.0)] }), Paint::Solid([0, 0, 0, 255])),
        ];
        let mut w = IrWriter::new();
        w.image(9, 1, 1, &[1, 2, 3, 255]);
        for n in &nodes {
            w.upsert(n, APPEND);
        }
        w.remove(5).drop_image(42).clear();
        let ops = decode(&w.finish()).unwrap();
        assert_eq!(ops.len(), 9);
        for (i, n) in nodes.iter().enumerate() {
            assert_eq!(ops[i + 1], Op::Upsert { node: n.clone(), index: APPEND });
        }
        assert_eq!(ops[6], Op::Remove(5));
        assert_eq!(ops[7], Op::DropImage(42));
        assert_eq!(ops[8], Op::Clear);
    }

    #[test]
    fn rejects_malformed_batches() {
        assert!(decode(b"NOPE").is_err());
        let mut bad_version = IrWriter::new().finish();
        bad_version[4] = 9;
        assert!(decode(&bad_version).unwrap_err().0.contains("version"));
        let mut w = IrWriter::new();
        w.upsert(&rect(1, 0.0, 0.0, 1.0, 1.0), APPEND);
        let mut bytes = w.finish();
        bytes.truncate(bytes.len() - 3);
        assert!(decode(&bytes).unwrap_err().0.contains("truncated"));
        let mut trailing = IrWriter::new().finish();
        trailing.push(0);
        assert!(decode(&trailing).unwrap_err().0.contains("trailing"));
        let mut unknown = IrWriter::new();
        unknown.ops = 1;
        unknown.u8(77);
        assert!(decode(&unknown.finish()).unwrap_err().0.contains("unknown op"));
        let mut root = IrWriter::new();
        root.upsert(&group(0, ROOT), APPEND);
        assert!(decode(&root.finish()).is_err());
    }

    #[test]
    fn tracks_tree_order_bounds_and_dirty_rects() {
        let mut scene = Scene::new();
        let mut w = IrWriter::new();
        w.upsert(&rect(1, 10.0, 10.0, 20.0, 20.0), APPEND).upsert(&rect(2, 100.0, 0.0, 10.0, 10.0), APPEND).upsert(&rect(3, 0.0, 0.0, 5.0, 5.0), 0);
        let applied = scene.apply(&w.finish()).unwrap();
        assert_eq!(scene.children(ROOT), &[3, 1, 2]);
        assert_eq!(applied.dirty.len(), 3);
        assert_eq!(scene.bounds(), Some(Rect::new(0.0, 0.0, 110.0, 30.0)));

        // move: old and new bounds are dirty
        let mut w = IrWriter::new();
        w.upsert(&rect(1, 50.0, 50.0, 20.0, 20.0), APPEND);
        let moved = scene.apply(&w.finish()).unwrap();
        assert_eq!(moved.dirty, vec![Rect::new(10.0, 10.0, 30.0, 30.0), Rect::new(50.0, 50.0, 70.0, 70.0)]);
        assert_eq!(scene.children(ROOT), &[3, 2, 1]);

        // group transform moves children; group bounds cover them; remove takes the subtree
        let mut g = group(10, ROOT);
        g.transform = Affine::translate((200.0, 0.0));
        let mut w = IrWriter::new();
        w.upsert(&g, APPEND);
        let mut child = rect(11, 0.0, 0.0, 10.0, 10.0);
        child.parent = 10;
        w.upsert(&child, APPEND);
        scene.apply(&w.finish()).unwrap();
        assert_eq!(scene.bounds_of(11), Some(Rect::new(200.0, 0.0, 210.0, 10.0)));
        assert_eq!(scene.bounds_of(10), Some(Rect::new(200.0, 0.0, 210.0, 10.0)));
        let mut w = IrWriter::new();
        w.remove(10);
        let removed = scene.apply(&w.finish()).unwrap();
        assert_eq!(removed.dirty, vec![Rect::new(200.0, 0.0, 210.0, 10.0)]);
        assert!(scene.node(11).is_none());
        assert_eq!(scene.len(), 3);
    }

    #[test]
    fn clips_bounds_and_strokes_inflate_them() {
        let mut scene = Scene::new();
        let mut g = group(1, ROOT);
        g.clip = Clip::Rect(Rect::new(0.0, 0.0, 10.0, 10.0));
        let mut big = rect(2, 0.0, 0.0, 100.0, 100.0);
        big.parent = 1;
        let mut stroked = rect(3, 200.0, 200.0, 10.0, 10.0);
        stroked.stroke = Some(StrokeStyle { width: 4.0, paint: Paint::Solid([0, 0, 0, 255]), join: 1, cap: 0 });
        let mut w = IrWriter::new();
        w.upsert(&g, APPEND).upsert(&big, APPEND).upsert(&stroked, APPEND);
        scene.apply(&w.finish()).unwrap();
        assert_eq!(scene.bounds_of(1), Some(Rect::new(0.0, 0.0, 10.0, 10.0)));
        assert_eq!(scene.bounds_of(3), Some(Rect::new(196.0, 196.0, 214.0, 214.0)));
    }

    #[test]
    fn rejects_unknown_parents_and_cycles() {
        let mut scene = Scene::new();
        let mut orphan = rect(1, 0.0, 0.0, 1.0, 1.0);
        orphan.parent = 99;
        let mut w = IrWriter::new();
        w.upsert(&orphan, APPEND);
        assert!(scene.apply(&w.finish()).unwrap_err().0.contains("unknown parent"));
        let mut w = IrWriter::new();
        w.upsert(&group(1, ROOT), APPEND).upsert(&group(2, 1), APPEND).upsert(&group(1, 2), APPEND);
        assert!(scene.apply(&w.finish()).unwrap_err().0.contains("ancestor"));
    }

    #[test]
    fn images_are_retained_and_dirty_their_users() {
        let mut scene = Scene::new();
        let mut w = IrWriter::new();
        w.image(7, 2, 1, &[255, 0, 0, 255, 0, 0, 255, 128]).upsert(&leaf(1, ROOT, Geometry::Image { image: 7, w: 10.0, h: 5.0 }, Paint::Image(7)), APPEND);
        let first = scene.apply(&w.finish()).unwrap();
        assert_eq!(first.images_set, vec![7]);
        assert!(scene.image(7).is_some());
        let mut w = IrWriter::new();
        w.drop_image(7);
        let dropped = scene.apply(&w.finish()).unwrap();
        assert_eq!(dropped.images_dropped, vec![7]);
        assert_eq!(dropped.dirty, vec![Rect::new(0.0, 0.0, 10.0, 5.0)]);
        let mut w = IrWriter::new();
        w.clear();
        let cleared = scene.apply(&w.finish()).unwrap();
        assert!(cleared.cleared);
        assert!(scene.is_empty());
        assert_eq!(scene.bounds(), None);
    }
}
