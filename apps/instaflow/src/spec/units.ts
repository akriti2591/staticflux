/**
 * DI units of the editor spec module: the registries built from every contributed lens, tool, panel,
 * HUD action and declared capability, and Studio's own contributions (placeholders until B1–B5 land).
 */
import { capabilityDeclarationUnit, CapabilityDeclarationsToken } from '@staticflux/capabilities';
import { token, unit } from '@staticflux/core';
import { editDocumentCapability, proposeSpecCapability } from './capabilities.js';
import {
  HudActionContributionsToken,
  hudActionContribution,
  LensContributionsToken,
  lensContribution,
  PanelContributionsToken,
  panelContribution,
  ToolContributionsToken,
  toolContribution,
} from './contributions.js';
import { createEditorRegistries, type EditorRegistries } from './registries.js';
import { studioHudActions, studioLenses, studioPanels, studioTools } from './studio-contributions.js';

export const EditorRegistriesToken = /* @__PURE__ */ token('instaflow/editor-registries').type<EditorRegistries>();

export const editorRegistriesUnit = unit({
  id: 'instaflow/editor-registries-unit',
  provides: EditorRegistriesToken,
  scope: 'app',
  deps: {
    required: {
      lenses: LensContributionsToken,
      tools: ToolContributionsToken,
      panels: PanelContributionsToken,
      hud: HudActionContributionsToken,
      capabilities: CapabilityDeclarationsToken,
    },
  },
  create: ({ lenses, tools, panels, hud, capabilities }): EditorRegistries => {
    const registries = createEditorRegistries({ lenses, tools, panels, hud, capabilities });
    if (!registries.ok) throw registries.error;
    return registries.value;
  },
  description: 'The closed vocabulary editor specs are validated against (IF-19.2).',
});

/** Studio's contributions and the editor capabilities (one line to opt in). */
export const studioContributionUnits = Object.freeze([
  ...studioLenses.map(lensContribution),
  ...studioTools.map(toolContribution),
  ...studioPanels.map(panelContribution),
  ...studioHudActions.map(hudActionContribution),
  capabilityDeclarationUnit(proposeSpecCapability),
  capabilityDeclarationUnit(editDocumentCapability),
]);
