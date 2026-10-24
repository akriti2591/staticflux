/**
 * Feature `studio/desktop` (chunk `feature:studio-desktop`, heavy): the editor for
 * expanded/medium form factors. Logic and UI have separate lifetimes (R5): the logic
 * follows the route and binds view state; the UI mounts the editor into the outlet.
 */
import { err, ok, unit } from '@staticflux/core';
import { ModelProviderToken } from '@staticflux/ai';
import { CapabilityRegistryToken, implementCapability, provideCapabilities } from '@staticflux/capabilities';
import { DataClientToken } from '@staticflux/data';
import { defineFeatureModule, type FeatureLogicContext } from '@staticflux/runtime';
import { html } from 'lit';
import { type DocumentStore, DocumentStoreToken, SummarizeCapability } from '../../app/contracts.js';
import { ExportPdfEndpoint } from '../../app/endpoints.js';
import { NoDocumentOpenError } from '../../app/errors.js';
import { activateStudioLogic, guardPendingSave, isStudioSnapshot, snapshotStudio } from '../../lib/studio-logic.js';
import { mountFeatureRoot } from '../../ui/feature-root.js';
import { defineDesktopEditor } from './editor.js';
import { ExportPdfToken, type PdfExporter } from './tokens.js';

const exportPdfUnit = unit({
  id: 'studio/export-pdf-unit',
  provides: ExportPdfToken,
  scope: 'feature',
  deps: { required: { client: DataClientToken, doc: DocumentStoreToken } },
  create: ({ client, doc }): PdfExporter => ({
    async export() {
      const id = doc.docId;
      if (id === undefined) return err(NoDocumentOpenError());
      await doc.flush();
      return client.call(ExportPdfEndpoint, { id });
    },
  }),
  description: 'PDF export (functional dependency, pre-warmed on hover).',
});

let store: DocumentStore | undefined;

async function provideSummarize(context: FeatureLogicContext, doc: DocumentStore) {
  const [registry, models] = await Promise.all([context.injector.get(CapabilityRegistryToken), context.injector.get(ModelProviderToken)]);
  if (!registry.ok) return registry;
  const summarize = implementCapability(SummarizeCapability, async (_input, run) => {
    const text = doc.plainText();
    if (!models.ok) return ok({ summary: text.slice(0, 140) }); // non-AI fallback (R19.15)
    const result = await models.value.summarize({ text, signal: run.signal });
    return ok({ summary: result.ok ? result.value.text : text.slice(0, 140) });
  });
  const provided = provideCapabilities(registry.value, [summarize], context.scope);
  return provided.ok ? ok() : provided;
}

export default defineFeatureModule({
  units: [exportPdfUnit],
  async activate(context) {
    const logic = await activateStudioLogic(context);
    if (!logic.ok) return logic;
    store = logic.value;
    return provideSummarize(context, logic.value);
  },
  async mount(context) {
    defineDesktopEditor();
    const guarded = await guardPendingSave(context);
    if (!guarded.ok) return guarded;
    await mountFeatureRoot(context, () => html`<studio-desktop-editor></studio-desktop-editor>`);
    return ok();
  },
  snapshot: () => snapshotStudio(store),
  async restore(data, _version, context) {
    if (!isStudioSnapshot(data) || data.docId === null) return ok();
    const doc = await context.injector.get(DocumentStoreToken);
    if (doc.ok) doc.value.tab.set(data.tab === 'comments' || data.tab === 'history' ? data.tab : undefined);
    return ok();
  },
  deactivate() {
    store = undefined;
  },
});
