// WebGPU compositor for N video layers. Mode 'external' = importExternalTexture(VideoFrame) (zero-copy where
// the platform allows); mode 'copy' = copyExternalImageToTexture into a persistent texture (the fallback).
const WGSL = (external) => /* wgsl */ `
struct U { rect: vec4f, size: vec2f, opacity: f32, pad: f32 };
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: ${external ? 'texture_external' : 'texture_2d<f32>'};
@group(0) @binding(2) var<uniform> u: U;
struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var c = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(0,1), vec2f(1,0), vec2f(1,1));
  let q = c[i];
  let px = u.rect.xy + q * u.rect.zw;
  var o: VO;
  o.p = vec4f(px.x / u.size.x * 2.0 - 1.0, 1.0 - px.y / u.size.y * 2.0, 0.0, 1.0);
  o.uv = q;
  return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let c = ${external ? 'textureSampleBaseClampToEdge(tex, samp, v.uv)' : 'textureSample(tex, samp, v.uv)'};
  return vec4f(c.rgb * u.opacity, u.opacity);
}`;

// Layer layout on a 1920x1080 stage. Layer 0 full frame (its barcode stays visible top-left for readback checks).
export const LAYOUT = [
  { rect: [0, 0, 1920, 1080], opacity: 1 },
  { rect: [480, 270, 1440, 810], opacity: 0.6 },
  { rect: [0, 540, 960, 540], opacity: 0.8 },
];

export async function createCompositor(canvas, { mode = 'external', layers = 3, width = 1920, height = 1080 } = {}) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  let lost = null;
  device.lost.then((i) => { lost = i.message || i.reason || 'lost'; });
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const external = mode === 'external';
  const module = device.createShaderModule({ code: WGSL(external) });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const ubufs = [];
  for (let i = 0; i < layers; i++) {
    const L = LAYOUT[i % LAYOUT.length];
    const b = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, new Float32Array([...L.rect, width, height, L.opacity, 0]));
    ubufs.push(b);
  }
  const copyTex = []; const copyBind = [];
  if (!external) {
    for (let i = 0; i < layers; i++) {
      const t = device.createTexture({ size: [1920, 1080], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      copyTex.push(t);
      copyBind.push(device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: t.createView() }, { binding: 2, resource: { buffer: ubufs[i] } }] }));
    }
  }
  const readBuf = device.createBuffer({ size: 3072 * 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let inflight = 0;

  /** Composites frames[i] (VideoFrame) into layer i. Does not close frames. Returns after submit. */
  function draw(frames, { readback = false } = {}) {
    const enc = device.createCommandEncoder();
    const binds = frames.map((f, i) => {
      if (!f) return null;
      if (external) {
        const et = device.importExternalTexture({ source: f });
        return device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: et }, { binding: 2, resource: { buffer: ubufs[i] } }] });
      }
      device.queue.copyExternalImageToTexture({ source: f }, { texture: copyTex[i] }, [Math.min(f.displayWidth, 1920), Math.min(f.displayHeight, 1080)]);
      return copyBind[i];
    });
    const target = ctx.getCurrentTexture();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pipeline);
    for (const b of binds) { if (!b) continue; pass.setBindGroup(0, b); pass.draw(6); }
    pass.end();
    if (readback) enc.copyTextureToBuffer({ texture: target, origin: [0, 0] }, { buffer: readBuf, bytesPerRow: 3072 }, [768, 48]);
    device.queue.submit([enc.finish()]);
  }
  /** Reads the layer-0 barcode back from the composited canvas texture (after draw(..., {readback:true})). */
  async function readBarcode() {
    await readBuf.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    let v = 0;
    for (let k = 0; k < 16; k++) if (px[24 * 3072 + (k * 48 + 24) * 4 + 1] > 128) v |= 1 << k;
    return v;
  }
  const done = () => device.queue.onSubmittedWorkDone();
  const info = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : {};
  return { device, draw, done, readBarcode, info, format, get lost() { return lost; }, get inflight() { return inflight; } };
}
