// @vitest-environment node
/** B11b page edits as ops (STUDIO-UX-SPEC §3.2): add after a page with its size, duplicate re-parents the copies, delete never the last page. */
import type { PartOp } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { addPageOps, deletePageOps, duplicatePageOps, neighbourPage, PAGE_GAP, renamePageOps } from './page-ops.js';
import type { CompositionStructure } from './structure.js';

const S: CompositionStructure = {
  composition: 'comp',
  format: { width: 1080, height: 1350 },
  pages: [
    { id: 'p1', name: 'Cover', index: 0, width: 1080, height: 1350, canvas: { x: 0, y: 0 } },
    { id: 'p2', index: 1, width: 1080, height: 1920, canvas: { x: 1200, y: 0 } },
  ],
  loose: [],
};

describe('page ops', () => {
  it('add: after the given page (or at the end), its size, the next free canvas spot, a numbered name', () => {
    const made = addPageOps(S, 'p3', { after: 'p2' });
    expect(made.root).toEqual([
      { op: 'create', node: 'p3', kind: 'page', parent: 'comp', position: { after: 'p2' }, props: { name: 'Page 3', 'page.size': { width: 1080, height: 1920 }, 'page.canvas': [1200 + 1080 + PAGE_GAP, 0] } },
    ]);
    expect(made.page).toEqual([{ op: 'create', node: 'p3', kind: 'page', parent: null, props: { name: '', 'page.size': { width: 1080, height: 1920 } } }]);
    expect(addPageOps({ ...S, pages: [] }, 'p1').root[0]).toMatchObject({ position: { index: 0 }, props: { 'page.size': { width: 1080, height: 1350 } } });
  });

  it('duplicate: named "<name> copy", top-level copies re-parented in order, other ops stay with the source', () => {
    const copied: PartOp[] = [
      { op: 'set', node: 'a', path: 'lineage.key', value: 'lk_a' },
      { op: 'create', node: 'a2', kind: 'shape', parent: 'p1', position: { after: 'a' }, props: {} },
      { op: 'create', node: 'c2', kind: 'shape', parent: 'a2', position: { index: 0 }, props: {} },
      { op: 'create', node: 'b2', kind: 'text', parent: 'p1', position: { after: 'b' }, props: {} },
    ];
    const made = duplicatePageOps(S, 'p1', 'p9', copied);
    if (!made.ok) throw made.error;
    expect(made.value.root[0]).toMatchObject({ node: 'p9', position: { after: 'p1' }, props: { name: 'Cover copy' } });
    expect(made.value.source).toEqual([copied[0]]);
    expect(made.value.page.map((op) => (op.op === 'create' ? [op.node, op.parent, JSON.stringify(op.position ?? null)] : []))).toEqual([
      ['p9', null, 'null'],
      ['a2', 'p9', '{"index":0}'],
      ['c2', 'a2', '{"index":0}'],
      ['b2', 'p9', '{"index":1}'],
    ]);
    expect(duplicatePageOps(S, 'nope', 'p9', []).ok).toBe(false);
  });

  it('delete never the last page (IF-POL-052); rename refuses an empty name (IF-POL-053); unknown pages are IF-LIB-011', () => {
    expect(deletePageOps(S, 'p2')).toEqual({ ok: true, value: [{ op: 'delete', node: 'p2' }] });
    const last = deletePageOps({ ...S, pages: [S.pages[0] as never] }, 'p1');
    expect(!last.ok && last.error.code).toBe('IF-POL-052');
    expect(renamePageOps(S, 'p1', '  Front  ')).toEqual({ ok: true, value: [{ op: 'set', node: 'p1', path: 'name', value: 'Front' }] });
    const empty = renamePageOps(S, 'p1', '   ');
    expect(!empty.ok && empty.error.code).toBe('IF-POL-053');
    const unknown = deletePageOps(S, 'zz');
    expect(!unknown.ok && unknown.error.code).toBe('IF-LIB-011');
    expect([neighbourPage(S, 'p1'), neighbourPage(S, 'p2')]).toEqual(['p2', 'p1']);
  });
});
