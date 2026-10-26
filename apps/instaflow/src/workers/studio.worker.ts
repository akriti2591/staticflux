/**
 * The browser entry of Studio's worker (B9): one script for every worker of the plan; the start arguments give it its
 * roles. The editor role loads the authoring Wasm (geometry, text) and the bundled fonts and uses Loro with B2's mark
 * rules; the render role loads the render Wasm and draws with Vello on the transferred `OffscreenCanvas`. Nothing
 * here imports Lit or the DOM (`worker-imports.test.ts` guards the graph).
 *
 * Spawn it with `new Worker(new URL('./studio.worker.ts', import.meta.url), { type: 'module', name })`.
 */
import { err, ok, type Result } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { fromWorkerScope, type MessageTargetLike } from '@staticflux/worker';
import { createStudioFonts, type FontFile } from '../app/fonts.js';
import { createVelloRaster, STUDIO_BACKGROUND } from '../app/vello-raster.js';
import { createGeometry, loadAuthoringModule as loadGeometryModule } from '../elements/geometry.js';
import { browserImageDecoder } from '../library/thumbnails.js';
import { loadRenderModule } from '../render/render-module.js';
import { loadAuthoringModule as loadTextModule } from '../text/authoring-module.js';
import { TEXT_MARK_EXPAND } from '../text/model.js';
import { WorkerBootError } from './errors.js';
import { hostStudioWorker } from './host.js';

async function font(url: string, signal: AbortSignal): Promise<FontFile> {
  const bytes = new Uint8Array(await (await fetch(url, { signal })).arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { bytes, hash: `sha256:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}` };
}

const needAssets = (): Result<never> => err(WorkerBootError({ message: 'The worker needs the Wasm manifest and the fonts (`assets` in the start arguments).', details: { step: 'assets' } }));

hostStudioWorker({
  port: fromWorkerScope(globalThis as unknown as MessageTargetLike),
  name: `instaflow/studio-worker:${(globalThis as { name?: string }).name ?? 'pipeline'}`,
  env: {
    async editor(assets, signal) {
      if (assets === undefined) return needAssets();
      const manifestUrl = assets.manifest;
      const [geometryWasm, textWasm, fonts] = await Promise.all([loadGeometryModule({ manifestUrl, signal }), loadTextModule({ manifestUrl, signal }), Promise.all(assets.fonts.map((url) => font(url, signal)))]);
      if (!geometryWasm.ok) return geometryWasm;
      if (!textWasm.ok) return textWasm;
      const studioFonts = createStudioFonts({ wasm: textWasm.value, fonts, loadComplex: (s) => loadTextModule({ manifestUrl, build: 'complex', ...(s === undefined ? {} : { signal: s }) }) });
      if (!studioFonts.ok) return studioFonts;
      return ok({ engine: createLoroEngine({ marks: TEXT_MARK_EXPAND }), geometry: createGeometry(geometryWasm.value), fonts: studioFonts.value, decoder: browserImageDecoder() });
    },
    async raster(handoff, assets, signal) {
      if (assets === undefined) return needAssets();
      const wasm = await loadRenderModule({ manifestUrl: assets.manifest, signal });
      if (!wasm.ok) return wasm;
      return createVelloRaster({ wasm: wasm.value, canvas: handoff.canvas as { width: number; height: number }, width: handoff.width, height: handoff.height, devicePixelRatio: handoff.dpr, background: STUDIO_BACKGROUND, signal });
    },
  },
});
