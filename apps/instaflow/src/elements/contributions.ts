/**
 * B1's contributions to the editor spec (D16, B0's `apps/instaflow/src/spec`): every element action is a
 * **capability** (validated, gated per subject, attributed, one change set = one undo step) with a **HUD action**
 * that runs it, and the Fill / Stroke / Effects inspector is a **panel**. Nothing here builds a screen.
 *
 * - `elementCapabilities` — one declaration per action (`instaflow/align-left`, …, `instaflow/flatten`); input
 *   `{ nodes, target?, key?, token? }`, output `{ ops }` (ops written). Exposed to agents (they run through the same
 *   pipeline, gated as the agent; locks and brand rules apply).
 * - `elementCapabilityImplementations(env)` — implementations over the editor's element context and undo service.
 * - `elementHudActions` / `appearancePanel` — B0 contributions; `elementContributionUnits(env)` contributes them all.
 *
 * Applicability beyond lens and scope (e.g. "three elements to distribute") is the capability's input validation
 * (`IF-EL-004`), which the HUD uses to disable an action — never a mode check.
 */
import { capabilityDeclarationUnit, capabilityImplementationUnit } from '@staticflux/capabilities';
import { html } from 'lit';
import { defineHudAction, definePanel, hudActionContribution, type HudActionContribution, panelContribution, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import { ELEMENT_ACTIONS, elementActionId, elementCapabilities, elementCapabilityImplementations, type ElementEditEnv } from './capabilities.js';

export * from './capabilities.js';

/** HUD actions (B0), each running its capability; Canvas lens. */
export const elementHudActions: readonly HudActionContribution[] = ELEMENT_ACTIONS.map((a) =>
  defineHudAction({
    id: elementActionId(a.name),
    label: a.title,
    description: a.description,
    tone: a.tone,
    capability: elementActionId(a.name),
    lenses: [StudioIds.lens.canvas],
    scopes: ['selection', 'page'],
    ...(a.shortcut === undefined ? {} : { shortcut: a.shortcut as never }),
  }),
);

export const APPEARANCE_PANEL_ID = 'instaflow/appearance';

/** The Fill / Stroke / Effects panel (inspector column); the host binds its model with `bindPaintInspector`. */
export const appearancePanel: PanelContribution = definePanel({
  id: APPEARANCE_PANEL_ID,
  label: 'Fill, stroke and effects',
  description: 'Fills, strokes, effects, corners, opacity and blend of the selected element.',
  placements: ['inspector'],
  lenses: [StudioIds.lens.canvas],
  scopes: ['selection'],
  render: () => html`<if-paint-inspector></if-paint-inspector>`,
});

/** Every B1 contribution: capability declarations and implementations, HUD actions and the panel. */
export function elementContributionUnits(env: ElementEditEnv) {
  return [
    ...elementCapabilities.map((c) => capabilityDeclarationUnit(c)),
    ...elementCapabilityImplementations(env).map((impl) => capabilityImplementationUnit(impl)),
    ...elementHudActions.map((a) => hudActionContribution(a)),
    panelContribution(appearancePanel),
  ];
}
