import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, readCompositionStructure, STRUCTURE_PATHS, structureFeed } from './structure.js';
import { compositionDoc, priya, unwrap } from './test-helpers.js';

describe('readCompositionStructure', () => {
  it('reads page stubs in story order with sizes, canvas positions and names, and loose elements', async () => {
    const { root } = await compositionDoc(
      [
        { id: 'p1', name: 'Cover', canvas: [0, 0] },
        { id: 'p2', size: [1080, 1920], canvas: [1200, 0] },
        { id: 'p3', size: [-1, 5] },
      ],
      [{ id: 'sticker', box: [-300, 40, 120, 80] }],
    );
    const s = unwrap(readCompositionStructure(root));
    expect(s.composition).toBe('comp');
    expect(s.format).toEqual({ width: 1080, height: 1350 });
    expect(s.pages).toEqual([
      { id: 'p1', index: 0, name: 'Cover', width: 1080, height: 1350, canvas: { x: 0, y: 0 } },
      { id: 'p2', index: 1, width: 1080, height: 1920, canvas: { x: 1200, y: 0 } },
      { id: 'p3', index: 2, width: 1080, height: 1350 },
    ]);
    expect(s.loose).toEqual([{ id: 'sticker', kind: 'shape', box: { x: -300, y: 40, w: 120, h: 80 } }]);
  });

  it('falls back to the default page size without a valid format, skips unplaced non-pages, and reports IF-LIB-010', async () => {
    const { doc, root } = await compositionDoc([{ id: 'p1' }], [], { width: 0, height: 10 });
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'x' }, { root: [{ op: 'create', node: 'floating', kind: 'text', parent: 'comp' }] }));
    const s = unwrap(readCompositionStructure(root, 'comp'));
    expect(s.format).toEqual(DEFAULT_PAGE_SIZE);
    expect(s.loose).toEqual([]);
    const missing = readCompositionStructure(root, 'p1');
    expect(!missing.ok && missing.error.code).toBe('IF-LIB-010');
    const empty = readCompositionStructure({ children: () => [], node: () => undefined, prop: () => undefined });
    expect(!empty.ok && empty.error.code).toBe('IF-LIB-010');
    expect(STRUCTURE_PATHS.pageCanvas).toBe('page.canvas');
  });
});

describe('structureFeed', () => {
  it('re-reads on demand and notifies on every part change', async () => {
    const { doc, root } = await compositionDoc([{ id: 'p1' }]);
    const feed = structureFeed(root);
    let changes = 0;
    const stop = feed.observe(() => (changes += 1));
    unwrap(doc.commit({ actor: { kind: 'human', id: priya.id }, label: 'Add page' }, { root: [{ op: 'create', node: 'p2', kind: 'page', parent: 'comp' }] }));
    stop();
    expect(changes).toBe(1);
    expect(unwrap(feed.read()).pages.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
