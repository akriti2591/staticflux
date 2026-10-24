/**
 * App-lifetime capability implementations over the shared document store, so the UI,
 * the command palette, the agent and WebMCP all call ONE pipeline (R3.1, R19.18):
 * validate → authorize (gate) → confirm → activate → reserve (credits) → run → commit.
 * Feature-specific capabilities (summarize) are provided by the feature at activation.
 */
import { contribution, err, ok } from '@staticflux/core';
import { CapabilityDeclarationsToken, CapabilityImplementationsToken, implementCapability } from '@staticflux/capabilities';
import { ClearDocumentCapability, DocumentStoreToken, InsertImageCapability, InsertTextCapability, SummarizeCapability } from './contracts.js';
import { NoDocumentOpenError } from './errors.js';

export const documentCapabilityDeclarations = [InsertTextCapability, InsertImageCapability, ClearDocumentCapability, SummarizeCapability].map((capability, index) =>
  contribution({
    id: `studio/capability-declaration-${index}`,
    provides: CapabilityDeclarationsToken,
    scope: 'app',
    create: () => capability,
  }),
);

export const insertTextImplementationUnit = contribution({
  id: 'studio/insert-text-implementation-unit',
  provides: CapabilityImplementationsToken,
  scope: 'app',
  deps: { required: { doc: DocumentStoreToken } },
  create: ({ doc }) =>
    implementCapability(InsertTextCapability, async ({ text }) => {
      if (doc.docId === undefined) return err(NoDocumentOpenError());
      const created = await doc.insertText(text);
      return created.ok ? ok({ blockId: created.value }) : created;
    }),
});

export const insertImageImplementationUnit = contribution({
  id: 'studio/insert-image-implementation-unit',
  provides: CapabilityImplementationsToken,
  scope: 'app',
  deps: { required: { doc: DocumentStoreToken } },
  create: ({ doc }) =>
    implementCapability(InsertImageCapability, async ({ src, alt }, context) => {
      if (doc.docId === undefined) return err(NoDocumentOpenError());
      const created = await doc.insertImage(src, alt);
      if (!created.ok) return created;
      context.reportCost(context.reserved?.amount ?? 0);
      return ok({ blockId: created.value });
    }),
});

export const clearDocumentImplementationUnit = contribution({
  id: 'studio/clear-document-implementation-unit',
  provides: CapabilityImplementationsToken,
  scope: 'app',
  deps: { required: { doc: DocumentStoreToken } },
  create: ({ doc }) =>
    implementCapability(ClearDocumentCapability, async () => {
      if (doc.docId === undefined) return err(NoDocumentOpenError());
      const removed = await doc.clear();
      return removed.ok ? ok({ removed: removed.value }) : removed;
    }),
});
