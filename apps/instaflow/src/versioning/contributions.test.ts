import { createInjector } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { CREATE_MILESTONE_SHORTCUT, CreateMilestoneCapability } from './command.js';
import {
  CommandContributionToken,
  milestoneCommandContribution,
  milestonesPanelContribution,
  saveStatusContribution,
  TopBarContributionToken,
  versioningContributionUnits,
} from './contributions.js';
import { PanelContributionsToken } from '../spec/contributions.js';
import { StudioIds } from '../spec/studio-contributions.js';
import { MILESTONES_PANEL_TAG } from './milestones-panel.js';
import { SAVE_STATUS_TAG } from './save-status.js';
import { unwrap } from './test-helpers.js';

describe('versioning contributions', () => {
  it('are data: a panel, a top-bar status item and a command, each with its element or capability', () => {
    expect(milestonesPanelContribution).toMatchObject({ kind: 'instaflow/panel', id: StudioIds.panel.milestones, placements: ['dock', 'side'], minDensity: 'standard' });
    expect(saveStatusContribution).toMatchObject({ element: SAVE_STATUS_TAG, area: 'status' });
    expect(milestoneCommandContribution).toMatchObject({ capability: CreateMilestoneCapability, shortcut: CREATE_MILESTONE_SHORTCUT, topBar: { label: 'Milestone' } });
  });

  it('rendering the panel (and define) registers the elements and their kit dependencies (idempotent)', () => {
    milestonesPanelContribution.render({ density: 'pro', lens: StudioIds.lens.canvas, scope: 'asset' });
    milestonesPanelContribution.render({ density: 'pro', lens: StudioIds.lens.canvas, scope: 'asset' });
    saveStatusContribution.define();
    for (const tag of [MILESTONES_PANEL_TAG, SAVE_STATUS_TAG, 'sf-tree', 'sf-toolbar', 'sf-button', 'sf-text-field', 'sf-status']) expect(customElements.get(tag)).toBeDefined();
  });

  it('are collected through the contribution tokens', async () => {
    const injector = createInjector({ units: [...versioningContributionUnits] });
    expect(unwrap(await injector.get(PanelContributionsToken))).toEqual([milestonesPanelContribution]);
    expect(unwrap(await injector.get(TopBarContributionToken))).toEqual([saveStatusContribution]);
    expect(unwrap(await injector.get(CommandContributionToken))).toEqual([milestoneCommandContribution]);
    await injector.dispose();
  });
});
