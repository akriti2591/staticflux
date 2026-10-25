//! The PDF writer (C1; IF-7.10, IF-29.x): the recorded display list as PDF 1.7 through `pdf-writer`.
//!
//! - **Real text.** Every glyph run is text: Type 3 fonts built from the run's own glyph outlines (unhinted, at the
//!   run's variation coordinates, exactly the paths the canvas draws) and advances, with a ToUnicode map, and each run
//!   in an `/ActualText` span carrying the run's text (scene IR v4), so text selects, searches and extracts as
//!   written whatever the shaping (ligatures, Arabic, Devanagari clusters). Only the glyphs used are written.
//!   Synthetic italic is the run's shear; synthetic bold is the recorded stroke. Text filled with a gradient or an
//!   image draws its outlines with that paint under invisible text (still selectable and extractable).
//! - **Vector everything else**: every item keeps its full matrix (`cm`: rotation, scale, skew, flips); solid fills
//!   and strokes with opacity, linear and radial gradients as shadings (stops with alpha through a luminosity soft
//!   mask), images (clipped to the shape; tiles repeated), dashes, even-odd, clip paths, opacity and blend modes as
//!   isolated transparency groups, masks as soft masks (inverted: a luminosity mask over white with the mask content
//!   painted black).
//! - From the D21 rasterize list: shadows and blurs are raster patches, conic gradients pixel patterns.
//!
//! Coordinates: the page starts with `cm` = scale(0.75) · flip-y, so everything below is in output px, y down (1 px =
//! 0.75 pt, the CSS reference pixel at 96 dpi: a 1080 × 1350 px design is an 810 × 1012.5 pt page). Shadings are
//! painted with `sh` under the item's own transform, so no pattern matrices are needed.
//!
//! Why not krilla (S7's pick): in the export Wasm it measured 481 KB brotli (its font scaler links skrifa's hinters,
//! and subsetter, write-fonts and image decoders come along), over the 400 KB IF-15.1 budget; this writer on krilla's
//! own foundation (`pdf-writer`) keeps the whole export Wasm far below it.

use crate::plan::{Fallback, Feature, Format, degenerate, fallback};
use crate::record::{Draw, Item, Layer, bounds, union};
use crate::svg::PatchImage;
use flate2::Compression;
use flate2::write::ZlibEncoder;
use pdf_writer::types::{BlendMode as PdfBlend, FunctionShadingType, LineCapStyle, LineJoinStyle, MaskType};
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect as PdfRect, Ref, Str, TextStr};
use render::glyphs::{font_glyph, units_per_em};
use render::ir::{FontHash, GlyphRun, Scene};
use std::collections::HashMap;
use std::io::Write;
use vello_common::kurbo::{Affine, BezPath, Cap, Join, PathEl, Point, Rect, Shape, Stroke};
use vello_common::paint::{ImageSource, PaintType};
use vello_common::peniko::{FontData, Gradient, GradientKind, Mix};

/// Points per CSS px.
pub const PT_PER_PX: f64 = 0.75;
/// Codes per Type 3 font (single-byte encodings).
const CODES: usize = 256;
/// Most image tiles drawn for one tiled image paint.
const MAX_TILES: usize = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct PdfError(pub String);

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut z = ZlibEncoder::new(Vec::with_capacity(data.len() / 2 + 16), Compression::new(6));
    let _ = z.write_all(data);
    z.finish().unwrap_or_default()
}

fn m(a: &Affine) -> [f32; 6] {
    a.as_coeffs().map(|v| v as f32)
}

/// Append `p` to the content (quadratics as the cubics they are: PDF has cubics only).
fn path(c: &mut Content, p: &BezPath) {
    let mut start = Point::ZERO;
    let mut at = Point::ZERO;
    for el in p.elements() {
        match *el {
            PathEl::MoveTo(a) => {
                c.move_to(a.x as f32, a.y as f32);
                start = a;
                at = a;
            }
            PathEl::LineTo(a) => {
                c.line_to(a.x as f32, a.y as f32);
                at = a;
            }
            PathEl::QuadTo(q, b) => {
                let c1 = at + (q - at) * (2.0 / 3.0);
                let c2 = b + (q - b) * (2.0 / 3.0);
                c.cubic_to(c1.x as f32, c1.y as f32, c2.x as f32, c2.y as f32, b.x as f32, b.y as f32);
                at = b;
            }
            PathEl::CurveTo(a, b, d) => {
                c.cubic_to(a.x as f32, a.y as f32, b.x as f32, b.y as f32, d.x as f32, d.y as f32);
                at = d;
            }
            PathEl::ClosePath => {
                c.close_path();
                at = start;
            }
        }
    }
}

fn blend(mix: Mix) -> Option<PdfBlend> {
    Some(match mix {
        Mix::Normal => return None,
        Mix::Multiply => PdfBlend::Multiply,
        Mix::Screen => PdfBlend::Screen,
        Mix::Overlay => PdfBlend::Overlay,
        Mix::Darken => PdfBlend::Darken,
        Mix::Lighten => PdfBlend::Lighten,
        Mix::ColorDodge => PdfBlend::ColorDodge,
        Mix::ColorBurn => PdfBlend::ColorBurn,
        Mix::HardLight => PdfBlend::HardLight,
        Mix::SoftLight => PdfBlend::SoftLight,
        Mix::Difference => PdfBlend::Difference,
        Mix::Exclusion => PdfBlend::Exclusion,
        Mix::Hue => PdfBlend::Hue,
        Mix::Saturation => PdfBlend::Saturation,
        Mix::Color => PdfBlend::Color,
        Mix::Luminosity => PdfBlend::Luminosity,
    })
}

