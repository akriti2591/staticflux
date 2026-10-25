//! The SVG writer (C1; IF-7.10): the recorded display list (`record.rs`) as SVG 1.1 + the CSS compositing bits every
//! modern renderer reads (`mix-blend-mode`, `isolation`, `mask-type`).
//!
//! - Every item keeps its **full matrix** (`transform="matrix(a b c d e f)"`): rotation, scale, skew and flips.
//! - Fills and strokes in every paint (solid, linear, radial; conic as a pixel pattern, D21; images as embedded PNG,
//!   clipped to the shape), stacked fills and strokes, dashes, even-odd.
//! - Layers: clip paths, opacity, blend modes, isolated like the renderer's layers; drop / inner shadows and layer
//!   blur as SVG filters in the layer's own space (sRGB, like the renderer); background blur from raster patches.
//! - Masks: `<mask mask-type="alpha">` (clip, alpha and luminance masks are all alpha by the time they are recorded);
//!   inverted masks are luminance masks over white with the mask content painted black.
//! - Text: glyph outlines (exact glyphs, no font needed), labelled with the run's text (`aria-label`).

use crate::plan::{Fallback, Feature, Format, fallback, straight};
use crate::record::{Draw, Item, Layer, bounds, union};
use base64::Engine as _;
use render::ir::Scene;
use std::collections::HashMap;
use std::fmt::Write as _;
use vello_common::color::{AlphaColor, Srgb};
use vello_common::filter_effects::{EdgeMode, Filter, FilterPrimitive};
use vello_common::kurbo::{Affine, BezPath, Cap, Join, PathEl, Rect, Shape, Stroke};
use vello_common::paint::{ImageSource, PaintType};
use vello_common::peniko::{Extend, GradientKind, Mix};

/// Raster patch pixels (straight RGBA), by node.
#[derive(Clone, Debug)]
pub struct PatchImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct SvgOptions {
    /// Output size in px (the viewBox).
    pub width: f64,
    pub height: f64,
    /// Opaque page colour behind everything (None: transparent).
    pub background: Option<[u8; 4]>,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WriteError(pub String);

/// A number as SVG wants it: at most 4 decimals, no trailing zeros, no `-0`.
pub fn num(v: f64) -> String {
    let r = (v * 10_000.0).round() / 10_000.0;
    if r == 0.0 {
        return "0".into();
    }
    let s = format!("{r:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

fn matrix(t: &Affine) -> String {
    let c = t.as_coeffs();
    if c == [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
        return String::new();
    }
    format!(" transform=\"matrix({} {} {} {} {} {})\"", num(c[0]), num(c[1]), num(c[2]), num(c[3]), num(c[4]), num(c[5]))
}

pub fn path_data(path: &BezPath) -> String {
    let mut d = String::new();
    for el in path.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                let _ = write!(d, "M{} {}", num(p.x), num(p.y));
            }
            PathEl::LineTo(p) => {
                let _ = write!(d, "L{} {}", num(p.x), num(p.y));
            }
            PathEl::QuadTo(a, p) => {
                let _ = write!(d, "Q{} {} {} {}", num(a.x), num(a.y), num(p.x), num(p.y));
            }
            PathEl::CurveTo(a, b, p) => {
                let _ = write!(d, "C{} {} {} {} {} {}", num(a.x), num(a.y), num(b.x), num(b.y), num(p.x), num(p.y));
            }
            PathEl::ClosePath => d.push('Z'),
        }
    }
    d
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' => {}
            c => out.push(c),
        }
    }
    out
}

fn hex(c: [f32; 4]) -> String {
    let b = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]))
}

fn components(c: &AlphaColor<Srgb>) -> [f32; 4] {
    c.components
}

