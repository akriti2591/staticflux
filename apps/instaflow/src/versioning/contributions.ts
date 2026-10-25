/**
 * Versioning's contributions to the editor spec runtime (D16). The Milestones panel is a **B0 panel
 * contribution** (`instaflow/milestones`, reconciled by B8: Studio's spec places it in the dock). The top-bar
 * save status and the "Milestone" command are shapes B0's vocabulary does not have yet
 * (`TopBarContribution`, `CommandContribution`): Studio shows the save status in its top bar slot and runs the
 * command from its Milestone button.
 *
 * Every contribution is data: an element tag and its `define`, where it docks, and the units it
 * needs. Nothing here lays out a screen.
 */
import { contribution, type MultiToken, token } from '@staticflux/core';
import { html } from 'lit';
import { definePanel, panelContribution, type PanelContribution } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-ids.js';
import type { AnyCapability } from '@staticflux/capabilities';
import type { KeyCombo } from '@staticflux/a11y';
import type { CustomElementTag } from '@staticflux/ui';
import { CREATE_MILESTONE_SHORTCUT, CreateMilestoneCapability } from './command.js';
import { defineMilestonesPanel } from './milestones-panel.js';
import { defineSaveStatus, SAVE_STATUS_TAG } from './save-status.js';

export type ContributionId = `${string}/${string}`;

/** An item in the top bar (status area or actions). */
export interface TopBarContribution {
  readonly id: ContributionId;
  readonly element: CustomElementTag;
  readonly define: (registry?: CustomElementRegistry) => void;
  readonly area: 'status' | 'actions';
  readonly order: number;
}

/** A command: a capability in the palette, optionally with a shortcut and a top-bar button. */
export interface CommandContribution {
  readonly id: ContributionId;
  readonly capability: AnyCapability;
  readonly shortcut?: KeyCombo;
  /** Shown as a secondary button in the top bar actions (design: "Milestone"). */
  readonly topBar?: { readonly label: string; readonly order: number };
}

export const TopBarContributionToken: MultiToken<TopBarContribution> = /* @__PURE__ */ token('instaflow/top-bar-contributions').multi<TopBarContribution>();
export const CommandContributionToken: MultiToken<CommandContribution> = /* @__PURE__ */ token('instaflow/command-contributions').multi<CommandContribution>();

/** The Milestones panel (dock; Standard density and up, like the other dock panels). */
export const milestonesPanelContribution: PanelContribution = /* @__PURE__ */ definePanel({
  id: StudioIds.panel.milestones,
  label: 'Milestones',
  description: 'Named milestones: create, pin, rename, open read-only, compare, new document from a milestone (B5).',
  placements: ['dock', 'side'],
  minDensity: 'standard',
  render: () => {
    defineMilestonesPanel();
    return html`<if-milestones-panel></if-milestones-panel>`;
  },
});

export const saveStatusContribution: TopBarContribution = {
  id: 'instaflow/save-status',
  element: SAVE_STATUS_TAG,
  define: defineSaveStatus,
  area: 'status',
  order: 10,
};

export const milestoneCommandContribution: CommandContribution = {
  id: 'instaflow/milestone-command',
  capability: CreateMilestoneCapability,
  shortcut: CREATE_MILESTONE_SHORTCUT,
  topBar: { label: 'Milestone', order: 20 },
};

/** The contribution units B0's registry collects (app scope: they are data). */
export const versioningContributionUnits = [
  panelContribution(milestonesPanelContribution),
  contribution({ id: 'instaflow/save-status', provides: TopBarContributionToken, scope: 'app', create: () => saveStatusContribution }),
  contribution({ id: 'instaflow/milestone-command', provides: CommandContributionToken, scope: 'app', create: () => milestoneCommandContribution }),
] as const;