/// Names a content stream uses (its resource dictionary).
#[derive(Default)]
struct Res {
    gs: Vec<Ref>,
    xo: Vec<Ref>,
    sh: Vec<Ref>,
    fonts: Vec<Ref>,
}

fn named(list: &mut Vec<Ref>, r: Ref, prefix: &str) -> String {
    let i = list.iter().position(|x| *x == r).unwrap_or_else(|| {
        list.push(r);
        list.len() - 1
    });
    format!("{prefix}{i}")
}

impl Res {
    fn gs(&mut self, r: Ref) -> String {
        named(&mut self.gs, r, "G")
    }
    fn xo(&mut self, r: Ref) -> String {
        named(&mut self.xo, r, "X")
    }
    fn sh(&mut self, r: Ref) -> String {
        named(&mut self.sh, r, "S")
    }
    fn font(&mut self, r: Ref) -> String {
        named(&mut self.fonts, r, "F")
    }
    fn write(&self, mut resources: pdf_writer::writers::Resources) {
        let lists: [(&Vec<Ref>, &str); 4] = [(&self.gs, "G"), (&self.xo, "X"), (&self.sh, "S"), (&self.fonts, "F")];
        for (kind, (list, prefix)) in lists.iter().enumerate() {
            if list.is_empty() {
                continue;
            }
            let mut dict = match kind {
                0 => resources.ext_g_states(),
                1 => resources.x_objects(),
                2 => resources.shadings(),
                _ => resources.fonts(),
            };
            for (i, r) in list.iter().enumerate() {
                let name = format!("{prefix}{i}");
                dict.pair(Name(name.as_bytes()), *r);
            }
            dict.finish();
        }
        resources.finish();
    }
}

/// One content stream being written (a page or a form XObject).
struct Stream {
    c: Content,
    res: Res,
}

impl Stream {
    fn new() -> Self {
        Stream { c: Content::new(), res: Res::default() }
    }
}

/// A face instance (font file × variation coordinates) as Type 3 fonts of up to 256 codes each.
struct FontInstance {
    face: FontData,
    coords: Vec<i16>,
    upem: f32,
    /// glyph → (chunk, code, advance)
    codes: HashMap<u32, (usize, u8, f32)>,
    chunks: Vec<Chunk>,
}

struct Chunk {
    font: Ref,
    glyphs: Vec<u32>,
    unicode: Vec<Option<String>>,
}

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
struct GsKey {
    fill: u32,
    stroke: u32,
    blend: u8,
    mask: Option<Ref>,
}

/// A multi-page PDF built page by page (each page from the scene applied at the time).
pub struct PdfWriter {
    pdf: Pdf,
    next: i32,
    pages: Vec<Ref>,
    tree: Ref,
    fonts: HashMap<(FontHash, Vec<i16>), usize>,
    instances: Vec<FontInstance>,
    gstates: HashMap<GsKey, Ref>,
}

impl Default for PdfWriter {
    fn default() -> Self {
        Self::new()
    }
}

struct Page<'a> {
    scene: &'a Scene,
    patches: &'a HashMap<u32, PatchImage>,
    images: HashMap<u32, Ref>,
    patch_refs: HashMap<u32, Ref>,
}

/// One glyph placed by `PdfWriter::code`.
struct Coded {
    font: Ref,
    code: u8,
    advance: f32,
}

impl PdfWriter {
    pub fn new() -> Self {
        let mut pdf = Pdf::new();
        pdf.set_version(1, 7);
        PdfWriter { pdf, next: 2, pages: Vec::new(), tree: Ref::new(1), fonts: HashMap::new(), instances: Vec::new(), gstates: HashMap::new() }
    }

    pub fn pages(&self) -> usize {
        self.pages.len()
    }

    fn alloc(&mut self) -> Ref {
        let r = Ref::new(self.next);
        self.next += 1;
        r
    }

    /// An ExtGState (deduplicated): fill and stroke alpha, blend mode, soft mask.
    fn gs(&mut self, fill: f32, stroke: f32, mix: Mix, mask: Option<(Ref, MaskType)>) -> Ref {
        let key = GsKey { fill: fill.to_bits(), stroke: stroke.to_bits(), blend: mix as u8, mask: mask.map(|(r, _)| r) };
        if let Some(r) = self.gstates.get(&key) {
            return *r;
        }
        let r = self.alloc();
        let mut g = self.pdf.ext_graphics(r);
        g.non_stroking_alpha(fill.clamp(0.0, 1.0)).stroking_alpha(stroke.clamp(0.0, 1.0));
        if let Some(b) = blend(mix) {
            g.blend_mode(b);
        }
        if let Some((group, kind)) = mask {
            let mut sm = g.soft_mask();
            sm.subtype(kind).group(group);
            if kind == MaskType::Luminosity {
                sm.backdrop([0.0, 0.0, 0.0]);
            }
            sm.finish();
        }
        g.finish();
        self.gstates.insert(key, r);
        r
    }

