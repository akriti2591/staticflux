//! vello_cpu reference backend + SVG writer + metrics, exported to JS (wasm) and to the native tool.
use ir::{Camera, Doc, Grid, Painter};
use std::sync::Arc;
use vello_cpu::color::{AlphaColor, Srgb};
use vello_cpu::kurbo::{Affine, BezPath, Rect, Stroke};
use vello_cpu::peniko::{Gradient, ImageSampler};
use vello_cpu::{Image, ImageSource, Pixmap, RasterizerSettings, RenderContext, RenderMode, Resources};

pub struct CpuPainter<'a> {
    pub ctx: &'a mut RenderContext,
    pub images: &'a [Arc<Pixmap>],
}

impl Painter for CpuPainter<'_> {
    fn set_transform(&mut self, t: Affine) { self.ctx.set_transform(t) }
    fn set_paint_transform(&mut self, t: Affine) { self.ctx.set_paint_transform(t) }
    fn reset_paint_transform(&mut self) { self.ctx.reset_paint_transform() }
    fn set_solid(&mut self, c: AlphaColor<Srgb>) { self.ctx.set_paint(c) }
    fn set_gradient(&mut self, g: Gradient) { self.ctx.set_paint(g) }
    fn set_image(&mut self, idx: u8) {
        self.ctx.set_paint(Image {
            image: ImageSource::Pixmap(self.images[idx as usize].clone()),
            sampler: ImageSampler::default(),
        })
    }
    fn fill_path(&mut self, p: &BezPath) { self.ctx.fill_path(p) }
    fn fill_rect(&mut self, r: &Rect) { self.ctx.fill_rect(r) }
    fn stroke_path(&mut self, p: &BezPath, s: Stroke) {
        self.ctx.set_stroke(s);
        self.ctx.stroke_path(p)
    }
}

/// Render a frame (premultiplied RGBA8; opaque because of the BG clear).
pub fn render_frame(doc: &Doc, grid: &Grid, cam: &Camera, lifted: &[u32], offset: (f64, f64), quality: bool) -> Vec<u8> {
    let images = ir::shared_images();
    let mut ctx = RenderContext::new(cam.w as u16, cam.h as u16);
    {
        let mut p = CpuPainter { ctx: &mut ctx, images: &images };
        ir::draw_frame(&mut p, doc, grid, cam, lifted, offset);
    }
    ctx.flush();
    let mut pixmap = Pixmap::new(cam.w as u16, cam.h as u16);
    let mut res = Resources::new();
    ctx.render_with(
        &mut pixmap,
        &mut res,
        RasterizerSettings {
            render_mode: if quality { RenderMode::OptimizeQuality } else { RenderMode::OptimizeSpeed },
            target_init: vello_cpu::TargetInit::Clear(ir::color(ir::BG)),
            ..Default::default()
        },
    );
    pixmap.data_as_u8_slice().to_vec()
}

pub fn images_png() -> Vec<Vec<u8>> {
    ir::make_images().into_iter().map(|p| rgba_to_png(p.data_as_u8_slice(), p.width() as u32, p.height() as u32)).collect()
}

pub fn corpus_camera() -> Camera {
    Camera { ox: 0.0, oy: 0.0, zoom: 1.0, w: 256, h: 256 }
}

pub fn big_camera(ox: f64, oy: f64, zoom: f64, w: u32, h: u32) -> Camera {
    Camera { ox, oy, zoom, w, h }
}

pub fn svg_frame(doc: &Doc, grid: &Grid, cam: &Camera) -> String {
    let mut ids = Vec::new();
    grid.query(doc, cam.world_rect(), &mut ids);
    ir::to_svg(doc, &ids, cam.view(), cam.w, cam.h, &images_png())
}

pub fn rgba_to_png(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().unwrap();
        wr.write_image_data(rgba).unwrap();
    }
    out
}

#[cfg(target_arch = "wasm32")]
mod js {
    use super::*;
    use wasm_bindgen::prelude::*;

    thread_local! {
        static BIG: std::cell::RefCell<Option<(Doc, Grid)>> = const { std::cell::RefCell::new(None) };
    }

    fn with_big<R>(count: usize, f: impl FnOnce(&Doc, &Grid) -> R) -> R {
        BIG.with(|b| {
            let mut b = b.borrow_mut();
            if b.as_ref().map(|(d, _)| d.elements.len() != count + 1).unwrap_or(true) {
                let d = ir::big_doc(count);
                let g = Grid::build(&d, 256.0);
                *b = Some((d, g));
            }
            let (d, g) = b.as_ref().unwrap();
            f(d, g)
        })
    }

    /// Render the big doc with `lifted_n` elements lifted (selected near view centre) at offset.
    #[wasm_bindgen]
    pub fn cpu_render_big(count: usize, ox: f64, oy: f64, zoom: f64, w: u32, h: u32, lifted_n: usize, dx: f64, dy: f64, quality: bool) -> Vec<u8> {
        with_big(count, |d, g| {
            let cam = big_camera(ox, oy, zoom, w, h);
            let lifted = if lifted_n > 0 { ir::select_near(d, g, cam.world_rect(), lifted_n) } else { vec![] };
            render_frame(d, g, &cam, &lifted, (dx, dy), quality)
        })
    }

    #[wasm_bindgen]
    pub fn svg_big(count: usize, ox: f64, oy: f64, zoom: f64, w: u32, h: u32) -> String {
        with_big(count, |d, g| svg_frame(d, g, &big_camera(ox, oy, zoom, w, h)))
    }

    #[wasm_bindgen]
    pub fn cpu_render_corpus(i: u32) -> Vec<u8> {
        let d = ir::corpus_doc(i);
        let g = Grid::build(&d, 64.0);
        render_frame(&d, &g, &corpus_camera(), &[], (0.0, 0.0), false)
    }

    #[wasm_bindgen]
    pub fn svg_corpus(i: u32) -> String {
        let d = ir::corpus_doc(i);
        let g = Grid::build(&d, 64.0);
        svg_frame(&d, &g, &corpus_camera())
    }

    #[wasm_bindgen]
    pub fn ssim(a: &[u8], b: &[u8], w: usize, h: usize) -> f64 { ir::ssim(a, b, w, h) }

    /// [max channel diff, fraction of pixels with diff > 2]
    #[wasm_bindgen]
    pub fn diff(a: &[u8], b: &[u8]) -> Vec<f64> {
        let (m, f) = ir::diff_stats(a, b);
        vec![m as f64, f]
    }

    #[wasm_bindgen]
    pub fn hash(a: &[u8]) -> String { ir::hash(a) }

    #[wasm_bindgen]
    pub fn png(rgba: &[u8], w: u32, h: u32) -> Vec<u8> { rgba_to_png(rgba, w, h) }
}
