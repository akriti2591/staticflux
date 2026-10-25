import { describe, expect, it } from 'vitest';
import {
  buildPartFromCanonical,
  type CanonicalPart,
  canonicalPartDigest,
  encodeCanonicalPart,
  migrateCanonicalPart,
  parseCanonicalPart,
  rankKeys,
} from './canonical.js';
import { createComponentRegistry, defineComponent, field } from './components.js';
import type { DocumentCRDTv2, PartOp, TransactionMeta } from './crdt-v2.js';
import { createLoroEngine } from './loro-crdt.js';

const engine = createLoroEngine();
const meta: TransactionMeta = { actor: { kind: 'human', id: 'h' }, label: 'Edit' };
const Spatial = defineComponent('spatial', { x: 'f64', y: 'f64', rotation: 'f64' }, { defaults: { rotation: 0 } });
const Style = defineComponent('style', { fill: 'color', vars: field.map('f64'), effects: field.list('json') }, { version: 2, migrations: { 2: (v) => ({ ...v, fill: v['color'] ?? null, color: null }) } });
const Text = defineComponent('text', { content: 'richtext' });
const registry = createComponentRegistry({ version: 4, components: [Spatial, Style, Text], roles: ['headline'] });

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const ops: PartOp[] = [
  { op: 'create', node: 'page', kind: 'page', parent: null, props: { name: 'Cover' } },
  { op: 'create', node: 'b', kind: 'shape', parent: 'page', props: { 'spatial.x': 10, 'spatial.rotation': 0, 'style.vars.gap': 4, role: 'headline' }, lists: { 'style.effects': [{ blur: 2 }] } },
  { op: 'create', node: 'a', kind: 'text', parent: 'page', texts: { 'text.content': { text: 'Hello world', spans: [{ start: 0, end: 5, marks: { bold: true } }] } } },
  { op: 'create', node: 'c', kind: 'shape', parent: 'page', props: { 'custom.flag': true, loose: 1 }, texts: { 'note.body': { text: 'n', spans: [] } } },
];

function build(peer: `${number}`): DocumentCRDTv2 {
  const doc = engine.create({ peer });
  unwrap(doc.transact(meta, ops));
  return doc;
}

describe('rankKeys', () => {
  it('is sortable and fixed width', () => {
    expect(rankKeys(3)).toEqual(['a0', 'a1', 'a2']);
    const keys = rankKeys(40);
    expect(keys[39]).toBe('a13');
    expect([...keys].sort()).toEqual(keys);
    expect(rankKeys(0)).toEqual([]);
  });
});

