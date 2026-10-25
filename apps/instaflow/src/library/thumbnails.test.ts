import { err, ok, type Result } from '@staticflux/core';
import { scaleImage } from '@staticflux/surface/image';
import type { RasterImage, RasterRegion } from '@staticflux/surface/raster';
import { runThumbnailRendererContract } from '@staticflux/testkit';
import { describe, expect, it } from 'vitest';
import { createSceneWriter } from '../render/scene-ir.js';
import { browserImageDecoder, type BrowserImageApis, decoderMediaProbe, pngImageEncoder, sceneThumbnailRenderer, scaleThumbnailRenderer } from './thumbnails.js';
import { fakeImageDecoder, signal, unwrap } from './test-helpers.js';

const solid = (width: number, height: number, rgba: readonly number[]): RasterImage => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
};

// The shared port suite on both back ends. The scene renderer's fake backend rasterizes the uploaded
// image by area scaling (a stand-in for Vello; the GPU run is A6's `render.gpu.test.ts`).
runThumbnailRendererContract('scaleThumbnailRenderer', () => ({ renderer: scaleThumbnailRenderer() }), { describe, it });
runThumbnailRendererContract(
  'sceneThumbnailRenderer (scene IR → headless render)',
  () => {
    let uploaded: RasterImage | undefined;
    const scene = sceneThumbnailRenderer({
      backend: {
        id: 'fake-vello',
        maxRegionSize: 4096,
        apply: () => ok([]),
        renderRegion: async (region) => (uploaded === undefined ? err(new Error('no scene') as never) : scaleImage(uploaded, region.width, region.height)),
      },
    });
    return {
      renderer: {
        id: scene.id,
        render: (source, size, s) => {
          uploaded = source;
          return scene.render(source, size, s);
        },
      },
    };
  },
  { describe, it },
);

describe('scaleThumbnailRenderer (CPU fallback)', () => {
  it('area-scales to the requested size and honours an aborted signal', async () => {
    const renderer = scaleThumbnailRenderer();
    expect(renderer.id).toBe('scale/1');
    const out = unwrap(await renderer.render(solid(8, 4, [1, 2, 3, 255]), { width: 4, height: 2 }, signal));
    expect([out.width, out.height, ...out.data.subarray(0, 4)]).toEqual([4, 2, 1, 2, 3, 255]);
    const controller = new AbortController();
    controller.abort();
    expect((await renderer.render(solid(2, 2, [0, 0, 0, 0]), { width: 1, height: 1 }, controller.signal)).ok).toBe(false);
  });
});

describe('sceneThumbnailRenderer (A6 render path)', () => {
  function fakeBackend(fail?: 'apply' | 'render') {
    const applied: Uint8Array[] = [];
    const regions: RasterRegion[] = [];
    return {
      applied,
      regions,
      backend: {
        id: 'vello',
        maxRegionSize: 64,
        apply(delta: Uint8Array): Result<readonly never[]> {
          applied.push(delta);
          return fail === 'apply' && applied.length === 1 ? err(new Error('nope') as never) : ok([]);
        },
        async renderRegion(region: RasterRegion): Promise<Result<RasterImage>> {
          regions.push(region);
          if (fail === 'render') return err(new Error('lost') as never);
          return ok(solid(region.width, region.height, [9, 9, 9, 255]));
        },
      },
    };
  }

  it('draws the image as one scene IR image node over its world rect and renders that rect at the target size', async () => {
    const { backend, applied, regions } = fakeBackend();
    const renderer = sceneThumbnailRenderer({ backend });
    expect(renderer.id).toBe('scene/vello');
    const source = solid(100, 50, [255, 0, 0, 255]);
    const out = unwrap(await renderer.render(source, { width: 20, height: 10 }, signal));
    expect([out.width, out.height]).toEqual([20, 10]);
    const expected = createSceneWriter().clear().image(1, 100, 50, source.data).upsert({ id: 1, geometry: { kind: 'image', image: 1, w: 100, h: 50 } }).finish();
    expect(applied[0]).toEqual(expected);
    expect(applied[1]).toEqual(createSceneWriter().clear().dropImage(1).finish());
    expect(regions).toEqual([{ world: { x0: 0, y0: 0, x1: 100, y1: 50 }, width: 20, height: 10, background: [0, 0, 0, 0] }]);
  });

  it('serializes jobs on one backend and maps backend failures to IF-LIB-006 (the scene is still cleared)', async () => {
    const ok1 = fakeBackend();
    const renderer = sceneThumbnailRenderer({ backend: ok1.backend });
    await Promise.all([renderer.render(solid(4, 4, [1, 1, 1, 255]), { width: 2, height: 2 }, signal), renderer.render(solid(4, 4, [2, 2, 2, 255]), { width: 2, height: 2 }, signal)]);
    expect(ok1.applied).toHaveLength(4);
    const rejected = fakeBackend('apply');
    const a = await sceneThumbnailRenderer({ backend: rejected.backend }).render(solid(2, 2, [0, 0, 0, 255]), { width: 1, height: 1 }, signal);
    expect(!a.ok && a.error.code).toBe('IF-LIB-006');
    const lost = fakeBackend('render');
    const b = await sceneThumbnailRenderer({ backend: lost.backend }).render(solid(2, 2, [0, 0, 0, 255]), { width: 1, height: 1 }, signal);
    expect(!b.ok && b.error.code).toBe('IF-LIB-006');
    expect(lost.applied).toHaveLength(2);
  });
});

