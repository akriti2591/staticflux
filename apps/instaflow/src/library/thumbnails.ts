/**
 * Rendition back ends. Thumbnails go **through the A6 render path** when a raster backend is at hand
 * (`sceneThumbnailRenderer`: the decoded image becomes one scene IR image node, rendered by the
 * backend's headless surface at the target size — the same compositor as the canvas and export, so a
 * thumbnail looks like the asset does on the canvas). The **documented fallback** is
 * `scaleThumbnailRenderer` (area-average scaling on the CPU, `@staticflux/surface/image`) for contexts
 * without WebGPU: Node, CI, an export worker on the unsupported screen. Both are `ThumbnailRenderer`s;
 * which one runs is a boot binding (DI), never a branch in the queue.
 *
 * `pngImageEncoder` stores thumbnails as deterministic PNG; `browserImageDecoder` decodes content with
 * `createImageBitmap` + `OffscreenCanvas` (worker-safe); `decoderMediaProbe` turns a decoder into the
 * import probe for images.
 */
import type { BlobRef } from '@staticflux/blob';
import { err, ok, type Result } from '@staticflux/core';
import { encodePng, PNG_MIME, type RasterImage, scaleImage } from '@staticflux/surface/image';
import { createHeadlessSurface, type RasterBackend } from '@staticflux/surface/raster';
import { createSceneWriter } from '../render/scene-ir.js';
import { MediaDecodeError, RenditionError } from './errors.js';
import type { MediaProbe } from './ingest.js';
import type { ImageDecoder, ImageEncoder, ThumbnailRenderer } from './renditions.js';

/** CPU fallback: area-average scaling (deterministic, no GPU). */
export function scaleThumbnailRenderer(): ThumbnailRenderer {
  return {
    id: 'scale/1',
    render: async (source, size, signal) => {
      if (signal.aborted) return err(RenditionError({ message: 'The thumbnail render was cancelled.', cause: signal.reason }));
      return scaleImage(source, size.width, size.height);
    },
  };
}

/** Scene IR ids the thumbnail scene uses (its own backend; never the canvas scene). */
const THUMB_IMAGE = 1;
const THUMB_NODE = 1;

export interface SceneThumbnailOptions {
  /** A raster backend dedicated to renditions (scene IR deltas: the Vello backend, `@instaflow/app/render`). */
  readonly backend: Pick<RasterBackend<Uint8Array>, 'id' | 'apply' | 'renderRegion' | 'maxRegionSize'>;
}

/**
 * The A6 render path: upload the pixels as a scene image, draw one image node over the source's world
 * rect, render that rect headlessly at the target size, then clear the scene. Jobs are serialized
 * (one scene per backend).
 */
export function sceneThumbnailRenderer(options: SceneThumbnailOptions): ThumbnailRenderer {
  const { backend } = options;
  const surface = createHeadlessSurface({ backend });
  let chain: Promise<unknown> = Promise.resolve();
  const run = async (source: RasterImage, size: { readonly width: number; readonly height: number }, signal: AbortSignal): Promise<Result<RasterImage>> => {
    const scene = createSceneWriter()
      .clear()
      .image(THUMB_IMAGE, source.width, source.height, source.data)
      .upsert({ id: THUMB_NODE, geometry: { kind: 'image', image: THUMB_IMAGE, w: source.width, h: source.height } })
      .finish();
    const applied = backend.apply(scene);
    if (!applied.ok) return err(RenditionError({ message: 'The render backend rejected the thumbnail scene.', cause: applied.error }));
    try {
      const rendered = await surface.render({ world: { x0: 0, y0: 0, x1: source.width, y1: source.height }, width: size.width, height: size.height, background: [0, 0, 0, 0], signal });
      return rendered.ok ? rendered : err(RenditionError({ message: 'The headless thumbnail render failed.', cause: rendered.error }));
    } finally {
      backend.apply(createSceneWriter().clear().dropImage(THUMB_IMAGE).finish());
    }
  };
  return {
    id: `scene/${backend.id}`,
    render(source, size, signal) {
      const result = chain.then(() => run(source, size, signal));
      chain = result.catch(() => undefined);
      return result;
    },
  };
}

/** Deterministic PNG thumbnails. */
export function pngImageEncoder(): ImageEncoder {
  return { mime: PNG_MIME, encode: (image, signal) => encodePng(image, { signal }) };
}

/** The browser APIs `browserImageDecoder` uses (injectable for tests). */
export interface BrowserImageApis {
  readonly createImageBitmap: (source: Blob) => Promise<{ readonly width: number; readonly height: number; close(): void }>;
  readonly createCanvas: (width: number, height: number) => {
    getContext(kind: '2d'): { drawImage(image: unknown, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { readonly data: Uint8ClampedArray } } | null;
  };
}

const defaultApis = (): BrowserImageApis | undefined => {
  const g = globalThis as { createImageBitmap?: BrowserImageApis['createImageBitmap']; OffscreenCanvas?: new (w: number, h: number) => ReturnType<BrowserImageApis['createCanvas']> };
  const Canvas = g.OffscreenCanvas;
  if (g.createImageBitmap === undefined || Canvas === undefined) return undefined;
  return { createImageBitmap: (blob) => (g.createImageBitmap as BrowserImageApis['createImageBitmap'])(blob), createCanvas: (w, h) => new Canvas(w, h) };
};

/** Decode with `createImageBitmap` + `OffscreenCanvas` (main thread or worker). IF-LIB-005 on failure. */
export function browserImageDecoder(apis: BrowserImageApis | undefined = defaultApis()): ImageDecoder {
  return {
    async decode(bytes, mime, signal) {
      if (apis === undefined) return err(MediaDecodeError({ message: 'This context cannot decode images (no createImageBitmap / OffscreenCanvas).', details: { mime } }));
      if (signal.aborted) return err(MediaDecodeError({ message: 'Decoding was cancelled.', cause: signal.reason, details: { mime } }));
      try {
        const bitmap = await apis.createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
        try {
          const context = apis.createCanvas(bitmap.width, bitmap.height).getContext('2d');
          if (context === null) return err(MediaDecodeError({ message: 'No 2D context to read the decoded pixels.', details: { mime } }));
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
          return ok({ width: bitmap.width, height: bitmap.height, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) });
        } finally {
          bitmap.close();
        }
      } catch (cause) {
        return err(MediaDecodeError({ cause, details: { mime } }));
      }
    },
  };
}

/** An import probe for images: decode once and record the pixel size (and whether any pixel is translucent). */
export function decoderMediaProbe(decoder: ImageDecoder): MediaProbe {
  return {
    async probe(content: BlobRef, read, signal) {
      const bytes = await read();
      if (!bytes.ok) return bytes;
      const decoded = await decoder.decode(bytes.value, content.mime, signal);
      if (!decoded.ok) return decoded;
      let alpha = false;
      for (let i = 3; i < decoded.value.data.length && !alpha; i += 4) alpha = (decoded.value.data[i] as number) < 255;
      return ok({ width: decoded.value.width, height: decoded.value.height, alpha });
    },
  };
}
