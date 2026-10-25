/**
 * Contract suite for **thumbnail renderers** (Instaflow M1b B4, IF-23.11): anything that renders straight
 * RGBA pixels at a target size — a GPU scene path (the A6 headless render) or a CPU fallback — must
 * agree on the basics, so the rendition queue can take either:
 *
 * - the output has exactly the requested size (and `width × height × 4` bytes);
 * - a solid colour stays that colour (within `tolerance` per channel);
 * - the same input renders the same bytes (renditions dedupe by digest);
 * - an aborted signal is an error `Result`, never a throw;
 * - `id` names the renderer (it is recorded in rendition params).
 *
 * ```ts
 * runThumbnailRendererContract('scale', () => ({ renderer: scaleThumbnailRenderer() }), { describe, it });
 * ```
 */
import type { Result } from '@staticflux/core';
import type { RasterImage } from '@staticflux/surface/raster';
import { assertEqual, assertTrue, type ContractCaseBase, type ContractRunner, okValue } from './contract-runner.js';

/** The port, structurally (Instaflow's `ThumbnailRenderer`). */
export interface ThumbnailRendererLike {
  readonly id: string;
  render(source: RasterImage, size: { readonly width: number; readonly height: number }, signal: AbortSignal): Promise<Result<RasterImage>>;
}

export interface ThumbnailRendererFixture {
  readonly renderer: ThumbnailRendererLike;
  /** Largest per-channel difference accepted for a solid colour (default 0). */
  readonly tolerance?: number;
  readonly cleanup?: () => void | Promise<void>;
}

export type ThumbnailRendererCase = ContractCaseBase<ThumbnailRendererFixture>;

const signal = (): AbortSignal => new AbortController().signal;

function solid(width: number, height: number, rgba: readonly [number, number, number, number]): RasterImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

/** A deterministic gradient with a translucent corner. */
function pattern(width: number, height: number): RasterImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data.set([(x * 255) / Math.max(1, width - 1), (y * 255) / Math.max(1, height - 1), 128, x < width / 4 && y < height / 4 ? 64 : 255], i);
    }
  }
  return { width, height, data };
}

export function thumbnailRendererContractCases(): readonly ThumbnailRendererCase[] {
  return [
    {
      name: 'names itself',
      async run({ renderer }) {
        assertTrue(typeof renderer.id === 'string' && renderer.id.length > 0, 'a renderer has a non-empty id');
      },
    },
    {
      name: 'renders exactly the requested size',
      async run({ renderer }) {
        for (const [source, size] of [
          [pattern(64, 32), { width: 16, height: 8 }],
          [pattern(30, 50), { width: 7, height: 11 }],
          [pattern(8, 8), { width: 8, height: 8 }],
        ] as const) {
          const out = okValue(await renderer.render(source, size, signal()), `render ${source.width}×${source.height} → ${size.width}×${size.height}`);
          assertEqual([out.width, out.height, out.data.length], [size.width, size.height, size.width * size.height * 4], 'output size');
        }
      },
    },
    {
      name: 'keeps a solid colour',
      async run({ renderer, tolerance = 0 }) {
        const colour = [255, 92, 57, 255] as const;
        const out = okValue(await renderer.render(solid(40, 20, colour), { width: 10, height: 5 }, signal()), 'render solid');
        for (let i = 0; i < out.data.length; i += 1) {
          const delta = Math.abs((out.data[i] as number) - (colour[i % 4] as number));
          assertTrue(delta <= tolerance, `channel ${i % 4} of pixel ${Math.floor(i / 4)} differs by ${delta} (tolerance ${tolerance})`);
        }
      },
    },
    {
      name: 'is deterministic',
      async run({ renderer }) {
        const a = okValue(await renderer.render(pattern(48, 36), { width: 12, height: 9 }, signal()), 'first render');
        const b = okValue(await renderer.render(pattern(48, 36), { width: 12, height: 9 }, signal()), 'second render');
        assertTrue(a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]), 'the same input renders the same bytes');
      },
    },
    {
      name: 'an aborted signal is an error result, not a throw',
      async run({ renderer }) {
        const controller = new AbortController();
        controller.abort();
        const result = await renderer.render(pattern(16, 16), { width: 4, height: 4 }, controller.signal);
        assertTrue(!result.ok, 'an aborted render returns an error');
      },
    },
  ];
}

export function runThumbnailRendererContract(name: string, factory: () => ThumbnailRendererFixture | Promise<ThumbnailRendererFixture>, runner: ContractRunner): void {
  runner.describe(`ThumbnailRenderer contract: ${name}`, () => {
    for (const testCase of thumbnailRendererContractCases()) {
      runner.it(testCase.name, async () => {
        const fixture = await factory();
        try {
          await testCase.run(fixture);
        } finally {
          await fixture.cleanup?.();
        }
      });
    }
  });
}
