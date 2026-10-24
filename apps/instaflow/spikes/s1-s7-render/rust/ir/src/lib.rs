//! Spike scene IR shared by every backend (vello_gpu, vello_cpu, SVG writer, krilla).
//!
//! One deterministic synthetic document: a page with N elements (rects, rounded rects,
//! ellipses, stars, bezier blobs; solid / linear / radial / image paints; optional strokes).
//! Every backend implements [`Painter`] and calls [`draw`] so the drawing order and
//! geometry are identical by construction.

use std::fmt::Write as _;
use std::sync::Arc;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::kurbo::{Affine, BezPath, Circle, Point, Rect, RoundedRect, Shape, Stroke};
use vello_common::peniko::{
    ColorStop, ColorStops, Extend, Gradient, LinearGradientPosition, RadialGradientPosition,
};
use vello_common::peniko::ImageAlphaType;
use vello_common::pixmap::{PixelMetadata, Pixmap};

pub use vello_common;

pub type Color = [u8; 4]; // straight-alpha sRGB

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Rect,
    RoundRect(f64),
    Ellipse,
    Star(u8),
    Blob(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    Solid(Color),
    Linear(Color, Color),
    Radial(Color, Color),
    Image(u8),
}

#[derive(Clone, Debug)]
pub struct Element {
    pub id: u32,
    pub kind: Kind,
    pub paint: Paint,
    pub stroke: Option<(Color, f64)>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// rotation in radians about the element centre
    pub rot: f64,
}

impl Element {
    pub fn local_transform(&self) -> Affine {
        let c = Point::new(self.w / 2.0, self.h / 2.0);
        Affine::translate((self.x, self.y)) * Affine::rotate_about(self.rot, c)
    }

    /// Conservative world-space bounds (rotation + stroke).
    pub fn bounds(&self) -> Rect {
        let sw = self.stroke.map(|s| s.1).unwrap_or(0.0);
        let r = Rect::new(0.0, 0.0, self.w, self.h).inflate(sw, sw);
        self.local_transform().transform_rect_bbox(r)
    }

    /// Geometry in local coordinates. `None` = axis-aligned rect fast path.
    pub fn path(&self) -> BezPath {
        let (w, h) = (self.w, self.h);
        match &self.kind {
            Kind::Rect => Rect::new(0.0, 0.0, w, h).to_path(0.1),
            Kind::RoundRect(r) => RoundedRect::new(0.0, 0.0, w, h, *r).to_path(0.1),
            Kind::Ellipse => {
                let c = Circle::new((0.0, 0.0), 1.0).to_path(0.001);
                Affine::new([w / 2.0, 0.0, 0.0, h / 2.0, w / 2.0, h / 2.0]) * c
            }
            Kind::Star(n) => {
                let n = *n as usize;
                let mut p = BezPath::new();
                for i in 0..(2 * n) {
                    let a = std::f64::consts::PI * (i as f64) / (n as f64) - std::f64::consts::FRAC_PI_2;
                    let r = if i % 2 == 0 { 0.5 } else { 0.22 };
                    let pt = Point::new(w * (0.5 + r * a.cos()), h * (0.5 + r * a.sin()));
                    if i == 0 { p.move_to(pt) } else { p.line_to(pt) }
                }
                p.close_path();
                p
            }
            Kind::Blob(seed) => {
                let mut rng = Rng(*seed as u64 | 1);
                let k = 5;
                let pts: Vec<Point> = (0..k)
                    .map(|i| {
                        let a = std::f64::consts::TAU * (i as f64) / (k as f64);
                        let r = 0.3 + 0.2 * rng.f();
                        Point::new(w * (0.5 + r * a.cos()), h * (0.5 + r * a.sin()))
                    })
                    .collect();
                let mut p = BezPath::new();
                let mid = |a: Point, b: Point| a.midpoint(b);
                p.move_to(mid(pts[k - 1], pts[0]));
                for i in 0..k {
                    p.quad_to(pts[i], mid(pts[i], pts[(i + 1) % k]));
                }
                p.close_path();
                p
            }
        }
    }

    pub fn is_axis_rect(&self) -> bool {
        self.kind == Kind::Rect && self.rot == 0.0
    }
}

pub fn color(c: Color) -> AlphaColor<Srgb> {
    AlphaColor::from_rgba8(c[0], c[1], c[2], c[3])
}