    /// Write `stream` as an isolated transparency group form over `bbox` (output px).
    fn form(&mut self, stream: Stream, bbox: Rect, gray: bool) -> Ref {
        let r = self.alloc();
        let data = deflate(&stream.c.finish());
        let mut f = self.pdf.form_xobject(r, &data);
        f.filter(Filter::FlateDecode);
        f.bbox(PdfRect::new(bbox.x0 as f32, bbox.y0 as f32, bbox.x1 as f32, bbox.y1 as f32));
        {
            let mut g = f.group();
            g.transparency().isolated(true);
            if gray {
                g.color_space().device_gray();
            } else {
                g.color_space().device_rgb();
            }
        }
        stream.res.write(f.resources());
        f.finish();
        r
    }

    fn image(&mut self, rgba: &[u8], w: u32, h: u32) -> Ref {
        let n = (w * h) as usize;
        let mut rgb = Vec::with_capacity(n * 3);
        let mut alpha = Vec::with_capacity(n);
        for p in rgba.chunks_exact(4) {
            rgb.extend_from_slice(&p[..3]);
            alpha.push(p[3]);
        }
        let mask = if alpha.iter().all(|a| *a == 255) {
            None
        } else {
            let r = self.alloc();
            let data = deflate(&alpha);
            let mut im = self.pdf.image_xobject(r, &data);
            im.filter(Filter::FlateDecode);
            im.width(w as i32).height(h as i32).bits_per_component(8).interpolate(true);
            im.color_space().device_gray();
            im.finish();
            Some(r)
        };
        let r = self.alloc();
        let data = deflate(&rgb);
        let mut im = self.pdf.image_xobject(r, &data);
        im.filter(Filter::FlateDecode);
        im.width(w as i32).height(h as i32).bits_per_component(8).interpolate(true);
        im.color_space().device_rgb();
        if let Some(sm) = mask {
            im.s_mask(sm);
        }
        im.finish();
        r
    }

    /// An axial or radial shading for `g` (colours, or the stops' alpha as gray when `alpha`).
    fn shading(&mut self, g: &Gradient, black: bool, alpha: bool) -> Option<Ref> {
        let mut stops = crate::pixels::stops(g, black);
        if stops.is_empty() {
            return None;
        }
        // The function covers 0…1: pad with the end colours, keep the bounds strictly increasing.
        if stops[0].0 > 0.0 {
            stops.insert(0, (0.0, stops[0].1));
        }
        let last = *stops.last()?;
        if last.0 < 1.0 {
            stops.push((1.0, last.1));
        }
        if stops.len() == 1 {
            stops.push((1.0, stops[0].1));
        }
        let mut prev = 0.0f32;
        for (i, s) in stops.iter_mut().enumerate() {
            if i > 0 && s.0 <= prev {
                s.0 = prev + 1e-5;
            }
            prev = s.0;
        }
        let channels = |c: [f32; 4]| -> Vec<f32> { if alpha { vec![c[3]] } else { vec![c[0], c[1], c[2]] } };
        let mut parts = Vec::new();
        for w in stops.windows(2) {
            let f = self.alloc();
            let mut e = self.pdf.exponential_function(f);
            e.domain([0.0, 1.0]).c0(channels(w[0].1)).c1(channels(w[1].1)).n(1.0);
            e.finish();
            parts.push((f, w[1].0));
        }
        let end = stops.last().map_or(1.0, |s| s.0).max(1.0);
        let function = if parts.len() == 1 {
            parts[0].0
        } else {
            let f = self.alloc();
            let mut s = self.pdf.stitching_function(f);
            s.domain([0.0, end]).functions(parts.iter().map(|p| p.0)).bounds(parts[..parts.len() - 1].iter().map(|p| p.1));
            s.encode(parts.iter().flat_map(|_| [0.0, 1.0]));
            s.finish();
            f
        };
        let r = self.alloc();
        let mut sh = self.pdf.function_shading(r);
        match &g.kind {
            GradientKind::Linear(l) => {
                sh.shading_type(FunctionShadingType::Axial).coords([l.start.x as f32, l.start.y as f32, l.end.x as f32, l.end.y as f32]);
            }
            GradientKind::Radial(rg) => {
                sh.shading_type(FunctionShadingType::Radial).coords([rg.start_center.x as f32, rg.start_center.y as f32, rg.start_radius, rg.end_center.x as f32, rg.end_center.y as f32, rg.end_radius]);
            }
            GradientKind::Sweep(_) => return None,
        }
        if alpha {
            sh.color_space().device_gray();
        } else {
            sh.color_space().device_rgb();
        }
        sh.function(function).extend([true, true]);
        sh.finish();
        Some(r)
    }

