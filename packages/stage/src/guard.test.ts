import { describe, expect, it } from 'vitest';
import { stageWriteGuard } from './guard.js';
import { createSessionLayer } from './layers.js';
import { createStage } from './stage.js';
import { StageToken, UndoServiceToken } from './units.js';
import { agent, alice, docOf } from './test-helpers.js';

describe('stage write guard', () => {
  it('checks every part’s ops against the stage’s locks', () => {
    const { doc } = docOf('as_g', [
      { op: 'create', node: 'r', kind: 'composition', parent: null },
      { op: 'create', node: 'a', kind: 'shape', parent: 'r', props: { 'lock.scope': 'all' } },
      { op: 'create', node: 'b', kind: 'shape', parent: 'r' },
    ]);
    const guard = stageWriteGuard(createStage({ root: doc, session: createSessionLayer() }));
    expect(guard({ 'page:1': [{ op: 'set', node: 'b', path: 'spatial.x', value: 1 }] }, alice).ok).toBe(true);
    const denied = guard({ 'page:1': [{ op: 'set', node: 'b', path: 'spatial.x', value: 1 }], 'page:2': [{ op: 'delete', node: 'a' }] }, agent);
    expect(denied.ok ? '' : denied.error.code).toBe('SF-STAGE-001');
    expect(guard({}, alice).ok).toBe(true);
  });

  it('exposes typed tokens for the stage and the undo service', () => {
    expect(StageToken.id).toBe('stage/stage');
    expect(UndoServiceToken.id).toBe('stage/undo-service');
  });
});
