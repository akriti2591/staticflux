//! Vello GPU on wgpu/WebGPU and our WGSL compositor (IF-7.4, IF-7.5): the Wasm exports behind the
//! `RasterBackend` port (`apps/instaflow/src/render/vello-backend.ts`).
//!
//! Two objects, so a device loss never touches the scene (IF-7.11):
//! - `Engine` — the retained CPU-side scene (IR), layer membership and images. Lives as long as
//!   the render module.
//! - `Gpu` — everything bound to one `GPUDevice`: Vello renderer and image atlas, tile and layer
//!   textures, the frame target, the compositor pipelines, the canvas configuration. `create_gpu`
//!   makes one (async: adapter + device), `Engine::install_gpu` adopts it and re-uploads images.
//!   After a loss the old `Gpu` is dropped and a new one installed; tiles and layers render again
//!   from the scene.
//!
//! Every Vello render is its own submit (Vello stages queue writes; S1). Textures are `Rgba8Unorm`
//! with premultiplied alpha; readback returns straight alpha.

use crate::draw::{Filter, Painter, color, draw_scene};
use crate::ir::Scene;
use crate::tiles::{AA_PAD, TILE, layer_placement, premultiply, region_view, tile_view, unpremultiply};
use js_sys::{Function, Promise};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use vello_common::kurbo::{Affine, BezPath, Rect, Stroke};
use vello_common::multi_atlas::AtlasConfig;
use vello_common::paint::{ImageId, ImageSource, PaintType};
use vello_common::peniko::BlendMode;
use vello_gpu::{ClearSettings, MemorySettings, RenderSettings, RenderSize, RenderTargetConfig, Renderer, Resources, TargetInit, TextureBindings};
use wasm_bindgen::prelude::*;

const FMT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Floats per compositor instance: dst NDC (4), uv (4), params (4: opacity, 0, 0, 0).
const INSTANCE_FLOATS: usize = 12;
/// Largest render target side we allocate (regions, layers); larger outputs are chunked by the caller.
const MAX_TARGET: u32 = 4096;

thread_local! {
    static ERRORS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn js(msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

/// wgpu errors no scope caught (validation, OOM), drained.
#[wasm_bindgen]
pub fn take_errors() -> Vec<String> {
    ERRORS.with(|e| std::mem::take(&mut *e.borrow_mut()))
}

#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&format!("render wasm panic: {info}").into());
    }));
}

// ---------------------------------------------------------------- compositor (ours, WGSL)

/// One textured quad per instance; premultiplied alpha in and out. Sources: tiles, lifted layers,
/// the cached snapshot (and, from M3, external video textures through a second pipeline).
const COMPOSITOR_WGSL: &str = r#"
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) alpha: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) dst: vec4f, @location(1) uv: vec4f, @location(2) params: vec4f) -> VOut {
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  var o: VOut;
  o.pos = vec4f(mix(dst.x, dst.z, c.x), mix(dst.y, dst.w, c.y), 0.0, 1.0);
  o.uv = vec2f(mix(uv.x, uv.z, c.x), mix(uv.y, uv.w, c.y));
  o.alpha = params.x;
  return o;
}
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment fn fs(i: VOut) -> @location(0) vec4f { return textureSample(t, s, i.uv) * i.alpha; }
"#;

struct Target {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    bind: wgpu::BindGroup,
    w: u32,
    h: u32,
}

impl Target {
    fn bytes(&self) -> u64 {
        self.w as u64 * self.h as u64 * 4
    }
}

struct Compositor {
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    frame_pipeline: wgpu::RenderPipeline,
    present_pipeline: Option<wgpu::RenderPipeline>,
    instances: wgpu::Buffer,
    capacity: u64,
}

fn make_target(device: &wgpu::Device, c: &Compositor, w: u32, h: u32, label: &str) -> Target {
    let tex = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FMT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let view = tex.create_view(&Default::default());
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &c.bgl,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&c.sampler) },
        ],
    });
    Target { tex, view, bind, w: w.max(1), h: h.max(1) }
}

