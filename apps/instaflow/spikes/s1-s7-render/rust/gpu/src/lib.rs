//! S1 render worker engine: vello_gpu (sparse strips) on wgpu → WebGPU, drawing into a
//! transferred OffscreenCanvas. Two paths:
//!   * full:  Vello rasterizes every visible element into the frame texture each frame;
//!   * tiled: 512 px tiles per √2 zoom level cached as textures + a lifted layer for the
//!            selection, composited by our own tiny WGSL blit pass.
//! The frame texture is always Rgba8Unorm (readback for parity), then blitted to the surface.

use ir::{Camera, Doc, Grid, Painter};
use js_sys::{Function, Promise, Uint8Array};
use std::collections::HashMap;
use vello_gpu::color::{AlphaColor, Srgb};
use vello_gpu::kurbo::{Affine, BezPath, Rect, Stroke};
use vello_gpu::peniko::{Gradient, ImageSampler};
use vello_gpu::{ClearSettings, Image, ImageId, ImageSource, RenderSize, RenderTargetConfig, Renderer, Resources, Scene, TargetInit, TextureBindings};
use wasm_bindgen::prelude::*;
use web_sys::OffscreenCanvas;

const TILE: u32 = 512;
const FMT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const MAX_INST: u64 = 8192;

fn now() -> f64 {
    js_sys::global().unchecked_into::<web_sys::WorkerGlobalScope>().performance().map(|p| p.now()).unwrap_or(0.0)
}

#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&format!("wasm panic: {info}").into());
    }));
}

struct GpuPainter<'a> {
    scene: &'a mut Scene,
    images: &'a [ImageId],
}

impl Painter for GpuPainter<'_> {
    fn set_transform(&mut self, t: Affine) { self.scene.set_transform(t) }
    fn set_paint_transform(&mut self, t: Affine) { self.scene.set_paint_transform(t) }
    fn reset_paint_transform(&mut self) { self.scene.reset_paint_transform() }
    fn set_solid(&mut self, c: AlphaColor<Srgb>) { self.scene.set_paint(c) }
    fn set_gradient(&mut self, g: Gradient) { self.scene.set_paint(g) }
    fn set_image(&mut self, idx: u8) {
        self.scene.set_paint(Image {
            image: ImageSource::OpaqueId { id: self.images[idx as usize], may_have_transparency: false },
            sampler: ImageSampler::default(),
        })
    }
    fn fill_path(&mut self, p: &BezPath) { self.scene.fill_path(p) }
    fn fill_rect(&mut self, r: &Rect) { self.scene.fill_rect(r) }
    fn stroke_path(&mut self, p: &BezPath, s: Stroke) {
        self.scene.set_stroke(s);
        self.scene.stroke_path(p)
    }
}

struct Target {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    bind: wgpu::BindGroup,
    w: u32,
    h: u32,
}

struct Tile {
    t: Target,
    last_used: u64,
}

struct Lifted {
    t: Target,
    zoom: f64,
    /// device-space top-left of the texture at render time (integral px, at `zoom`, world*zoom)
    bx: f64,
    by: f64,
}

#[wasm_bindgen]
pub struct Engine {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    renderer: Renderer,
    resources: Resources,
    images: Vec<ImageId>,
    scene: Scene,
    frame: Target,
    frame_depth: wgpu::TextureView,
    tile_depth: wgpu::TextureView,
    blit_frame: wgpu::RenderPipeline,
    blit_surface: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    inst: wgpu::Buffer,
    doc: Doc,
    grid: Grid,
    cam: Camera,
    tiles: HashMap<(i32, i32, i32), Tile>,
    max_tiles: usize,
    frame_no: u64,
    lifted_ids: Vec<u32>,
    lifted_mask: Vec<bool>,
    drag: (f64, f64),
    lifted: Option<Lifted>,
    readback: Option<(wgpu::Buffer, u32, u32, u32)>,
    corpus_target: Option<(Target, wgpu::TextureView)>,
    init_ms: Vec<(String, f64)>,
    scratch: Vec<u32>,
    pub(crate) tiles_rendered_total: u64,
}