    fn font_instance(&mut self, scene: &Scene, run: &GlyphRun) -> Option<usize> {
        let hash = *scene.font_hash(run.font)?;
        let key = (hash, run.coords.clone());
        if let Some(i) = self.fonts.get(&key) {
            return Some(*i);
        }
        let face = scene.font(run.font)?.clone();
        let upem = units_per_em(&face)?;
        self.instances.push(FontInstance { face, coords: run.coords.clone(), upem, codes: HashMap::new(), chunks: Vec::new() });
        let i = self.instances.len() - 1;
        self.fonts.insert(key, i);
        Some(i)
    }

    /// Where a glyph is in the instance's Type 3 fonts (added on first use); `text`: the cluster it starts, for
    /// the ToUnicode map.
    fn code(&mut self, instance: usize, glyph: u32, text: Option<String>) -> Coded {
        if let Some(&(chunk, code, advance)) = self.instances[instance].codes.get(&glyph) {
            let c = &mut self.instances[instance].chunks[chunk];
            if c.unicode[code as usize].is_none() {
                c.unicode[code as usize] = text;
            }
            return Coded { font: c.font, code, advance };
        }
        if self.instances[instance].chunks.last().is_none_or(|c| c.glyphs.len() >= CODES) {
            let font = self.alloc();
            self.instances[instance].chunks.push(Chunk { font, glyphs: Vec::new(), unicode: Vec::new() });
        }
        let inst = &mut self.instances[instance];
        let advance = font_glyph(&inst.face, glyph, &inst.coords).map_or(0.0, |g| g.advance);
        let chunk = inst.chunks.len() - 1;
        let c = &mut inst.chunks[chunk];
        let code = c.glyphs.len() as u8;
        c.glyphs.push(glyph);
        c.unicode.push(text);
        let font = c.font;
        inst.codes.insert(glyph, (chunk, code, advance));
        Coded { font, code, advance }
    }

    /// Add a page of `width × height` px drawing `list` (output px), over `background` (None: transparent).
    pub fn page(&mut self, scene: &Scene, list: &[Item], patches: &HashMap<u32, PatchImage>, width: f64, height: f64, background: Option<[u8; 4]>) -> Result<(), PdfError> {
        if !(width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()) {
            return Err(PdfError(format!("invalid page size {width}×{height}")));
        }
        let mut page = Page { scene, patches, images: HashMap::new(), patch_refs: HashMap::new() };
        let mut s = Stream::new();
        s.c.transform([PT_PER_PX as f32, 0.0, 0.0, -(PT_PER_PX as f32), 0.0, (height * PT_PER_PX) as f32]);
        if let Some(bg) = background {
            s.c.save_state();
            if bg[3] < 255 {
                let g = self.gs(bg[3] as f32 / 255.0, 1.0, Mix::Normal, None);
                let name = s.res.gs(g);
                s.c.set_parameters(Name(name.as_bytes()));
            }
            s.c.set_fill_rgb(bg[0] as f32 / 255.0, bg[1] as f32 / 255.0, bg[2] as f32 / 255.0);
            s.c.rect(0.0, 0.0, width as f32, height as f32);
            s.c.fill_nonzero();
            s.c.restore_state();
        }
        self.items(&mut s, list, false, &mut page)?;
        let content = self.alloc();
        let data = deflate(&s.c.finish());
        self.pdf.stream(content, &data).filter(Filter::FlateDecode);
        let id = self.alloc();
        let mut p = self.pdf.page(id);
        p.media_box(PdfRect::new(0.0, 0.0, (width * PT_PER_PX) as f32, (height * PT_PER_PX) as f32)).parent(self.tree).contents(content);
        s.res.write(p.resources());
        p.finish();
        self.pages.push(id);
        Ok(())
    }

    fn items(&mut self, s: &mut Stream, list: &[Item], black: bool, page: &mut Page) -> Result<(), PdfError> {
        for item in list {
            self.item(s, item, black, page)?;
        }
        Ok(())
    }

