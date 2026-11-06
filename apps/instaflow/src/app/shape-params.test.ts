// @vitest-environment node
/**
 * #47: a polygon's sides and a star's points and inner radius are document values the inspector and the HUD edit
 * (`geometry.sides`, `geometry.ratio`). Over a real Studio document and the authoring Wasm: the selection summary
 * reports them, one edit is one undo step, and the outline the engine draws follows (8 sides = 8 vertices).
 */
import { ok } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { P } from '../elements/components.js';
import type { PathData } from '../elements/geometry.js';
import { resolveElement } from '../elements/resolve.js';
import { loadGeometry } from '../elements/testing/fixtures.js';
import { type SceneReader, selectionSummary } from './scene-summary.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';

const shape = (node: string, extra: Record<string, unknown>): PartOp => ({ op: 'create', node, kind: 'shape', parent: 'p1', props: { [P.x]: 0, [P.y]: 0, [P.w]: 100, [P.h]: 100, [P.fills]: [{ paint: '#ff5c39' }], ...extra } as never });

/** Corner points of an outline without rounded corners: every move-to and line-to (verbs 0 and 1). */
const vertices = (path: PathData): number => [...path.verbs].filter((v) => v === 0 || v === 1).length;

describe.skipIf(!authoringBuilt)('#47 shape parameters: sides, points, inner radius', () => {
  it('a polygon set to 8 sides is an octagon (8 vertices) in one undo step; undo gives the pentagon back', { timeout: 60_000 }, async () => {
    const geometry = await loadGeometry();
    const f = await createStudioFixture({ geometry });
    const doc = f.document;
    const reader: SceneReader = { stage: doc.view, kit: doc.kit, text: () => undefined, repeat: () => undefined, applicable: () => [] };
    // What the Polygon tool creates (`creation.ts`): 5 sides.
    unwrap(commitEdit(doc.target('p1'), person, 'Draw polygon', ok([shape('poly', { [P.shape]: 'polygon', [P.sides]: 5 })])));
    const outline = (node: NodeId): PathData => unwrap(geometry.outline(resolveElement(doc.view, node, doc.kit) as never));
    expect(selectionSummary(reader, ['poly']).points).toBe(5);
    expect(vertices(outline('poly'))).toBe(5);
    const before = doc.undo.history(person.id).undo.length;
    // The inspector's and the HUD's Sides field: one `setProp` of geometry.sides (the editor commits it as one step).
    unwrap(commitEdit(doc.target('p1'), person, 'Sides', ok([{ op: 'set', node: 'poly', path: P.sides, value: 8 }])));
    expect(doc.undo.history(person.id).undo.length).toBe(before + 1);
    expect(doc.undo.history(person.id).undo[0]?.label).toBe('Sides');
    expect(selectionSummary(reader, ['poly']).points).toBe(8);
    expect(vertices(outline('poly'))).toBe(8);
    unwrap(await doc.undo.undo(person, f.signal));
    expect(vertices(outline('poly'))).toBe(5);
    await f.scope.dispose();
  });

  it('a star’s points and inner radius change its outline; the summary reports both (inner ratio defaults to 0.382)', { timeout: 60_000 }, async () => {
    const geometry = await loadGeometry();
    const f = await createStudioFixture({ geometry });
    const doc = f.document;
    const reader: SceneReader = { stage: doc.view, kit: doc.kit, text: () => undefined, repeat: () => undefined, applicable: () => [] };
    unwrap(commitEdit(doc.target('p1'), person, 'Draw star', ok([shape('star', { [P.shape]: 'star', [P.sides]: 5 })])));
    const outline = (): PathData => unwrap(geometry.outline(resolveElement(doc.view, 'star', doc.kit) as never));
    expect(selectionSummary(reader, ['star'])).toMatchObject({ points: 5, ratio: 0.382 });
    expect(vertices(outline())).toBe(10);
    unwrap(commitEdit(doc.target('p1'), person, 'Points', ok([{ op: 'set', node: 'star', path: P.sides, value: 7 }])));
    expect(vertices(outline())).toBe(14);
    const narrow = [...outline().points];
    unwrap(commitEdit(doc.target('p1'), person, 'Inner radius', ok([{ op: 'set', node: 'star', path: P.ratio, value: 0.8 }])));
    expect(selectionSummary(reader, ['star'])).toMatchObject({ points: 7, ratio: 0.8 });
    expect([...outline().points]).not.toEqual(narrow);
    // A polygon has no inner radius.
    unwrap(commitEdit(doc.target('p1'), person, 'Draw polygon', ok([shape('poly', { [P.shape]: 'polygon', [P.sides]: 5 })])));
    expect(selectionSummary(reader, ['poly']).ratio).toBeUndefined();
    await f.scope.dispose();
  });
});
