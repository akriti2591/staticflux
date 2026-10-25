// @vitest-environment node
import { err, ok } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { appearancePanel, elementCapabilities, elementHudActions } from '../elements/contributions.js';
import { P } from '../elements/components.js';
import { authoringBuilt, human, loadGeometry, shape, unwrap } from '../elements/testing/fixtures.js';
import { createEditorRegistries } from '../spec/registries.js';
import { studioHudActions, studioLenses, studioPanels, studioTools } from '../spec/studio-contributions.js';
import { RP } from './components.js';
import {
  REPEAT_ACTIONS,
  REPEAT_PANEL_ID,
  repeatCapabilities,
  repeatCapabilityImplementations,
  repeatContributionUnits,
  type RepeatEditEnv,
  repeatHudActions,
  repeatPanel,
  repeatSelectionFacts,
  runRepeatAction,
} from './contributions.js';
import { RepeatNotApplicableError } from './errors.js';
import { createRepeatFixture } from './testing/fixtures.js';

describe('B7 contributions (B0 tokens)', () => {
  it('declares one capability and one HUD action per repeat operation, plus the panel', () => {
    expect(repeatCapabilities.map((c) => c.id)).toEqual(['instaflow/repeat-radial', 'instaflow/repeat-grid', 'instaflow/repeat-mirror', 'instaflow/repeat-edit', 'instaflow/repeat-expand', 'instaflow/repeat-release']);
    expect(repeatHudActions.map((h) => h.capability)).toEqual(repeatCapabilities.map((c) => c.id));
    expect(repeatCapabilities.find((c) => c.id === 'instaflow/repeat-expand')?.destructive).toBe(true);
    expect(repeatCapabilities.every((c) => c.exposeToAgents)).toBe(true);
    expect(repeatPanel.id).toBe(REPEAT_PANEL_ID);
    expect(repeatPanel.placements).toEqual(['inspector']);
    expect(repeatPanel.render({ density: 'pro', lens: 'instaflow/lens-canvas', scope: 'selection' })).toBeDefined();
    const units = repeatContributionUnits({ context: () => undefined, target: () => undefined, actorFor: () => ok(human) });
    expect(units).toHaveLength(REPEAT_ACTIONS.length * 3 + 1);
  });

  it('registers with the Studio vocabulary next to B1 (no id collisions)', () => {
    const registries = createEditorRegistries({
      lenses: studioLenses,
      tools: studioTools,
      panels: [...studioPanels, appearancePanel, repeatPanel],
      hud: [...studioHudActions, ...elementHudActions, ...repeatHudActions],
      capabilities: [...elementCapabilities, ...repeatCapabilities],
    });
    expect(registries.ok).toBe(true);
  });
});

describe.skipIf(!authoringBuilt)('repeat operations through the capability seam', () => {
  it('run as one change set with the run actor; refuse inapplicable selections and aborted runs', async () => {
    const g = await loadGeometry();
    const f = await createRepeatFixture(g, [shape('a', { [P.w]: 10, [P.h]: 10, [P.fills]: [{ paint: '#000' }] }), shape('b', { [P.x]: 20, [P.w]: 10, [P.h]: 10 })]);
    const ctx = f.rctx();
    const env: RepeatEditEnv = { context: () => ctx, target: () => f.target, actorFor: () => ok(human) };
    expect(repeatSelectionFacts(ctx, ['a', 'b'])).toEqual({ count: 2, elements: 2, sameParent: true, repeats: 0, derived: 0 });
    expect(unwrap(runRepeatAction(env, 'repeat-grid', { nodes: ['a', 'b'], params: { columns: 4, rows: 1 } }, human))).toEqual({ ops: 3 });
    expect(f.undo.history(human.id).undo).toHaveLength(1);
    expect(f.view.children('x1')).toHaveLength(4);
    expect(repeatSelectionFacts(ctx, ['x1', 'x1~1^a'])).toMatchObject({ repeats: 1, derived: 1 });
    const onCopy = runRepeatAction(env, 'repeat-radial', { nodes: ['x1~1^a'] }, human);
    expect(!onCopy.ok && onCopy.error.code).toBe('IF-REP-003');
    const noParams = runRepeatAction(env, 'repeat-edit', { nodes: ['x1'] }, human);
    expect(!noParams.ok && noParams.error.code).toBe('IF-REP-003');
    const tooMany = runRepeatAction(env, 'repeat-edit', { nodes: ['x1'], params: { rows: 100, columns: 100 } }, human);
    expect(!tooMany.ok && tooMany.error.code).toBe('IF-REP-002');
    expect(unwrap(runRepeatAction(env, 'repeat-edit', { nodes: ['x1'], params: { kind: 'mirror' } }, human))).toEqual({ ops: 1 });
    expect(f.view.children('x1')).toHaveLength(2);
    const aborted = new AbortController();
    aborted.abort();
    const stopped = runRepeatAction(env, 'repeat-release', { nodes: ['x1'] }, human, aborted.signal);
    expect(!stopped.ok && stopped.error.code).toBe('SF-CORE-002'); // aborted
    expect(runRepeatAction({ ...env, context: () => undefined }, 'repeat-release', { nodes: ['x1'] }, human).ok).toBe(false);
    const run = { invocationId: 'i1', subject: 'user', origin: undefined, signal: new AbortController().signal, span: undefined, reserved: undefined, reportCost: () => undefined } as never;
    const expand = repeatCapabilityImplementations(env).find((i) => i.capability.id === 'instaflow/repeat-expand');
    expect(unwrap(await expand!.run({ nodes: ['x1'] }, run)).ops).toBeGreaterThan(3);
    expect(f.view.params('x1')).toBeUndefined();
    expect(f.view.read('x1')?.values[RP.kind]).toBeUndefined();
    const denied = repeatCapabilityImplementations({ ...env, actorFor: () => err(RepeatNotApplicableError()) })[0];
    expect((await denied!.run({ nodes: ['a'] }, run)).ok).toBe(false);
  });
});
