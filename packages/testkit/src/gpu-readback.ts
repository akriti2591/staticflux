/**
 * Page-side helpers for GPU tests (browser-safe, also run against the fake GPU in Node):
 * read a texture back into an `RgbaImage`, and publish a result for the real-GPU runner.
 *
 * The page protocol (`runGpuPage` in `@staticflux/testkit/node` waits for it):
 *   globalThis.__sfGpuResult = { ok: true, data?: <JSON>, images?: { [name]: { width, height, rgba: <base64> } } }
 *   globalThis.__sfGpuResult = { ok: false, error: { message, code? } }
 * A page must publish exactly once, also on failure (wrap the test body in try/catch).
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { GpuReadbackError } from './errors.js';
import { validateImage, type RgbaImage } from './image.js';

/** WebGPU interface constants (spec values), so code needs no `GPUBufferUsage` global. */
export const GPU_CONSTANTS = {
  BufferUsage: { MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008, INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080, INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200 },
  TextureUsage: { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10 },
  MapMode: { READ: 0x0001, WRITE: 0x0002 },
  ShaderStage: { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 },
  ColorWrite: { RED: 0x1, GREEN: 0x2, BLUE: 0x4, ALPHA: 0x8, ALL: 0xf },
} as const;

/** Name of the global a GPU test page sets when it is done. */
export const GPU_RESULT_GLOBAL = '__sfGpuResult';

/** `bytesPerRow` for texture→buffer copies must be a multiple of 256. */
export const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

/** Smallest valid `bytesPerRow` for `width` texels of `bytesPerTexel` bytes. */
export function alignedBytesPerRow(width: number, bytesPerTexel = 4): number {
  return Math.ceil((width * bytesPerTexel) / COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT;
}

/** The parts of `GPUDevice` readback needs (a real device and the testkit fake both fit). */
export interface ReadbackDevice {
  createBuffer(descriptor: { label?: string; size: number; usage: number }): ReadbackBuffer;
  createCommandEncoder(descriptor?: { label?: string }): {
    copyTextureToBuffer(source: { texture: never }, destination: { buffer: never; bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number }): void;
    finish(): unknown;
  };
  readonly queue: { submit(buffers: never[]): void };
  pushErrorScope(filter: 'validation'): void;
  popErrorScope(): Promise<{ readonly message: string } | null>;
}

export interface ReadbackBuffer {
  mapAsync(mode: number): Promise<unknown>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export interface ReadbackTexture {
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

const RGBA_FORMATS = new Set(['rgba8unorm', 'rgba8unorm-srgb']);
const BGRA_FORMATS = new Set(['bgra8unorm', 'bgra8unorm-srgb']);

/**
 * Copy a texture into a mappable buffer, map it, strip the row padding and swizzle BGRA → RGBA.
 * The texture needs `COPY_SRC` usage (canvas contexts: configure `usage: RENDER_ATTACHMENT | COPY_SRC`);
 * the copy runs inside a validation error scope, so a missing usage is an error, not silent zeros.
 * Supported formats: `rgba8unorm`, `bgra8unorm` and their `-srgb` variants (bytes are returned as stored).
 * `signal` aborts the wait: the buffer is destroyed, which rejects the pending map.
 */
export async function readbackTexture(device: ReadbackDevice, texture: ReadbackTexture, options: { readonly signal?: AbortSignal; readonly label?: string } = {}): Promise<Result<RgbaImage, SfError>> {
  const { width, height, format } = texture;
  const bgra = BGRA_FORMATS.has(format);
  if (!bgra && !RGBA_FORMATS.has(format)) {
    return err(GpuReadbackError({ message: `readbackTexture: format "${format}" is not supported (8-bit RGBA/BGRA only).`, details: { format } }));
  }
  if (isAborted(options.signal)) return err(GpuReadbackError({ message: 'readbackTexture was aborted before it started.', details: { aborted: true } }));
  const bytesPerRow = alignedBytesPerRow(width);
  const buffer = device.createBuffer({ label: options.label ?? 'sf-readback', size: bytesPerRow * height, usage: GPU_CONSTANTS.BufferUsage.MAP_READ | GPU_CONSTANTS.BufferUsage.COPY_DST });
  // Aborting destroys the buffer, which rejects the pending map.
  const listening = new AbortController();
  options.signal?.addEventListener('abort', () => buffer.destroy(), { once: true, signal: listening.signal });
  try {
    device.pushErrorScope('validation');
    const encoder = device.createCommandEncoder({ label: 'sf-readback' });
    encoder.copyTextureToBuffer({ texture: texture as never }, { buffer: buffer as never, bytesPerRow, rowsPerImage: height }, { width, height });
    device.queue.submit([encoder.finish() as never]);
    const validation = await device.popErrorScope();
    if (validation !== null) {
      return err(GpuReadbackError({ message: `readbackTexture: the copy failed validation (${validation.message}).`, details: { validation: validation.message, format, usage: (texture as { usage?: unknown }).usage } }));
    }
    try {
      await buffer.mapAsync(GPU_CONSTANTS.MapMode.READ);
    } catch (e) {
      return err(GpuReadbackError({ message: `readbackTexture: mapping the readback buffer failed (${errorText(e)}).`, cause: e, details: { aborted: isAborted(options.signal) } }));
    }
    const padded = new Uint8Array(buffer.getMappedRange());
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) data.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    buffer.unmap();
    if (bgra) {
      for (let i = 0; i < data.length; i += 4) {
        const b = data[i]!;
        data[i] = data[i + 2]!;
        data[i + 2] = b;
      }
    }
    return ok({ width, height, data });
  } finally {
    listening.abort();
    buffer.destroy();
  }
}

/** One image as published by a page: base64 of the raw RGBA bytes. */
export interface GpuPageImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: string;
}

export type GpuPagePayload =
  | { readonly ok: true; readonly data?: unknown; readonly images?: Readonly<Record<string, GpuPageImage>> }
  | { readonly ok: false; readonly error: { readonly message: string; readonly code?: string } };

/** Encode an image for `GpuPagePayload.images`. */
export function encodePageImage(image: RgbaImage): GpuPageImage {
  const valid = validateImage(image);
  if (!valid.ok) throw valid.error;
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < image.data.length; i += chunk) binary += String.fromCharCode(...image.data.subarray(i, i + chunk));
  return { width: image.width, height: image.height, rgba: btoa(binary) };
}

/** Decode a published image (validates size). */
export function decodePageImage(image: GpuPageImage, name = 'image'): Result<RgbaImage, SfError> {
  let binary: string;
  try {
    binary = atob(image.rgba);
  } catch (e) {
    return err(GpuReadbackError({ message: `Published image "${name}" is not valid base64.`, cause: e, details: { name } }));
  }
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return validateImage({ width: image.width, height: image.height, data }, name);
}

/** Publish the page's result for `runGpuPage` (sets `globalThis.__sfGpuResult`). */
export function publishGpuResult(payload: GpuPagePayload, target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  target[GPU_RESULT_GLOBAL] = payload;
}

/** Reads the flag through a call so TypeScript does not narrow it across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function errorText(e: unknown): string {
  return e instanceof Error || (typeof e === 'object' && e !== null && 'message' in e) ? String((e as { message: unknown }).message) : String(e);
}