fn make_target(device: &wgpu::Device, bgl: &wgpu::BindGroupLayout, sampler: &wgpu::Sampler, w: u32, h: u32, label: &str) -> Target {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FMT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&Default::default());
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
        ],
    });
    Target { tex, view, bind, w, h }
}

const BLIT_WGSL: &str = r#"
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) dst: vec4f, @location(1) uv: vec4f) -> VOut {
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  var o: VOut;
  o.pos = vec4f(mix(dst.x, dst.z, c.x), mix(dst.y, dst.w, c.y), 0.0, 1.0);
  o.uv = vec2f(mix(uv.x, uv.z, c.x), mix(uv.y, uv.w, c.y));
  return o;
}
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment fn fs(i: VOut) -> @location(0) vec4f { return textureSample(t, s, i.uv); }
"#;

fn depth(device: &wgpu::Device, w: u32, h: u32) -> wgpu::TextureView {
    Renderer::create_depth_texture_view(device, &RenderSize { width: w as u16, height: h as u16 })
}

fn bg() -> AlphaColor<Srgb> {
    ir::color(ir::BG)
}

/// Create the engine on a transferred OffscreenCanvas. `count` = number of page elements.
#[wasm_bindgen]
pub async fn create_engine(canvas: OffscreenCanvas, width: u32, height: u32, count: usize, max_tiles: usize) -> Result<Engine, JsValue> {
    let mut marks = Vec::new();
    let t0 = now();
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::BROWSER_WEBGPU,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas))
        .map_err(|e| JsValue::from_str(&format!("create_surface: {e}")))?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), ..Default::default() })
        .await
        .map_err(|e| JsValue::from_str(&format!("request_adapter: {e}")))?;
    let info = adapter.get_info();
    marks.push((format!("adapter:{} / {} / {:?}", info.name, info.driver, info.backend), now() - t0));
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("s1"),
            required_limits: adapter.limits(),
            ..Default::default()
        })
        .await
        .map_err(|e| JsValue::from_str(&format!("request_device: {e}")))?;
    marks.push(("device".into(), now() - t0));
    let mut sc = surface
        .get_default_config(&adapter, width, height)
        .ok_or_else(|| JsValue::from_str("surface unsupported"))?;
    let caps = surface.get_capabilities(&adapter);
    sc.format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(sc.format);
    sc.usage = wgpu::TextureUsages::RENDER_ATTACHMENT;
    sc.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
    surface.configure(&device, &sc);
    marks.push((format!("surface:{:?}", sc.format), now() - t0));

    let (mut renderer, mut resources) = Renderer::new(&device, &RenderTargetConfig { format: FMT, width: width as u16, height: height as u16 });
    marks.push(("vello_renderer".into(), now() - t0));

    // images
    let mut enc = device.create_command_encoder(&Default::default());
    let images: Vec<ImageId> = ir::make_images()
        .iter()
        .map(|p| renderer.upload_image(&mut resources, &device, &queue, &mut enc, p))
        .collect();
    queue.submit([enc.finish()]);

    // blit pipelines
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("blit"), source: wgpu::ShaderSource::Wgsl(BLIT_WGSL.into()) });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                count: None,
            },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
        ],
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&bgl)], immediate_size: 0 });
    let mk = |format: wgpu::TextureFormat| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("blit"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 32,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    };
    let blit_frame = mk(FMT);
    let blit_surface = mk(sc.format);
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let inst = device.create_buffer(&wgpu::BufferDescriptor { label: Some("inst"), size: MAX_INST * 32, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let frame = make_target(&device, &bgl, &sampler, width, height, "frame");
    let frame_depth = depth(&device, width, height);
    let tile_depth = depth(&device, TILE, TILE);
    marks.push(("pipelines".into(), now() - t0));

    let doc = ir::big_doc(count);
    let grid = Grid::build(&doc, 256.0);
    marks.push(("scene_ir".into(), now() - t0));
    let n = doc.elements.len();
    Ok(Engine {
        device,
        queue,
        surface,
        renderer,
        resources,
        images,
        scene: Scene::new(width as u16, height as u16),
        frame,
        frame_depth,
        tile_depth,
        blit_frame,
        blit_surface,
        bgl,
        sampler,
        inst,
        doc,
        grid,
        cam: Camera { ox: 0.0, oy: 0.0, zoom: 1.0, w: width, h: height },
        tiles: HashMap::new(),
        max_tiles,
        frame_no: 0,
        lifted_ids: Vec::new(),
        lifted_mask: vec![false; n],
        drag: (0.0, 0.0),
        lifted: None,
        readback: None,
        corpus_target: None,
        init_ms: marks,
        scratch: Vec::new(),
        tiles_rendered_total: 0,
    })
}

fn level_of(zoom: f64) -> (i32, f64) {
    let k = (2.0 * zoom.log2()).round() as i32;
    (k, 2f64.powf(k as f64 / 2.0))
}

#[wasm_bindgen]
impl Engine {
    pub fn init_marks(&self) -> String {
        let parts: Vec<String> = self.init_ms.iter().map(|(k, v)| format!("{{\"step\":\"{k}\",\"ms\":{v:.2}}}")).collect();
        format!("[{}]", parts.join(","))
    }

    pub fn set_camera(&mut self, ox: f64, oy: f64, zoom: f64) {
        self.cam.ox = ox.round();
        self.cam.oy = oy.round();
        self.cam.zoom = zoom;
    }

    /// Vello render of `scene` into `view`; one submit per Vello render (it stages queue writes).
    fn vello(&mut self, w: u32, h: u32, view_is_frame: bool, tile: Option<&wgpu::TextureView>, init: TargetInit<'_>) {
        let mut enc = self.device.create_command_encoder(&Default::default());
        let (view, depth) = match tile {
            Some(v) => (v, if w == TILE && h == TILE { Some(&self.tile_depth) } else { None }),
            None => {
                debug_assert!(view_is_frame);
                (&self.frame.view, Some(&self.frame_depth))
            }
        };
        self.renderer
            .render(&self.scene, &mut self.resources, &self.device, &self.queue, &mut enc, &RenderSize { width: w as u16, height: h as u16 }, view, depth, &TextureBindings::new(), init)
            .expect("vello render");
        self.queue.submit([enc.finish()]);
    }

    /// Full path: re-rasterize every visible element (lifted ones on top at the drag offset).
    /// Returns [scene_build_ms, render_encode_submit_ms, elements_drawn].
    pub fn frame_full(&mut self) -> Vec<f64> {
        let t0 = now();
        self.scene.reset();
        let lifted = self.lifted_ids.clone();
        {
            let mut p = GpuPainter { scene: &mut self.scene, images: &self.images };
            ir::draw_frame(&mut p, &self.doc, &self.grid, &self.cam, &lifted, self.drag);
        }
        self.grid.query(&self.doc, self.cam.world_rect(), &mut self.scratch);
        let drawn = self.scratch.len();
        let t1 = now();
        let (w, h) = (self.frame.w, self.frame.h);
        self.vello(w, h, true, None, TargetInit::Clear(ClearSettings::Viewport { color: bg() }));
        self.present();
        let t2 = now();
        vec![t1 - t0, t2 - t1, drawn as f64]
    }

    fn tile_world(k: i32, tx: i32, ty: i32) -> Rect {
        let s = 2f64.powf(k as f64 / 2.0);
        let t = TILE as f64;
        Rect::new(tx as f64 * t / s, ty as f64 * t / s, (tx + 1) as f64 * t / s, (ty + 1) as f64 * t / s)
    }

    fn render_tile(&mut self, k: i32, tx: i32, ty: i32) {
        let s = 2f64.powf(k as f64 / 2.0);
        let wr = Self::tile_world(k, tx, ty).inflate(2.0 / s, 2.0 / s);
        let mut ids = std::mem::take(&mut self.scratch);
        self.grid.query(&self.doc, wr, &mut ids);
        ids.retain(|&i| !self.lifted_mask[i as usize]);
        self.scene.reset_and_resize(TILE as u16, TILE as u16);
        let view = Affine::translate((-(tx as f64) * TILE as f64, -(ty as f64) * TILE as f64)) * Affine::scale(s);
        {
            let mut p = GpuPainter { scene: &mut self.scene, images: &self.images };
            ir::draw(&mut p, &self.doc, &ids, view, None);
        }
        self.scratch = ids;
        let target = match self.tiles.remove(&(k, tx, ty)) {
            Some(t) => t.t,
            None => {
                if self.tiles.len() >= self.max_tiles {
                    self.evict();
                }
                make_target(&self.device, &self.bgl, &self.sampler, TILE, TILE, "tile")
            }
        };
        let v = target.view.clone();
        self.vello(TILE, TILE, false, Some(&v), TargetInit::Clear(ClearSettings::Viewport { color: bg() }));
        self.tiles.insert((k, tx, ty), Tile { t: target, last_used: self.frame_no });
        self.tiles_rendered_total += 1;
        let (fw, fh) = (self.frame.w, self.frame.h);
        self.scene.reset_and_resize(fw as u16, fh as u16);
    }

    fn evict(&mut self) {
        if let Some((&key, _)) = self.tiles.iter().min_by_key(|(_, t)| t.last_used) {
            self.tiles.remove(&key);
        }
    }

    fn visible_tiles(&self, k: i32, ring: i32) -> Vec<(i32, i32)> {
        let s = 2f64.powf(k as f64 / 2.0);
        let wr = self.cam.world_rect();
        let t = TILE as f64;
        let (x0, y0) = ((wr.x0 * s / t).floor() as i32 - ring, (wr.y0 * s / t).floor() as i32 - ring);
        let (x1, y1) = (((wr.x1 * s - 1e-6) / t).floor() as i32 + ring, ((wr.y1 * s - 1e-6) / t).floor() as i32 + ring);
        let (pw, ph) = (self.doc.width * s / t, self.doc.height * s / t);
        let (cx, cy) = ((x0 + x1) as f64 / 2.0, (y0 + y1) as f64 / 2.0);
        let mut v = Vec::new();
        for ty in y0..=y1 {
            for tx in x0..=x1 {
                // tiles entirely outside the page are pure background → never rasterized
                if (tx as f64) >= pw || (ty as f64) >= ph || tx < 0 || ty < 0 {
                    continue;
                }
                v.push((tx, ty));
            }
        }
        // Manhattan order from the viewport centre (Penpot)
        v.sort_by(|a, b| {
            let da = (a.0 as f64 - cx).abs() + (a.1 as f64 - cy).abs();
            let db = (b.0 as f64 - cx).abs() + (b.1 as f64 - cy).abs();
            da.partial_cmp(&db).unwrap()
        });
        v
    }

    /// Tiled path. `budget` = max tiles rasterized this frame; `reraster_lift` = draw the lifted
    /// selection with Vello every frame (instead of compositing the cached lifted texture).
    /// Returns [cpu_ms, tiles_rendered, visible_missing_after, visible, lifted_ms].
    pub fn frame_tiled(&mut self, budget: u32, reraster_lift: bool) -> Vec<f64> {
        let t0 = now();
        self.frame_no += 1;
        let (k, s) = level_of(self.cam.zoom);
        let visible = self.visible_tiles(k, 0);
        let mut rendered = 0u32;
        for &(tx, ty) in &visible {
            if rendered >= budget {
                break;
            }
            if !self.tiles.contains_key(&(k, tx, ty)) {
                self.render_tile(k, tx, ty);
                rendered += 1;
            }
        }
        if rendered < budget {
            for (tx, ty) in self.visible_tiles(k, 1) {
                if rendered >= budget {
                    break;
                }
                if !self.tiles.contains_key(&(k, tx, ty)) {
                    self.render_tile(k, tx, ty);
                    rendered += 1;
                }
            }
        }
        let mut missing = 0;
        for &(tx, ty) in &visible {
            match self.tiles.get_mut(&(k, tx, ty)) {
                Some(t) => t.last_used = self.frame_no,
                None => missing += 1,
            }
        }
        // lifted cached texture
        let tl = now();
        let lifted_active = !self.lifted_ids.is_empty();
        if lifted_active && !reraster_lift {
            let stale = self.lifted.as_ref().map(|l| l.zoom != self.cam.zoom).unwrap_or(true);
            if stale {
                self.render_lifted_tex();
            }
        }
        let lifted_ms = now() - tl;

        // composite
        let z = self.cam.zoom;
        let (fw, fh) = (self.frame.w as f64, self.frame.h as f64);
        let ndc = |x0: f64, y0: f64, x1: f64, y1: f64| -> [f32; 4] {
            [(x0 / fw * 2.0 - 1.0) as f32, (1.0 - y0 / fh * 2.0) as f32, (x1 / fw * 2.0 - 1.0) as f32, (1.0 - y1 / fh * 2.0) as f32]
        };
        let wr = self.cam.world_rect();
        let mut quads: Vec<(F32x8, (i32, i32, i32))> = Vec::new();
        // fallback: other levels' cached tiles (farthest level first), then current level
        let mut keys: Vec<(i32, i32, i32)> = self
            .tiles
            .keys()
            .copied()
            .filter(|&(kk, tx, ty)| {
                let r = Self::tile_world(kk, tx, ty);
                r.x1 > wr.x0 && r.y1 > wr.y0 && r.x0 < wr.x1 && r.y0 < wr.y1
            })
            .collect();
        if missing == 0 {
            keys.retain(|key| key.0 == k);
        }
        keys.sort_by_key(|key| (key.0 == k, std::cmp::Reverse((key.0 - k).abs())));
        for key in keys {
            let r = Self::tile_world(key.0, key.1, key.2);
            let d = ndc(r.x0 * z - self.cam.ox, r.y0 * z - self.cam.oy, r.x1 * z - self.cam.ox, r.y1 * z - self.cam.oy);
            quads.push(([d[0], d[1], d[2], d[3], 0.0, 0.0, 1.0, 1.0], key));
        }
        let _ = s;
        let mut data: Vec<f32> = Vec::with_capacity(quads.len() * 8 + 16);
        for q in &quads {
            data.extend_from_slice(&q.0);
        }
        let lifted_quad = if lifted_active && !reraster_lift {
            let l = self.lifted.as_ref().unwrap();
            let x0 = l.bx - self.cam.ox + (self.drag.0 * z).round();
            let y0 = l.by - self.cam.oy + (self.drag.1 * z).round();
            let d = ndc(x0, y0, x0 + l.t.w as f64, y0 + l.t.h as f64);
            data.extend_from_slice(&[d[0], d[1], d[2], d[3], 0.0, 0.0, 1.0, 1.0]);
            true
        } else {
            false
        };
        self.queue.write_buffer(&self.inst, 0, as_bytes(&data));
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let c = bg().premultiply().to_rgba8();
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.frame.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: c.r as f64 / 255.0, g: c.g as f64 / 255.0, b: c.b as f64 / 255.0, a: 1.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.blit_frame);
            pass.set_vertex_buffer(0, self.inst.slice(..));
            for (i, q) in quads.iter().enumerate() {
                pass.set_bind_group(0, &self.tiles[&q.1].t.bind, &[]);
                pass.draw(0..4, i as u32..i as u32 + 1);
            }
            if lifted_quad {
                let i = quads.len() as u32;
                pass.set_bind_group(0, &self.lifted.as_ref().unwrap().t.bind, &[]);
                pass.draw(0..4, i..i + 1);
            }
        }
        self.queue.submit([enc.finish()]);
        let mut lifted_ms2 = 0.0;
        if lifted_active && reraster_lift {
            let tr = now();
            self.scene.reset();
            let v = self.cam.view() * Affine::translate(self.drag);
            let ids = self.lifted_ids.clone();
            {
                let mut p = GpuPainter { scene: &mut self.scene, images: &self.images };
                ir::draw(&mut p, &self.doc, &ids, v, None);
            }
            let (w, h) = (self.frame.w, self.frame.h);
            self.vello(w, h, true, None, TargetInit::SrcOver);
            lifted_ms2 = now() - tr;
        }
        self.present();
        vec![now() - t0, rendered as f64, missing as f64, visible.len() as f64, lifted_ms + lifted_ms2]
    }

    fn render_lifted_tex(&mut self) {
        let z = self.cam.zoom;
        let mut b = Rect::new(f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for &i in &self.lifted_ids {
            b = b.union(self.doc.elements[i as usize].bounds());
        }
        let bx = (b.x0 * z).floor() - 1.0;
        let by = (b.y0 * z).floor() - 1.0;
        let w = (((b.x1 * z).ceil() + 1.0 - bx) as u32).clamp(1, 4096);
        let h = (((b.y1 * z).ceil() + 1.0 - by) as u32).clamp(1, 4096);
        let t = make_target(&self.device, &self.bgl, &self.sampler, w, h, "lifted");
        self.scene.reset_and_resize(w as u16, h as u16);
        let view = Affine::translate((-bx, -by)) * Affine::scale(z);
        let ids = self.lifted_ids.clone();
        {
            let mut p = GpuPainter { scene: &mut self.scene, images: &self.images };
            ir::draw(&mut p, &self.doc, &ids, view, None);
        }
        let v = t.view.clone();
        self.vello(w, h, false, Some(&v), TargetInit::Clear(ClearSettings::Viewport { color: AlphaColor::TRANSPARENT }));
        let (fw, fh) = (self.frame.w, self.frame.h);
        self.scene.reset_and_resize(fw as u16, fh as u16);
        self.lifted = Some(Lifted { t, zoom: z, bx, by });
    }

    fn invalidate(&mut self, r: Rect) -> u32 {
        let before = self.tiles.len();
        self.tiles.retain(|&(k, tx, ty), _| {
            let t = Self::tile_world(k, tx, ty);
            !(t.x1 > r.x0 && t.y1 > r.y0 && t.x0 < r.x1 && t.y0 < r.y1)
        });
        (before - self.tiles.len()) as u32
    }

    /// Lift the `n` elements nearest the viewport centre into the lifted layer. Returns
    /// [lifted_count, tiles_invalidated].
    pub fn lift(&mut self, n: usize) -> Vec<f64> {
        let ids = ir::select_near(&self.doc, &self.grid, self.cam.world_rect(), n);
        let mut inv = 0;
        for &i in &ids {
            self.lifted_mask[i as usize] = true;
            let b = self.doc.elements[i as usize].bounds();
            inv += self.invalidate(b);
        }
        self.lifted_ids = ids;
        self.drag = (0.0, 0.0);
        self.lifted = None;
        vec![self.lifted_ids.len() as f64, inv as f64]
    }

    /// Drag offset in world units.
    pub fn set_drag(&mut self, dx: f64, dy: f64) {
        self.drag = (dx, dy);
    }

    /// Commit the drag: move elements, update the index, invalidate tiles under old+new bounds.
    pub fn drop_lift(&mut self) -> f64 {
        let ids = std::mem::take(&mut self.lifted_ids);
        let mut inv = 0;
        for &i in &ids {
            let e = self.doc.elements[i as usize].clone();
            self.grid.remove(&e);
            inv += self.invalidate(e.bounds());
            let e2 = &mut self.doc.elements[i as usize];
            e2.x += self.drag.0;
            e2.y += self.drag.1;
            let e2 = e2.clone();
            self.grid.insert(&e2);
            inv += self.invalidate(e2.bounds());
            self.lifted_mask[i as usize] = false;
        }
        self.lifted = None;
        self.drag = (0.0, 0.0);
        inv as f64
    }

    pub fn clear_tiles(&mut self) {
        self.tiles.clear();
    }

    fn present(&mut self) {
        let st = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            _ => return,
        };
        let view = st.texture.create_view(&Default::default());
        let off = (MAX_INST - 1) * 32;
        self.queue.write_buffer(&self.inst, off, as_bytes(&[-1.0f32, 1.0, 1.0, -1.0, 0.0, 0.0, 1.0, 1.0]));
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.blit_surface);
            pass.set_vertex_buffer(0, self.inst.slice(off..));
            pass.set_bind_group(0, &self.frame.bind, &[]);
            pass.draw(0..4, 0..1);
        }
        self.queue.submit([enc.finish()]);
        self.queue.present(st);
    }

    /// Resolves when all submitted GPU work is done.
    pub fn gpu_done(&self) -> Promise {
        let q = self.queue.clone();
        Promise::new(&mut |resolve: Function, _reject: Function| {
            q.on_submitted_work_done(move || {
                let _ = resolve.call0(&JsValue::NULL);
            });
        })
    }

    fn begin_copy(&mut self, tex: &wgpu::Texture, w: u32, h: u32) -> Promise {
        let bpr = (w * 4).next_multiple_of(256);
        let buf = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (bpr * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: None } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);
        let b2 = buf.clone();
        let p = Promise::new(&mut |resolve: Function, reject: Function| {
            b2.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                if r.is_ok() {
                    let _ = resolve.call0(&JsValue::NULL);
                } else {
                    let _ = reject.call1(&JsValue::NULL, &JsValue::from_str("map failed"));
                }
            });
        });
        self.readback = Some((buf, w, h, bpr));
        p
    }

    /// Copy the current frame texture; await the promise, then call `finish_readback`.
    pub fn begin_readback(&mut self) -> Promise {
        let tex = self.frame.tex.clone();
        let (w, h) = (self.frame.w, self.frame.h);
        self.begin_copy(&tex, w, h)
    }

    pub fn finish_readback(&mut self) -> Uint8Array {
        let (buf, w, h, bpr) = self.readback.take().expect("no readback");
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        {
            let m = buf.slice(..).get_mapped_range().expect("mapped");
            for row in m.chunks_exact(bpr as usize) {
                out.extend_from_slice(&row[..(w * 4) as usize]);
            }
        }
        buf.unmap();
        buf.destroy();
        Uint8Array::from(&out[..])
    }

    /// Render corpus scene `i` (256x256) with Vello GPU into an offscreen texture and start readback.
    pub fn begin_corpus(&mut self, i: u32) -> Promise {
        if self.corpus_target.is_none() {
            let t = make_target(&self.device, &self.bgl, &self.sampler, 256, 256, "corpus");
            let d = depth(&self.device, 256, 256);
            self.corpus_target = Some((t, d));
        }
        let d = ir::corpus_doc(i);
        let g = Grid::build(&d, 64.0);
        let cam = Camera { ox: 0.0, oy: 0.0, zoom: 1.0, w: 256, h: 256 };
        self.scene.reset_and_resize(256, 256);
        {
            let mut p = GpuPainter { scene: &mut self.scene, images: &self.images };
            ir::draw_frame(&mut p, &d, &g, &cam, &[], (0.0, 0.0));
        }
        let (view, tex) = {
            let (t, _) = self.corpus_target.as_ref().unwrap();
            (t.view.clone(), t.tex.clone())
        };
        let mut enc = self.device.create_command_encoder(&Default::default());
        let dv = self.corpus_target.as_ref().unwrap().1.clone();
        self.renderer
            .render(&self.scene, &mut self.resources, &self.device, &self.queue, &mut enc, &RenderSize { width: 256, height: 256 }, &view, Some(&dv), &TextureBindings::new(), TargetInit::Clear(ClearSettings::Viewport { color: bg() }))
            .expect("corpus render");
        self.queue.submit([enc.finish()]);
        let (fw, fh) = (self.frame.w, self.frame.h);
        self.scene.reset_and_resize(fw as u16, fh as u16);
        self.begin_copy(&tex, 256, 256)
    }

    /// JSON: tile cache and texture memory estimate (bytes; our allocations only — Vello's
    /// internal strip/alpha/paint textures are not counted).
    pub fn stats(&self) -> String {
        let tile_bytes = self.tiles.len() as u64 * (TILE as u64 * TILE as u64 * 4);
        let frame = self.frame.w as u64 * self.frame.h as u64 * (4 + 4);
        let lifted = self.lifted.as_ref().map(|l| l.t.w as u64 * l.t.h as u64 * 4).unwrap_or(0);
        let depth_tile = TILE as u64 * TILE as u64 * 4;
        format!(
            "{{\"tiles\":{},\"tile_bytes\":{},\"frame_bytes\":{},\"lifted_bytes\":{},\"est_total_bytes\":{},\"tiles_rendered_total\":{},\"lifted_ids\":{}}}",
            self.tiles.len(),
            tile_bytes,
            frame,
            lifted,
            tile_bytes + frame + lifted + depth_tile,
            self.tiles_rendered_total,
            self.lifted_ids.len()
        )
    }
}

type F32x8 = [f32; 8];

fn as_bytes(v: &[f32]) -> &[u8] {
    // SAFETY: f32 slice reinterpreted as bytes, alignment of u8 is 1.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}