    fn item(&mut self, s: &mut Stream, item: &Item, black: bool, page: &mut Page) -> Result<(), PdfError> {
        match item {
            Item::Fill { draw, path: p, even_odd } => self.fill(s, draw, p, *even_odd, black, page),
            Item::Stroke { draw, path: p, stroke } => {
                if degenerate(&draw.transform) {
                    return Ok(());
                }
                match &draw.paint {
                    PaintType::Solid(c) => {
                        let mut c = c.components;
                        if black {
                            c = [0.0, 0.0, 0.0, c[3]];
                        }
                        s.c.save_state();
                        if c[3] < 1.0 {
                            let g = self.gs(1.0, c[3], Mix::Normal, None);
                            let n = s.res.gs(g);
                            s.c.set_parameters(Name(n.as_bytes()));
                        }
                        s.c.transform(m(&draw.transform));
                        s.c.set_stroke_rgb(c[0], c[1], c[2]);
                        stroke_style(&mut s.c, stroke);
                        path(&mut s.c, p);
                        s.c.stroke();
                        s.c.restore_state();
                    }
                    // Gradient and image strokes: the stroke's outline, filled with the paint.
                    _ => {
                        let outline = vello_common::kurbo::stroke(p.iter(), stroke, &Default::default(), 0.1);
                        self.fill(s, draw, &outline, false, black, page);
                    }
                }
            }
            Item::Glyphs { draw, run, outline } => self.glyphs(s, draw, run, outline, black, page),
            Item::Layer(layer) => self.layer(s, layer, black, page)?,
            Item::Masked { content, mask, invert } => {
                let region = if *invert { union(content.iter().filter_map(bounds)) } else { union(mask.iter().filter_map(bounds)) };
                let Some(region) = region else { return Ok(()) };
                let region = region.inflate(2.0, 2.0);
                let mut ms = Stream::new();
                if *invert {
                    ms.c.set_fill_rgb(1.0, 1.0, 1.0);
                    ms.c.rect(region.x0 as f32, region.y0 as f32, region.width() as f32, region.height() as f32);
                    ms.c.fill_nonzero();
                }
                self.items(&mut ms, mask, *invert || black, page)?;
                let mask_form = self.form(ms, region, false);
                let mut cs = Stream::new();
                self.items(&mut cs, content, black, page)?;
                let content_bounds = union(content.iter().filter_map(bounds)).unwrap_or(region).inflate(2.0, 2.0);
                let content_form = self.form(cs, content_bounds, false);
                let g = self.gs(1.0, 1.0, Mix::Normal, Some((mask_form, if *invert { MaskType::Luminosity } else { MaskType::Alpha })));
                let gn = s.res.gs(g);
                let xn = s.res.xo(content_form);
                s.c.save_state();
                s.c.set_parameters(Name(gn.as_bytes()));
                s.c.x_object(Name(xn.as_bytes()));
                s.c.restore_state();
            }
            Item::Patch { node, world, view, clip } => {
                let Some(px) = page.patches.get(node) else { return Err(PdfError(format!("raster patch for node {node} is missing"))) };
                let r = match page.patch_refs.get(node) {
                    Some(r) => *r,
                    None => {
                        let r = self.image(&px.rgba, px.width, px.height);
                        page.patch_refs.insert(*node, r);
                        r
                    }
                };
                let place = *view * Affine::translate((world.x0, world.y0)) * Affine::scale_non_uniform(world.width() / px.width as f64, world.height() / px.height as f64);
                s.c.save_state();
                if let Some(c) = clip {
                    path(&mut s.c, &(*view * c.clone()));
                    s.c.clip_nonzero();
                    s.c.end_path();
                }
                self.draw_image(s, r, place, px.width, px.height, black);
                s.c.restore_state();
            }
        }
        Ok(())
    }

    /// Draw image `r` (`w × h` px) with `place` (image px → output); `black`: its alpha, in black.
    fn draw_image(&mut self, s: &mut Stream, r: Ref, place: Affine, w: u32, h: u32, black: bool) {
        // The image's unit square (row 0 at v = 1) in image px, y down.
        let unit = place * Affine::new([w as f64, 0.0, 0.0, -(h as f64), 0.0, h as f64]);
        if black {
            let mut ms = Stream::new();
            let n = ms.res.xo(r);
            ms.c.save_state();
            ms.c.transform(m(&unit));
            ms.c.x_object(Name(n.as_bytes()));
            ms.c.restore_state();
            let bbox = place.transform_rect_bbox(Rect::new(0.0, 0.0, w as f64, h as f64));
            let mask = self.form(ms, bbox, false);
            let g = self.gs(1.0, 1.0, Mix::Normal, Some((mask, MaskType::Alpha)));
            let gn = s.res.gs(g);
            s.c.save_state();
            s.c.set_parameters(Name(gn.as_bytes()));
            s.c.set_fill_rgb(0.0, 0.0, 0.0);
            s.c.rect(bbox.x0 as f32, bbox.y0 as f32, bbox.width() as f32, bbox.height() as f32);
            s.c.fill_nonzero();
            s.c.restore_state();
            return;
        }
        let n = s.res.xo(r);
        s.c.save_state();
        s.c.transform(m(&unit));
        s.c.x_object(Name(n.as_bytes()));
        s.c.restore_state();
    }

    /// Image `id` of the scene as an image XObject (once per page).
    fn scene_image(&mut self, id: u32, page: &mut Page) -> Option<(Ref, u32, u32)> {
        let px = page.scene.image(id)?;
        let (w, h) = (px.width() as u32, px.height() as u32);
        if let Some(r) = page.images.get(&id) {
            return Some((*r, w, h));
        }
        let rgba = crate::plan::straight(px);
        let r = self.image(&rgba, w, h);
        page.images.insert(id, r);
        Some((r, w, h))
    }