pub fn gradient(e: &Element) -> Option<Gradient> {
    let stops = |a: Color, b: Color| {
        ColorStops::from([ColorStop::from((0.0, color(a))), ColorStop::from((1.0, color(b)))].as_slice())
    };
    match &e.paint {
        Paint::Linear(a, b) => Some(Gradient {
            kind: LinearGradientPosition { start: Point::new(0.0, 0.0), end: Point::new(e.w, e.h) }.into(),
            stops: stops(*a, *b),
            extend: Extend::Pad,
            ..Default::default()
        }),
        Paint::Radial(a, b) => {
            let c = Point::new(e.w / 2.0, e.h / 2.0);
            Some(Gradient {
                kind: RadialGradientPosition {
                    start_center: c,
                    start_radius: 0.0,
                    end_center: c,
                    end_radius: (e.w.min(e.h) / 2.0) as f32,
                }
                .into(),
                stops: stops(*a, *b),
                extend: Extend::Pad,
                ..Default::default()
            })
        }
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct Doc {
    pub width: f64,
    pub height: f64,
    /// elements[0] is the page background (not selectable)
    pub elements: Vec<Element>,
}

pub const BG: Color = [229, 229, 229, 255];
pub const IMAGE_COUNT: u8 = 4;
pub const IMAGE_SIZE: u16 = 64;

pub struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        // xorshift64*
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    pub fn f(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.f()
    }
    pub fn u(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    pub fn color(&mut self, alpha: bool) -> Color {
        let a = if alpha && self.u(3) == 0 { self.range(140.0, 255.0) as u8 } else { 255 };
        [self.u(256) as u8, self.u(256) as u8, self.u(256) as u8, a]
    }
}

/// Feature mix selector for corpus scenes (0 = everything).
#[derive(Clone, Copy)]
pub struct Mix {
    pub images: bool,
    pub only: Option<u8>,
}

pub fn generate(seed: u64, count: usize, width: f64, height: f64, min: f64, max: f64, mix: Mix) -> Doc {
    let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
    let mut elements = Vec::with_capacity(count + 1);
    elements.push(Element {
        id: 0,
        kind: Kind::Rect,
        paint: Paint::Solid([255, 255, 255, 255]),
        stroke: None,
        x: 0.0,
        y: 0.0,
        w: width,
        h: height,
        rot: 0.0,
    });
    for i in 1..=count {
        let w = rng.range(min, max);
        let h = rng.range(min, max);
        let x = rng.range(0.0, width - w);
        let y = rng.range(0.0, height - h);
        let kind_sel = mix.only.unwrap_or(rng.u(5) as u8);
        let kind = match kind_sel {
            0 => Kind::Rect,
            1 => Kind::RoundRect(rng.range(2.0, w.min(h) / 3.0)),
            2 => Kind::Ellipse,
            3 => Kind::Star(5 + rng.u(3) as u8),
            _ => Kind::Blob(rng.next() as u32),
        };
        let p = rng.u(10);
        let paint = match p {
            0..=4 => Paint::Solid(rng.color(true)),
            5 | 6 => Paint::Linear(rng.color(false), rng.color(true)),
            7 | 8 => Paint::Radial(rng.color(false), rng.color(false)),
            _ if mix.images => Paint::Image(rng.u(IMAGE_COUNT as u64) as u8),
            _ => Paint::Solid(rng.color(false)),
        };
        let stroke = if rng.u(4) == 0 { Some((rng.color(false), rng.range(1.0, 4.0))) } else { None };
        let rot = if rng.u(4) == 0 { rng.range(-0.6, 0.6) } else { 0.0 };
        elements.push(Element { id: i as u32, kind, paint, stroke, x, y, w, h, rot });
    }
    Doc { width, height, elements }
}

/// The S1 page: 10k elements on a 6000x6000 page.
pub fn big_doc(count: usize) -> Doc {
    generate(42, count, 6000.0, 6000.0, 16.0, 140.0, Mix { images: true, only: None })
}

/// Corpus scene `i` (0..200): 256x256, 40 elements, feature focus rotates.
pub fn corpus_doc(i: u32) -> Doc {
    let only = match i % 6 {
        0 => None,
        k => Some((k - 1) as u8),
    };
    generate(1000 + i as u64, 40, 256.0, 256.0, 12.0, 120.0, Mix { images: i % 3 == 0, only })
}

/// Procedural premultiplied test images.
pub fn make_images() -> Vec<Pixmap> {
    (0..IMAGE_COUNT)
        .map(|k| {
            let n = IMAGE_SIZE;
            let mut data = Vec::with_capacity(n as usize * n as usize * 4);
            for y in 0..n {
                for x in 0..n {
                    let checker = ((x / 8) + (y / 8) + k as u16) % 2 == 0;
                    let (r, g, b) = if checker {
                        ((x * 4) as u8, (y * 4) as u8, 60 + 40 * k)
                    } else {
                        (250 - 50 * k, 200, (x * 2 + y * 2) as u8)
                    };
                    data.extend_from_slice(&[r, g, b, 255]);
                }
            }
            Pixmap::from_parts(
                data,
                n,
                n,
                PixelMetadata { may_have_transparency: false, alpha_type: ImageAlphaType::Alpha },
            )
        })
        .collect()
}

/// Uniform grid spatial index (cells of `cell` world units) for culling and tile invalidation.
pub struct Grid {
    pub cell: f64,
    pub cols: usize,
    pub rows: usize,
    pub cells: Vec<Vec<u32>>,
}

impl Grid {
    pub fn build(doc: &Doc, cell: f64) -> Self {
        let cols = (doc.width / cell).ceil() as usize + 1;
        let rows = (doc.height / cell).ceil() as usize + 1;
        let mut g = Self { cell, cols, rows, cells: vec![Vec::new(); cols * rows] };
        for e in doc.elements.iter().skip(1) {
            g.insert(e);
        }
        g
    }
    fn range(&self, r: Rect) -> (usize, usize, usize, usize) {
        let cl = |v: f64, n: usize| (v / self.cell).floor().clamp(0.0, (n - 1) as f64) as usize;
        (cl(r.x0, self.cols), cl(r.y0, self.rows), cl(r.x1, self.cols), cl(r.y1, self.rows))
    }
    pub fn insert(&mut self, e: &Element) {
        let (a, b, c, d) = self.range(e.bounds());
        for y in b..=d {
            for x in a..=c {
                self.cells[y * self.cols + x].push(e.id);
            }
        }
    }
    pub fn remove(&mut self, e: &Element) {
        let (a, b, c, d) = self.range(e.bounds());
        for y in b..=d {
            for x in a..=c {
                self.cells[y * self.cols + x].retain(|&i| i != e.id);
            }
        }
    }
    /// Ids (z-ordered, deduplicated) whose bounds intersect `r`; always includes the page (0).
    pub fn query(&self, doc: &Doc, r: Rect, out: &mut Vec<u32>) {
        out.clear();
        if r.x1 < 0.0 || r.y1 < 0.0 || r.x0 > doc.width || r.y0 > doc.height {
            return;
        }
        out.push(0);
        let (a, b, c, d) = self.range(r);
        for y in b..=d {
            for x in a..=c {
                out.extend_from_slice(&self.cells[y * self.cols + x]);
            }
        }
        out.sort_unstable();
        out.dedup();
        out.retain(|&i| {
            let b = doc.elements[i as usize].bounds();
            b.x1 >= r.x0 && b.y1 >= r.y0 && b.x0 <= r.x1 && b.y0 <= r.y1
        });
    }
}

/// Backend-neutral drawing surface: both `vello_gpu::Scene` and `vello_cpu::RenderContext`
/// implement this with a 1:1 mapping onto their identical method names.
pub trait Painter {
    fn set_transform(&mut self, t: Affine);
    fn set_paint_transform(&mut self, t: Affine);
    fn reset_paint_transform(&mut self);
    fn set_solid(&mut self, c: AlphaColor<Srgb>);
    fn set_gradient(&mut self, g: Gradient);
    fn set_image(&mut self, idx: u8);
    fn fill_path(&mut self, p: &BezPath);
    fn fill_rect(&mut self, r: &Rect);
    fn stroke_path(&mut self, p: &BezPath, s: Stroke);
}

/// Draw `ids` (in the given order) with a global `view` transform (world → device px).
/// `offset` is applied to elements listed in `moved` (drag preview), if any.
pub fn draw<P: Painter>(p: &mut P, doc: &Doc, ids: &[u32], view: Affine, moved: Option<(&[bool], (f64, f64))>) {
    for &id in ids {
        let e = &doc.elements[id as usize];
        let mut t = view * e.local_transform();
        if let Some((mask, (dx, dy))) = moved {
            if mask[id as usize] {
                t = view * Affine::translate((dx, dy)) * e.local_transform();
            }
        }
        draw_one(p, e, t);
    }
}

pub fn draw_one<P: Painter>(p: &mut P, e: &Element, t: Affine) {
    p.set_transform(t);
    match &e.paint {
        Paint::Solid(c) => {
            p.reset_paint_transform();
            p.set_solid(color(*c));
        }
        Paint::Linear(..) | Paint::Radial(..) => {
            p.reset_paint_transform();
            p.set_gradient(gradient(e).unwrap());
        }
        Paint::Image(i) => {
            let s = IMAGE_SIZE as f64;
            p.set_paint_transform(Affine::scale_non_uniform(e.w / s, e.h / s));
            p.set_image(*i);
        }
    }
    if e.is_axis_rect() {
        p.fill_rect(&Rect::new(0.0, 0.0, e.w, e.h));
    } else {
        p.fill_path(&e.path());
    }
    if let Some((c, w)) = e.stroke {
        p.reset_paint_transform();
        p.set_solid(color(c));
        p.stroke_path(&e.path(), Stroke::new(w));
    }
}

// ---------------------------------------------------------------- SVG writer

/// SVG for the elements in `ids` with `view` applied (world → px), `w`×`h` viewport,
/// background `BG`. `images` are embedded as PNG data URIs (caller supplies PNG bytes).
pub fn to_svg(doc: &Doc, ids: &[u32], view: Affine, w: u32, h: u32, images_png: &[Vec<u8>]) -> String {
    let mut s = String::new();
    let _ = write!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><rect width="{w}" height="{h}" fill="{}"/><defs>"#,
        hex(BG)
    );
    for (i, png) in images_png.iter().enumerate() {
        let _ = write!(
            s,
            r#"<image id="img{i}" width="{n}" height="{n}" preserveAspectRatio="none" xlink:href="data:image/png;base64,{}"/>"#,
            base64(png),
            n = IMAGE_SIZE
        );
    }
    s.push_str("</defs>");
    for &id in ids {
        let e = &doc.elements[id as usize];
        let t = view * e.local_transform();
        let c = t.as_coeffs();
        let _ = write!(s, r#"<g transform="matrix({} {} {} {} {} {})">"#, c[0], c[1], c[2], c[3], c[4], c[5]);
        let fill = match &e.paint {
            Paint::Solid(c) => fill_attr(*c),
            Paint::Linear(a, b) => {
                let _ = write!(
                    s,
                    r#"<linearGradient id="g{id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{}" y2="{}"><stop offset="0" {}/><stop offset="1" {}/></linearGradient>"#,
                    e.w, e.h, stop(*a), stop(*b)
                );
                format!(r#"fill="url(#g{id})""#)
            }
            Paint::Radial(a, b) => {
                let _ = write!(
                    s,
                    r#"<radialGradient id="g{id}" gradientUnits="userSpaceOnUse" cx="{cx}" cy="{cy}" r="{r}" fx="{cx}" fy="{cy}"><stop offset="0" {}/><stop offset="1" {}/></radialGradient>"#,
                    stop(*a),
                    stop(*b),
                    cx = e.w / 2.0,
                    cy = e.h / 2.0,
                    r = e.w.min(e.h) / 2.0
                );
                format!(r#"fill="url(#g{id})""#)
            }
            Paint::Image(i) => {
                // pattern in local space scaled to the element box
                let _ = write!(
                    s,
                    r##"<pattern id="p{id}" patternUnits="userSpaceOnUse" width="{}" height="{}"><use xlink:href="#img{i}" transform="scale({} {})"/></pattern>"##,
                    e.w,
                    e.h,
                    e.w / IMAGE_SIZE as f64,
                    e.h / IMAGE_SIZE as f64
                );
                format!(r#"fill="url(#p{id})""#)
            }
        };
        let d = e.path().to_svg();
        let _ = write!(s, r#"<path d="{d}" {fill}/>"#);
        if let Some((c, w)) = e.stroke {
            let _ = write!(s, r#"<path d="{d}" fill="none" stroke="{}" stroke-opacity="{}" stroke-width="{w}"/>"#, hex(c), c[3] as f64 / 255.0);
        }
        s.push_str("</g>");
    }
    s.push_str("</svg>");
    s
}

fn hex(c: Color) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}
fn fill_attr(c: Color) -> String {
    if c[3] == 255 { format!(r#"fill="{}""#, hex(c)) } else { format!(r#"fill="{}" fill-opacity="{}""#, hex(c), c[3] as f64 / 255.0) }
}
fn stop(c: Color) -> String {
    format!(r#"stop-color="{}" stop-opacity="{}""#, hex(c), c[3] as f64 / 255.0)
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len() * 4 / 3 + 4);
    for ch in data.chunks(3) {
        let b = [ch[0], *ch.get(1).unwrap_or(&0), *ch.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if ch.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if ch.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

// ---------------------------------------------------------------- image metrics

/// Mean SSIM over luma (Rec.601) with 8x8 windows, stride 4, on straight or premultiplied RGBA8
/// composited over opaque background (inputs here are opaque). Standard C1/C2 (L=255).
pub fn ssim(a: &[u8], b: &[u8], w: usize, h: usize) -> f64 {
    assert_eq!(a.len(), w * h * 4);
    assert_eq!(b.len(), w * h * 4);
    let luma = |p: &[u8]| -> Vec<f64> {
        p.chunks_exact(4).map(|c| 0.299 * c[0] as f64 + 0.587 * c[1] as f64 + 0.114 * c[2] as f64).collect()
    };
    let (la, lb) = (luma(a), luma(b));
    let (c1, c2) = ((0.01f64 * 255.0).powi(2), (0.03f64 * 255.0).powi(2));
    let win = 8;
    let mut total = 0.0;
    let mut n = 0usize;
    let mut y = 0;
    while y + win <= h {
        let mut x = 0;
        while x + win <= w {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for yy in y..y + win {
                for xx in x..x + win {
                    let (va, vb) = (la[yy * w + xx], lb[yy * w + xx]);
                    sa += va;
                    sb += vb;
                    saa += va * va;
                    sbb += vb * vb;
                    sab += va * vb;
                }
            }
            let m = (win * win) as f64;
            let (ma, mb) = (sa / m, sb / m);
            let va = saa / m - ma * ma;
            let vb = sbb / m - mb * mb;
            let cov = sab / m - ma * mb;
            total += ((2.0 * ma * mb + c1) * (2.0 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
            n += 1;
            x += 4;
        }
        y += 4;
    }
    total / n as f64
}

/// (max abs channel diff, fraction of pixels with any channel diff > 2)
pub fn diff_stats(a: &[u8], b: &[u8]) -> (u8, f64) {
    let mut max = 0u8;
    let mut bad = 0usize;
    for (pa, pb) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        let mut m = 0u8;
        for k in 0..4 {
            m = m.max(pa[k].abs_diff(pb[k]));
        }
        max = max.max(m);
        if m > 2 {
            bad += 1;
        }
    }
    (max, bad as f64 / (a.len() / 4) as f64)
}

/// FNV-1a 64 of a buffer, hex.
pub fn hash(data: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub fn shared_images() -> Vec<Arc<Pixmap>> {
    make_images().into_iter().map(Arc::new).collect()
}

// ---------------------------------------------------------------- camera + selection

/// Device-space camera: screen = world * zoom - (ox, oy). `ox/oy` are integral device px.
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub ox: f64,
    pub oy: f64,
    pub zoom: f64,
    pub w: u32,
    pub h: u32,
}

impl Camera {
    pub fn view(&self) -> Affine {
        Affine::translate((-self.ox, -self.oy)) * Affine::scale(self.zoom)
    }
    pub fn world_rect(&self) -> Rect {
        Rect::new(
            self.ox / self.zoom,
            self.oy / self.zoom,
            (self.ox + self.w as f64) / self.zoom,
            (self.oy + self.h as f64) / self.zoom,
        )
    }
}

/// The `n` selectable elements whose centres are nearest the centre of `r`.
pub fn select_near(doc: &Doc, grid: &Grid, r: Rect, n: usize) -> Vec<u32> {
    let mut ids = Vec::new();
    grid.query(doc, r, &mut ids);
    let c = r.center();
    let mut v: Vec<(f64, u32)> = ids
        .iter()
        .filter(|&&i| i != 0)
        .map(|&i| (doc.elements[i as usize].bounds().center().distance(c), i))
        .collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut out: Vec<u32> = v.into_iter().take(n).map(|x| x.1).collect();
    out.sort_unstable();
    out
}

/// Reference frame order used for every backend comparison: the visible non-lifted elements in
/// z-order, then the lifted ones (on top, at `offset`). This mirrors what the tiled GPU path
/// shows during a drag (lifted layer composited above tiles).
pub fn draw_frame<P: Painter>(p: &mut P, doc: &Doc, grid: &Grid, cam: &Camera, lifted: &[u32], offset: (f64, f64)) {
    let mut ids = Vec::new();
    grid.query(doc, cam.world_rect(), &mut ids);
    let mut mask = vec![false; doc.elements.len()];
    for &i in lifted {
        mask[i as usize] = true;
    }
    ids.retain(|&i| !mask[i as usize]);
    draw(p, doc, &ids, cam.view(), None);
    let v = cam.view() * Affine::translate(offset);
    draw(p, doc, lifted, v, None);
}
