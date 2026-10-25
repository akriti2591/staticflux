//! `vello_cpu` reference rasterizer (IF-7.4: the CI reference). Host builds only: goldens and
//! GPU-vs-CPU parity fixtures are rendered here, never in the shipped Wasm.

use crate::draw::{Filter, Painter, draw_scene};
use crate::ir::Scene;
use crate::tiles::{region_view, unpremultiply};
use std::collections::HashSet;
use vello_common::kurbo::{Affine, BezPath, Rect, Stroke};
use vello_common::paint::{ImageSource, PaintType};
use vello_common::peniko::BlendMode;
use vello_cpu::{Pixmap, RasterizerSettings, RenderContext, Resources};

struct CpuPainter<'a> {
    ctx: &'a mut RenderContext,
    scene: &'a Scene,
}

impl Painter for CpuPainter<'_> {
    fn set_transform(&mut self, t: Affine) {
        self.ctx.set_transform(t);
    }
    fn set_paint_transform(&mut self, t: Affine) {
        self.ctx.set_paint_transform(t);
    }
    fn reset_paint_transform(&mut self) {
        self.ctx.reset_paint_transform();
    }
    fn set_paint(&mut self, paint: PaintType) {
        self.ctx.set_paint(paint);
    }
    fn image_source(&self, image: u32) -> Option<(ImageSource, u32, u32)> {
        let pixmap = self.scene.image(image)?;
        Some((ImageSource::Pixmap(pixmap.clone()), pixmap.width() as u32, pixmap.height() as u32))
    }
    fn fill_path(&mut self, path: &BezPath) {
        self.ctx.fill_path(path);
    }
    fn fill_rect(&mut self, rect: &Rect) {
        self.ctx.fill_rect(rect);
    }
    fn stroke_path(&mut self, path: &BezPath, stroke: &Stroke) {
        self.ctx.set_stroke(stroke.clone());
        self.ctx.stroke_path(path);
    }
    fn push_layer(&mut self, clip: Option<&BezPath>, blend: BlendMode, opacity: f32) {
        self.ctx.push_layer(clip, Some(blend), Some(opacity), None, None);
    }
    fn pop_layer(&mut self) {
        self.ctx.pop_layer();
    }
    fn push_filter_layer(&mut self, filter: vello_common::filter_effects::Filter) {
        self.ctx.push_filter_layer(filter);
    }
    fn set_even_odd(&mut self, even_odd: bool) {
        self.ctx.set_fill_rule(if even_odd { vello_common::peniko::Fill::EvenOdd } else { vello_common::peniko::Fill::NonZero });
    }
}

/// Render `world` of the scene into a `width × height` straight-alpha RGBA8 image over `background`.
pub fn render_region(scene: &Scene, world: Rect, width: u16, height: u16, background: [u8; 4]) -> Vec<u8> {
    let mut ctx = RenderContext::new(width, height);
    {
        let mut painter = CpuPainter { ctx: &mut ctx, scene };
        let view = region_view(world, width as u32, height as u32);
        draw_scene(&mut painter, scene, view, Rect::new(-2.0, -2.0, width as f64 + 2.0, height as f64 + 2.0), &Filter::Except(&HashSet::new()));
    }
    ctx.flush();
    let mut pixmap = Pixmap::new(width, height);
    let mut resources = Resources::new();
    ctx.render_with(
        &mut pixmap,
        &mut resources,
        RasterizerSettings { target_init: vello_cpu::TargetInit::Clear(crate::draw::color(background)), ..Default::default() },
    );
    let mut out = pixmap.data_as_u8_slice().to_vec();
    unpremultiply(&mut out);
    out
}

/// PNG bytes of a straight RGBA8 image (fixture files).
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::High);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(rgba).expect("png data");
    }
    out
}

/// Straight RGBA8 pixels of a PNG written by `encode_png`.
pub fn decode_png(bytes: &[u8]) -> (Vec<u8>, u32, u32) {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().expect("png info");
    let mut buf = vec![0; reader.output_buffer_size().expect("png size")];
    let info = reader.next_frame(&mut buf).expect("png frame");
    buf.truncate(info.buffer_size());
    (buf, info.width, info.height)
}