fn blend_name(m: Mix) -> Option<&'static str> {
    Some(match m {
        Mix::Normal => return None,
        Mix::Multiply => "multiply",
        Mix::Screen => "screen",
        Mix::Overlay => "overlay",
        Mix::Darken => "darken",
        Mix::Lighten => "lighten",
        Mix::ColorDodge => "color-dodge",
        Mix::ColorBurn => "color-burn",
        Mix::HardLight => "hard-light",
        Mix::SoftLight => "soft-light",
        Mix::Difference => "difference",
        Mix::Exclusion => "exclusion",
        Mix::Hue => "hue",
        Mix::Saturation => "saturation",
        Mix::Color => "color",
        Mix::Luminosity => "luminosity",
    })
}

fn data_uri(rgba: &[u8], w: u32, h: u32) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(crate::png::encode(rgba, w, h)))
}

struct Writer<'a> {
    scene: &'a Scene,
    patches: &'a HashMap<u32, PatchImage>,
    defs: String,
    body: String,
    ids: u32,
    images: HashMap<u32, String>,
    patch_ids: HashMap<u32, String>,
    black_filter: Option<String>,
}

impl Writer<'_> {
    fn id(&mut self, prefix: &str) -> String {
        self.ids += 1;
        format!("{prefix}{}", self.ids)
    }

    /// `<image>` in defs for a scene image (once), its id and size.
    fn image_def(&mut self, image: u32) -> Option<(String, u32, u32)> {
        let px = self.scene.image(image)?;
        let (w, h) = (px.width() as u32, px.height() as u32);
        if let Some(id) = self.images.get(&image) {
            return Some((id.clone(), w, h));
        }
        let id = self.id("img");
        let uri = data_uri(&straight(px), w, h);
        let _ = write!(self.defs, "<image id=\"{id}\" width=\"{w}\" height=\"{h}\" preserveAspectRatio=\"none\" xlink:href=\"{uri}\"/>");
        self.images.insert(image, id.clone());
        Some((id, w, h))
    }

    fn black(&mut self) -> String {
        if let Some(id) = &self.black_filter {
            return id.clone();
        }
        let id = self.id("k");
        let _ = write!(self.defs, "<filter id=\"{id}\" color-interpolation-filters=\"sRGB\"><feColorMatrix type=\"matrix\" values=\"0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0\"/></filter>");
        self.black_filter = Some(id.clone());
        id
    }

    /// The `fill="…"` / `stroke="…"` attributes of a paint (gradients and conic patterns go to defs). None: the
    /// paint is an image (drawn separately) or unknown.
    fn paint(&mut self, which: &str, draw: &Draw, local: Rect, black: bool) -> Option<String> {
        match &draw.paint {
            PaintType::Solid(c) => {
                let mut c = components(c);
                if black {
                    c = [0.0, 0.0, 0.0, c[3]];
                }
                let opacity = if c[3] < 1.0 { format!(" {which}-opacity=\"{}\"", num(c[3] as f64)) } else { String::new() };
                Some(format!(" {which}=\"{}\"{opacity}", hex(c)))
            }
            PaintType::Gradient(g) => {
                let stops = crate::pixels::stops(g, black);
                let spread = match g.extend {
                    Extend::Pad => "",
                    Extend::Repeat => " spreadMethod=\"repeat\"",
                    Extend::Reflect => " spreadMethod=\"reflect\"",
                };
                let transform = {
                    let m = matrix(&draw.paint_transform);
                    m.replace(" transform=", " gradientTransform=")
                };
                let stop_xml = |stops: &[(f32, [f32; 4])]| -> String {
                    stops
                        .iter()
                        .map(|(o, c)| {
                            let op = if c[3] < 1.0 { format!(" stop-opacity=\"{}\"", num(c[3] as f64)) } else { String::new() };
                            format!("<stop offset=\"{}\" stop-color=\"{}\"{op}/>", num(*o as f64), hex(*c))
                        })
                        .collect()
                };
                let id = self.id("g");
                match &g.kind {
                    GradientKind::Linear(p) => {
                        let _ = write!(
                            self.defs,
                            "<linearGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\"{spread}{transform}>{}</linearGradient>",
                            num(p.start.x),
                            num(p.start.y),
                            num(p.end.x),
                            num(p.end.y),
                            stop_xml(&stops)
                        );
                    }
                    GradientKind::Radial(p) => {
                        let _ = write!(
                            self.defs,
                            "<radialGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" fx=\"{}\" fy=\"{}\" fr=\"{}\" cx=\"{}\" cy=\"{}\" r=\"{}\"{spread}{transform}>{}</radialGradient>",
                            num(p.start_center.x),
                            num(p.start_center.y),
                            num(p.start_radius as f64),
                            num(p.end_center.x),
                            num(p.end_center.y),
                            num(p.end_radius as f64),
                            stop_xml(&stops)
                        );
                    }
                    GradientKind::Sweep(_) => {
                        // D21: SVG has no conic gradient; the writer computes it as pixels over the shape's box.
                        debug_assert_eq!(fallback(Format::Svg, Feature::SweepGradient), Some(Fallback::PixelPattern));
                        let px = crate::pixels::sweep(g, draw.paint_transform, draw.transform, local, black)?;
                        let uri = data_uri(&px.rgba, px.width, px.height);
                        let _ = write!(
                            self.defs,
                            "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" x=\"{x}\" y=\"{y}\" width=\"{bw}\" height=\"{bh}\"><image width=\"{bw}\" height=\"{bh}\" x=\"{x}\" y=\"{y}\" preserveAspectRatio=\"none\" xlink:href=\"{uri}\"/></pattern>",
                            x = num(px.local.x0),
                            y = num(px.local.y0),
                            bw = num(px.local.width()),
                            bh = num(px.local.height())
                        );
                    }
                }
                Some(format!(" {which}=\"url(#{id})\""))
            }
            PaintType::Image(_) => None,
        }
    }

    /// An image paint over `path`: the image at its paint transform, clipped to the shape (repeat: a pattern).
    fn image_fill(&mut self, draw: &Draw, path: &BezPath, even_odd: bool, black: bool) {
        let PaintType::Image(brush) = &draw.paint else { return };
        let image = match &brush.image {
            ImageSource::OpaqueId { id, .. } => id.as_u32(),
            _ => return,
        };
        let Some((img, w, h)) = self.image_def(image) else { return };
        let filter = if black { format!(" filter=\"url(#{})\"", self.black()) } else { String::new() };
        let rule = if even_odd { " fill-rule=\"evenodd\" clip-rule=\"evenodd\"" } else { "" };
        if brush.sampler.x_extend == Extend::Repeat || brush.sampler.y_extend == Extend::Repeat {
            let id = self.id("p");
            let pt = matrix(&draw.paint_transform).replace(" transform=", " patternTransform=");
            let _ = write!(self.defs, "<pattern id=\"{id}\" patternUnits=\"userSpaceOnUse\" width=\"{w}\" height=\"{h}\"{pt}><use xlink:href=\"#{img}\"/></pattern>");
            let _ = write!(self.body, "<path{}{filter} d=\"{}\" fill=\"url(#{id})\"{rule}/>", matrix(&draw.transform), path_data(path));
            return;
        }
        let clip = self.id("c");
        let _ = write!(self.defs, "<clipPath id=\"{clip}\"><path{} d=\"{}\"{rule}/></clipPath>", matrix(&draw.transform), path_data(path));
        let _ = write!(self.body, "<g clip-path=\"url(#{clip})\"{filter}><use xlink:href=\"#{img}\"{}/></g>", matrix(&(draw.transform * draw.paint_transform)));
    }

    fn stroke_attrs(stroke: &Stroke) -> String {
        let mut a = format!(" fill=\"none\" stroke-width=\"{}\"", num(stroke.width));
        a.push_str(match stroke.join {
            Join::Bevel => " stroke-linejoin=\"bevel\"",
            Join::Round => " stroke-linejoin=\"round\"",
            Join::Miter => "",
        });
        a.push_str(match stroke.start_cap {
            Cap::Square => " stroke-linecap=\"square\"",
            Cap::Round => " stroke-linecap=\"round\"",
            Cap::Butt => "",
        });
        if stroke.join == Join::Miter && (stroke.miter_limit - 4.0).abs() > 1e-9 {
            let _ = write!(a, " stroke-miterlimit=\"{}\"", num(stroke.miter_limit.max(1.0)));
        }
        if !stroke.dash_pattern.is_empty() {
            let dashes: Vec<String> = stroke.dash_pattern.iter().map(|d| num(*d)).collect();
            let _ = write!(a, " stroke-dasharray=\"{}\"", dashes.join(" "));
            if stroke.dash_offset != 0.0 {
                let _ = write!(a, " stroke-dashoffset=\"{}\"", num(stroke.dash_offset));
            }
        }
        a
    }

    fn items(&mut self, items: &[Item], black: bool) -> Result<(), WriteError> {
        for item in items {
            self.item(item, black)?;
        }
        Ok(())
    }

    fn item(&mut self, item: &Item, black: bool) -> Result<(), WriteError> {
        match item {
            Item::Fill { draw, path, even_odd } => {
                if crate::plan::degenerate(&draw.transform) {
                    return Ok(());
                }
                if matches!(draw.paint, PaintType::Image(_)) {
                    self.image_fill(draw, path, *even_odd, black);
                    return Ok(());
                }
                if let Some(fill) = self.paint("fill", draw, path.bounding_box(), black) {
                    let rule = if *even_odd { " fill-rule=\"evenodd\"" } else { "" };
                    let _ = write!(self.body, "<path{} d=\"{}\"{fill}{rule}/>", matrix(&draw.transform), path_data(path));
                }
            }
            Item::Glyphs { draw, run, outline } => {
                if crate::plan::degenerate(&draw.transform) || outline.elements().is_empty() {
                    return Ok(());
                }
                let label = if run.text.is_empty() { String::new() } else { format!(" aria-label=\"{}\"", escape(&run.text)) };
                if matches!(draw.paint, PaintType::Image(_)) {
                    self.image_fill(draw, outline, false, black);
                } else if let Some(fill) = self.paint("fill", draw, outline.bounding_box(), black) {
                    let _ = write!(self.body, "<path{}{label} d=\"{}\"{fill}/>", matrix(&draw.transform), path_data(outline));
                }
            }
            Item::Stroke { draw, path, stroke } => {
                if crate::plan::degenerate(&draw.transform) {
                    return Ok(());
                }
                let local = path.bounding_box().inflate(stroke.width, stroke.width);
                let paint = match &draw.paint {
                    PaintType::Image(_) => {
                        // An image stroke: the stroke's outline filled with the image.
                        let outline = vello_common::kurbo::stroke(path.iter(), stroke, &Default::default(), 0.1);
                        self.image_fill(draw, &outline, false, black);
                        return Ok(());
                    }
                    _ => self.paint("stroke", draw, local, black),
                };
                if let Some(paint) = paint {
                    let _ = write!(self.body, "<path{} d=\"{}\"{}{paint}/>", matrix(&draw.transform), path_data(path), Self::stroke_attrs(stroke));
                }
            }
            Item::Layer(layer) => self.layer(layer, black)?,
            Item::Masked { content, mask, invert } => {
                let region = if *invert { union(content.iter().filter_map(bounds)) } else { union(mask.iter().filter_map(bounds)) };
                let Some(region) = region else { return Ok(()) };
                let region = region.inflate(2.0, 2.0);
                let id = self.id("m");
                let body = std::mem::take(&mut self.body);
                if *invert {
                    let _ = write!(self.body, "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#ffffff\"/>", num(region.x0), num(region.y0), num(region.width()), num(region.height()));
                }
                self.items(mask, *invert || black)?;
                let mask_body = std::mem::replace(&mut self.body, body);
                let kind = if *invert { "luminance" } else { "alpha" };
                let _ = write!(
                    self.defs,
                    "<mask id=\"{id}\" maskUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" mask-type=\"{kind}\" style=\"mask-type:{kind}\">{mask_body}</mask>",
                    num(region.x0),
                    num(region.y0),
                    num(region.width()),
                    num(region.height())
                );
                let _ = write!(self.body, "<g mask=\"url(#{id})\">");
                self.items(content, black)?;
                self.body.push_str("</g>");
            }
            Item::Patch { node, world, view, clip } => {
                let Some(px) = self.patches.get(node) else { return Err(WriteError(format!("raster patch for node {node} is missing"))) };
                let id = match self.patch_ids.get(node) {
                    Some(id) => id.clone(),
                    None => {
                        let id = self.id("r");
                        let uri = data_uri(&px.rgba, px.width, px.height);
                        let _ = write!(self.defs, "<image id=\"{id}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" xlink:href=\"{uri}\"/>", px.width, px.height);
                        self.patch_ids.insert(*node, id.clone());
                        id
                    }
                };
                let place = *view * Affine::translate((world.x0, world.y0)) * Affine::scale_non_uniform(world.width() / px.width as f64, world.height() / px.height as f64);
                let filter = if black { format!(" filter=\"url(#{})\"", self.black()) } else { String::new() };
                let clip_attr = match clip {
                    Some(c) => {
                        let cid = self.id("c");
                        let _ = write!(self.defs, "<clipPath id=\"{cid}\"><path{} d=\"{}\"/></clipPath>", matrix(view), path_data(c));
                        format!(" clip-path=\"url(#{cid})\"")
                    }
                    None => String::new(),
                };
                let _ = write!(self.body, "<g{clip_attr}{filter}><use xlink:href=\"#{id}\"{}/></g>", matrix(&place));
            }
        }
        Ok(())
    }

    fn filter(&mut self, filter: &Filter, region: Rect) -> Option<String> {
        let primitive = filter.graph.primitives.first()?;
        let id = self.id("f");
        let r = format!(
            "<filter id=\"{id}\" filterUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" color-interpolation-filters=\"sRGB\">",
            num(region.x0),
            num(region.y0),
            num(region.width()),
            num(region.height())
        );
        let shadow = |dx: f32, dy: f32, std: f32, c: &AlphaColor<Srgb>| -> String {
            let c = components(c);
            format!(
                "<feGaussianBlur in=\"SourceAlpha\" stdDeviation=\"{}\"/><feOffset dx=\"{}\" dy=\"{}\" result=\"o\"/><feFlood flood-color=\"{}\" flood-opacity=\"{}\"/><feComposite in2=\"o\" operator=\"in\" result=\"s\"/>",
                num(std as f64),
                num(dx as f64),
                num(dy as f64),
                hex(c),
                num(c[3] as f64)
            )
        };
        let body = match primitive {
            FilterPrimitive::GaussianBlur { std_deviation, edge_mode } => {
                let edge = if *edge_mode == EdgeMode::Duplicate { " edgeMode=\"duplicate\"" } else { "" };
                format!("<feGaussianBlur stdDeviation=\"{}\"{edge}/>", num(*std_deviation as f64))
            }
            FilterPrimitive::DropShadowOnly { dx, dy, std_deviation, color, .. } => shadow(*dx, *dy, *std_deviation, color),
            FilterPrimitive::DropShadow { dx, dy, std_deviation, color, .. } => {
                format!("{}<feMerge><feMergeNode in=\"s\"/><feMergeNode in=\"SourceGraphic\"/></feMerge>", shadow(*dx, *dy, *std_deviation, color))
            }
            _ => return None,
        };
        let _ = write!(self.defs, "{r}{body}</filter>");
        Some(id)
    }

    fn layer(&mut self, layer: &Layer, black: bool) -> Result<(), WriteError> {
        let mut open = String::from("<g");
        let mut style = vec!["isolation:isolate".to_string()];
        if let Some(name) = blend_name(layer.blend) {
            style.push(format!("mix-blend-mode:{name}"));
        }
        let _ = write!(open, " style=\"{}\"", style.join(";"));
        if layer.opacity < 1.0 {
            let _ = write!(open, " opacity=\"{}\"", num(layer.opacity as f64));
        }
        if let Some(clip) = &layer.clip {
            let id = self.id("c");
            let _ = write!(self.defs, "<clipPath id=\"{id}\"><path{} d=\"{}\"/></clipPath>", matrix(&layer.transform), path_data(clip));
            let _ = write!(open, " clip-path=\"url(#{id})\"");
        }
        open.push('>');
        // Filters work in the layer's own space: wrap the content in T · filter · T⁻¹.
        let filtered = match &layer.filter {
            Some(f) if !crate::plan::degenerate(&layer.transform) => {
                let inner = union(layer.items.iter().filter_map(bounds));
                match inner {
                    None => return Ok(()),
                    Some(inner) => {
                        let inv = layer.transform.inverse();
                        let local = inv.transform_rect_bbox(inner);
                        let e = f.graph.filter_expansion(&Affine::IDENTITY);
                        let region = Rect::new(local.x0 + e.x0.min(0.0), local.y0 + e.y0.min(0.0), local.x1 + e.x1.max(0.0), local.y1 + e.y1.max(0.0)).inflate(1.0, 1.0);
                        self.filter(f, region).map(|id| (id, inv))
                    }
                }
            }
            _ => None,
        };
        self.body.push_str(&open);
        match filtered {
            Some((id, inv)) => {
                let _ = write!(self.body, "<g{}><g filter=\"url(#{id})\"><g{}>", matrix(&layer.transform), matrix(&inv));
                self.items(&layer.items, black)?;
                self.body.push_str("</g></g></g>");
            }
            None => self.items(&layer.items, black)?,
        }
        self.body.push_str("</g>");
        Ok(())
    }
}