fn make_compositor(device: &wgpu::Device, surface_format: Option<wgpu::TextureFormat>) -> Compositor {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("sf-compositor"), source: wgpu::ShaderSource::Wgsl(COMPOSITOR_WGSL.into()) });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("sf-compositor"),
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
    let pipeline = |format: wgpu::TextureFormat, blend: Option<wgpu::BlendState>| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("sf-compositor"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: (INSTANCE_FLOATS * 4) as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    };
    let frame_pipeline = pipeline(FMT, Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING));
    let present_pipeline = surface_format.map(|f| pipeline(f, None));
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let capacity = 256;
    let instances = device.create_buffer(&wgpu::BufferDescriptor { label: Some("sf-compositor-instances"), size: capacity * (INSTANCE_FLOATS * 4) as u64, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    Compositor { bgl, sampler, frame_pipeline, present_pipeline, instances, capacity }
}

fn as_bytes(v: &[f32]) -> &[u8] {
    // SAFETY: an f32 slice viewed as bytes; u8 has alignment 1 and the length is exact.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

// ---------------------------------------------------------------- Gpu (device-bound state)

struct Layer {
    target: Target,
    x: f64,
    y: f64,
    zoom: f64,
}

struct Pending {
    buffer: wgpu::Buffer,
    w: u32,
    h: u32,
    bpr: u32,
}

/// Everything bound to one GPU device. Created by `create_gpu`, adopted by `Engine::install_gpu`.
#[wasm_bindgen]
pub struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: Option<(wgpu::Surface<'static>, wgpu::SurfaceConfiguration)>,
    renderer: Renderer,
    resources: Resources,
    vscene: vello_gpu::Scene,
    compositor: Compositor,
    frame: Target,
    tile_depth: wgpu::TextureView,
    tiles: Vec<Option<Target>>,
    layers: HashMap<u32, Layer>,
    snapshot: Option<Target>,
    images: HashMap<u32, (ImageId, u32, u32)>,
    pending: Option<Pending>,
    max_target: u32,
}

/// Create a device (fresh adapter), the Vello renderer, the compositor and — when `canvas` is an
/// `OffscreenCanvas` — the canvas configuration. `canvas` null/undefined = headless.
#[wasm_bindgen]
pub async fn create_gpu(canvas: JsValue, width: u32, height: u32) -> Result<Gpu, JsValue> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::BROWSER_WEBGPU, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let surface = if canvas.is_null() || canvas.is_undefined() {
        None
    } else {
        let offscreen: web_sys::OffscreenCanvas = canvas.dyn_into().map_err(|_| js("create_gpu: canvas must be an OffscreenCanvas"))?;
        Some(instance.create_surface(wgpu::SurfaceTarget::OffscreenCanvas(offscreen)).map_err(|e| js(format!("create_surface: {e}")))?)
    };
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: surface.as_ref(), power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })
        .await
        .map_err(|e| js(format!("request_adapter: {e}")))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor { label: Some("instaflow-render"), required_limits: adapter.limits(), ..Default::default() })
        .await
        .map_err(|e| js(format!("request_device: {e}")))?;
    device.on_uncaptured_error(std::sync::Arc::new(|e: wgpu::Error| {
        ERRORS.with(|v| v.borrow_mut().push(e.to_string()));
    }));
    let surface = match surface {
        None => None,
        Some(s) => {
            let mut config = s.get_default_config(&adapter, width.max(1), height.max(1)).ok_or_else(|| js("the canvas does not support this adapter"))?;
            let caps = s.get_capabilities(&adapter);
            config.format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(config.format);
            config.usage = wgpu::TextureUsages::RENDER_ATTACHMENT;
            config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
            s.configure(&device, &config);
            Some((s, config))
        }
    };
    let max_target = device.limits().max_texture_dimension_2d.min(MAX_TARGET);
    let settings = RenderSettings {
        // S1: Vello's default image atlas is 4096² (64 MiB) allocated on the first image; 2048² pages, lazily.
        memory_settings: MemorySettings { image_atlas_config: AtlasConfig { initial_atlas_count: 0, max_atlases: 8, atlas_size: (2048, 2048), ..Default::default() }, ..Default::default() },
        ..Default::default()
    };
    let (renderer, resources) = Renderer::new_with(&device, &RenderTargetConfig { format: FMT, width: TILE as u16, height: TILE as u16 }, settings);
    let compositor = make_compositor(&device, surface.as_ref().map(|(_, c)| c.format));
    let frame = make_target(&device, &compositor, width.max(1), height.max(1), "sf-frame");
    let tile_depth = Renderer::create_depth_texture_view(&device, &RenderSize { width: TILE as u16, height: TILE as u16 });
    Ok(Gpu {
        device,
        queue,
        surface,
        renderer,
        resources,
        vscene: vello_gpu::Scene::new(TILE as u16, TILE as u16),
        compositor,
        frame,
        tile_depth,
        tiles: Vec::new(),
        layers: HashMap::new(),
        snapshot: None,
        images: HashMap::new(),
        pending: None,
        max_target,
    })
}

