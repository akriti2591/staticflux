//! S7: krilla PDF writer over the same IR (vector paths, gradients, images, optional real text).
use ir::vello_common::kurbo::{Affine, PathEl};
use ir::{Doc, Paint};
use krilla::Document;
use krilla::color::rgb;
use krilla::geom::{PathBuilder, Point, Size, Transform};
use krilla::image::Image;
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, FillRule, LinearGradient, RadialGradient, SpreadMethod, Stop, Stroke};

fn tr(a: Affine) -> Transform {
    let c = a.as_coeffs();
    Transform::from_row(c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32, c[4] as f32, c[5] as f32)
}

fn path(p: &ir::vello_common::kurbo::BezPath) -> krilla::geom::Path {
    let mut b = PathBuilder::new();
    for el in p.elements() {
        match *el {
            PathEl::MoveTo(q) => b.move_to(q.x as f32, q.y as f32),
            PathEl::LineTo(q) => b.line_to(q.x as f32, q.y as f32),
            PathEl::QuadTo(a, q) => b.quad_to(a.x as f32, a.y as f32, q.x as f32, q.y as f32),
            PathEl::CurveTo(a, c, q) => b.cubic_to(a.x as f32, a.y as f32, c.x as f32, c.y as f32, q.x as f32, q.y as f32),
            PathEl::ClosePath => b.close(),
        }
    }
    b.finish().unwrap()
}

fn n(v: f32) -> NormalizedF32 {
    NormalizedF32::new(v.clamp(0.0, 1.0)).unwrap()
}
fn col(c: ir::Color) -> krilla::color::Color {
    rgb::Color::new(c[0], c[1], c[2]).into()
}
fn stops(a: ir::Color, b: ir::Color) -> Vec<Stop> {
    vec![
        Stop { offset: n(0.0), color: col(a), opacity: n(a[3] as f32 / 255.0) },
        Stop { offset: n(1.0), color: col(b), opacity: n(b[3] as f32 / 255.0) },
    ]
}

/// One page of `w`×`h` pt (1 pt = 1 px of the raster references), background BG.
pub fn to_pdf(doc: &Doc, ids: &[u32], view: Affine, w: f32, h: f32, images_rgba: &[Vec<u8>], text: Option<(Vec<u8>, &str)>) -> Vec<u8> {
    let mut document = Document::new();
    let mut page = document.start_page_with(PageSettings::from_wh(w, h).unwrap());
    let mut s = page.surface();
    let images: Vec<Image> = images_rgba.iter().map(|d| Image::from_rgba8(d.clone(), ir::IMAGE_SIZE as u32, ir::IMAGE_SIZE as u32)).collect();
    let mut bgp = PathBuilder::new();
    bgp.push_rect(krilla::geom::Rect::from_xywh(0.0, 0.0, w, h).unwrap());
    s.set_fill(Some(Fill { paint: col(ir::BG).into(), opacity: NormalizedF32::ONE, rule: FillRule::NonZero }));
    s.draw_path(&bgp.finish().unwrap());
    for &id in ids {
        let e = &doc.elements[id as usize];
        let p = path(&e.path());
        s.push_transform(&tr(view * e.local_transform()));
        match &e.paint {
            Paint::Solid(c) => {
                s.set_fill(Some(Fill { paint: col(*c).into(), opacity: n(c[3] as f32 / 255.0), rule: FillRule::NonZero }));
                s.draw_path(&p);
            }
            Paint::Linear(a, b) => {
                let g = LinearGradient { x1: 0.0, y1: 0.0, x2: e.w as f32, y2: e.h as f32, transform: Transform::identity(), spread_method: SpreadMethod::Pad, stops: stops(*a, *b), anti_alias: true };
                s.set_fill(Some(Fill { paint: g.into(), opacity: NormalizedF32::ONE, rule: FillRule::NonZero }));
                s.draw_path(&p);
            }
            Paint::Radial(a, b) => {
                let (cx, cy, r) = ((e.w / 2.0) as f32, (e.h / 2.0) as f32, (e.w.min(e.h) / 2.0) as f32);
                let g = RadialGradient { fx: cx, fy: cy, fr: 0.0, cx, cy, cr: r, transform: Transform::identity(), spread_method: SpreadMethod::Pad, stops: stops(*a, *b), anti_alias: true };
                s.set_fill(Some(Fill { paint: g.into(), opacity: NormalizedF32::ONE, rule: FillRule::NonZero }));
                s.draw_path(&p);
            }
            Paint::Image(i) => {
                s.push_clip_path(&p, &FillRule::NonZero);
                s.draw_image(images[*i as usize].clone(), Size::from_wh(e.w as f32, e.h as f32).unwrap());
                s.pop();
            }
        }
        if let Some((c, sw)) = e.stroke {
            s.set_fill(None);
            s.set_stroke(Some(Stroke { paint: col(c).into(), width: sw as f32, opacity: n(c[3] as f32 / 255.0), ..Default::default() }));
            s.draw_path(&p);
            s.set_stroke(None);
        }
        s.pop();
    }
    #[cfg(feature = "text")]
    if let Some((font, t)) = text {
        let font = krilla::text::Font::new(font.into(), 0).unwrap();
        s.set_fill(Some(Fill { paint: col([0, 0, 0, 255]).into(), opacity: NormalizedF32::ONE, rule: FillRule::NonZero }));
        s.draw_text(Point::from_xy(20.0, h - 20.0), font, 28.0, t, false, krilla::text::TextDirection::Auto);
    }
    #[cfg(not(feature = "text"))]
    let _ = (text, Point::from_xy(0.0, 0.0));
    s.finish();
    page.finish();
    document.finish().unwrap()
}

/// Wasm size probe entry point (no wasm-bindgen): builds corpus scene `i` as PDF, returns byte length.
#[unsafe(no_mangle)]
pub extern "C" fn pdf_corpus_len(i: u32) -> u32 {
    let d = ir::corpus_doc(i);
    let ids: Vec<u32> = (0..d.elements.len() as u32).collect();
    let imgs: Vec<Vec<u8>> = ir::make_images().iter().map(|p| p.data_as_u8_slice().to_vec()).collect();
    to_pdf(&d, &ids, Affine::IDENTITY, 256.0, 256.0, &imgs, None).len() as u32
}
