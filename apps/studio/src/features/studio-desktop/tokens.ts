/** Feature-private tokens of studio-desktop (units registered in the feature injector). */
import { type Result, token } from '@staticflux/core';

export interface PdfExporter {
  export(): Promise<Result<{ readonly url: string }>>;
}
/** Functional dependency: resolved (and pre-warmed on hover) only when the user exports. */
export const ExportPdfToken = /* @__PURE__ */ token('studio/export-pdf').type<PdfExporter>();
