import { describe, expect, it } from 'vitest';
import { createStoryWriter, storyMoveOp } from './story.js';
import { readCompositionStructure } from './structure.js';
import { compositionDoc, priya, unwrap } from './test-helpers.js';

const pages = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];

describe('storyMoveOp', () => {
  it('moves a stub after the page that will precede it (first: after null)', async () => {
    const { root } = await compositionDoc(pages);
    const s = unwrap(readCompositionStructure(root));
    expect(unwrap(storyMoveOp(s, 'p3', 0))).toEqual({ op: 'move', node: 'p3', parent: 'comp', position: { after: null } });
    expect(unwrap(storyMoveOp(s, 'p1', 2))).toEqual({ op: 'move', node: 'p1', parent: 'comp', position: { after: 'p3' } });
    expect(unwrap(storyMoveOp(s, 'p1', 1))).toEqual({ op: 'move', node: 'p1', parent: 'comp', position: { after: 'p2' } });
    expect(unwrap(storyMoveOp(s, 'p2', 1))).toBeUndefined();
    const out = storyMoveOp(s, 'p1', 3);
    expect(!out.ok && out.error.code).toBe('IF-LIB-013');
    expect(storyMoveOp(s, 'p1', 0.5).ok).toBe(false);
    const unknown = storyMoveOp(s, 'zz', 0);
    expect(!unknown.ok && unknown.error.code).toBe('IF-LIB-011');
  });
});

describe('createStoryWriter', () => {
  it('reorders the story in one attributed commit; a no-op move writes nothing', async () => {
    const { doc, root } = await compositionDoc(pages);
    const labels: string[] = [];
    doc.onCommit((record) => labels.push(`${record.meta.label}:${record.meta.actor.id}`));
    const story = createStoryWriter({ doc, structure: () => readCompositionStructure(root), actor: () => priya });
    unwrap(story.movePage('p3', 0));
    expect(unwrap(readCompositionStructure(root)).pages.map((p) => p.id)).toEqual(['p3', 'p1', 'p2']);
    unwrap(story.movePage('p3', 2));
    expect(unwrap(readCompositionStructure(root)).pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    unwrap(story.movePage('p2', 1));
    expect(labels).toEqual([`Reorder pages:${priya.id}`, `Reorder pages:${priya.id}`]);
    expect(story.movePage('p2', 9).ok).toBe(false);
    const broken = createStoryWriter({ doc, structure: () => readCompositionStructure(root, 'p1'), actor: () => priya });
    expect(broken.movePage('p1', 0).ok).toBe(false);
  });
});
