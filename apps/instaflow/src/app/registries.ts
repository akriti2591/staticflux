/**
 * Studio's vocabulary with the real M1b contributions (B8; IF-27.14–27.17). B0's placeholders keep their stable ids
 * and are **replaced** by the feature that owns the id (never added next to it: the registry rejects duplicates,
 * IF-SPEC-002): Select / Hand (B3), Text (B2), Pages (B4 lenses), Assets (B4 library), Typography (B2), Milestones
 * (B5). Features with new ids join: Fill / stroke / effects (B1), Repeat (B7), and every HUD action (B1, B7, B2, B3,
 * B6), B10a's numeric transform bar (Transform) and C1's Export panel and capability. Placeholders nobody owns yet (Chat, Layers, Brand, Adjust, the agent HUD actions) stay as B0 drew them.
 *
 * `bindPanel` lets the host bind panel elements that take their model from the host (B1's paint inspector, B7's
 * repeat inspector) when they render, without the feature knowing about Studio.
 */
import type { AnyCapability } from '@staticflux/capabilities';
import { ok, type Result } from '@staticflux/core';
import { describeCanvasCapability, describeHudAction } from '../a11y/contributions.js';
import { appearancePanel, elementCapabilities, elementHudActions } from '../elements/contributions.js';
import { pagesPanel } from '../lenses/contributions.js';
import { libraryPanel } from '../library/contributions.js';
import { repeatCapabilities, repeatHudActions, repeatPanel } from '../repeat/contributions.js';
import { editDocumentCapability, proposeSpecCapability } from '../spec/capabilities.js';
import type { HudActionContribution, LensContribution, PanelContribution, ToolContribution } from '../spec/contributions.js';
import { createEditorRegistries, type EditorRegistries } from '../spec/registries.js';
import { studioHudActions, studioLenses, studioPanels, studioTools } from '../spec/studio-contributions.js';
import { textHudActions, textTool, typographyPanel } from '../text/contributions.js';
import { toolCapabilities, toolContributions, toolHudActions } from '../tools/contributions.js';
import { transformBarPanel } from '../tools/transform-bar.js';
import { CreateMilestoneCapability } from '../versioning/command.js';
import { ExportCapability } from '../export/capability.js';
import { exportPanel } from '../export/panel.js';
import { milestonesPanelContribution } from '../versioning/contributions.js';
import { STUDIO_COMMAND_CAPABILITIES } from './studio-commands.js';
import { FIND_CAPABILITIES } from './find-replace.js';
import { inspectorPanel } from '../studio/inspector-panel.js';
import { layersPanel } from '../studio/layers-panel.js';

/** Replace items of `base` by id with `real`, keeping `base`'s order; `real` items with new ids are appended. */
export function replaceById<T extends { readonly id: string }>(base: readonly T[], real: readonly T[]): T[] {
  const byId = new Map(real.map((item) => [item.id, item] as const));
  const replaced = base.map((item) => byId.get(item.id) ?? item);
  const known = new Set(base.map((item) => item.id));
  return [...replaced, ...real.filter((item) => !known.has(item.id))];
}

export interface StudioContributions {
  readonly lenses: readonly LensContribution[];
  readonly tools: readonly ToolContribution[];
  readonly panels: readonly PanelContribution[];
  readonly hud: readonly HudActionContribution[];
  readonly capabilities: readonly AnyCapability[];
}

/** Wrap a panel's render (the host binds the rendered element). */
export type PanelBinder = (panel: PanelContribution) => PanelContribution;

/** Every M1b contribution Studio composes (see the module header). */
export function studioContributions(bindPanel: PanelBinder = (p) => p): StudioContributions {
  return {
    lenses: studioLenses,
    tools: replaceById(studioTools, [...toolContributions, textTool]),
    panels: replaceById(studioPanels, [pagesPanel, libraryPanel, typographyPanel, milestonesPanelContribution, bindPanel(transformBarPanel), bindPanel(appearancePanel), bindPanel(repeatPanel), bindPanel(exportPanel), bindPanel(inspectorPanel), bindPanel(layersPanel)]),
    hud: replaceById(studioHudActions, [...elementHudActions, ...repeatHudActions, ...textHudActions, ...toolHudActions, describeHudAction]),
    capabilities: [proposeSpecCapability, editDocumentCapability, ...elementCapabilities, ...repeatCapabilities, ...toolCapabilities, describeCanvasCapability, CreateMilestoneCapability, ExportCapability, ...STUDIO_COMMAND_CAPABILITIES, ...FIND_CAPABILITIES],
  };
}

/** Studio's registries over `studioContributions` (IF-SPEC-002 on a duplicate). */
export function studioAppRegistries(bindPanel?: PanelBinder): Result<EditorRegistries> {
  const registries = createEditorRegistries(studioContributions(bindPanel));
  return registries.ok ? ok(registries.value) : registries;
}
