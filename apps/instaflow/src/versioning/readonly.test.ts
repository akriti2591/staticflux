import { canonicalJsonBytes, type CanonicalPart, createComponentRegistry, createMemoryDocumentStore, defineComponent } from '@staticflux/document/v2';
import { describe, expect, it } from 'vitest';
import { MilestoneDataError } from './errors.js';
import { indexCanonicalPart, openReadOnlyDocument, readCanonicalPart } from './readonly.js';
import { signal, unwrap } from './test-helpers.js';

const part: CanonicalPart = {
  schema: 'instaflow.part/1',
  part: 'page:p',
  treeSchema: 1,
  components: { spatial: 1 },
  nodes: [
    { id: 'b', kind: 'shape', parent: 'p', order: 'a1', props: { spatial: { x: 2 } } },
    { id: 'a', kind: 'shape', parent: 'p', order: 'a0', props: { spatial: { x: 1 } } },
    { id: 'p', kind: 'page', parent: null, order: 'a0', props: {} },
    { id: 'c', kind: 'shape', parent: 'gone', order: 'a1', props: {} },
  ],
};

describe('indexCanonicalPart', () => {
  it('reads nodes, ordered children (orphans at the top) and walks in pre-order', () => {
    const index = indexCanonicalPart('page:p', part);
    expect(index.size()).toBe(4);
    expect(index.node('a')?.props).toEqual({ spatial: { x: 1 } });
    expect(index.node('zz')).toBeUndefined();
    expect(index.children('p')).toEqual(['a', 'b']);
    expect(index.children(null)).toEqual(['p', 'c']);
    expect(index.children('a')).toEqual([]);
    const seen: string[] = [];
    index.forEachNode((n) => void seen.push(n.id));
    expect(seen).toEqual(['p', 'a', 'b', 'c']);
    const stopped: string[] = [];
    index.forEachNode((n) => (stopped.push(n.id), n.id !== 'a'));
    expect(stopped).toEqual(['p', 'a']);
  });
});

describe('openReadOnlyDocument / readCanonicalPart', () => {
  it('loads parts lazily, migrates on read, caches, and retries failures', async () => {
    const store = createMemoryDocumentStore();
    const ref = unwrap(await store.putBlob(unwrap(canonicalJsonBytes(part)), signal));
    const Spatial2 = defineComponent('spatial', { x: 'f64', left: 'f64' }, { version: 2, migrations: { 2: (v) => ({ left: v['x'] ?? null, x: null }) } });
    const registry = createComponentRegistry({ version: 2, components: [Spatial2] });
    const doc = openReadOnlyDocument({ store, asset: 'as_1', source: { kind: 'snapshot', id: `sn_${'0'.repeat(64)}` }, treeSchema: 1, parts: { 'page:p': ref, root: { digest: 'sha256:missing', size: 1 } }, registry });
    expect(doc.readOnly).toBe(true);
    expect(doc.partIds()).toEqual(['page:p', 'root']);
    const page = unwrap(await doc.part('page:p', signal));
    expect(page.node('a')?.props).toEqual({ spatial: { left: 1 } });
    expect(page.canonical.treeSchema).toBe(2);
    expect(await doc.part('page:p', signal)).toMatchObject({ ok: true });
    expect(await doc.part('root', signal)).toMatchObject({ ok: false, error: { code: MilestoneDataError.code } });
    expect(await doc.part('page:none', signal)).toMatchObject({ ok: false, error: { code: MilestoneDataError.code } });
  });

  it('reports malformed parts', async () => {
    const store = createMemoryDocumentStore();
    const ref = unwrap(await store.putBlob(new TextEncoder().encode('{"nope":1}'), signal));
    expect(await readCanonicalPart(store, 'root', ref, signal)).toMatchObject({ ok: false, error: { code: MilestoneDataError.code } });
  });
});
