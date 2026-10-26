// @vitest-environment node
import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { createEditorRegistries } from '../spec/registries.js';
import { studioHudActions, studioLenses, studioPanels, studioTools } from '../spec/studio-contributions.js';
import { P } from './components.js';
import {
  APPEARANCE_PANEL_ID,
  appearancePanel,
  ELEMENT_ACTIONS,
  elementCapabilities,
  elementCapabilityImplementations,
  elementContributionUnits,
  type ElementEditEnv,
  elementHudActions,
  runElementAction,
  selectionFacts,
} from './contributions.js';
import { ActionNotApplicableError } from './errors.js';
import { authoringBuilt, createFixture, human, loadGeometry, PAGE, shape, unwrap } from './testing/fixtures.js';

describe('B1 contributions (B0 tokens)', () => {
  it('declares one capability and one HUD action per element action, plus the inspector panel', () => {
    expect(elementCapabilities).toHaveLength(ELEMENT_ACTIONS.length);
    expect(elementHudActions.map((h) => h.capability)).toEqual(elementCapabilities.map((c) => c.id));
    expect(new Set(elementCapabilities.map((c) => c.id)).size).toBe(ELEMENT_ACTIONS.length);
    for (const name of ['align-left', 'center-in-container', 'distribute-h-spacing', 'tidy-up', 'boolean-union', 'boolean-exclude', 'flatten', 'outline-stroke', 'mask-luminance', 'mask-release', 'apply-token']) {
      expect(elementCapabilities.some((c) => c.id === `instaflow/${name}`), name).toBe(true);
    }
    expect(elementCapabilities.find((c) => c.id === 'instaflow/flatten')?.destructive).toBe(true);
    expect(appearancePanel.id).toBe(APPEARANCE_PANEL_ID);
    expect(appearancePanel.placements).toEqual(['inspector']);
    expect(appearancePanel.render({ density: 'pro', lens: 'instaflow/lens-canvas', scope: 'selection' })).toBeDefined();
    const units = elementContributionUnits({ context: () => undefined, target: () => undefined, actorFor: () => ok(human) });
    expect(units).toHaveLength(ELEMENT_ACTIONS.length * 3 + 1);
  });

  it('registers with the Studio vocabulary (B0 registries)', () => {
    const registries = createEditorRegistries({
      lenses: studioLenses,
      tools: studioTools,
      panels: [...studioPanels, appearancePanel],
      hud: [...studioHudActions, ...elementHudActions],
      capabilities: elementCapabilities,
    });
    expect(registries.ok).toBe(true);
  });
});

describe.skipIf(!authoringBuilt)('element actions through the capability seam', () => {
  it('runs as one change set with the run actor; refuses inapplicable selections', async () => {
    const g = await loadGeometry();
    const f = await createFixture([
      shape('a', { [P.x]: 0, [P.w]: 10, [P.h]: 10 }),
      shape('b', { [P.x]: 40, [P.y]: 30, [P.w]: 10, [P.h]: 10, [P.strokes]: [{ paint: '#000', width: 1 }] }),
    ]);
    const env: ElementEditEnv = { context: () => f.ctx(g), target: () => ({ undo: f.undo, stage: f.stage, part: PAGE }), actorFor: () => ok(human) };
    expect(selectionFacts(f.ctx(g), ['a', 'b'])).toEqual({ count: 2, elements: 2, sameParent: true, booleans: 0, masks: 0, withStroke: 1, flattenable: 2, containers: 0 });
    expect(unwrap(runElementAction(env, 'align-top', { nodes: ['a', 'b'] }, human))).toEqual({ ops: 1 });
    expect(f.stage.value('b', P.y)).toBe(0);
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    const few = runElementAction(env, 'distribute-h-spacing', { nodes: ['a', 'b'] }, human);
    expect(!few.ok && few.error.code).toBe('IF-EL-004');
    expect(runElementAction({ ...env, context: () => undefined }, 'tidy-up', { nodes: ['a', 'b'] }, human).ok).toBe(false);
    const impl = elementCapabilityImplementations(env).find((i) => i.capability.id === 'instaflow/boolean-union');
    const run = { invocationId: 'i1', subject: 'user', origin: undefined, signal: new AbortController().signal, span: undefined, reserved: undefined, reportCost: () => undefined } as never;
    expect(unwrap(await impl!.run({ nodes: ['a', 'b'] }, run))).toEqual({ ops: 3 });
    const denied = elementCapabilityImplementations({ ...env, actorFor: () => err(ActionNotApplicableError()) })[0];
    expect((await denied!.run({ nodes: ['a'] }, run)).ok).toBe(false);
    expect(unwrap(runElementAction(env, 'apply-token', { nodes: ['a'], tokenTarget: 'fill', token: '@primary' }, human))).toEqual({ ops: 1 });
    expect(runElementAction(env, 'apply-token', { nodes: ['a'] }, human).ok).toBe(false);
  });
});
