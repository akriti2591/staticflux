//! Scene IR (IF-7.10): the retained, CPU-side scene every render backend draws from.
//!
//! The editor sends **batches** (snapshot or delta) in a small binary format; the scene keeps the
//! node tree, world transforms, world bounds and image pixels, so a GPU device loss rebuilds every
//! texture from here without touching the document (IF-7.11).
//!
//! # Wire format (version 3, little-endian)
//!
//! ```text
//! batch   = "SFIR" version:u16 reserved:u16 op_count:u32 op*
//! op      = CLEAR(1)
//!         | UPSERT(2) id:u32 parent:u32 index:u32 transform:f64×6 opacity:f32 blend:u8 flags:u8 mask:u8
//!                     clip geometry fills strokes effects
//!         | REMOVE(3) id:u32                         (the node and its subtree)
//!         | IMAGE(4)  image:u32 width:u32 height:u32 alpha:u8 rgba8[width·height·4]
//!         | DROP_IMAGE(5) image:u32
//!         | FONT(6) font:u32 hash:u8[32] len:u32 bytes[len]  (len 0: alias of a font whose hash is already retained)
//!         | DROP_FONT(7) font:u32
//! clip     = NONE(0) | RECT(1) x0 y0 x1 y1:f64 | ROUNDED(2) x0 y0 x1 y1 radius:f64 | PATH(3) path
//! geometry = GROUP(0) | RECT(1) w h radius:f64 | ELLIPSE(2) w h:f64 | PATH(3) path
//!          | IMAGE(4) image:u32 w h:f64
//!          | GLYPHS(5) font:u32 size:f32 flags:u8 skew:f32 coords:u8 (coord:i16)* count:u32 (glyph:u32 x:f32 y:f32)*
//!          | RRECT(6) w h tl tr br bl:f64                          (a radius per corner, already fitted)
//! path     = verbs:u32 verb:u8* points:u32 (x:f64 y:f64)*     verbs: move 0, line 1, quad 2, cubic 3, close 4
//! paint    = NONE(0) | SOLID(1) rgba8 | LINEAR(2) x0 y0 x1 y1:f64 stops | RADIAL(3) cx cy r:f64 stops | IMAGE(4) image:u32 fit:u8
//!          | SWEEP(5) cx cy start end:f64 stops                    (conic; angles in radians, clockwise from +x)
//! stops    = count:u8 (offset:f32 rgba8)*
//! fills    = count:u8 (paint opacity:f32 blend:u8)*                        (bottom first)
//! strokes  = count:u8 (width:f32 paint opacity:f32 blend:u8 join:u8 cap:u8 miter:f32
//!                      dashes:u8 dash:f32* dash_offset:f32 ring:u8 [path when ring = 1])*
//! effects  = count:u8 effect*
//! effect   = DROP_SHADOW(1) dx dy blur spread:f32 rgba8 | INNER_SHADOW(2) dx dy blur spread:f32 rgba8
//!          | LAYER_BLUR(3) radius:f32 | BACKGROUND_BLUR(4) radius:f32
//! ```
//!
//! v2 (M1 B1) adds stacked fills and strokes (each with opacity and blend; strokes with dashes, or a precomputed
//! `ring` path filled instead of stroked: inside / outside / per-side strokes), conic gradients, per-corner rects,
//! image fit (0 stretch, 1 cover, 2 contain, 3 tile), the even-odd fill rule
//! (`flags` bit 1), effects and masks. Effect offsets and blur are in the node's local space (blur = 2σ, like CSS).
//! **Masks** (`mask` low bits: 0 none, 1 clip = the node's geometry, 2 alpha, 3 luminance; bit 7 = invert): a mask
//! node is not drawn itself; it masks the siblings that follow it in its parent (a later mask among them nests).
//! In luminance mode solid and gradient colours become alpha = a × luma; image paints are used as alpha unchanged,
//! so the sender uploads luminance-as-alpha pixels for an image used as a luminance mask (and a matte's alpha as is).
//!
//! `parent` 0 is the root; `index` is the position among the parent's children (`u32::MAX` appends).
//! `flags` bit 0 = visible. Colors are straight-alpha sRGB. Image paint maps the image onto the
//! shape's `w × h` box. `blend` is a `peniko::Mix` value (0 normal … 15 luminosity).
//! Every geometry, paint and clip kind must be handled by every backend (exhaustive matches).
//!
//! **Fonts (B2):** font bytes are retained by **content hash** (sha-256 from the sender, usually the blob store
//! key): `FONT` with bytes uploads a face once; `FONT` with `len = 0` maps another id to retained bytes without
//! resending them. Bytes no font id references are released at the end of the batch (a `CLEAR` + resnapshot
//! re-references them in the same batch, so a resnapshot never resends fonts). Glyph runs name a font id;
//! `flags` bit 0 = synthetic bold, `skew` = synthetic italic angle in degrees, `coords` = variation coordinates
//! (F2Dot14, the run's `normalized_coords` from Parley; S3: CJK variable fonts default to weight 100 without
//! them). Glyph `x, y` are pen positions on the baseline in the node's local space; fill paints them.
//! Version history: 1 (A6) → 2 (B1: stacks, effects, masks) → 3 (B2: FONT/DROP_FONT ops, synthesis and coords on GLYPHS).

