import { createInjector } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { CREATE_MILESTONE_SHORTCUT, CreateMilestoneCapability } from './command.js';
import {
  CommandContributionToken,
  milestoneCommandContribution,
  milestonesPanelContribution,
  PanelContributionToken,
  saveStatusContribution,
  TopBarContributionToken,
  versioningContributionUnits,
} from './contributions.js';
import { MILESTONES_PANEL_TAG } from './milestones-panel.js';
import { SAVE_STATUS_TAG } from './save-status.js';
import { unwrap } from './test-helpers.js';

describe('versioning contributions', () => {
  it('are data: a panel, a top-bar status item and a command, each with its element or capability', () => {
    expect(milestonesPanelContribution).toMatchObject({ id: 'instaflow/milestones-panel', element: MILESTONES_PANEL_TAG, placement: { dock: 'end' } });
    expect(saveStatusContribution).toMatchObject({ element: SAVE_STATUS_TAG, area: 'status' });
    expect(milestoneCommandContribution).toMatchObject({ capability: CreateMilestoneCapability, shortcut: CREATE_MILESTONE_SHORTCUT, topBar: { label: 'Milestone' } });
  });

  it('define registers the elements and their kit dependencies (idempotent)', () => {
    milestonesPanelContribution.define();
    milestonesPanelContribution.define();
    saveStatusContribution.define();
    for (const tag of [MILESTONES_PANEL_TAG, SAVE_STATUS_TAG, 'sf-tree', 'sf-toolbar', 'sf-button', 'sf-text-field', 'sf-status']) expect(customElements.get(tag)).toBeDefined();
  });

  it('are collected through the contribution tokens', async () => {
    const injector = createInjector({ units: [...versioningContributionUnits] });
    expect(unwrap(await injector.get(PanelContributionToken))).toEqual([milestonesPanelContribution]);
    expect(unwrap(await injector.get(TopBarContributionToken))).toEqual([saveStatusContribution]);
    expect(unwrap(await injector.get(CommandContributionToken))).toEqual([milestoneCommandContribution]);
    await injector.dispose();
  });
});
