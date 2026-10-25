/**
 * The library's contributions to the editor spec runtime (B0, D16): the real **Assets** panel, under
 * Studio's stable id `instaflow/assets` (it replaces B0's placeholder of that id; compose one or the
 * other, since the registry rejects duplicate ids). Data only: nothing here lays out a screen.
 */
import { html } from 'lit';
import { definePanel, panelContribution, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import { defineLibraryPanel } from './library-panel.js';

export const libraryPanel: PanelContribution = /* @__PURE__ */ definePanel({
  id: StudioIds.panel.assets,
  label: 'Assets',
  description: 'Workspace assets: import, search, filter, preview, place, favorite, rename, trash (B4).',
  placements: ['dock'],
  minDensity: 'standard',
  render: () => {
    defineLibraryPanel();
    return html`<if-library-panel></if-library-panel>`;
  },
});

/** The library's contribution units (app scope: they are data). */
export const libraryContributionUnits = [/* @__PURE__ */ panelContribution(libraryPanel)] as const;
