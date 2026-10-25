// @vitest-environment node
/**
 * Export on real WebGPU (C1: IF-29.20, IF-29.21; D21): Chromium on SwiftShader + ANGLE by default, or a real GPU
 * (`SF_GPU=real`). Off unless SF_GPU is set — run `pnpm build && pnpm test:gpu`.
 *
 * The page (`gpu-page/`) renders the export parity corpus (`engine/crates/export/fixtures/<scene>.sfir`) through the
 * export worker's PNG path (headless Vello → headless surface → encodePng) and rasterizes the committed SVG exports in
 * Chrome; this file checks:
 * - PNG golden parity with the renderer: the exported PNG (decoded here) vs the `vello_cpu` reference
 *   (RENDER_THRESHOLDS.gpuVsCpu), at 1×; 2× and 3× have the right size and box-downsample to the 1× file
 *   (blurred SSIM ≥ 0.99, no missing content); a transparent export composited over white is the opaque export;
 * - SVG in Chrome against the reference under D21 (SSIM ≥ 0.98, blurred SSIM ≥ 0.99, missing ≤ 0.5 %). The numbers
 *   are printed for DECISIONS.md D21.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareImages, type ImageThresholds, RENDER_THRESHOLDS, type RgbaImage } from '@staticflux/testkit';
import { decodePng, gpuModeFromEnv, runGpuPage } from '@staticflux/testkit/node';
import { describe, expect, it } from 'vitest';

const mode = gpuModeFromEnv();
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const corpus = new URL('../../engine/crates/export/fixtures/', import.meta.url);
const NAMES = ['appearance', 'gradients', 'effects', 'masks', 'booleans', 'transforms', 'repeats', 'images', 'layers', 'text'] as const;
/**
 * A 2×/3× export box-downsampled against the 1× export: same content, different sampling. Plain SSIM is not a
 * criterion — Vello's coverage AA conflates abutting edges (measured on `masks`: one column per 16 px stripe edge,
 * SSIM 0.957 at 3×) — so blurred SSIM and missing content, as in D21.
 */
const RESAMPLED: ImageThresholds = { minSsim: 0, maxChannelDelta: 255, minBlurredSsim: 0.99, blurRadius: 1 };
/** D21 (DECISIONS.md): the vector parity rule. */
const D21 = { minSsim: 0.98, minBlurredSsim: 0.99, maxMissing: 0.005 } as const;

function png(bytes: Uint8Array): RgbaImage {
  const decoded = decodePng(bytes);
  if (!decoded.ok) throw decoded.error;
  return decoded.value;
}

function compare(actual: RgbaImage, expected: RgbaImage, thresholds: ImageThresholds): { failures: readonly string[]; ssim: number } {
  const r = compareImages(actual, expected, thresholds);
  if (!r.ok) throw r.error;
  return { failures: r.value.failures.map(String), ssim: r.value.ssim };
}

/** Over white, then a k × k box average (downsample by k). */
function downsample(image: RgbaImage, k: number): RgbaImage {
  const w = image.width / k;
  const h = image.height / k;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += image.data[((y * k + j) * image.width + x * k + i) * 4 + c] as number;
        out[(y * w + x) * 4 + c] = Math.round(s / (k * k));
      }
  return { width: w, height: h, data: out };
}

function overWhite(image: RgbaImage): RgbaImage {
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = (image.data[i + 3] as number) / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((image.data[i + c] as number) * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data: out };
}

/** Fraction of pixels whose luma differs by more than 64 after a 3 × 3 blur (missing or extra content; D21). */
function missing(a: RgbaImage, b: RgbaImage): number {
  const luma = (img: RgbaImage): Float64Array => {
    const out = new Float64Array(img.width * img.height);
    for (let i = 0; i < out.length; i++) {
      const p = i * 4;
      const al = (img.data[p + 3] as number) / 255;
      const c = (v: number): number => v * al + 255 * (1 - al);
      out[i] = 0.299 * c(img.data[p] as number) + 0.587 * c(img.data[p + 1] as number) + 0.114 * c(img.data[p + 2] as number);
    }
    return out;
  };
  const blur = (l: Float64Array, w: number, h: number): Float64Array => {
    const out = new Float64Array(l.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) {
              s += l[yy * w + xx] as number;
              n += 1;
            }
          }
        out[y * w + x] = s / n;
      }
    return out;
  };
  const la = blur(luma(a), a.width, a.height);
  const lb = blur(luma(b), b.width, b.height);
  let off = 0;
  for (let i = 0; i < la.length; i++) if (Math.abs((la[i] as number) - (lb[i] as number)) > 64) off += 1;
  return off / la.length;
}

