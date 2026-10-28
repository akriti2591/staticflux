/**
 * A design's cover (#64; HOME-FILES §1 "Jump back in" and §2 Files: the card's thumbnail "rendered by Studio"): the
 * design's first page, made off the main thread by an export worker of its own (the composition, headless raster and
 * PNG encoder of a PNG export; D10: from a frozen snapshot, writing nothing) and fitted within `COVER_EDGE` px there.
 * Main gets only the encoded bytes. A cover never competes with the person's export: it has its own service.
 */
import { err, ok, type Result } from '@staticflux/core';
import { NothingToExportError } from './errors.js';
import type { ExportOptions } from './formats.js';
import { createExportService, type ExportServiceOptions } from './service.js';

/** Longest side of a cover in px: the 158 px card thumbnail (HOME-FILES §1.3) at 2×. */
export const COVER_EDGE = 320;
/** Recorded in the rendition params. */
export const COVER_RENDERER = 'instaflow/export-png';
/** The page over its own fill, at 2× before fitting (a small page stays sharp; a large one renders at the cover's size). */
export const COVER_EXPORT_OPTIONS: ExportOptions = Object.freeze({ format: 'png', scale: 2, transparent: false, scope: 'page' });

/** One rendered cover. */
export interface CoverImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly edge: number;
  /** The snapshot it was rendered from (its digest). */
  readonly source: string;
  readonly renderer: string;
}

export type CoverRenderer = (signal: AbortSignal) => Promise<Result<CoverImage>>;

/** Covers through a dedicated export service (first page, `COVER_EDGE`, PNG). */
export function createCoverRenderer(options: Omit<ExportServiceOptions, 'deliver' | 'edge'>): { readonly render: CoverRenderer; dispose(): void } {
  let source = '';
  const service = createExportService({
    ...options,
    edge: COVER_EDGE,
    target: async (signal) => {
      const target = await options.target(signal);
      if (!target.ok) return target;
      source = target.value.snapshot.ref.digest;
      return ok({ ...target.value, page: target.value.pages[0], selection: [] });
    },
  });
  return {
    async render(signal) {
      const done = await service.run(COVER_EXPORT_OPTIONS, signal);
      if (!done.ok) return done;
      const file = done.value.files[0];
      if (file === undefined) return err(NothingToExportError({ message: 'The design has no page to show on its card.' }));
      return ok({ bytes: file.bytes, mime: file.mime, edge: COVER_EDGE, source, renderer: COVER_RENDERER });
    },
    dispose: () => service.dispose(),
  };
}