    fn fill(&mut self, s: &mut Stream, draw: &Draw, p: &BezPath, even_odd: bool, black: bool, page: &mut Page) {
        if degenerate(&draw.transform) {
            return;
        }
        let clip = |c: &mut Content| {
            path(c, p);
            if even_odd {
                c.clip_even_odd();
            } else {
                c.clip_nonzero();
            }
            c.end_path();
        };
        match &draw.paint {
            PaintType::Solid(c) => {
                let mut c = c.components;
                if black {
                    c = [0.0, 0.0, 0.0, c[3]];
                }
                s.c.save_state();
                if c[3] < 1.0 {
                    let g = self.gs(c[3], 1.0, Mix::Normal, None);
                    let n = s.res.gs(g);
                    s.c.set_parameters(Name(n.as_bytes()));
                }
                s.c.transform(m(&draw.transform));
                s.c.set_fill_rgb(c[0], c[1], c[2]);
                path(&mut s.c, p);
                if even_odd {
                    s.c.fill_even_odd();
                } else {
                    s.c.fill_nonzero();
                }
                s.c.restore_state();
            }
            PaintType::Gradient(g) if matches!(g.kind, GradientKind::Sweep(_)) => {
                debug_assert_eq!(fallback(Format::Pdf, Feature::SweepGradient), Some(Fallback::PixelPattern));
                let Some(px) = crate::pixels::sweep(g, draw.paint_transform, draw.transform, p.bounding_box(), black) else { return };
                let r = self.image(&px.rgba, px.width, px.height);
                s.c.save_state();
                s.c.transform(m(&draw.transform));
                clip(&mut s.c);
                let place = Affine::translate((px.local.x0, px.local.y0)) * Affine::scale_non_uniform(px.local.width() / px.width as f64, px.local.height() / px.height as f64);
                self.draw_image(s, r, place, px.width, px.height, false);
                s.c.restore_state();
            }
            PaintType::Gradient(g) => {
                let Some(color) = self.shading(g, black, false) else { return };
                let translucent = crate::pixels::stops(g, false).iter().any(|st| st.1[3] < 1.0);
                let space = draw.transform * draw.paint_transform;
                s.c.save_state();
                s.c.transform(m(&draw.transform));
                clip(&mut s.c);
                s.c.transform(m(&draw.paint_transform));
                if translucent && !degenerate(&space) {
                    if let Some(alpha) = self.shading(g, black, true) {
                        // The stops' alpha as a luminosity mask in the same (gradient) space.
                        let mut ms = Stream::new();
                        let n = ms.res.sh(alpha);
                        ms.c.shading(Name(n.as_bytes()));
                        let local = draw.paint_transform.inverse().transform_rect_bbox(p.bounding_box()).inflate(1.0, 1.0);
                        let mask = self.form(ms, local, true);
                        let gs = self.gs(1.0, 1.0, Mix::Normal, Some((mask, MaskType::Luminosity)));
                        let gn = s.res.gs(gs);
                        s.c.set_parameters(Name(gn.as_bytes()));
                    }
                }
                let n = s.res.sh(color);
                s.c.shading(Name(n.as_bytes()));
                s.c.restore_state();
            }
            PaintType::Image(brush) => {
                let ImageSource::OpaqueId { id, .. } = &brush.image else { return };
                let Some((r, w, h)) = self.scene_image(id.as_u32(), page) else { return };
                s.c.save_state();
                s.c.transform(m(&draw.transform));
                clip(&mut s.c);
                let repeat = brush.sampler.x_extend == vello_common::peniko::Extend::Repeat || brush.sampler.y_extend == vello_common::peniko::Extend::Repeat;
                if repeat && !degenerate(&draw.paint_transform) {
                    // Tiles covering the shape, in image space.
                    let cover = draw.paint_transform.inverse().transform_rect_bbox(p.bounding_box());
                    let (x0, x1) = ((cover.x0 / w as f64).floor() as i64, (cover.x1 / w as f64).ceil() as i64);
                    let (y0, y1) = ((cover.y0 / h as f64).floor() as i64, (cover.y1 / h as f64).ceil() as i64);
                    let mut drawn = 0;
                    'tiles: for ty in y0..y1 {
                        for tx in x0..x1 {
                            if drawn >= MAX_TILES {
                                break 'tiles;
                            }
                            let place = draw.paint_transform * Affine::translate(((tx * w as i64) as f64, (ty * h as i64) as f64));
                            self.draw_image(s, r, place, w, h, black);
                            drawn += 1;
                        }
                    }
                } else {
                    self.draw_image(s, r, draw.paint_transform, w, h, black);
                }
                s.c.restore_state();
            }
        }
    }

    fn glyphs(&mut self, s: &mut Stream, draw: &Draw, run: &GlyphRun, outline: &BezPath, black: bool, page: &mut Page) {
        if degenerate(&draw.transform) || run.glyphs.is_empty() {
            return;
        }
        let Some(instance) = self.font_instance(page.scene, run) else {
            self.fill(s, draw, outline, false, black, page);
            return;
        };
        // Solid paints colour the text itself; other paints draw the outline under invisible text.
        let solid = match &draw.paint {
            PaintType::Solid(c) => Some(if black { [0.0, 0.0, 0.0, c.components[3]] } else { c.components }),
            _ => None,
        };
        if solid.is_none() {
            self.fill(s, draw, outline, false, black, page);
        }
        let upem = self.instances[instance].upem;
        let size = run.size.max(0.01);
        let y0 = run.glyphs[0].2;
        let shear = if run.skew != 0.0 { Affine::translate((0.0, y0 as f64)) * Affine::skew(-(run.skew as f64).to_radians().tan(), 0.0) * Affine::translate((0.0, -(y0 as f64))) } else { Affine::IDENTITY };
        s.c.save_state();
        let alpha = solid.map_or(0.0, |c| c[3]);
        if alpha < 1.0 {
            let g = self.gs(alpha, 1.0, Mix::Normal, None);
            let n = s.res.gs(g);
            s.c.set_parameters(Name(n.as_bytes()));
        }
        s.c.transform(m(&(draw.transform * shear)));
        if let Some(c) = solid {
            s.c.set_fill_rgb(c[0], c[1], c[2]);
        }
        if !run.text.is_empty() {
            let mut mc = s.c.begin_marked_content_with_properties(Name(b"Span"));
            mc.properties().actual_text(TextStr(&run.text));
        }
        s.c.begin_text();
        // Segments of one font chunk on one baseline; the pen follows Parley's positions exactly.
        let mut i = 0;
        while i < run.glyphs.len() {
            let (g0, x0, gy) = run.glyphs[i];
            let first = cluster_start(run, i);
            let lead = self.code(instance, g0, first);
            let fname = s.res.font(lead.font);
            s.c.set_font(Name(fname.as_bytes()), 1.0);
            s.c.set_text_matrix([size, 0.0, 0.0, -size, x0, gy]);
            let mut codes: Vec<(u8, f32)> = vec![(lead.code, 0.0)];
            let mut pen = x0 + lead.advance / upem * size;
            let mut j = i + 1;
            while j < run.glyphs.len() {
                let (g, x, y) = run.glyphs[j];
                if (y - gy).abs() > 1e-3 {
                    break;
                }
                let next = self.code(instance, g, cluster_start(run, j));
                if next.font != lead.font {
                    break;
                }
                // TJ adjustment: thousandths of text space (1 unit = `size` px); positive moves the pen back.
                codes.push((next.code, -(x - pen) / size * 1000.0));
                pen = x + next.advance / upem * size;
                j += 1;
            }
            {
                let mut tj = s.c.show_positioned();
                let mut items = tj.items();
                for (c, adjust) in &codes {
                    if adjust.abs() > 1e-3 {
                        items.adjust(*adjust);
                    }
                    items.show(Str(&[*c]));
                }
            }
            i = j;
        }
        s.c.end_text();
        if !run.text.is_empty() {
            s.c.end_marked_content();
        }
        s.c.restore_state();
    }

    fn layer(&mut self, s: &mut Stream, layer: &Layer, black: bool, page: &mut Page) -> Result<(), PdfError> {
        // Filters never reach a PDF (D21: their nodes are patches). If one does, a shadow-only layer draws nothing
        // and a blur draws its content sharp.
        if let Some(f) = &layer.filter {
            if matches!(f.graph.primitives.first(), Some(vello_common::filter_effects::FilterPrimitive::DropShadowOnly { .. })) {
                return Ok(());
            }
        }
        s.c.save_state();
        if let Some(clip) = &layer.clip {
            if !degenerate(&layer.transform) {
                path(&mut s.c, &(layer.transform * clip.clone()));
                s.c.clip_nonzero();
                s.c.end_path();
            }
        }
        if layer.opacity < 1.0 || layer.blend != Mix::Normal {
            let Some(b) = union(layer.items.iter().filter_map(bounds)) else {
                s.c.restore_state();
                return Ok(());
            };
            let mut inner = Stream::new();
            self.items(&mut inner, &layer.items, black, page)?;
            let form = self.form(inner, b.inflate(1.0, 1.0), false);
            let g = self.gs(layer.opacity, layer.opacity, if black { Mix::Normal } else { layer.blend }, None);
            let gn = s.res.gs(g);
            let xn = s.res.xo(form);
            s.c.set_parameters(Name(gn.as_bytes()));
            s.c.x_object(Name(xn.as_bytes()));
        } else {
            self.items(s, &layer.items, black, page)?;
        }
        s.c.restore_state();
        Ok(())
    }

    fn write_fonts(&mut self) {
        let instances = std::mem::take(&mut self.instances);
        for inst in &instances {
            let scale = 1.0 / inst.upem;
            for chunk in &inst.chunks {
                let mut procs = Vec::with_capacity(chunk.glyphs.len());
                let mut widths = Vec::with_capacity(chunk.glyphs.len());
                let mut bbox: Option<Rect> = None;
                for &g in &chunk.glyphs {
                    let glyph = font_glyph(&inst.face, g, &inst.coords);
                    let advance = glyph.as_ref().map_or(0.0, |g| g.advance);
                    let mut c = Content::new();
                    match glyph.as_ref().and_then(|g| g.outline.as_ref()) {
                        Some(outline) => {
                            let b = outline.bounding_box();
                            bbox = Some(bbox.map_or(b, |a| a.union(b)));
                            c.start_shape_glyph(advance, b.x0 as f32, b.y0 as f32, b.x1 as f32, b.y1 as f32);
                            path(&mut c, outline);
                            c.fill_nonzero();
                        }
                        None => {
                            c.start_shape_glyph(advance, 0.0, 0.0, 0.0, 0.0);
                        }
                    }
                    let r = self.alloc();
                    let data = deflate(&c.finish());
                    self.pdf.stream(r, &data).filter(Filter::FlateDecode);
                    procs.push(r);
                    widths.push(advance);
                }
                let cmap_ref = self.alloc();
                let data = deflate(to_unicode(&chunk.unicode).as_bytes());
                self.pdf.stream(cmap_ref, &data).filter(Filter::FlateDecode);
                let b = bbox.unwrap_or(Rect::ZERO);
                let names: Vec<String> = (0..chunk.glyphs.len()).map(|i| format!("g{i}")).collect();
                let mut f = self.pdf.type3_font(chunk.font);
                f.bbox(PdfRect::new(b.x0 as f32, b.y0 as f32, b.x1 as f32, b.y1 as f32)).matrix([scale, 0.0, 0.0, scale, 0.0, 0.0]);
                {
                    let mut cp = f.char_procs();
                    for (n, r) in names.iter().zip(&procs) {
                        cp.pair(Name(n.as_bytes()), *r);
                    }
                }
                f.encoding_custom().differences().consecutive(0, names.iter().map(|n| Name(n.as_bytes())));
                f.first_char(0).last_char((chunk.glyphs.len() - 1) as u8).widths(widths);
                f.resources().finish();
                f.to_unicode(cmap_ref);
                f.finish();
            }
        }
    }

    /// The document's bytes (`title` in its info dictionary).
    pub fn finish(mut self, title: &str) -> Result<Vec<u8>, PdfError> {
        if self.pages.is_empty() {
            return Err(PdfError("no PDF page was added".into()));
        }
        self.write_fonts();
        let catalog = self.alloc();
        let pages = self.pages.clone();
        self.pdf.pages(self.tree).kids(pages.iter().copied()).count(pages.len() as i32);
        self.pdf.catalog(catalog).pages(self.tree);
        let info = self.alloc();
        let mut d = self.pdf.document_info(info);
        if !title.is_empty() {
            d.title(TextStr(title));
        }
        d.producer(TextStr("Instaflow"));
        d.finish();
        Ok(self.pdf.finish())
    }
}

