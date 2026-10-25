import { describe, expect, it } from 'vitest';
import { adaptToV1 } from './crdt-v1-adapter.js';
import type { PeerId } from './crdt-v2.js';
import { defineComponent, defineTextComponent } from './ecs.js';
import { createDocumentEngine, type DocumentEngine, restoreDocumentEngine, withComponent, withText } from './engine.js';
import { createLoroEngine } from './loro-crdt.js';

// The v1 ECS engine (Studio's) running on the Loro engine through the adapter.
const Block = defineComponent('studio/block', { order: 'string', kind: 'string' });
const Image = defineComponent('studio/image', { src: 'string', width: 'f64', height: 'f64' });
const Body = defineTextComponent('studio/body');
const components = [Block, Image, Body] as const;
const loro = createLoroEngine();

const engineFor = (clientId: number): DocumentEngine =>
  createDocumentEngine({ clientId, components, crdt: adaptToV1(loro.create({ peer: `${clientId}` as PeerId }), { clientId }) });

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

function link(a: DocumentEngine, b: DocumentEngine): () => void {
  const offA = a.onLocalUpdate((u) => unwrap(b.applyRemote(u)));
  const offB = b.onLocalUpdate((u) => unwrap(a.applyRemote(u)));
  return () => {
    offA();
    offB();
  };
}

describe('adaptToV1 (v1 DocumentCRDT over a v2 part)', () => {
  it('runs the ECS engine: entities, components, text, remove, destroy', () => {
    const engine = engineFor(1);
    const id = unwrap(engine.createEntity([withComponent(Block, { order: 'a', kind: 'text' }), withText(Body, 'Hello')]));
    expect(id).toBe('1-1');
    expect(engine.get(id, Block)).toEqual({ order: 'a', kind: 'text' });
    expect(engine.text(id, Body)).toBe('Hello');
    unwrap(engine.insertText(id, Body, 5, ', world'));
    unwrap(engine.deleteText(id, Body, 0, 1));
    expect(engine.text(id, Body)).toBe('ello, world');
    unwrap(engine.set(id, Block, { order: 'b' }));
    expect(engine.get(id, Block)).toEqual({ order: 'b', kind: 'text' });
    unwrap(engine.remove(id, Body));
    expect(engine.text(id, Body)).toBeUndefined();
    unwrap(engine.set(id, Image, { src: 'x.png' }));
    expect(engine.get(id, Image)).toEqual({ src: 'x.png', width: 0, height: 0 });
    unwrap(engine.destroy(id));
    expect(engine.has(id)).toBe(false);
    expect(engine.view()).toEqual({ entities: {} });
    engine.dispose();
  });

  it('keeps transactions all-or-nothing with one update each', () => {
    const engine = engineFor(2);
    const updates: Uint8Array[] = [];
    engine.onLocalUpdate((u) => updates.push(u));
    const set = engine.transact((tx) => {
      const a = tx.createEntity([withComponent(Block, { order: 'a' })]);
      if (!a.ok) return a;
      tx.insertText(a.value, Body, 0, 'x');
      return tx.createEntity([withComponent(Image, { src: 'i' })]);
    });
    expect(set.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(engine.query([Block])).toHaveLength(1);
    const failed = engine.transact((tx) => {
      tx.createEntity([withComponent(Block, { order: 'z' })]);
      return tx.destroy('ghost');
    });
    expect(failed.ok).toBe(false);
    expect(updates).toHaveLength(1);
    engine.dispose();
  });

  it('converges two engines on concurrent text and property edits; delete wins', () => {
    const a = engineFor(10);
    const b = engineFor(20);
    const unlink = link(a, b);
    const id = unwrap(a.createEntity([withComponent(Block, { order: 'a', kind: 'text' }), withText(Body, 'abc')]));
    unlink();
    unwrap(a.insertText(id, Body, 0, '1'));
    unwrap(b.insertText(id, Body, 3, '2'));
    unwrap(a.set(id, Block, { order: 'x' }));
    unwrap(b.set(id, Block, { kind: 'image' }));
    unwrap(b.applyRemote(unwrap(a.encodeUpdate(b.encodeStateVector()))));
    unwrap(a.applyRemote(unwrap(b.encodeUpdate(a.encodeStateVector()))));
    expect(a.view()).toEqual(b.view());
    expect(a.text(id, Body)).toBe('1abc2');
    expect(a.get(id, Block)).toEqual({ order: 'x', kind: 'image' });
    const other = unwrap(a.createEntity([withComponent(Image, { src: 'q' })]));
    unwrap(b.applyRemote(unwrap(a.encodeUpdate(b.encodeStateVector()))));
    unwrap(a.destroy(other));
    unwrap(b.set(other, Image, { width: 5 }));
    unwrap(b.applyRemote(unwrap(a.encodeUpdate(b.encodeStateVector()))));
    unwrap(a.applyRemote(unwrap(b.encodeUpdate(a.encodeStateVector()))));
    expect(a.has(other)).toBe(false);
    expect(b.has(other)).toBe(false);
    a.dispose();
    b.dispose();
  });

  it('snapshots and restores (respawn), continuing deterministic ids', () => {
    const engine = engineFor(3);
    unwrap(engine.createEntity([withComponent(Block, { order: 'a' }), withText(Body, 'hi')]));
    const archive = unwrap(engine.snapshot());
    engine.dispose();
    const restored = unwrap(
      restoreDocumentEngine(archive, { clientId: 3, components, crdt: adaptToV1(loro.create({ peer: '3' }), { clientId: 3 }) }),
    );
    expect(restored.text('3-1', Body)).toBe('hi');
    expect(unwrap(restored.createEntity([]))).toBe('3-2');
    expect(restored.crdt.entityIds()).toContain('3-1');
    expect(restored.crdt.readEntity('nope')).toBeUndefined();
    restored.dispose();
  });

  it('reports remote changes to observers and frees the part on dispose', () => {
    const before = loro.liveHandles();
    const a = engineFor(30);
    const b = engineFor(40);
    const seen: string[][] = [];
    b.crdt.observe((c) => seen.push([c.origin, ...c.entities]));
    const id = unwrap(a.createEntity([withComponent(Block, { order: 'a' })]));
    unwrap(b.applyRemote(unwrap(a.encodeUpdate(b.encodeStateVector()))));
    expect(seen).toEqual([['remote', id]]);
    expect(b.crdt.applyLocal([{ type: 'component.set', entity: id, component: 'studio/block', values: { order: () => 1 } }]).ok).toBe(false);
    a.dispose();
    b.dispose();
    expect(loro.liveHandles()).toBe(before);
  });
});