describe.skipIf(mode === undefined)(`export on WebGPU (${mode ?? 'off'})`, () => {
  it('exports PNG with the renderer’s pixels at 1×/2×/3× and transparent, and Chrome draws the SVG exports within D21', { timeout: 600_000 }, async () => {
    const run = await runGpuPage({ target: { root, page: 'apps/instaflow/src/export/gpu-page/index.html' }, mode: mode!, timeoutMs: 540_000 });
    if (!run.ok) throw run.error;
    const report = run.value;
    const data = report.data as { png: Record<string, string>; errors: string[]; timings: Record<string, number> };
    expect(report.pageErrors).toEqual([]);
    expect(data.errors).toEqual([]);
    const rows: string[] = [];
    // `SF_EXPORT_DUMP=<dir>` keeps the exported PNGs for a look.
    const dump = process.env.SF_EXPORT_DUMP;
    if (dump !== undefined) {
      mkdirSync(dump, { recursive: true });
      for (const [key, b64] of Object.entries(data.png)) writeFileSync(`${dump}/${key.replace('@', '-')}.png`, Buffer.from(b64, 'base64'));
    }
    for (const name of NAMES) {
      const reference = png(readFileSync(new URL(`${name}.cpu.png`, corpus)));
      const file = (key: string): RgbaImage => png(Buffer.from(data.png[`${name}@${key}`] ?? '', 'base64'));
      const one = file('1');
      const gpu = compare(one, reference, RENDER_THRESHOLDS.gpuVsCpu);
      expect(gpu.failures, `PNG 1× vs vello_cpu: ${name} (ssim ${gpu.ssim.toFixed(5)})`).toEqual([]);
      for (const k of [2, 3]) {
        const big = file(String(k));
        expect([big.width, big.height]).toEqual([one.width * k, one.height * k]);
        const small = downsample(big, k);
        const down = compare(small, one, RESAMPLED);
        expect(down.failures, `PNG ${k}× downsampled vs 1×: ${name} (ssim ${down.ssim.toFixed(5)})`).toEqual([]);
        expect(missing(small, one), `PNG ${k}× downsampled vs 1×: missing content: ${name}`).toBeLessThanOrEqual(D21.maxMissing);
      }
      const clear = file('1t');
      const composited = compare(overWhite(clear), one, RENDER_THRESHOLDS.gpuVsCpu);
      expect(composited.failures, `transparent PNG over white vs opaque: ${name}`).toEqual([]);

      const chrome = report.images[`chrome-svg-${name}`];
      expect(chrome, `Chrome SVG raster: ${name}`).toBeDefined();
      const svg = compareImages(chrome!, reference, { minSsim: D21.minSsim, maxChannelDelta: 255, minBlurredSsim: D21.minBlurredSsim, blurRadius: 1 });
      if (!svg.ok) throw svg.error;
      const off = missing(chrome!, reference);
      rows.push(`${name}: png ${gpu.ssim.toFixed(4)} · svg(chrome) ssim ${svg.value.ssim.toFixed(4)} blurred ${(svg.value.blurredSsim ?? NaN).toFixed(4)} missing ${(off * 100).toFixed(2)}%`);
      expect(svg.value.failures, `SVG in Chrome vs vello_cpu (D21): ${name}`).toEqual([]);
      expect(off, `SVG in Chrome: missing content (D21): ${name}`).toBeLessThanOrEqual(D21.maxMissing);
    }
    // eslint-disable-next-line no-console
    console.log(`export GPU (${mode}, ${report.adapter?.architecture ?? '?'}):\n${rows.join('\n')}\ntimings ${JSON.stringify(data.timings)}`);
  });
});
