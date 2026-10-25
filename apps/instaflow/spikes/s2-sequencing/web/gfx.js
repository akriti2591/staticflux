// Minimal renderers for S2 (S1 already proved Vello; this only needs to put 10k rects on screen per frame).
//  webgpu: one instanced draw (selection outlines, elements with overlay offset, marquee), camera in a uniform.
//  2d:     OffscreenCanvas 2D fillRect of visible elements.
//  none:   no raster (sequencing cost only; the canvas still exists so worker rAF keeps ticking).
import { N, SIZE, VIEW_W, VIEW_H, color } from './model.js';
import { absNow } from './channels.js';

const MAXI = N + 1024 + 1, STRIDE = 6; // x y w h pad color(u32)

const WGSL = /* wgsl */ `
struct U { t: vec2f, z: f32, _p: f32, vp: vec2f, _q: vec2f };
@group(0) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) p: vec4f, @location(0) c: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) r: vec4f, @location(1) pad: f32, @location(2) c: vec4f) -> VO {
  let k = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let s = (r.xy + k * r.zw) * u.z + u.t + (k * 2.0 - 1.0) * pad;
  return VO(vec4f(s.x / u.vp.x * 2.0 - 1.0, 1.0 - s.y / u.vp.y * 2.0, 0.0, 1.0), c);
}
@fragment fn fs(i: VO) -> @location(0) vec4f { return i.c; }`;

function fillInstances(rc, F, f32, u32) {
  let n = 0;
  const put = (x, y, w, h, pad, c) => { const o = n * STRIDE; f32[o] = x; f32[o + 1] = y; f32[o + 2] = w; f32[o + 3] = h; f32[o + 4] = pad; u32[o + 5] = c; n++; };
  const drag = F.nT && (F.dx || F.dy);
  const off = drag ? new Set(F.targets) : null;
  for (const i of F.sel) if (rc.alive[i]) { const d = off && off.has(i); put(rc.x[i] + (d ? F.dx : 0), rc.y[i] + (d ? F.dy : 0), SIZE, SIZE, 2, 0xff00d0ff); }
  for (let i = 0; i < N; i++) if (rc.alive[i] && !(off && off.has(i))) put(rc.x[i], rc.y[i], SIZE, SIZE, 0, color(i));
  if (off) for (const i of F.targets) if (rc.alive[i]) put(rc.x[i] + F.dx, rc.y[i] + F.dy, SIZE, SIZE, 0, color(i)); // lifted layer on top
  if (F.mq) put(F.mq[0], F.mq[1], F.mq[2] - F.mq[0], F.mq[3] - F.mq[1], 0, 0x40ff8040);
  return n;
}

export async function makeGfx(kind, canvas) {
  if (kind === 'webgpu') return makeWebGPU(canvas);
  if (kind === '2d') return make2D(canvas);
  return { info: { kind: 'none' }, draw() {}, onDone: null };
}

async function makeWebGPU(canvas) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  const lost = { reason: null }; device.lost.then((l) => { lost.reason = `${l.reason}: ${l.message}`; });
  const errors = []; device.onuncapturederror = (e) => errors.length < 5 && errors.push(String(e.error?.message ?? e));
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const mod = device.createShaderModule({ code: WGSL });
  const pipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: mod, entryPoint: 'vs', buffers: [{ arrayStride: STRIDE * 4, stepMode: 'instance', attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32' }, { shaderLocation: 2, offset: 20, format: 'unorm8x4' }] }] },
    fragment: { module: mod, entryPoint: 'fs', targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
    primitive: { topology: 'triangle-strip' },
  });
  const ibuf = device.createBuffer({ size: MAXI * STRIDE * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  const f32 = new Float32Array(MAXI * STRIDE), u32 = new Uint32Array(f32.buffer), uni = new Float32Array(8);
  let inflight = 0;
  const info = { kind: 'webgpu', adapter: adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}` : '?', format, lost, errors, skippedGpuDone: 0 };
  return {
    info,
    draw(rc, F, cam) {
      const n = fillInstances(rc, F, f32, u32);
      uni[0] = cam.tx; uni[1] = cam.ty; uni[2] = cam.z; uni[4] = VIEW_W; uni[5] = VIEW_H;
      device.queue.writeBuffer(ubuf, 0, uni);
      device.queue.writeBuffer(ibuf, 0, f32, 0, n * STRIDE);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.12, g: 0.12, b: 0.14, a: 1 } }] });
      pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, ibuf); pass.draw(4, n); pass.end();
      device.queue.submit([enc.finish()]);
    },
    onDone(cb) {
      if (inflight > 3) { info.skippedGpuDone++; return; }
      inflight++;
      device.queue.onSubmittedWorkDone().then(() => { inflight--; cb(absNow()); });
    },
  };
}

function make2D(canvas) {
  const g = canvas.getContext('2d', { alpha: false, desynchronized: false });
  const css = (c) => `rgb(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255})`;
  const cols = Array.from({ length: N }, (_, i) => css(color(i)));
  return {
    info: { kind: '2d' },
    draw(rc, F, cam) {
      g.fillStyle = '#1f1f24'; g.fillRect(0, 0, VIEW_W, VIEW_H);
      const z = cam.z, s = SIZE * z, drag = F.nT && (F.dx || F.dy), off = drag ? new Set(F.targets) : null;
      const rect = (i, dx, dy) => { const sx = (rc.x[i] + dx) * z + cam.tx, sy = (rc.y[i] + dy) * z + cam.ty; if (sx > -s && sy > -s && sx < VIEW_W && sy < VIEW_H) { g.fillStyle = cols[i]; g.fillRect(sx, sy, s, s); } };
      g.fillStyle = '#00d0ff';
      for (const i of F.sel) if (rc.alive[i]) { const d = off && off.has(i); g.fillRect((rc.x[i] + (d ? F.dx : 0)) * z + cam.tx - 2, (rc.y[i] + (d ? F.dy : 0)) * z + cam.ty - 2, s + 4, s + 4); }
      for (let i = 0; i < N; i++) if (rc.alive[i] && !(off && off.has(i))) rect(i, 0, 0);
      if (off) for (const i of F.targets) if (rc.alive[i]) rect(i, F.dx, F.dy);
      if (F.mq) { g.fillStyle = 'rgba(64,128,255,0.25)'; g.fillRect(F.mq[0] * z + cam.tx, F.mq[1] * z + cam.ty, (F.mq[2] - F.mq[0]) * z, (F.mq[3] - F.mq[1]) * z); }
    },
    onDone: null,
  };
}