struct GpuPainter<'a> {
    scene: &'a mut vello_gpu::Scene,
    images: &'a HashMap<u32, (ImageId, u32, u32)>,
}

impl Painter for GpuPainter<'_> {
    fn set_transform(&mut self, t: Affine) {
        self.scene.set_transform(t);
    }
    fn set_paint_transform(&mut self, t: Affine) {
        self.scene.set_paint_transform(t);
    }
    fn reset_paint_transform(&mut self) {
        self.scene.reset_paint_transform();
    }
    fn set_paint(&mut self, paint: PaintType) {
        self.scene.set_paint(paint);
    }
    fn image_source(&self, image: u32) -> Option<(ImageSource, u32, u32)> {
        let (id, w, h) = *self.images.get(&image)?;
        Some((ImageSource::OpaqueId { id, may_have_transparency: true }, w, h))
    }
    fn fill_path(&mut self, path: &BezPath) {
        self.scene.fill_path(path);
    }
    fn fill_rect(&mut self, rect: &Rect) {
        self.scene.fill_rect(rect);
    }
    fn stroke_path(&mut self, path: &BezPath, stroke: &Stroke) {
        self.scene.set_stroke(stroke.clone());
        self.scene.stroke_path(path);
    }
    fn push_layer(&mut self, clip: Option<&BezPath>, blend: BlendMode, opacity: f32) {
        self.scene.push_layer(clip, Some(blend), Some(opacity), None, None);
    }
    fn pop_layer(&mut self) {
        self.scene.pop_layer();
    }
    fn push_filter_layer(&mut self, filter: vello_common::filter_effects::Filter) {
        self.scene.push_filter_layer(filter);
    }
    fn set_even_odd(&mut self, even_odd: bool) {
        self.scene.set_fill_rule(if even_odd { vello_common::peniko::Fill::EvenOdd } else { vello_common::peniko::Fill::NonZero });
    }
}

impl Gpu {
    /// Draw `scene` (world → target pixels via `view`) into `target` with Vello; one submit.
    fn render_into(&mut self, scene: &Scene, view: Affine, filter: &Filter<'_>, target: &wgpu::TextureView, w: u32, h: u32, depth: bool, clear: [u8; 4]) -> Result<(), JsValue> {
        self.vscene.reset_and_resize(w as u16, h as u16);
        {
            let mut painter = GpuPainter { scene: &mut self.vscene, images: &self.images };
            let cull = Rect::new(-AA_PAD, -AA_PAD, w as f64 + AA_PAD, h as f64 + AA_PAD);
            draw_scene(&mut painter, scene, view, cull, filter);
        }
        let mut enc = self.device.create_command_encoder(&Default::default());
        let depth_view = if depth { Some(&self.tile_depth) } else { None };
        self.renderer
            .render(&self.vscene, &mut self.resources, &self.device, &self.queue, &mut enc, &RenderSize { width: w as u16, height: h as u16 }, target, depth_view, &TextureBindings::new(), TargetInit::Clear(ClearSettings::Viewport { color: color(clear) }))
            .map_err(|e| js(format!("vello render: {e:?}")))?;
        self.queue.submit([enc.finish()]);
        Ok(())
    }

