// @vitest-environment node
/**
 * The chrome's read of the open page (B11b): the layers tree (top-most first, names from the element, its text or its
 * kind; hidden and locked flags; repeats tagged) and the selection summary (kind per STUDIO-UX-SPEC §4.2.4, the values
 * the pill shows, mixed values), over a real Studio document.
 */
import { ok } from '@staticflux/core';
import type { NodeId, PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { commitEdit } from '../elements/actions.js';
import { runElementAction } from '../elements/capabilities.js';
import { P } from '../elements/components.js';
import { repeatModel } from '../repeat/inspector.js';
import { readTextBlock } from '../text/rich-text.js';
import { placeTextOps } from '../text/commands.js';
import { documentColors, layerTree, paintSummary, type SceneReader, selectionSummary } from './scene-summary.js';
import { authoringBuilt, createStudioFixture, person, unwrap } from './test-helpers.js';
import { runRepeatAction } from '../repeat/capabilities.js';

const shape = (node: string, extra: Record<string, unknown> = {}): PartOp => ({ op: 'create', node, kind: 'shape', parent: 'p1', props: { [P.x]: 0, [P.y]: 0, [P.w]: 40, [P.h]: 40, [P.fills]: [{ paint: '#ff5c39' }], ...extra } as never });

async function rig() {
  const f = await createStudioFixture();
  const doc = f.document;
  const reader: SceneReader = {
    stage: doc.view,
    kit: doc.kit,
    text: (node) => {
      const block = readTextBlock(doc.part('p1') as never, node);
      return block.ok ? block.value.text : undefined;
    },
    repeat: (node) => {
      const m = repeatModel(doc.context(), node);
      return m === undefined ? undefined : { kind: m.params.kind, count: m.instances };
    },
    applicable: () => ['instaflow/delete'],
  };
  const env = { context: () => doc.context(), target: () => doc.target('p1'), actorFor: () => ok(person) };
  return { f, doc, reader, env };
}

describe.skipIf(!authoringBuilt)('scene summary (B11b)', () => {
  it('layers: top-most first, names from the element, its text or its kind; hidden and locked; groups nest', async () => {
    const { f, doc, reader, env } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([shape('a'), shape('b', { [P.shape]: 'ellipse', name: 'Sun' }), shape('c', { [P.hidden]: true, [P.lockScope]: 'all' })])));
    unwrap(doc.commitOps('p1', person, 'Text', unwrap(placeTextOps({ node: 't', parent: 'p1', x: 0, y: 100, text: 'Night market tonight' }))));
    expect(layerTree(reader, 'p1').map((r) => [r.id, r.name, r.kind, r.hidden, r.locked])).toEqual([
      ['t', 'Night market tonight', 'text', false, false],
      ['c', 'Rectangle', 'rectangle', true, true],
      ['b', 'Sun', 'ellipse', false, false],
      ['a', 'Rectangle', 'rectangle', false, false],
    ]);
    const grouped = unwrap(runElementAction(env, 'group', { nodes: ['a', 'b'] }, person));
    const tree = layerTree(reader, 'p1');
    const group = tree.find((r) => r.id === grouped.select?.[0]);
    expect(group?.kind).toBe('group');
    expect(group?.children.map((r) => r.id)).toEqual(['b', 'a']);
    await f.scope.dispose();
  });

  it('selection kinds and values: shape, multi with mixed fills, mixed kinds, locked, boolean, mask, repeat', async () => {
    const { f, doc, reader, env } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([shape('a', { [P.radius]: 12 }), shape('b', { [P.fills]: [{ paint: '@ink' }] }), shape('l', { [P.lockScope]: 'all' })])));
    unwrap(doc.commitOps('p1', person, 'Text', unwrap(placeTextOps({ node: 't', parent: 'p1', x: 0, y: 100, text: 'Hi' }))));
    const one = selectionSummary(reader, ['a']);
    expect([one.kind, one.common, one.fill?.color, one.radius, one.label, one.actions]).toEqual(['shape', 'rectangle', '#ff5c39', 12, 'Rectangle', ['instaflow/delete']]);
    const multi = selectionSummary(reader, ['a', 'b']);
    expect([multi.kind, multi.fill?.kind, multi.label]).toEqual(['multi', 'mixed', '2 selected']);
    expect(selectionSummary(reader, ['b']).fill).toMatchObject({ kind: 'solid', token: '@ink' });
    expect(selectionSummary(reader, ['a', 't']).kind).toBe('mixed');
    expect(selectionSummary(reader, ['l']).kind).toBe('locked');
    expect(selectionSummary(reader, ['a', 'l'])).toMatchObject({ kind: 'multi', anyLocked: true, locked: false });
    expect(selectionSummary(reader, []).kind).toBe('none');
    const boolean = unwrap(runElementAction(env, 'boolean-subtract', { nodes: ['a', 'b'] }, person));
    void boolean;
    const booleanGroup = doc.view.read('a')?.parent as NodeId;
    expect(selectionSummary(reader, [booleanGroup])).toMatchObject({ kind: 'boolean', booleanOp: 'subtract' });
    await f.scope.dispose();
  });

  it('mask groups and repeats are their own kinds; document colours count uses', async () => {
    const { f, doc, reader, env } = await rig();
    unwrap(commitEdit(doc.target('p1'), person, 'Seed', ok([shape('a'), shape('b'), shape('c', { [P.fills]: [{ paint: '#3d5afe' }] })])));
    unwrap(runElementAction(env, 'mask-alpha', { nodes: ['a', 'b'] }, person));
    const maskGroup = doc.view.read('a')?.parent as NodeId;
    expect(selectionSummary(reader, [maskGroup])).toMatchObject({ kind: 'mask', mask: { node: 'a', mode: 'alpha', invert: false } });
    unwrap(runRepeatAction({ context: () => doc.context(), target: () => doc.target('p1'), actorFor: () => ok(person) }, 'repeat-radial', { nodes: ['c'] }, person));
    const repeat = layerTree(reader, 'p1').find((r) => r.kind === 'repeat');
    expect(repeat?.meta).toMatch(/^Radial · \d+$/);
    expect(selectionSummary(reader, [repeat?.id as NodeId]).kind).toBe('repeat');
    expect(documentColors(reader, 'p1')[0]).toEqual({ hex: '#FF5C39', uses: 2 });
    await f.scope.dispose();
  });

  it('paintSummary: tokens resolve through the kit, unresolved tokens are flagged, gradients show their first stop', async () => {
    const { f, doc } = await rig();
    expect(paintSummary('@primary', doc.kit)).toEqual({ kind: 'solid', color: '#ff5c39', token: '@primary' });
    expect(paintSummary('@nope', doc.kit)).toEqual({ kind: 'solid', token: '@nope', unresolved: true });
    expect(paintSummary({ kind: 'linear', stops: [{ offset: 0, color: '#000000' }] } as never, doc.kit)).toEqual({ kind: 'gradient', color: '#000000' });
    expect(paintSummary({ kind: 'image', asset: 'x' } as never, doc.kit).kind).toBe('image');
    expect(paintSummary(undefined, doc.kit).kind).toBe('none');
    await f.scope.dispose();
  });
});