use std::collections::HashMap;
use std::sync::Arc;
use vello_common::kurbo::{Affine, BezPath, Point, Rect, Shape};
use vello_common::peniko::{Blob, FontData, ImageAlphaType};
use vello_common::pixmap::{PixelMetadata, Pixmap};

pub const MAGIC: [u8; 4] = *b"SFIR";
pub const VERSION: u16 = 3;
pub const ROOT: u32 = 0;
pub const APPEND: u32 = u32::MAX;

pub mod op {
    pub const CLEAR: u8 = 1;
    pub const UPSERT: u8 = 2;
    pub const REMOVE: u8 = 3;
    pub const IMAGE: u8 = 4;
    pub const DROP_IMAGE: u8 = 5;
    pub const FONT: u8 = 6;
    pub const DROP_FONT: u8 = 7;
}

/// sha-256 of the font file (computed by the sender).
pub type FontHash = [u8; 32];

pub type Rgba8 = [u8; 4];

#[derive(Clone, Debug, PartialEq)]
pub struct GlyphRun {
    pub font: u32,
    pub size: f32,
    /// Synthetic bold (the font has no bold face).
    pub embolden: bool,
    /// Synthetic italic skew in degrees (0 = none).
    pub skew: f32,
    /// Variation coordinates (F2Dot14 bits).
    pub coords: Vec<i16>,
    pub glyphs: Vec<(u32, f32, f32)>,
}