    fn upload_image(&mut self, id: u32, pixmap: &std::sync::Arc<vello_common::pixmap::Pixmap>) {
        let mut enc = self.device.create_command_encoder(&Default::default());
        if let Some((old, _, _)) = self.images.remove(&id) {
            self.renderer.destroy_image(&mut self.resources, &mut enc, old);
        }
        let image = self.renderer.upload_image(&mut self.resources, &self.device, &self.queue, &mut enc, pixmap);
        self.queue.submit([enc.finish()]);
        self.images.insert(id, (image, pixmap.width() as u32, pixmap.height() as u32));
    }

    fn drop_image(&mut self, id: u32) {
        if let Some((old, _, _)) = self.images.remove(&id) {
            let mut enc = self.device.create_command_encoder(&Default::default());
            self.renderer.destroy_image(&mut self.resources, &mut enc, old);
            self.queue.submit([enc.finish()]);
        }
    }

    fn begin_copy(&mut self, tex: &wgpu::Texture, w: u32, h: u32) -> Result<Promise, JsValue> {
        if self.pending.is_some() {
            return Err(js("a readback is already pending (await it and call finish_readback)"));
        }
        let bpr = (w * 4).next_multiple_of(256);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("sf-readback"), size: (bpr * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: None } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.queue.submit([enc.finish()]);
        let mapped = buffer.clone();
        let promise = Promise::new(&mut |resolve: Function, reject: Function| {
            mapped.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                if r.is_ok() {
                    let _ = resolve.call0(&JsValue::NULL);
                } else {
                    let _ = reject.call1(&JsValue::NULL, &js("map_async failed (device lost?)"));
                }
            });
        });
        self.pending = Some(Pending { buffer, w, h, bpr });
        Ok(promise)
    }

    fn present(&mut self) {
        let Some((surface, _)) = &self.surface else { return };
        let Some(pipeline) = &self.compositor.present_pipeline else { return };
        let st = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            _ => return,
        };
        let view = st.texture.create_view(&Default::default());
        // The last instance slot holds the full-screen quad.
        let slot = (self.compositor.capacity - 1) * (INSTANCE_FLOATS * 4) as u64;
        self.queue.write_buffer(&self.compositor.instances, slot, as_bytes(&[-1.0, 1.0, 1.0, -1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]));
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("sf-present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_vertex_buffer(0, self.compositor.instances.slice(slot..));
            pass.set_bind_group(0, &self.frame.bind, &[]);
            pass.draw(0..4, 0..1);
        }
        self.queue.submit([enc.finish()]);
        self.queue.present(st);
    }

    fn other_bytes(&self) -> u64 {
        let frame = self.frame.bytes();
        let depth = TILE as u64 * TILE as u64 * 4;
        let snapshot = self.snapshot.as_ref().map_or(0, Target::bytes);
        // Vello does not expose its atlas count: estimate whole 2048² pages from the uploaded pixels.
        let page = 2048u64 * 2048 * 4;
        let pixels: u64 = self.images.values().map(|(_, w, h)| *w as u64 * *h as u64 * 4).sum();
        let atlases = if self.images.is_empty() { 0 } else { pixels.div_ceil(page).max(1) * page };
        frame + depth + snapshot + atlases
    }
}

// ---------------------------------------------------------------- Engine (retained scene)

/// The render module: the retained scene plus, while a device is attached, a `Gpu`.
#[wasm_bindgen]
pub struct Engine {
    scene: Scene,
    layers: HashMap<u32, HashSet<u32>>,
    lifted: HashSet<u32>,
    gpu: Option<Gpu>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

fn rects(list: &[Rect]) -> Vec<f64> {
    list.iter().flat_map(|r| [r.x0, r.y0, r.x1, r.y1]).collect()
}

fn rgba8(c: &[f32]) -> [u8; 4] {
    let at = |i: usize| (c.get(i).copied().unwrap_or(1.0).clamp(0.0, 1.0) * 255.0).round() as u8;
    [at(0), at(1), at(2), at(3)]
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { scene: Scene::new(), layers: HashMap::new(), lifted: HashSet::new(), gpu: None }
    }

