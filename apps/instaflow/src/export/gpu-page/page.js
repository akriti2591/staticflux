// Real-WebGPU checks of the export paths (see index.html). Plain ESM over the built dist files; every result goes to
// globalThis.__sfGpuResult. PNG files travel as base64 in `data.png` (Node decodes them: the encoder is under test).
import { encodePng } from '@staticflux/surface/image';
import { createHeadlessSurface } from '@staticflux/surface/raster';
import { loadRenderModule } from '/apps/instaflow/dist/render/render-module.js';
import { createVelloRasterBackend } from '/apps/instaflow/dist/render/vello-backend.js';
import { encodePageImage, publishGpuResult } from '/packages/testkit/dist/gpu-readback.js';

const CORPUS = '/apps/instaflow/engine/crates/export/fixtures/';
const NAMES = ['appearance', 'gradients', 'effects', 'masks', 'booleans', 'transforms', 'repeats', 'images', 'layers', 'text'];
const SIZE = 192;
const WHITE = [255, 255, 255, 255];
const images = {};
const data = { png: {}, errors: [], timings: {} };
const started = performance.now();
const step = (name) => console.log(`[export-gpu] ${(performance.now() - started).toFixed(0)} ms: ${name}`);
const must = (result, what) => {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} ${result.error.message}`);
  return result.value;
};
const base64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

async function run() {
  const wasm = must(await loadRenderModule({ manifestUrl: '/apps/instaflow/engine/dist/sf-wasm-manifest.json' }), 'load render wasm');
  for (const name of NAMES) {
    step(`corpus ${name}`);
    const batch = new Uint8Array(await (await fetch(`${CORPUS}${name}.sfir`)).arrayBuffer());
    // The export worker's PNG path: a headless Vello backend, the headless surface (chunks within the region limit),
    // then the PNG encoder.
    const backend = createVelloRasterBackend({ wasm, width: 256, height: 256, id: 'instaflow-export' });
    must(await backend.attach({ signal: new AbortController().signal }), 'attach');
    must(backend.apply(batch), `apply ${name}`);
    const surface = createHeadlessSurface({ backend, maxPixels: 4096 * 4096 });
    for (const [scale, background] of [[1, WHITE], [2, WHITE], [3, WHITE], [1, undefined]]) {
      const t0 = performance.now();
      const image = must(await surface.render({ world: { x0: 0, y0: 0, x1: SIZE, y1: SIZE }, width: SIZE * scale, height: SIZE * scale, ...(background === undefined ? {} : { background }), signal: new AbortController().signal }), `render ${name} ${scale}x`);
      data.timings[`${name}@${scale}`] = Math.round(performance.now() - t0);
      const png = must(await encodePng(image, { signal: new AbortController().signal }), `encode ${name}`);
      data.png[`${name}@${scale}${background === undefined ? 't' : ''}`] = base64(png);
    }
    backend.dispose();

    // Chrome rasterizing the committed SVG export (D21 rule, scored in Node).
    const svg = await (await fetch(`${CORPUS}${name}.svg`)).text();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = new OffscreenCanvas(SIZE, SIZE);
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, SIZE, SIZE);
      g.drawImage(img, 0, 0, SIZE, SIZE);
      const px = g.getImageData(0, 0, SIZE, SIZE);
      images[`chrome-svg-${name}`] = encodePageImage({ width: SIZE, height: SIZE, data: new Uint8Array(px.data.buffer) });
    } catch (e) {
      data.errors.push(`svg ${name}: ${String(e?.message ?? e)}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

run().then(
  () => publishGpuResult({ ok: true, data, images }),
  (e) => publishGpuResult({ ok: false, error: String(e?.stack ?? e), data, images }),
);
