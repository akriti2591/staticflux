/**
 * Export formats and options as data (C1; IF-29.1–29.4). A format's row says how it is made (raster through the
 * render module's headless surface, or vector through the export Wasm with that writer's wire value), its MIME type
 * and extension; nothing in the export code branches on the format name.
 */
import { err, ok, type Result } from '@staticflux/core';
import { ExportOptionsError } from './errors.js';

export interface ExportFormatInfo {
  readonly label: string;
  readonly mime: string;
  readonly extension: string;
  /** `raster`: the render module draws it (PNG). `vector`: the export Wasm writes it (`wire`: its format value). */
  readonly kind: 'raster' | 'vector';
  readonly wire?: number;
  /** One file holds every page (PDF); otherwise one file per page. */
  readonly multiPage: boolean;
  /** `scale` changes the output (pixels); vector output is resolution-independent. */
  readonly scales: boolean;
}

export const EXPORT_FORMATS = {
  png: { label: 'PNG', mime: 'image/png', extension: 'png', kind: 'raster', multiPage: false, scales: true },
  pdf: { label: 'PDF', mime: 'application/pdf', extension: 'pdf', kind: 'vector', wire: 1, multiPage: true, scales: false },
  svg: { label: 'SVG', mime: 'image/svg+xml', extension: 'svg', kind: 'vector', wire: 0, multiPage: false, scales: false },
} as const satisfies Record<string, ExportFormatInfo>;

export type ExportFormat = keyof typeof EXPORT_FORMATS;
export const EXPORT_FORMAT_IDS = Object.keys(EXPORT_FORMATS) as readonly ExportFormat[];

/** PNG pixel density: output px per design px. */
export const EXPORT_SCALES = [1, 2, 3] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];

/** What is exported: the page shown, the selection (its bounds, only its elements), or every page. */
export const EXPORT_SCOPES = ['page', 'selection', 'pages'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly scale: ExportScale;
  /** No page background (PNG alpha, SVG and PDF without the white page). */
  readonly transparent: boolean;
  readonly scope: ExportScope;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = Object.freeze({ format: 'png', scale: 2, transparent: false, scope: 'page' });

/** Raster patches for vector formats (shadows, blurs: D21) at this many px per design px (≈ 192 dpi). */
export const PATCH_SCALE = 2;

/** The page colour behind an export that is not transparent (Studio's canvas draws pages on white). */
export const PAGE_BACKGROUND: readonly [number, number, number, number] = [255, 255, 255, 255];

/** Largest PNG (pixels): the headless surface's ceiling, 16k × 16k. */
export const MAX_EXPORT_PIXELS = 256 * 1024 * 1024;

const isOneOf = <T>(list: readonly T[], value: unknown): value is T => list.includes(value as T);

/** Options from untrusted input (agents, the panel), defaults filled in. IF-EXP-001 on anything else. */
export function validateExportOptions(input: unknown): Result<ExportOptions> {
  if (input === null || typeof input !== 'object') return err(ExportOptionsError({ details: { input: typeof input } }));
  const o = input as Partial<Record<keyof ExportOptions, unknown>>;
  const format = o.format ?? DEFAULT_EXPORT_OPTIONS.format;
  const scale = o.scale ?? DEFAULT_EXPORT_OPTIONS.scale;
  const scope = o.scope ?? DEFAULT_EXPORT_OPTIONS.scope;
  const transparent = o.transparent ?? DEFAULT_EXPORT_OPTIONS.transparent;
  if (!isOneOf(EXPORT_FORMAT_IDS, format)) return err(ExportOptionsError({ message: `Unknown export format "${String(format)}".`, details: { format: String(format) } }));
  if (!isOneOf<number>(EXPORT_SCALES, scale)) return err(ExportOptionsError({ message: `Export scale must be 1, 2 or 3, got ${String(scale)}.`, details: { scale: String(scale) } }));
  if (!isOneOf(EXPORT_SCOPES, scope)) return err(ExportOptionsError({ message: `Unknown export scope "${String(scope)}".`, details: { scope: String(scope) } }));
  if (typeof transparent !== 'boolean') return err(ExportOptionsError({ message: '`transparent` must be true or false.', details: { transparent: String(transparent) } }));
  return ok({ format, scale: scale as ExportScale, transparent, scope });
}

/** A file name from the design title: letters, digits, spaces, dashes; a page suffix when there are several. */
export function exportFileName(title: string, format: ExportFormat, page?: { readonly index: number; readonly count: number }): string {
  const base =
    title
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Design';
  const suffix = page !== undefined && page.count > 1 ? ` - ${String(page.index + 1).padStart(String(page.count).length, '0')}` : '';
  return `${base}${suffix}.${EXPORT_FORMATS[format].extension}`;
}

/** One exported file. */
export interface ExportFile {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}