    /// Tile edge in device pixels.
    pub fn tile_size(&self) -> u32 {
        TILE
    }

    /// Apply a scene batch; returns dirty world rects `[x0, y0, x1, y1, …]`.
    pub fn apply(&mut self, batch: &[u8]) -> Result<Vec<f64>, JsValue> {
        let applied = self.scene.apply(batch).map_err(js)?;
        if applied.cleared {
            self.layers.clear();
            self.lifted.clear();
        }
        if let Some(gpu) = self.gpu.as_mut() {
            for id in &applied.images_dropped {
                gpu.drop_image(*id);
            }
            for id in &applied.images_set {
                if let Some(pixmap) = self.scene.image(*id).cloned() {
                    gpu.upload_image(*id, &pixmap);
                }
            }
        }
        Ok(rects(&applied.dirty))
    }

    /// Scene bounds `[x0, y0, x1, y1]`, or empty.
    pub fn bounds(&self) -> Vec<f64> {
        self.scene.bounds().map(|b| rects(&[b])).unwrap_or_default()
    }

    /// Lift `nodes` into `layer` (`[]` returns them to the tiles). Returns rects of nodes that moved in or out.
    pub fn set_layer(&mut self, layer: u32, nodes: &[u32]) -> Vec<f64> {
        let next: HashSet<u32> = nodes.iter().copied().collect();
        let prev = self.layers.get(&layer).cloned().unwrap_or_default();
        let changed: Vec<Rect> = prev.symmetric_difference(&next).filter_map(|n| self.scene.bounds_of(*n)).collect();
        self.layers.insert(layer, next);
        self.lifted = self.layers.values().flatten().copied().collect();
        rects(&changed)
    }

