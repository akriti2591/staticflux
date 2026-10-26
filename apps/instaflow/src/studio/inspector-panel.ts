/**
 * The inspector as a spec panel (B11b): Studio places `instaflow/inspector` in the inspector column of every lens, so
 * the layout stays declared (an agent's spec can move or drop it like any panel). The host binds the rendered
 * `<if-inspector>` to the editor's mirrors and its port (`bindPanel`); the panel passes the density.
 */
import { html } from 'lit';
import { definePanel, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';

export const inspectorPanel: PanelContribution = definePanel({
  id: StudioIds.panel.inspector,
  label: 'Inspector',
  description: 'The selection’s sections (transform, text, image, fill, stroke, effects, layer …), or the page and document when nothing is selected.',
  placements: ['inspector'],
  // Focus density shows the inspector as a rail (STUDIO §5.1); Standard and Pro open it.
  minDensity: 'standard',
  render: (context) => html`<if-inspector density=${context.density}></if-inspector>`,
});