/// Write the display list as an SVG document.
pub fn write(scene: &Scene, items: &[Item], patches: &HashMap<u32, PatchImage>, options: &SvgOptions) -> Result<String, WriteError> {
    let mut w = Writer { scene, patches, defs: String::new(), body: String::new(), ids: 0, images: HashMap::new(), patch_ids: HashMap::new(), black_filter: None };
    if let Some(bg) = options.background {
        let c = [bg[0] as f32 / 255.0, bg[1] as f32 / 255.0, bg[2] as f32 / 255.0, bg[3] as f32 / 255.0];
        let op = if bg[3] < 255 { format!(" fill-opacity=\"{}\"", num(c[3] as f64)) } else { String::new() };
        let _ = write!(w.body, "<rect width=\"{}\" height=\"{}\" fill=\"{}\"{op}/>", num(options.width), num(options.height), hex(c));
    }
    w.items(items, false)?;
    let mut out = String::with_capacity(w.defs.len() + w.body.len() + 256);
    let _ = write!(
        out,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" version=\"1.1\" width=\"{w_}\" height=\"{h_}\" viewBox=\"0 0 {w_} {h_}\">",
        w_ = num(options.width),
        h_ = num(options.height)
    );
    if !options.title.is_empty() {
        let _ = write!(out, "<title>{}</title>", escape(&options.title));
    }
    if !w.defs.is_empty() {
        let _ = write!(out, "<defs>{}</defs>", w.defs);
    }
    out.push_str(&w.body);
    out.push_str("</svg>");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_and_matrices_compactly() {
        assert_eq!(num(1.0), "1");
        assert_eq!(num(-0.00001), "0");
        assert_eq!(num(2.50004), "2.5");
        assert_eq!(num(-3.14159), "-3.1416");
        assert_eq!(matrix(&Affine::IDENTITY), "");
        assert_eq!(matrix(&Affine::new([-1.0, 0.0, 0.25, 1.0, 10.0, 0.0])), " transform=\"matrix(-1 0 0.25 1 10 0)\"");
        assert_eq!(escape("a<b & \"c\""), "a&lt;b &amp; &quot;c&quot;");
        let mut p = BezPath::new();
        p.move_to((0.0, 0.0));
        p.quad_to((1.0, 2.0), (3.0, 4.0));
        p.curve_to((1.0, 1.0), (2.0, 2.0), (3.0, 3.0));
        p.line_to((5.0, 0.5));
        p.close_path();
        assert_eq!(path_data(&p), "M0 0Q1 2 3 4C1 1 2 2 3 3L5 0.5Z");
        assert_eq!(blend_name(Mix::Multiply), Some("multiply"));
        assert_eq!(blend_name(Mix::Normal), None);
    }
}