    pub fn release_layer(&mut self, layer: u32) {
        self.layers.remove(&layer);
        self.lifted = self.layers.values().flatten().copied().collect();
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.layers.remove(&layer);
        }
    }

    pub fn has_layer(&self, layer: u32) -> bool {
        self.layers.contains_key(&layer)
    }

    /// Adopt a device (first attach or after a loss): re-upload every retained image.
    pub fn install_gpu(&mut self, mut gpu: Gpu) {
        let images: Vec<(u32, std::sync::Arc<vello_common::pixmap::Pixmap>)> = self.scene.images().map(|(id, p)| (*id, p.clone())).collect();
        for (id, pixmap) in images {
            gpu.upload_image(id, &pixmap);
        }
        self.gpu = Some(gpu);
    }

    /// Drop the device-bound state (after a loss, or on dispose). The scene stays.
    pub fn drop_gpu(&mut self) {
        if let Some(gpu) = self.gpu.take() {
            gpu.device.destroy();
        }
    }

    pub fn has_gpu(&self) -> bool {
        self.gpu.is_some()
    }

    /// The raw `GPUDevice` (the TypeScript lifecycle watches `lost` and reads facts from it).
    pub fn raw_device(&self) -> JsValue {
        self.gpu.as_ref().and_then(|g| g.device.as_webgpu()).map(|d| JsValue::from(d.clone())).unwrap_or(JsValue::UNDEFINED)
    }

    /// Largest render-target side (regions, layers).
    pub fn max_target(&self) -> u32 {
        self.gpu.as_ref().map_or(MAX_TARGET, |g| g.max_target)
    }

    fn gpu(&mut self) -> Result<&mut Gpu, JsValue> {
        self.gpu.as_mut().ok_or_else(|| js("no GPU device attached"))
    }

    /// Resize the frame target and the canvas configuration (device pixels).
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), JsValue> {
        let gpu = self.gpu()?;
        let (w, h) = (width.max(1), height.max(1));
        if let Some((surface, config)) = gpu.surface.as_mut() {
            config.width = w;
            config.height = h;
            surface.configure(&gpu.device, config);
        }
        gpu.frame = make_target(&gpu.device, &gpu.compositor, w, h, "sf-frame");
        Ok(())
    }

    /// Rasterize tile (`level`, `tx`, `ty`) into `slot` over `background` (straight RGBA 0…1). Returns its bytes.
    pub fn render_tile(&mut self, slot: u32, level: i32, tx: i32, ty: i32, background: &[f32]) -> Result<f64, JsValue> {
        let gpu = self.gpu.as_mut().ok_or_else(|| js("no GPU device attached"))?;
        let index = slot as usize;
        if gpu.tiles.len() <= index {
            gpu.tiles.resize_with(index + 1, || None);
        }
        if gpu.tiles[index].is_none() {
            gpu.tiles[index] = Some(make_target(&gpu.device, &gpu.compositor, TILE, TILE, "sf-tile"));
        }
        let view = gpu.tiles[index].as_ref().map(|t| t.view.clone()).unwrap();
        gpu.render_into(&self.scene, tile_view(level, tx, ty), &Filter::Except(&self.lifted), &view, TILE, TILE, true, rgba8(background))?;
        Ok((TILE as u64 * TILE as u64 * 4) as f64)
    }

    pub fn release_tile(&mut self, slot: u32) {
        if let Some(gpu) = self.gpu.as_mut() {
            if let Some(t) = gpu.tiles.get_mut(slot as usize) {
                *t = None;
            }
        }
    }

    /// Rasterize a lifted layer at `zoom`. Returns `[x, y, width, height, bytes]` (device px at `zoom`).
    pub fn render_layer(&mut self, layer: u32, zoom: f64) -> Result<Vec<f64>, JsValue> {
        let members = self.layers.get(&layer).ok_or_else(|| js(format!("unknown layer {layer}")))?.clone();
        let bounds = members.iter().filter_map(|n| self.scene.bounds_of(*n)).reduce(|a, b| a.union(b)).unwrap_or(Rect::ZERO);
        let gpu = self.gpu.as_mut().ok_or_else(|| js("no GPU device attached"))?;
        let (x, y, w, h) = layer_placement(bounds, zoom, gpu.max_target);
        let reuse = gpu.layers.get(&layer).is_some_and(|l| l.target.w == w && l.target.h == h);
        if !reuse {
            let target = make_target(&gpu.device, &gpu.compositor, w, h, "sf-layer");
            gpu.layers.insert(layer, Layer { target, x, y, zoom });
        }
        let view = gpu.layers[&layer].target.view.clone();
        let transform = Affine::translate((-x, -y)) * Affine::scale(zoom);
        gpu.render_into(&self.scene, transform, &Filter::Only(&members), &view, w, h, false, [0, 0, 0, 0])?;
        let entry = gpu.layers.get_mut(&layer).unwrap();
        entry.x = x;
        entry.y = y;
        entry.zoom = zoom;
        Ok(vec![x, y, w as f64, h as f64, (w as u64 * h as u64 * 4) as f64])
    }

    /// Upload a cached frame (straight RGBA8) as the snapshot source.
    pub fn upload_snapshot(&mut self, width: u32, height: u32, rgba: &[u8]) -> Result<(), JsValue> {
        if rgba.len() != (width * height * 4) as usize {
            return Err(js("snapshot size does not match its pixels"));
        }
        let gpu = self.gpu()?;
        let target = make_target(&gpu.device, &gpu.compositor, width, height, "sf-snapshot");
        let mut data = rgba.to_vec();
        premultiply(&mut data);
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &target.tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &data,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: None },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        gpu.snapshot = Some(target);
        Ok(())
    }

    /// Composite quads into the frame target (and present it). `quads`: 9 floats each (dst x0 y0 x1 y1
    /// in device px, uv u0 v0 u1 v1, opacity); `sources`: one `kind << 24 | id` each (kind 0 tile slot,
    /// 1 layer, 2 snapshot, 3 external). `clear`: straight RGBA 0…1.
    pub fn composite(&mut self, clear: &[f32], quads: &[f32], sources: &[u32], present: bool) -> Result<(), JsValue> {
        let gpu = self.gpu.as_mut().ok_or_else(|| js("no GPU device attached"))?;
        if quads.len() != sources.len() * 9 {
            return Err(js("composite: quads and sources disagree"));
        }
        let (fw, fh) = (gpu.frame.w as f32, gpu.frame.h as f32);
        let mut instances: Vec<f32> = Vec::with_capacity(sources.len() * INSTANCE_FLOATS);
        let mut binds: Vec<&wgpu::BindGroup> = Vec::with_capacity(sources.len());
        for (i, source) in sources.iter().enumerate() {
            let id = source & 0x00ff_ffff;
            let bind = match source >> 24 {
                0 => gpu.tiles.get(id as usize).and_then(|t| t.as_ref()).map(|t| &t.bind).ok_or_else(|| js(format!("composite: unknown tile slot {id}")))?,
                1 => gpu.layers.get(&id).map(|l| &l.target.bind).ok_or_else(|| js(format!("composite: unknown layer {id}")))?,
                2 => gpu.snapshot.as_ref().map(|t| &t.bind).ok_or_else(|| js("composite: no snapshot uploaded"))?,
                _ => return Err(js("composite: external textures arrive with M3")),
            };
            binds.push(bind);
            let q = &quads[i * 9..i * 9 + 9];
            instances.extend_from_slice(&[q[0] / fw * 2.0 - 1.0, 1.0 - q[1] / fh * 2.0, q[2] / fw * 2.0 - 1.0, 1.0 - q[3] / fh * 2.0, q[4], q[5], q[6], q[7], q[8], 0.0, 0.0, 0.0]);
        }
        // Keep one slot free at the end for the present quad.
        let needed = sources.len() as u64 + 1;
        if needed > gpu.compositor.capacity {
            let capacity = needed.next_power_of_two();
            gpu.compositor.instances = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("sf-compositor-instances"), size: capacity * (INSTANCE_FLOATS * 4) as u64, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            gpu.compositor.capacity = capacity;
        }
        if !instances.is_empty() {
            gpu.queue.write_buffer(&gpu.compositor.instances, 0, as_bytes(&instances));
        }
        let c = rgba8(clear);
        let a = c[3] as f64 / 255.0;
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("sf-composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &gpu.frame.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: c[0] as f64 / 255.0 * a, g: c[1] as f64 / 255.0 * a, b: c[2] as f64 / 255.0 * a, a }), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&gpu.compositor.frame_pipeline);
            pass.set_vertex_buffer(0, gpu.compositor.instances.slice(..));
            for (i, bind) in binds.iter().enumerate() {
                pass.set_bind_group(0, *bind, &[]);
                pass.draw(0..4, i as u32..i as u32 + 1);
            }
        }
        gpu.queue.submit([enc.finish()]);
        if present {
            gpu.present();
        }
        Ok(())
    }

    /// Compile Vello's pipelines (and the compositor's) with a tiny scene off the frame (S1: the
    /// first render otherwise costs ≈ 1 s). Resolves when the GPU finished.
    pub fn warm_up(&mut self) -> Result<Promise, JsValue> {
        let has_images = self.scene.images().next().is_some();
        let gpu = self.gpu.as_mut().ok_or_else(|| js("no GPU device attached"))?;
        let mut warm = Scene::new();
        warm.apply(&crate::ir::warm_up_batch(has_images.then(|| *gpu.images.keys().next().unwrap()))).map_err(js)?;
        let target = make_target(&gpu.device, &gpu.compositor, 64, 64, "sf-warm-up");
        gpu.render_into(&warm, Affine::IDENTITY, &Filter::Except(&HashSet::new()), &target.view, 64, 64, false, [255, 255, 255, 255])?;
        // Compositor: one quad of the warm target into itself is not allowed; draw it into a scratch target.
        let scratch = make_target(&gpu.device, &gpu.compositor, 64, 64, "sf-warm-up-2");
        gpu.queue.write_buffer(&gpu.compositor.instances, 0, as_bytes(&[-1.0, 1.0, 1.0, -1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]));
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("sf-warm-up"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &scratch.view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&gpu.compositor.frame_pipeline);
            pass.set_vertex_buffer(0, gpu.compositor.instances.slice(..));
            pass.set_bind_group(0, &target.bind, &[]);
            pass.draw(0..4, 0..1);
        }
        gpu.queue.submit([enc.finish()]);
        let queue = gpu.queue.clone();
        Ok(Promise::new(&mut |resolve: Function, _reject: Function| {
            queue.on_submitted_work_done(move || {
                let _ = resolve.call0(&JsValue::NULL);
            });
        }))
    }

    /// Start reading back the frame target; await the promise, then `finish_readback`.
    pub fn begin_read_frame(&mut self) -> Result<Promise, JsValue> {
        let gpu = self.gpu()?;
        let tex = gpu.frame.tex.clone();
        let (w, h) = (gpu.frame.w, gpu.frame.h);
        gpu.begin_copy(&tex, w, h)
    }

    /// Render a world region straight to a `width × height` target (no tiles, lifted nodes
    /// included) and start reading it back.
    #[allow(clippy::too_many_arguments)]
    pub fn begin_region(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, width: u32, height: u32, background: &[f32]) -> Result<Promise, JsValue> {
        let gpu = self.gpu.as_mut().ok_or_else(|| js("no GPU device attached"))?;
        if width == 0 || height == 0 || width > gpu.max_target || height > gpu.max_target {
            return Err(js(format!("region {width}×{height} exceeds {}", gpu.max_target)));
        }
        let target = make_target(&gpu.device, &gpu.compositor, width, height, "sf-region");
        let world = Rect::new(x0, y0, x1, y1);
        gpu.render_into(&self.scene, region_view(world, width, height), &Filter::Except(&HashSet::new()), &target.view, width, height, false, rgba8(background))?;
        gpu.begin_copy(&target.tex, width, height)
    }

    /// Straight RGBA8 pixels of the readback started by `begin_read_frame` / `begin_region`.
    pub fn finish_readback(&mut self) -> Result<Vec<u8>, JsValue> {
        let gpu = self.gpu()?;
        let pending = gpu.pending.take().ok_or_else(|| js("no readback pending"))?;
        let mut out = Vec::with_capacity((pending.w * pending.h * 4) as usize);
        {
            let mapped = pending.buffer.slice(..).get_mapped_range().map_err(|e| js(format!("get_mapped_range: {e:?}")))?;
            for row in mapped.chunks_exact(pending.bpr as usize).take(pending.h as usize) {
                out.extend_from_slice(&row[..(pending.w * 4) as usize]);
            }
        }
        pending.buffer.unmap();
        pending.buffer.destroy();
        unpremultiply(&mut out);
        Ok(out)
    }

    /// Abandon a readback whose promise rejected (device lost).
    pub fn cancel_readback(&mut self) {
        if let Some(gpu) = self.gpu.as_mut() {
            if let Some(p) = gpu.pending.take() {
                p.buffer.destroy();
            }
        }
    }

    /// `[tiles, tile_bytes, layer_bytes, other_bytes]` (our textures and Vello's image atlas pages).
    pub fn stats(&self) -> Vec<f64> {
        let Some(gpu) = self.gpu.as_ref() else { return vec![0.0, 0.0, 0.0, 0.0] };
        let tiles = gpu.tiles.iter().filter(|t| t.is_some()).count() as u64;
        let layers: u64 = gpu.layers.values().map(|l| l.target.bytes()).sum();
        vec![tiles as f64, (tiles * TILE as u64 * TILE as u64 * 4) as f64, layers as f64, gpu.other_bytes() as f64]
    }
}
