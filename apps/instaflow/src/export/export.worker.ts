/**
 * The browser entry of the export worker (C1; ARCHITECTURE §2: on demand, one job each). Loads what composing a page
 * needs (the authoring Wasm for geometry and text layout, the bundled fonts, Loro with B2's mark rules), a headless
 * Vello render module (no canvas: PNG and raster patches read back from the GPU), and the export Wasm only when a job
 * needs it (SVG, PDF, selections). Nothing here imports Lit or the DOM.
 *
 * Spawn it with `new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module', name: 'export' })`.
 */
import { ok, type Result } from '@staticflux/core';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { fromWorkerScope, type MessageTargetLike } from '@staticflux/worker';
import { createStudioFonts, type FontFile } from '../app/fonts.js';
import { createGeometry, loadAuthoringModule as loadGeometryModule } from '../elements/geometry.js';
import { browserImageDecoder } from '../library/thumbnails.js';
import { loadRenderModule } from '../render/render-module.js';
import { createVelloRasterBackend } from '../render/vello-backend.js';
import { loadAuthoringModule as loadTextModule } from '../text/authoring-module.js';
import { TEXT_MARK_EXPAND } from '../text/model.js';
import { ExportRenderError } from './errors.js';
import { type ExportWasm, loadExportModule } from './export-module.js';
import { hostExportWorker } from './host.js';
import type { ExportRaster } from './job.js';

async function font(url: string, signal: AbortSignal): Promise<FontFile> {
  const bytes = new Uint8Array(await (await fetch(url, { signal })).arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { bytes, hash: `sha256:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}` };
}

/** Headless region renders: the backend's own size is irrelevant (regions size their targets). */
const RASTER_SIZE = 256;

hostExportWorker({
  port: fromWorkerScope(globalThis as unknown as MessageTargetLike),
  name: 'instaflow/export-worker',
  env: {
    async load(assets, signal) {
      const manifestUrl = assets.manifest;
      const [geometryWasm, textWasm, fonts] = await Promise.all([loadGeometryModule({ manifestUrl, signal }), loadTextModule({ manifestUrl, signal }), Promise.all(assets.fonts.map((url) => font(url, signal)))]);
      if (!geometryWasm.ok) return geometryWasm;
      if (!textWasm.ok) return textWasm;
      const studioFonts = createStudioFonts({ wasm: textWasm.value, fonts, loadComplex: (s) => loadTextModule({ manifestUrl, build: 'complex', ...(s === undefined ? {} : { signal: s }) }) });
      if (!studioFonts.ok) return studioFonts;
      let vector: Promise<Result<ExportWasm>> | undefined;
      return ok({
        engine: createLoroEngine({ marks: TEXT_MARK_EXPAND }),
        geometry: createGeometry(geometryWasm.value),
        fonts: studioFonts.value,
        decoder: browserImageDecoder(),
        async raster(s: AbortSignal): Promise<Result<ExportRaster>> {
          const wasm = await loadRenderModule({ manifestUrl, signal: s });
          if (!wasm.ok) return wasm;
          const backend = createVelloRasterBackend({ wasm: wasm.value, width: RASTER_SIZE, height: RASTER_SIZE, id: 'instaflow-export' });
          const attached = await backend.attach({ signal: s });
          if (!attached.ok) {
            backend.dispose();
            return { ok: false, error: ExportRenderError({ cause: attached.error, details: { step: 'GPU device' } }) };
          }
          return ok(backend);
        },
        vector(s: AbortSignal) {
          // Loaded once per worker; a failed or cancelled load is retried by the next caller.
          if (vector !== undefined) return vector;
          const loading = loadExportModule({ manifestUrl, signal: s });
          vector = loading;
          void loading.then((r) => {
            if (!r.ok && vector === loading) vector = undefined;
          });
          return loading;
        },
      });
    },
  },
});