impl GlyphRun {
    /// A plain run (no synthesis, default coordinates).
    pub fn new(font: u32, size: f32, glyphs: Vec<(u32, f32, f32)>) -> Self {
        GlyphRun { font, size, embolden: false, skew: 0.0, coords: Vec::new(), glyphs }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Geometry {
    Group,
    Rect { w: f64, h: f64, radius: f64 },
    Ellipse { w: f64, h: f64 },
    Path(BezPath),
    Image { image: u32, w: f64, h: f64 },
    /// Positioned glyphs from the authoring module (B2), drawn with the retained font `run.font`.
    Glyphs(GlyphRun),
    /// A rect with a radius per corner `[top-left, top-right, bottom-right, bottom-left]`.
    RRect { w: f64, h: f64, radii: [f64; 4] },
}

/// Image fit for image paints: how the image maps onto the shape's `w × h` box.
pub mod fit {
    pub const STRETCH: u8 = 0;
    pub const COVER: u8 = 1;
    pub const CONTAIN: u8 = 2;
    pub const TILE: u8 = 3;
}

/// Mask modes (`Node::mask` low bits) and the invert bit.
pub mod mask {
    pub const NONE: u8 = 0;
    pub const CLIP: u8 = 1;
    pub const ALPHA: u8 = 2;
    pub const LUMINANCE: u8 = 3;
    pub const INVERT: u8 = 0x80;
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    DropShadow { dx: f32, dy: f32, blur: f32, spread: f32, color: Rgba8 },
    InnerShadow { dx: f32, dy: f32, blur: f32, spread: f32, color: Rgba8 },
    LayerBlur { radius: f32 },
    /// Blur of what is behind the node, inside its outline (frosted glass).
    BackgroundBlur { radius: f32 },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    None,
    Solid(Rgba8),
    Linear { start: Point, end: Point, stops: Vec<(f32, Rgba8)> },
    Radial { center: Point, radius: f64, stops: Vec<(f32, Rgba8)> },
    /// Image id and fit (`fit::*`).
    Image(u32, u8),
    /// Conic (sweep) gradient around `center` from `start` to `end` (radians).
    Sweep { center: Point, start: f64, end: f64, stops: Vec<(f32, Rgba8)> },
}

/// One fill of a node (fills stack bottom first).
#[derive(Clone, Debug, PartialEq)]
pub struct FillStyle {
    pub paint: Paint,
    pub opacity: f32,
    pub blend: u8,
}

impl FillStyle {
    pub fn of(paint: Paint) -> Self {
        FillStyle { paint, opacity: 1.0, blend: 0 }
    }
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
    pub opacity: f32,
    pub blend: u8,
    pub miter: f32,
    /// Dash pattern (empty = solid) and its offset.
    pub dash: Vec<f32>,
    pub dash_offset: f32,
    /// A precomputed outline of the stroke, filled instead of stroking (inside, outside, per-side widths).
    pub ring: Option<BezPath>,
}

impl StrokeStyle {
    /// A solid, centred stroke.
    pub fn new(width: f64, paint: Paint, join: u8, cap: u8) -> Self {
        StrokeStyle { width, paint, join, cap, opacity: 1.0, blend: 0, miter: 4.0, dash: Vec::new(), dash_offset: 0.0, ring: None }
    }
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
    pub fills: Vec<FillStyle>,
    pub strokes: Vec<StrokeStyle>,
    /// Even-odd fill rule (default non-zero).
    pub even_odd: bool,
    /// Mask mode and invert bit (`mask::*`); a mask node masks the siblings after it.
    pub mask: u8,
    pub effects: Vec<Effect>,
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
            Geometry::Rect { w, h, .. } | Geometry::RRect { w, h, .. } | Geometry::Ellipse { w, h } | Geometry::Image { w, h, .. } => Rect::new(0.0, 0.0, *w, *h),
            Geometry::Path(p) => p.bounding_box(),
            Geometry::Glyphs(run) => {
                let mut r: Option<Rect> = None;
                let s = run.size as f64;
                // Conservative ink box per glyph: tall marks (Arabic harakat, Devanagari reph) and wide glyphs.
                let skew = (run.skew as f64).to_radians().tan().abs() * s * 1.3;
                for &(_, x, y) in &run.glyphs {
                    let g = Rect::new(x as f64 - s * 0.3 - skew, y as f64 - s * 1.3, x as f64 + s * 1.3 + skew, y as f64 + s * 0.6);
                    r = Some(r.map_or(g, |a| a.union(g)));
                }
                r?
            }
        };
        let pad = self.strokes.iter().filter(|s| s.ring.is_none()).map(|s| s.width).fold(0.0, f64::max);
        let mut ink = base.inflate(pad, pad);
        for ring in self.strokes.iter().filter_map(|s| s.ring.as_ref()) {
            ink = ink.union(ring.bounding_box());
        }
        Some(self.effect_bounds(ink))
    }

    /// `ink` grown by the effects (drop shadows and layer blur reach 3σ = 1.5 × blur; inner shadows stay inside).
    pub fn effect_bounds(&self, ink: Rect) -> Rect {
        let mut out = ink;
        for e in &self.effects {
            match e {
                Effect::DropShadow { dx, dy, blur, spread, .. } => {
                    let r = (*spread as f64 + 1.5 * *blur as f64).max(0.0);
                    out = out.union(ink.inflate(r, r) + vello_common::kurbo::Vec2::new(*dx as f64, *dy as f64));
                }
                Effect::InnerShadow { .. } => {}
                Effect::LayerBlur { radius } => out = out.union(ink.inflate(1.5 * *radius as f64, 1.5 * *radius as f64)),
                Effect::BackgroundBlur { .. } => {}
            }
        }
        out
    }

