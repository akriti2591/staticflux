/**
 * App-lifetime capability implementations over the shared document store, so the UI,
 * the command palette, the agent and WebMCP all call ONE pipeline (R3.1, R19.18):
 * validate → authorize (gate) → confirm → activate → reserve (credits) → run → commit.
 * Feature-specific capabilities (summarize) are provided by the feature at activation.
 */
import { contribution, type DepHandle, err, ok, type Result } from '@staticflux/core';
import { CapabilityDeclarationsToken, CapabilityImplementationsToken, implementCapability } from '@staticflux/capabilities';
import { ClearDocumentCapability, type DocumentStore, DocumentStoreToken, InsertImageCapability, InsertTextCapability, SummarizeCapability } from './contracts.js';
import { NoDocumentOpenError } from './errors.js';

export const documentCapabilityDeclarations = [InsertTextCapability, InsertImageCapability, ClearDocumentCapability, SummarizeCapability].map((capability, index) =>
  contribution({
    id: `studio/capability-declaration-${index}`,
    provides: CapabilityDeclarationsToken,
    scope: 'app',
    create: () => capability,
  }),
);

/** The document store (lazy: loading it loads the document runtime chunk) with a document open. */
async function openDocument(doc: DepHandle<DocumentStore>, signal: AbortSignal): Promise<Result<DocumentStore>> {
  const ready = await doc.whenReady(signal);
  if (!ready.ok) return ready;
  return ready.value.docId === undefined ? err(NoDocumentOpenError()) : ok(ready.value);
}

export const insertTextImplementationUnit = contribution({
  id: 'studio/insert-text-implementation-unit',
  provides: CapabilityImplementationsToken,
  scope: 'app',
  deps: { lazy: { doc: DocumentStoreToken } },
  create: ({ doc }) =>
    implementCapability(InsertTextCapability, async ({ text }, context) => {
      const store = await openDocument(doc, context.signal);
      if (!store.ok) return store;
      const created = await store.value.insertText(text);
      return created.ok ? ok({ blockId: created.value }) : created;
    }),
});

export const insertImageImplementationUnit = contribution({
  id: 'studio/insert-image-implementation-unit',
  provides: CapabilityImplementationsToken,
  scope: 'app',
  deps: { lazy: { doc: DocumentStoreToken } },
  create: ({ doc }) =>
    implementCapability(InsertImageCapability, async ({ src, alt }, context) => {
      const store = await openDocument(doc, context.signal);
      if (!store.ok) return store;
      const created = await store.value.insertImage(src, alt);
      if (!created.ok) return created;
      context.reportCost(context.reserved?.amount ?? 0);
      return ok({ blockId: created.value });
    }),
});

export const clearDocumentImplementationUnit = contribution({
  id: 'studio/clear-document-implementation-unit',
  provides: CapabilityImplementationsToken,
  scope: 'app',
  deps: { lazy: { doc: DocumentStoreToken } },
  create: ({ doc }) =>
    implementCapability(ClearDocumentCapability, async (_input, context) => {
      const store = await openDocument(doc, context.signal);
      if (!store.ok) return store;
      const removed = await store.value.clear();
      return removed.ok ? ok({ removed: removed.value }) : removed;
    }),
});
