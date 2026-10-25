/**
 * Versioning's contributions to the editor spec runtime (D16). B0 owns the real contribution
 * tokens; until it lands on this branch these are **local interfaces named after B0's**
 * (`PanelContribution`) plus the two shapes B0's list does not name yet (`TopBarContribution`,
 * `CommandContribution`). The coordinator reconciles them at merge (M1B-NOTES).
 *
 * Every contribution is data: an element tag and its `define`, where it docks, and the units it
 * needs. Nothing here lays out a screen.
 */
import { contribution, type MultiToken, token } from '@staticflux/core';
import type { AnyCapability } from '@staticflux/capabilities';
import type { KeyCombo } from '@staticflux/a11y';
import type { CustomElementTag } from '@staticflux/ui';
import { CREATE_MILESTONE_SHORTCUT, CreateMilestoneCapability } from './command.js';
import { defineMilestonesPanel, MILESTONES_PANEL_TAG } from './milestones-panel.js';
import { defineSaveStatus, SAVE_STATUS_TAG } from './save-status.js';

export type ContributionId = `${string}/${string}`;

/** A docked panel (B0 `PanelContribution`). */
export interface PanelContribution {
  readonly id: ContributionId;
  readonly title: string;
  /** Icon name for the dock rail. */
  readonly icon: string;
  readonly element: CustomElementTag;
  readonly define: (registry?: CustomElementRegistry) => void;
  /** Default placement; a spec may move it. */
  readonly placement: { readonly dock: 'start' | 'end'; readonly order: number };
}

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

export const PanelContributionToken: MultiToken<PanelContribution> = /* @__PURE__ */ token('instaflow/panel-contributions').multi<PanelContribution>();
export const TopBarContributionToken: MultiToken<TopBarContribution> = /* @__PURE__ */ token('instaflow/top-bar-contributions').multi<TopBarContribution>();
export const CommandContributionToken: MultiToken<CommandContribution> = /* @__PURE__ */ token('instaflow/command-contributions').multi<CommandContribution>();

export const milestonesPanelContribution: PanelContribution = {
  id: 'instaflow/milestones-panel',
  title: 'Milestones',
  icon: 'history',
  element: MILESTONES_PANEL_TAG,
  define: defineMilestonesPanel,
  placement: { dock: 'end', order: 40 },
};

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
  contribution({ id: 'instaflow/milestones-panel', provides: PanelContributionToken, scope: 'app', create: () => milestonesPanelContribution }),
  contribution({ id: 'instaflow/save-status', provides: TopBarContributionToken, scope: 'app', create: () => saveStatusContribution }),
  contribution({ id: 'instaflow/milestone-command', provides: CommandContributionToken, scope: 'app', create: () => milestoneCommandContribution }),
] as const;
