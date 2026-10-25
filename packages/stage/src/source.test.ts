import { describe, expect, it } from 'vitest';
import { createPartsDocument, createStaticAssets, isAssetRef, isFollowing, refKey, type StageDocumentChange } from './source.js';
import { docOf, part, unwrap } from './test-helpers.js';

const meta = { actor: { kind: 'human', id: 'h' }, label: 'Edit' };

describe('asset references (IF-4.5)', () => {
  it('keys pinned and following references', () => {
    expect(refKey({ asset: 'as_1' })).toBe('as_1');
    expect(refKey({ asset: 'as_1', at: 'latest' })).toBe('as_1');
    expect(refKey({ asset: 'as_1', at: 'ms_9' })).toBe('as_1@ms_9');
    expect(isFollowing({ asset: 'as_1', at: 'latest' })).toBe(true);
    expect(isFollowing({ asset: 'as_1', at: 'ms_9' })).toBe(false);
    expect(isFollowing({ asset: 'as_1' })).toBe(false);
  });

  it('recognizes reference shapes', () => {
    expect(isAssetRef({ asset: 'as_1' })).toBe(true);
    expect(isAssetRef({ asset: 'as_1', at: 'latest' })).toBe(true);
    expect(isAssetRef({ asset: 'as_1', at: 3 })).toBe(false);
    expect(isAssetRef({ asset: 1 })).toBe(false);
    expect(isAssetRef([{ asset: 'as_1' }])).toBe(false);
    expect(isAssetRef(null)).toBe(false);
  });
});

describe('parts document', () => {
  it('reads nodes across attached parts and reports changes', () => {
    const doc = createPartsDocument('as_x');
    const changes: StageDocumentChange[] = [];
    const stop = doc.subscribe((c) => changes.push(c));
    const root = part([{ op: 'create', node: 'comp', kind: 'composition', parent: null }]);
    const page = part([
      { op: 'create', node: 'p1', kind: 'page', parent: null },
      { op: 'create', node: 'a', kind: 'shape', parent: 'p1' },
    ]);
    doc.attach(page, { id: 'page:p1' });
    expect(doc.root()).toBe('p1'); // no root part yet: the first top-level node
    doc.attach(root, { id: 'root' });
    expect(doc.root()).toBe('comp');
    expect(doc.parts()).toEqual([page, root]);
    expect(doc.node('a')?.parent).toBe('p1');
    expect(doc.node('missing')).toBeUndefined();
    expect(doc.children(null)).toEqual(['p1', 'comp']);
    expect(doc.children('p1')).toEqual(['a']);
    expect(changes.map((c) => [...c.nodes].sort())).toEqual([['a', 'p1'], ['comp']]);
    unwrap(page.transact(meta, [{ op: 'set', node: 'a', path: 'spatial.x', value: 1 }, { op: 'create', node: 'b', kind: 'shape', parent: 'p1' }]));
    expect([...(changes.at(-1)?.nodes ?? [])].sort()).toEqual(['a', 'b']);
    stop();
    unwrap(page.transact(meta, [{ op: 'delete', node: 'b' }]));
    expect(changes).toHaveLength(3);
  });

  it('names the nodes of a detached part, even after the part was disposed (eviction)', () => {
    const { doc, part: p } = docOf('as_y', [
      { op: 'create', node: 'r', kind: 'composition', parent: null },
      { op: 'create', node: 'c', kind: 'shape', parent: 'r' },
    ]);
    const other = part([{ op: 'create', node: 'z', kind: 'page', parent: null }]);
    const detach = doc.attach(other);
    const seen: string[][] = [];
    doc.subscribe((c) => seen.push([...c.nodes]));
    other.dispose();
    expect(doc.children(null)).toEqual(['r']);
    detach();
    detach();
    expect(seen).toEqual([['z']]);
    expect(doc.node('c')?.kind).toBe('shape');
    p.dispose();
    expect(doc.node('c')).toBeUndefined();
    expect(doc.root()).toBeUndefined();
    expect(doc.children('r')).toEqual([]);
  });
});

describe('static assets', () => {
  it('resolves by reference key and notifies on change', () => {
    const { doc } = docOf('as_k', []);
    const assets = createStaticAssets({ as_k: doc });
    expect(assets.resolve({ asset: 'as_k', at: 'latest' })).toBe(doc);
    expect(assets.resolve({ asset: 'as_k', at: 'ms_1' })).toBeUndefined();
    const keys: string[] = [];
    const stop = assets.subscribe?.((k) => keys.push(k));
    assets.set('as_k@ms_1', doc);
    expect(assets.resolve({ asset: 'as_k', at: 'ms_1' })).toBe(doc);
    assets.set('as_k', undefined);
    expect(assets.resolve({ asset: 'as_k' })).toBeUndefined();
    stop?.();
    assets.set('as_q', doc);
    expect(keys).toEqual(['as_k@ms_1', 'as_k']);
    expect(createStaticAssets().resolve({ asset: 'as_none' })).toBeUndefined();
  });
});