/// The text of the cluster glyph `i` starts (None when it continues the previous glyph's cluster or the run has no
/// text).
fn cluster_start(run: &GlyphRun, i: usize) -> Option<String> {
    let (start, end) = *run.clusters.get(i)?;
    if i > 0 && run.clusters.get(i - 1).is_some_and(|p| p.0 == start) {
        return None;
    }
    run.text.get(start as usize..end as usize).map(str::to_string).filter(|t| !t.is_empty())
}

fn stroke_style(c: &mut Content, stroke: &Stroke) {
    c.set_line_width(stroke.width as f32);
    c.set_line_cap(match stroke.start_cap {
        Cap::Butt => LineCapStyle::ButtCap,
        Cap::Round => LineCapStyle::RoundCap,
        Cap::Square => LineCapStyle::ProjectingSquareCap,
    });
    c.set_line_join(match stroke.join {
        Join::Bevel => LineJoinStyle::BevelJoin,
        Join::Miter => LineJoinStyle::MiterJoin,
        Join::Round => LineJoinStyle::RoundJoin,
    });
    c.set_miter_limit(stroke.miter_limit.max(1.0) as f32);
    if !stroke.dash_pattern.is_empty() {
        c.set_dash_pattern(stroke.dash_pattern.iter().map(|d| *d as f32), stroke.dash_offset as f32);
    }
}

