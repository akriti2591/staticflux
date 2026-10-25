/**
 * "Export" as a capability (C1; IF-29.13, D18): the Export panel's button and agents run the same declaration through
 * the one capability pipeline. The implementation lives on main (it spawns the export worker and hands the files to
 * the person); agents get the files' names, types and sizes back, and the person gets the files.
 */
import { type CapabilityInput, type CapabilityOutput, defineCapability, implementCapability, s } from '@staticflux/capabilities';
import { defineShortcut } from '@staticflux/a11y';
import { ok } from '@staticflux/core';
import { EXPORT_FORMAT_IDS, EXPORT_SCOPES } from './formats.js';
import type { ExportService } from './service.js';

export const ExportCapability = /* @__PURE__ */ defineCapability({
  id: 'instaflow/export',
  title: 'Export',
  description:
    'Export the page shown, the selection or every page as PNG (1×, 2× or 3×; optionally transparent), PDF (real, selectable text; vector shapes; every page in one file) or SVG. Renders from a frozen snapshot in a worker and creates nothing in the design; the person receives the files.',
  input: s.object({
    format: s.enum(EXPORT_FORMAT_IDS, { description: 'png, pdf or svg' }),
    scale: s.optional(s.number({ integer: true, min: 1, max: 3, description: 'PNG pixel density: 1, 2 (default) or 3' })),
    transparent: s.optional(s.boolean({ description: 'No page background (default false)' })),
    scope: s.optional(s.enum(EXPORT_SCOPES, { description: 'page (default), selection or pages' })),
  }),
  output: s.object({
    files: s.array(s.object({ name: s.string(), mime: s.string(), size: s.number({ integer: true, min: 0 }) })),
    missingImages: s.array(s.string()),
  }),
  requiresConfirmation: false,
  destructive: false,
});

export type ExportInput = CapabilityInput<typeof ExportCapability>;
export type ExportOutput = CapabilityOutput<typeof ExportCapability>;

/** `Mod+Shift+E`: show the Export panel and export with the last choice (PNG 2× of the page at first). */
export const ExportShortcut = /* @__PURE__ */ defineShortcut({ id: 'instaflow/export', keys: ['Mod+Shift+E'], description: 'Export' });

/** The capability over the export service (main). */
export function implementExport(service: Pick<ExportService, 'run'>) {
  return implementCapability(ExportCapability, async (input, run) => {
    const done = await service.run(
      { format: input.format, scale: (input.scale ?? 2) as 1 | 2 | 3, transparent: input.transparent ?? false, scope: input.scope ?? 'page' },
      run.signal,
    );
    if (!done.ok) return done;
    return ok({ files: done.value.files.map((f) => ({ name: f.name, mime: f.mime, size: f.bytes.length })), missingImages: [...done.value.missingImages] });
  });
}
