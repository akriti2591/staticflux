/**
 * B7's contributions to the editor spec (D16, B0's `../spec`): every repeat operation is a **capability**
 * (validated, gated per subject, attributed, one change set = one undo step) with a **HUD action** that runs it, and
 * the Repeat panel is an inspector **panel**. Nothing here builds a screen.
 *
 * Capabilities (`instaflow/repeat-radial`, `-grid`, `-mirror`, `-edit`, `-expand`, `-release`), input
 * `{ nodes, params? }`, output `{ ops }`. Make actions wrap the selection (or switch a selected repeat's generator);
 * `-edit` writes `params`; `-expand` is destructive (it is undoable, but the repeat is no longer live).
 * Applicability beyond lens and scope is input validation (IF-REP-003 / IF-REP-004), which the HUD uses to disable
 * an action — never a mode check.
 */
import { capabilityDeclarationUnit, capabilityImplementationUnit } from '@staticflux/capabilities';
import { html } from 'lit';
import { defineHudAction, definePanel, hudActionContribution, type HudActionContribution, panelContribution, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import { REPEAT_ACTIONS, repeatActionId, repeatCapabilities, repeatCapabilityImplementations, type RepeatEditEnv } from './capabilities.js';

export * from './capabilities.js';

/** HUD actions (B0), each running its capability; Canvas lens. */
export const repeatHudActions: readonly HudActionContribution[] = REPEAT_ACTIONS.map((a) =>
  defineHudAction({
    id: repeatActionId(a.name),
    label: a.title,
    description: a.description,
    tone: a.tone,
    capability: repeatActionId(a.name),
    lenses: [StudioIds.lens.canvas],
    scopes: ['selection'],
  }),
);

export const REPEAT_PANEL_ID = 'instaflow/repeat';

/** The Repeat panel (inspector column); the host binds its model with `bindRepeatInspector`. */
export const repeatPanel: PanelContribution = definePanel({
  id: REPEAT_PANEL_ID,
  label: 'Repeat',
  description: 'Generator and parameters of the selected repeat; expand or release it.',
  placements: ['inspector'],
  lenses: [StudioIds.lens.canvas],
  scopes: ['selection'],
  render: () => html`<if-repeat-inspector></if-repeat-inspector>`,
});

/** Every B7 contribution: capability declarations and implementations, HUD actions and the panel. */
export function repeatContributionUnits(env: RepeatEditEnv) {
  return [
    ...repeatCapabilities.map((c) => capabilityDeclarationUnit(c)),
    ...repeatCapabilityImplementations(env).map((impl) => capabilityImplementationUnit(impl)),
    ...repeatHudActions.map((a) => hudActionContribution(a)),
    panelContribution(repeatPanel),
  ];
}