describe('encodeCanonicalPart', () => {
  it('encodes local opinions by component, nodes sorted by id, defaults omitted, normalized order', () => {
    const doc = build('1');
    const encoded = unwrap(encodeCanonicalPart(doc, { part: 'page:page', registry, schema: 'instaflow.part/1' }));
    expect(encoded.part).toEqual({
      schema: 'instaflow.part/1',
      part: 'page:page',
      treeSchema: 4,
      components: { spatial: 1, style: 2, text: 1 },
      nodes: [
        { id: 'a', kind: 'text', parent: 'page', order: 'a1', props: { text: { content: { text: 'Hello world', spans: [{ start: 0, end: 5, marks: { bold: true } }] } } } },
        { id: 'b', kind: 'shape', role: 'headline', parent: 'page', order: 'a0', props: { spatial: { x: 10 }, style: { vars: { gap: 4 }, effects: [{ blur: 2 }] } } },
        { id: 'c', kind: 'shape', parent: 'page', order: 'a2', props: { $: { loose: 1 }, custom: { flag: true }, note: { body: { $text: { text: 'n', spans: [] } } } } },
        { id: 'page', kind: 'page', name: 'Cover', parent: null, order: 'a0', props: {} },
      ],
    });
    doc.dispose();
  });

  it('gives identical bytes and digests for the same content built by different peers and histories', async () => {
    const one = build('1');
    const two = engine.create({ peer: '2' });
    unwrap(two.transact(meta, [{ op: 'create', node: 'page', kind: 'page', parent: null, props: { name: 'Draft' } }]));
    unwrap(two.transact(meta, ops.slice(1).reverse().map((op) => (op.op === 'create' ? { ...op, position: { index: 0 } } : op)) as PartOp[]));
    unwrap(two.transact(meta, [{ op: 'set', node: 'page', path: 'name', value: 'Cover' }]));
    unwrap(two.transact(meta, [{ op: 'move', node: 'c', parent: 'page' }]));
    const order = two.children('page');
    expect(order).toEqual(['b', 'a', 'c']);
    const a = unwrap(encodeCanonicalPart(one, { part: 'p', registry }));
    const b = unwrap(encodeCanonicalPart(two, { part: 'p', registry }));
    expect(new TextDecoder().decode(b.bytes)).toBe(new TextDecoder().decode(a.bytes));
    expect(await canonicalPartDigest(a)).toBe(await canonicalPartDigest(b));
    expect(await canonicalPartDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    one.dispose();
    two.dispose();
  });

  it('works without a registry (lossless paths, storage markers)', () => {
    const doc = build('1');
    const encoded = unwrap(encodeCanonicalPart(doc, { part: 'p' }));
    expect(encoded.part.schema).toBe('sf.part/1');
    expect(encoded.part.treeSchema).toBe(1);
    expect(encoded.part.components).toBeUndefined();
    const b = encoded.part.nodes.find((n) => n.id === 'b');
    expect(b?.props).toEqual({ spatial: { x: 10, rotation: 0 }, style: { 'vars.gap': 4, effects: { $list: [{ blur: 2 }] } } });
    const rebuilt = unwrap(buildPartFromCanonical(engine, encoded.part, { peer: '5' }));
    expect(rebuilt.list('b', 'style.effects')).toEqual([{ blur: 2 }]);
    expect(rebuilt.prop('b', 'style.vars.gap')).toBe(4);
    expect(rebuilt.text('a', 'text.content')?.spans).toEqual([{ start: 0, end: 5, marks: { bold: true } }]);
    rebuilt.dispose();
    doc.dispose();
  });
});

describe('buildPartFromCanonical ("new document from milestone")', () => {
  it('rebuilds a fresh part (new peer, one commit) that re-encodes to the same bytes', () => {
    const doc = build('1');
    const encoded = unwrap(encodeCanonicalPart(doc, { part: 'p', registry }));
    const copy = unwrap(buildPartFromCanonical(engine, unwrap(parseCanonicalPart(encoded.bytes)), { peer: '77', registry }));
    expect(copy.peer).toBe('77');
    expect(copy.children('page')).toEqual(['b', 'a', 'c']);
    expect(copy.prop('b', 'spatial.rotation')).toBeUndefined(); // default omitted, not stored
    expect(copy.text('c', 'note.body')?.text).toBe('n');
    expect(copy.prop('c', 'loose')).toBe(1);
    const again = unwrap(encodeCanonicalPart(copy, { part: 'p', registry }));
    expect(again.bytes).toEqual(encoded.bytes);
    copy.dispose();
    doc.dispose();
  });

  it('migrates old component versions on read (parse → migrate → build)', () => {
    const old: CanonicalPart = {
      schema: 'sf.part/1',
      part: 'p',
      treeSchema: 1,
      components: { style: 1 },
      nodes: [{ id: 'n', kind: 'shape', parent: null, order: 'a0', props: { style: { color: '#fff' }, other: { k: 1 } } }],
    };
    const migrated = unwrap(migrateCanonicalPart(old, registry));
    expect(migrated.nodes[0]?.props).toEqual({ style: { fill: '#fff' }, other: { k: 1 } });
    expect(migrated.treeSchema).toBe(4);
    const doc = unwrap(buildPartFromCanonical(engine, old, { peer: '3', registry }));
    expect(doc.prop('n', 'style.fill')).toBe('#fff');
    doc.dispose();
    const future = migrateCanonicalPart({ ...old, components: { style: 9 } }, registry);
    expect(future.ok ? '' : future.error.code).toBe('SF-DOC-016');
    expect(buildPartFromCanonical(engine, { ...old, components: { style: 9 } }, { peer: '3', registry }).ok).toBe(false);
  });

  it('fails cleanly on an invalid part and leaks no handles', () => {
    const before = engine.liveHandles();
    const bad: CanonicalPart = { schema: 's', part: 'p', treeSchema: 1, nodes: [{ id: 'n', kind: '', parent: null, order: 'a0', props: {} }] };
    expect(buildPartFromCanonical(engine, bad, { peer: '3' }).ok).toBe(false);
    expect(engine.liveHandles()).toBe(before);
  });
});

describe('parseCanonicalPart', () => {
  it('checks the shape', () => {
    expect(parseCanonicalPart('{').ok).toBe(false);
    expect(parseCanonicalPart('{"schema":"s"}').ok).toBe(false);
    expect(parseCanonicalPart('{"schema":"s","part":"p","treeSchema":1,"nodes":[{"id":1}]}').ok).toBe(false);
    expect(parseCanonicalPart('{"schema":"s","part":"p","treeSchema":1,"nodes":[]}').ok).toBe(true);
  });
});