describe('pngImageEncoder', () => {
  it('encodes PNG with the PNG media type', async () => {
    const encoder = pngImageEncoder();
    expect(encoder.mime).toBe('image/png');
    const bytes = unwrap(await encoder.encode(solid(2, 2, [1, 2, 3, 4]), signal));
    expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  });
});

describe('browserImageDecoder', () => {
  const apis = (width: number, height: number, fail?: 'bitmap' | 'context'): BrowserImageApis & { closed: number } => {
    const state = { closed: 0 };
    return Object.assign(state, {
      createImageBitmap: async (blob: Blob) => {
        if (fail === 'bitmap') throw new Error(`cannot decode ${blob.type}`);
        return { width, height, close: () => (state.closed += 1) };
      },
      createCanvas: () => ({
        getContext: () => (fail === 'context' ? null : { drawImage: () => undefined, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }) }),
      }),
    });
  };

  it('decodes through createImageBitmap + a 2D canvas and closes the bitmap', async () => {
    const fake = apis(3, 2);
    const image = unwrap(await browserImageDecoder(fake).decode(new Uint8Array(4), 'image/png', signal));
    expect([image.width, image.height, image.data.length, image.data[0]]).toEqual([3, 2, 24, 200]);
    expect(fake.closed).toBe(1);
  });

  it('reports IF-LIB-005 without APIs, on decode errors, without a context and when aborted', async () => {
    const codes = async (decoder: ReturnType<typeof browserImageDecoder>, s = signal) => {
      const r = await decoder.decode(new Uint8Array(1), 'image/png', s);
      return !r.ok && r.error.code;
    };
    expect(await codes(browserImageDecoder(undefined))).toBe('IF-LIB-005');
    expect(await codes(browserImageDecoder(apis(1, 1, 'bitmap')))).toBe('IF-LIB-005');
    const noContext = apis(1, 1, 'context');
    expect(await codes(browserImageDecoder(noContext))).toBe('IF-LIB-005');
    expect(noContext.closed).toBe(1);
    const controller = new AbortController();
    controller.abort();
    expect(await codes(browserImageDecoder(apis(1, 1)), controller.signal)).toBe('IF-LIB-005');
    expect(await codes(browserImageDecoder())).toBe('IF-LIB-005'); // happy-dom: no OffscreenCanvas
  });
});

describe('decoderMediaProbe', () => {
  it('records the decoded size and whether any pixel is translucent', async () => {
    const probe = decoderMediaProbe(fakeImageDecoder());
    const ref = { digest: 'sha256:x' as const, size: 9, mime: 'image/png' };
    expect(unwrap(await probe.probe(ref, async () => ok(Uint8Array.of(3, 0, 2, 0, 1, 1, 1, 255, 0)), signal))).toEqual({ width: 3, height: 2, alpha: false });
    expect(unwrap(await probe.probe(ref, async () => ok(Uint8Array.of(1, 0, 1, 0, 1, 1, 1, 10, 0)), signal))).toEqual({ width: 1, height: 1, alpha: true });
    expect((await probe.probe(ref, async () => ok(Uint8Array.of(1)), signal)).ok).toBe(false);
    expect((await probe.probe(ref, async () => err(new Error('x') as never), signal)).ok).toBe(false);
  });
});
