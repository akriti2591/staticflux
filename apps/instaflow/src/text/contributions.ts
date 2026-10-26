/**
 * Text's contributions to the editor spec runtime (B0, D16; IF-21.26–21.29): the Text tool (B3 hosts tool behaviour;
 * this provides the creation and editing actions it calls), the Typography inspector panel, and the text HUD actions
 * (Font, Size, Fit to box). All data; nothing here lays out a screen. Wired to the real B0 tokens.
 */
import { contribution } from '@staticflux/core';
import { html } from 'lit';
import { defineHudAction, definePanel, defineTool, hudActionContribution, PanelContributionsToken, type PanelContribution, toolContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import { TextIds } from './commands.js';
import { defineTypographyPanel, TYPOGRAPHY_PANEL_TAG } from './typography-panel.js';
import { TypographyServiceToken } from './typography.js';

export * from './commands.js';

/** Text edits in the layout lenses (the same lenses as Studio's Text tool and Typography slot). */
const LENSES = [StudioIds.lens.canvas, StudioIds.lens.pages];

/** The Text tool (`T`): click to create a text element, click into text to edit it (B3 runs the pointer flow). */
export const textTool = /* @__PURE__ */ defineTool({
  id: TextIds.tool,
  label: 'Text',
  glyph: 'T',
  shortcut: 'T',
  lenses: LENSES,
  description: 'Create and edit text: click to place, drag to set a width, click into text to edit.',
});

export const typographyPanel: PanelContribution = /* @__PURE__ */ definePanel({
  id: TextIds.panel,
  label: 'Typography',
  placements: ['inspector', 'side'],
  // B11b: the inspector is open in Standard (DENSITY-DISCLOSURE §3.1).
  minDensity: 'standard',
  lenses: LENSES,
  scopes: ['selection', 'asset', 'page'],
  description: 'Font, size, style, alignment, line height and colour of the selected text.',
  render: () => html`<if-typography-panel></if-typography-panel>`,
});

export const textHudActions = Object.freeze([
  defineHudAction({ id: TextIds.hud.font, label: 'Font', tone: 'direct', lenses: LENSES, scopes: ['selection'], description: 'Pick the font of the selected text.' }),
  defineHudAction({ id: TextIds.hud.size, label: 'Size', tone: 'direct', lenses: LENSES, scopes: ['selection'], description: 'Set the font size of the selected text.' }),
  defineHudAction({ id: TextIds.hud.fit, label: 'Fit to box', tone: 'direct', lenses: LENSES, scopes: ['selection'], description: 'Scale the text so it fits its box.' }),
]);

/* @__NO_SIDE_EFFECTS__ */
function typographyPanelUnit() {
  return contribution({
    id: `${TextIds.panel}-panel`,
    provides: PanelContributionsToken,
    scope: 'app',
    deps: { required: { typography: TypographyServiceToken } },
    create: () => {
      defineTypographyPanel();
      return typographyPanel;
    },
    description: 'Panel Typography (needs the typography service).',
  });
}

/** Units contributing text's tool, panel and HUD actions (the panel needs `TypographyServiceToken` bound). */
export function textContributionUnits() {
  return [toolContribution(textTool), typographyPanelUnit(), ...textHudActions.map((a) => hudActionContribution(a))] as const;
}

export { TYPOGRAPHY_PANEL_TAG };
