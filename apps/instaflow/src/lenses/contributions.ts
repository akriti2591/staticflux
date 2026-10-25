/**
 * The lenses' contributions to the editor spec runtime (B0, D16). The Pages **lens** itself is a
 * Studio lens contribution (`studioLenses`, `StudioIds.lens.pages`) next to Canvas; what is per-mode
 * lives here and in the feature registry:
 * - the **Pages panel** under Studio's stable id `instaflow/pages` (replaces B0's placeholder of that id;
 *   compose one or the other, since the registry rejects duplicate ids);
 * - the Pages and Canvas **lens features** (`lensFeatureUnits` in `units.ts`).
 */
import { html } from 'lit';
import { definePanel, panelContribution, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { definePagesPanel } from './pages-panel.js';

export const pagesPanel: PanelContribution = /* @__PURE__ */ definePanel({
  id: StudioIds.panel.pages,
  label: 'Pages',
  description: 'The story in order: show a page, reorder pages, previous / next / fit all (B4).',
  placements: ['dock', 'tray'],
  minDensity: 'standard',
  render: () => {
    definePagesPanel();
    return html`<if-pages-panel></if-pages-panel>`;
  },
});

/** The lens chrome's contribution units (app scope: data). */
export const lensContributionUnits = [/* @__PURE__ */ panelContribution(pagesPanel)] as const;