    /// The layer blur radius, if any (applies to the node and its subtree).
    pub fn layer_blur(&self) -> Option<f32> {
        self.effects.iter().find_map(|e| match e {
            Effect::LayerBlur { radius } if *radius > 0.0 => Some(*radius),
            _ => None,
        })
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

/// A face from font bytes (index 0 of a collection), or None when it is not a font file.
fn font_face(bytes: Vec<u8>) -> Option<FontData> {
    let tag = bytes.get(0..4)?;
    let known = [[0, 1, 0, 0], *b"OTTO", *b"true", *b"ttcf"];
    if !known.iter().any(|k| k == tag) {
        return None;
    }
    Some(FontData::new(Blob::new(Arc::new(bytes)), 0))
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
            4 => {
                let image = self.u32()?;
                let fit = self.u8()?;
                if fit > fit::TILE {
                    return fail(format!("unknown image fit {fit}"));
                }
                Paint::Image(image, fit)
            }
            5 => Paint::Sweep { center: Point::new(self.f64()?, self.f64()?), start: self.f64()?, end: self.f64()?, stops: self.stops()? },
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
                let flags = self.u8()?;
                let skew = self.f32()?;
                let nc = self.u8()? as usize;
                let mut coords = Vec::with_capacity(nc);
                for _ in 0..nc {
                    coords.push(i16::from_le_bytes(self.take(2)?.try_into().unwrap()));
                }
                let n = self.u32()? as usize;
                let mut glyphs = Vec::with_capacity(n.min(1 << 20));
                for _ in 0..n {
                    glyphs.push((self.u32()?, self.f32()?, self.f32()?));
                }
                Geometry::Glyphs(GlyphRun { font, size, embolden: flags & 1 == 1, skew, coords, glyphs })
            }
            6 => Geometry::RRect { w: self.f64()?, h: self.f64()?, radii: [self.f64()?, self.f64()?, self.f64()?, self.f64()?] },
            other => return fail(format!("unknown geometry kind {other}")),
        })
    }
}

impl Reader<'_> {
    fn fills(&mut self) -> Result<Vec<FillStyle>, IrError> {
        let n = self.u8()? as usize;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let paint = self.paint()?;
            let opacity = self.f32()?.clamp(0.0, 1.0);
            let blend = self.u8()?;
            if blend > 15 {
                return fail(format!("unknown blend mode {blend}"));
            }
            out.push(FillStyle { paint, opacity, blend });
        }
        Ok(out)
    }

    fn strokes(&mut self) -> Result<Vec<StrokeStyle>, IrError> {
        let n = self.u8()? as usize;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            let width = self.f32()?.max(0.0) as f64;
            let paint = self.paint()?;
            let opacity = self.f32()?.clamp(0.0, 1.0);
            let blend = self.u8()?;
            if blend > 15 {
                return fail(format!("unknown blend mode {blend}"));
            }
            let join = self.u8()?;
            let cap = self.u8()?;
            let miter = self.f32()?.max(1.0);
            let dashes = self.u8()? as usize;
            let mut dash = Vec::with_capacity(dashes);
            for _ in 0..dashes {
                dash.push(self.f32()?.max(0.0));
            }
            let dash_offset = self.f32()?;
            let ring = match self.u8()? {
                0 => None,
                1 => Some(self.path()?),
                other => return fail(format!("unknown stroke ring flag {other}")),
            };
            out.push(StrokeStyle { width, paint, join, cap, opacity, blend, miter, dash, dash_offset, ring });
        }
        Ok(out)
    }

    fn effects(&mut self) -> Result<Vec<Effect>, IrError> {
        let n = self.u8()? as usize;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(match self.u8()? {
                1 => Effect::DropShadow { dx: self.f32()?, dy: self.f32()?, blur: self.f32()?.max(0.0), spread: self.f32()?, color: self.rgba()? },
                2 => Effect::InnerShadow { dx: self.f32()?, dy: self.f32()?, blur: self.f32()?.max(0.0), spread: self.f32()?, color: self.rgba()? },
                3 => Effect::LayerBlur { radius: self.f32()?.max(0.0) },
                4 => Effect::BackgroundBlur { radius: self.f32()?.max(0.0) },
                other => return fail(format!("unknown effect kind {other}")),
            });
        }
        Ok(out)
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
    /// `bytes` empty: alias of retained bytes with this hash.
    Font { font: u32, hash: FontHash, bytes: Vec<u8> },
    DropFont(u32),
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
                if flags & !0b11 != 0 {
                    return fail(format!("unknown node flags {flags:#x}"));
                }
                let mask_mode = r.u8()?;
                if mask_mode & 0x7f > mask::LUMINANCE {
                    return fail(format!("unknown mask mode {mask_mode:#x}"));
                }
                let clip = r.clip()?;
                let geometry = r.geometry()?;
                let fills = r.fills()?;
                let strokes = r.strokes()?;
                let effects = r.effects()?;
                let node = Node { id, parent, transform: Affine::new(t), opacity, blend, visible: flags & 1 == 1, clip, geometry, fills, strokes, even_odd: flags & 2 == 2, mask: mask_mode, effects };
                Op::Upsert { node, index }
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
            op::FONT => {
                let font = r.u32()?;
                let hash: FontHash = r.take(32)?.try_into().unwrap();
                let len = r.u32()? as usize;
                Op::Font { font, hash, bytes: r.take(len)?.to_vec() }
            }
            op::DROP_FONT => Op::DropFont(r.u32()?),
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
    /// Font ids added or re-pointed.
    pub fonts_set: Vec<u32>,
    pub cleared: bool,
}