/// A ToUnicode CMap for one Type 3 chunk (codes without text are left out).
pub fn to_unicode(unicode: &[Option<String>]) -> String {
    let mut out = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n",
    );
    let entries: Vec<(usize, &String)> = unicode.iter().enumerate().filter_map(|(i, t)| t.as_ref().map(|t| (i, t))).collect();
    for block in entries.chunks(100) {
        out.push_str(&format!("{} beginbfchar\n", block.len()));
        for (code, text) in block {
            let hex: String = text.encode_utf16().map(|u| format!("{u:04X}")).collect();
            out.push_str(&format!("<{code:02X}> <{hex}>\n"));
        }
        out.push_str("endbfchar\n");
    }
    out.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_to_unicode_map() {
        let cmap = to_unicode(&[Some("A".into()), None, Some("fi".into()), Some("😀".into())]);
        assert!(cmap.contains("3 beginbfchar"));
        assert!(cmap.contains("<00> <0041>"));
        assert!(cmap.contains("<02> <00660069>"));
        assert!(cmap.contains("<03> <D83DDE00>"));
        assert!(!cmap.contains("<01>"));
    }

    #[test]
    fn quadratics_become_cubics_from_the_pen_position() {
        let mut p = BezPath::new();
        p.move_to((0.0, 0.0));
        p.quad_to((3.0, 3.0), (6.0, 0.0));
        let mut c = Content::new();
        path(&mut c, &p);
        let text = String::from_utf8(c.finish().to_vec()).unwrap();
        assert!(text.contains("2 2 4 2 6 0 c"), "{text}");
    }

    #[test]
    fn cluster_starts_map_each_cluster_once() {
        let run = GlyphRun::new(1, 10.0, vec![(1, 0.0, 0.0), (2, 5.0, 0.0), (3, 9.0, 0.0)]).with_text("fié", vec![(0, 2), (0, 2), (2, 4)]);
        assert_eq!(cluster_start(&run, 0).as_deref(), Some("fi"));
        assert_eq!(cluster_start(&run, 1), None);
        assert_eq!(cluster_start(&run, 2).as_deref(), Some("é"));
    }
}
