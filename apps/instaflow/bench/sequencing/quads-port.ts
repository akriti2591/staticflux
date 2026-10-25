/**
 * Bench-only `RenderPort`: WebGPU instanced quads (one per element, overlay targets moved, selection
 * tinted, marquee drawn) into the transferred OffscreenCanvas. It stands in for A6's Vello renderer so
 * the bench measures sequencing + a real GPU submit/present, like S2's `gfx=webgpu`. Not production code.
 */
import { ok, type Result } from '@staticflux/core';
import type { RenderFrame, RenderPort } from '../../src/sequencing/render-port.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- no @webgpu/types in this repo; the bench talks to WebGPU untyped */
type Gpu = any;

const SHADER = /* wgsl */ `
struct Camera { tx: f32, ty: f32, zoom: f32, pad: f32, size: vec2f, pad2: vec2f };
@group(0) @binding(0) var<uniform> camera: Camera;
struct Out { @builtin(position) position: vec4f, @location(0) color: vec4f };
@vertex fn vs(@builtin(vertex_index) v: u32, @location(0) rect: vec4f, @location(1) color: vec4f) -> Out {
  let corner = vec2f(f32(v & 1u), f32((v >> 1u) & 1u));
  let doc = rect.xy + corner * rect.zw;
  let screen = doc * camera.zoom + vec2f(camera.tx, camera.ty);
  let clip = vec2f(screen.x / camera.size.x * 2.0 - 1.0, 1.0 - screen.y / camera.size.y * 2.0);
  var out: Out;
  out.position = vec4f(clip, 0.0, 1.0);
  out.color = color;
  return out;
}
@fragment fn fs(input: Out) -> @location(0) vec4f { return input.color; }
`;

export interface QuadsPortInfo {
  readonly ready: boolean;
  readonly adapter: string;
  readonly skippedBeforeReady: number;
  readonly error: string | undefined;
}

export interface QuadsPort extends RenderPort {
  readonly info: QuadsPortInfo;
  /** Resolves when the device is ready (or failed). */
  readonly whenReady: Promise<void>;
}

const tint = (slot: number): [number, number, number] => {
  let h = Math.imul(slot ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  return [((h & 0xff) / 255) * 0.6 + 0.2, (((h >>> 8) & 0xff) / 255) * 0.6 + 0.2, (((h >>> 16) & 0xff) / 255) * 0.6 + 0.2];
};

export function createQuadsPort(canvas: () => OffscreenCanvas | undefined): QuadsPort {
  let device: Gpu;
  let context: Gpu;
  let pipeline: Gpu;
  let uniform: Gpu;
  let bindGroup: Gpu;
  let instances: Gpu;
  let capacity = 0;
  let data = new Float32Array(0);
  let ready = false;
  let adapterName = '';
  let skipped = 0;
  let error: string | undefined;

  const init = async (): Promise<void> => {
    const target = canvas();
    const gpu: Gpu = (globalThis as { navigator?: { gpu?: Gpu } }).navigator?.gpu;
    if (target === undefined || gpu === undefined) {
      error = 'no canvas or no WebGPU';
      return;
    }
    const adapter = await gpu.requestAdapter();
    if (adapter === null) {
      error = 'no adapter';
      return;
    }
    adapterName = `${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''}`.trim();
    device = await adapter.requestDevice();
    context = target.getContext('webgpu');
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: SHADER });
    pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 32,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              { shaderLocation: 1, offset: 16, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-strip' },
    });
    uniform = device.createBuffer({ size: 32, usage: 0x40 | 0x8 }); // UNIFORM | COPY_DST
    bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    ready = true;
  };
  const whenReady = init().catch((e: unknown) => {
    error = String((e as Error)?.message ?? e);
  });

  const ensure = (count: number): void => {
    if (count <= capacity) return;
    capacity = Math.max(1024, 2 ** Math.ceil(Math.log2(count)));
    instances?.destroy?.();
    instances = device.createBuffer({ size: capacity * 32, usage: 0x20 | 0x8 }); // VERTEX | COPY_DST
    data = new Float32Array(capacity * 8);
  };

  return {
    whenReady,
    get info() {
      return { ready, adapter: adapterName, skippedBeforeReady: skipped, error };
    },
    draw(frame: RenderFrame): Result<void> {
      if (!ready) {
        skipped += 1;
        return ok();
      }
      const { scene, view } = frame;
      const xs = scene.column('x');
      const ys = scene.column('y');
      const ws = scene.column('w');
      const hs = scene.column('h');
      const lifted = new Map<number, true>();
      for (let i = 0; i < view.overlayCount; i++) lifted.set(view.targets[i] as number, true);
      const selected = new Set<number>();
      for (let i = 0; i < view.selectionCount; i++) selected.add(view.selection[i] as number);
      ensure(scene.count + 1);
      let n = 0;
      const put = (x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void => {
        const o = n * 8;
        data[o] = x;
        data[o + 1] = y;
        data[o + 2] = w;
        data[o + 3] = h;
        data[o + 4] = r;
        data[o + 5] = g;
        data[o + 6] = b;
        data[o + 7] = a;
        n += 1;
      };
      scene.forEach((slot) => {
        const moved = lifted.has(slot);
        const [r, g, b] = selected.has(slot) ? [1, 0.85, 0.2] : tint(slot);
        put((xs[slot] as number) + (moved ? view.dx : 0), (ys[slot] as number) + (moved ? view.dy : 0), ws[slot] as number, hs[slot] as number, r, g, b, 1);
      });
      if (view.marqueeOn === 1) {
        const m = view.marquee;
        put(m[0] as number, m[1] as number, (m[2] as number) - (m[0] as number), (m[3] as number) - (m[1] as number), 0.3, 0.6, 1, 0.25);
      }
      device.queue.writeBuffer(uniform, 0, new Float32Array([view.tx, view.ty, view.zoom, 0, 1280, 720, 0, 0]));
      device.queue.writeBuffer(instances, 0, data, 0, n * 8);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.07, g: 0.07, b: 0.08, a: 1 } }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setVertexBuffer(0, instances);
      pass.draw(4, n);
      pass.end();
      device.queue.submit([encoder.finish()]);
      return ok();
    },
    dispose() {
      instances?.destroy?.();
      device?.destroy?.();
    },
  };
}