#[derive(Default)]
pub struct Scene {
    nodes: HashMap<u32, Node>,
    children: HashMap<u32, Vec<u32>>,
    world: HashMap<u32, Affine>,
    bounds: HashMap<u32, Rect>,
    images: HashMap<u32, Arc<Pixmap>>,
    fonts: HashMap<u32, FontHash>,
    font_data: HashMap<FontHash, FontData>,
    glyphs: std::cell::RefCell<crate::glyphs::GlyphCache>,
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

    /// The face behind a font id.
    pub fn font(&self, id: u32) -> Option<&FontData> {
        self.font_data.get(self.fonts.get(&id)?)
    }

    /// Retained font files (each hash once, however many ids alias it).
    pub fn font_files(&self) -> usize {
        self.font_data.len()
    }

    pub fn has_font_hash(&self, hash: &FontHash) -> bool {
        self.font_data.contains_key(hash)
    }

    /// A glyph run as one local-space path (None when its font id is unknown or the face is unreadable).
    pub fn glyph_path(&self, run: &GlyphRun) -> Option<BezPath> {
        let font = self.font(run.font)?;
        self.glyphs.borrow_mut().run_path(font, run)
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
                    self.fonts.clear();
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
                Op::Font { font, hash, bytes } => {
                    if bytes.is_empty() {
                        if !self.font_data.contains_key(&hash) {
                            return fail(format!("font {font} aliases a font file this scene does not hold (resend it with its bytes)"));
                        }
                    } else if !self.font_data.contains_key(&hash) {
                        let face = font_face(bytes).ok_or_else(|| IrError(format!("font {font} is not an OpenType/TrueType file")))?;
                        self.font_data.insert(hash, face);
                    }
                    self.fonts.insert(font, hash);
                    out.fonts_set.push(font);
                    self.dirty_font_users(font, &mut out.dirty);
                }
                Op::DropFont(font) => {
                    if self.fonts.remove(&font).is_some() {
                        self.dirty_font_users(font, &mut out.dirty);
                    }
                }
            }
        }
        // Release font files no id references any more (content-addressed: one copy per hash).
        let live: std::collections::HashSet<FontHash> = self.fonts.values().copied().collect();
        let before = self.font_data.len();
        self.font_data.retain(|h, _| live.contains(h));
        if self.font_data.len() != before {
            self.glyphs.borrow_mut().clear();
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
                || node.fills.iter().any(|f| matches!(f.paint, Paint::Image(i, _) if i == image))
                || node.strokes.iter().any(|s| matches!(s.paint, Paint::Image(i, _) if i == image));
            if uses {
                if let Some(b) = self.bounds.get(&node.id) {
                    dirty.push(*b);
                }
            }
        }
    }

    fn dirty_font_users(&self, font: u32, dirty: &mut Vec<Rect>) {
        for node in self.nodes.values() {
            if matches!(&node.geometry, Geometry::Glyphs(run) if run.font == font) {
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
            Paint::Image(i, fit) => {
                self.u8(4);
                self.u32(*i);
                self.u8(*fit);
            }
            Paint::Sweep { center, start, end, stops } => {
                self.u8(5);
                for v in [center.x, center.y, *start, *end] {
                    self.f64(v);
                }
                self.stops(stops);
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
        self.u8(u8::from(node.visible) | (u8::from(node.even_odd) << 1));
        self.u8(node.mask);
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
            Geometry::RRect { w, h, radii } => {
                self.u8(6);
                for v in [*w, *h, radii[0], radii[1], radii[2], radii[3]] {
                    self.f64(v);
                }
            }
            Geometry::Glyphs(run) => {
                self.u8(5);
                self.u32(run.font);
                self.f32(run.size);
                self.u8(u8::from(run.embolden));
                self.f32(run.skew);
                self.u8(run.coords.len() as u8);
                for c in &run.coords {
                    self.buf.extend_from_slice(&c.to_le_bytes());
                }
                self.u32(run.glyphs.len() as u32);
                for &(g, x, y) in &run.glyphs {
                    self.u32(g);
                    self.f32(x);
                    self.f32(y);
                }
            }
        }
        self.u8(node.fills.len() as u8);
        for f in &node.fills {
            self.paint(&f.paint);
            self.f32(f.opacity);
            self.u8(f.blend);
        }
        self.u8(node.strokes.len() as u8);
        for s in &node.strokes {
            self.f32(s.width as f32);
            self.paint(&s.paint);
            self.f32(s.opacity);
            self.u8(s.blend);
            self.u8(s.join);
            self.u8(s.cap);
            self.f32(s.miter);
            self.u8(s.dash.len() as u8);
            for d in &s.dash {
                self.f32(*d);
            }
            self.f32(s.dash_offset);
            match &s.ring {
                None => self.u8(0),
                Some(ring) => {
                    self.u8(1);
                    self.path(ring);
                }
            }
        }
        self.u8(node.effects.len() as u8);
        for e in &node.effects {
            match e {
                Effect::DropShadow { dx, dy, blur, spread, color } | Effect::InnerShadow { dx, dy, blur, spread, color } => {
                    self.u8(if matches!(e, Effect::DropShadow { .. }) { 1 } else { 2 });
                    for v in [*dx, *dy, *blur, *spread] {
                        self.f32(v);
                    }
                    self.rgba(*color);
                }
                Effect::LayerBlur { radius } => {
                    self.u8(3);
                    self.f32(*radius);
                }
                Effect::BackgroundBlur { radius } => {
                    self.u8(4);
                    self.f32(*radius);
                }
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

    /// Retain a font file under `font` (pass empty `bytes` to alias a hash the scene already holds).
    pub fn font(&mut self, font: u32, hash: &FontHash, bytes: &[u8]) -> &mut Self {
        self.ops += 1;
        self.u8(op::FONT);
        self.u32(font);
        self.buf.extend_from_slice(hash);
        self.u32(bytes.len() as u32);
        self.buf.extend_from_slice(bytes);
        self
    }

    pub fn drop_font(&mut self, font: u32) -> &mut Self {
        self.ops += 1;
        self.u8(op::DROP_FONT);
        self.u32(font);
        self
    }
}

/// A leaf node with defaults (identity transform, opaque, normal blend, visible, no clip, no stroke).
pub fn leaf(id: u32, parent: u32, geometry: Geometry, fill: Paint) -> Node {
    Node { id, parent, transform: Affine::IDENTITY, opacity: 1.0, blend: 0, visible: true, clip: Clip::None, geometry, fills: if fill == Paint::None { Vec::new() } else { vec![FillStyle::of(fill)] }, strokes: Vec::new(), even_odd: false, mask: mask::NONE, effects: Vec::new() }
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
    solid.strokes = vec![StrokeStyle::new(2.0, Paint::Solid([0, 0, 0, 255]), 2, 2)];
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
        p.strokes = vec![StrokeStyle::new(2.0, Paint::Solid([0, 0, 0, 255]), 2, 1)];
        let mut v2 = leaf(6, ROOT, Geometry::RRect { w: 20.0, h: 10.0, radii: [1.0, 2.0, 3.0, 4.0] }, Paint::Image(9, fit::COVER));
        v2.even_odd = true;
        v2.mask = mask::LUMINANCE | mask::INVERT;
        v2.effects = vec![
            Effect::DropShadow { dx: 1.0, dy: 2.0, blur: 3.0, spread: 0.5, color: [0, 0, 0, 128] },
            Effect::InnerShadow { dx: -1.0, dy: 0.0, blur: 2.0, spread: 0.0, color: [255, 0, 0, 255] },
            Effect::LayerBlur { radius: 4.0 },
        ];
        let nodes = vec![
            g,
            p,
            v2,
            leaf(3, 1, Geometry::Ellipse { w: 4.0, h: 6.0 }, Paint::Radial { center: Point::new(2.0, 3.0), radius: 3.0, stops: vec![] }),
            leaf(4, ROOT, Geometry::Image { image: 9, w: 8.0, h: 8.0 }, Paint::Image(9, fit::STRETCH)),
            leaf(5, ROOT, Geometry::Glyphs(GlyphRun { font: 3, size: 12.0, embolden: true, skew: 14.0, coords: vec![16384, -3], glyphs: vec![(65, 0.0, 12.0)] }), Paint::Solid([0, 0, 0, 255])),
        ];
        let mut w = IrWriter::new();
        w.image(9, 1, 1, &[1, 2, 3, 255]);
        for n in &nodes {
            w.upsert(n, APPEND);
        }
        w.remove(5).drop_image(42).clear().font(4, &[7; 32], b"OTTO").font(5, &[7; 32], b"").drop_font(4);
        let ops = decode(&w.finish()).unwrap();
        assert_eq!(ops.len(), 13);
        assert_eq!(ops[10], Op::Font { font: 4, hash: [7; 32], bytes: b"OTTO".to_vec() });
        assert_eq!(ops[11], Op::Font { font: 5, hash: [7; 32], bytes: vec![] });
        assert_eq!(ops[12], Op::DropFont(4));
        for (i, n) in nodes.iter().enumerate() {
            assert_eq!(ops[i + 1], Op::Upsert { node: n.clone(), index: APPEND });
        }
        assert_eq!(ops[7], Op::Remove(5));
        assert_eq!(ops[8], Op::DropImage(42));
        assert_eq!(ops[9], Op::Clear);
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
        stroked.strokes = vec![StrokeStyle::new(4.0, Paint::Solid([0, 0, 0, 255]), 1, 0)];
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
    fn fonts_are_retained_by_hash_and_released_when_unreferenced() {
        let otf = b"OTTO fake font bytes".to_vec();
        let mut scene = Scene::new();
        let mut w = IrWriter::new();
        w.font(1, &[1; 32], &otf).font(2, &[1; 32], b"");
        let run = leaf(9, ROOT, Geometry::Glyphs(GlyphRun::new(2, 10.0, vec![(3, 0.0, 10.0)])), Paint::Solid([0, 0, 0, 255]));
        w.upsert(&run, APPEND);
        let applied = scene.apply(&w.finish()).unwrap();
        assert_eq!(applied.fonts_set, vec![1, 2]);
        assert_eq!(scene.font_files(), 1, "two ids, one file");
        assert!(scene.font(2).is_some() && scene.has_font_hash(&[1; 32]));
        // re-pointing a font dirties its glyph runs
        let mut w = IrWriter::new();
        w.font(2, &[1; 32], b"");
        assert_eq!(scene.apply(&w.finish()).unwrap().dirty, vec![scene.bounds_of(9).unwrap()]);
        // resnapshot: CLEAR then alias by hash, no bytes resent
        let mut w = IrWriter::new();
        w.clear().font(5, &[1; 32], b"");
        scene.apply(&w.finish()).unwrap();
        assert!(scene.font(5).is_some() && scene.font(1).is_none());
        // unknown hash alias and non-font bytes fail
        let mut w = IrWriter::new();
        w.font(6, &[9; 32], b"");
        assert!(scene.apply(&w.finish()).unwrap_err().0.contains("resend"));
        let mut w = IrWriter::new();
        w.font(7, &[8; 32], b"GIF89a");
        assert!(scene.apply(&w.finish()).unwrap_err().0.contains("not an OpenType"));
        // dropping the last id releases the file
        let mut w = IrWriter::new();
        w.drop_font(5);
        scene.apply(&w.finish()).unwrap();
        assert_eq!(scene.font_files(), 0);
    }

    #[test]
    fn images_are_retained_and_dirty_their_users() {
        let mut scene = Scene::new();
        let mut w = IrWriter::new();
        w.image(7, 2, 1, &[255, 0, 0, 255, 0, 0, 255, 128]).upsert(&leaf(1, ROOT, Geometry::Image { image: 7, w: 10.0, h: 5.0 }, Paint::Image(7, fit::STRETCH)), APPEND);
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
