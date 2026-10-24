import { createInjector, createMemorySink, createTelemetry, ok, token } from '@staticflux/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type ChangeSet,
  collaborationTransportUnit,
  CollaborationTransportToken,
  connectCollaboration,
  createDocumentEngine,
  createMockCollaborationNetwork,
  createPresenceStore,
  createViewProjection,
  createYjsDocumentCRDT,
  bindProjection,
  defineComponent,
  defineSystem,
  defineTextComponent,
  type DocumentEngine,
  documentEngineUnit,
  documentReplica,
  isDocumentArchive,
  mergeDocumentUpdates,
  restoreDocumentEngine,
  withComponent,
  withText,
} from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await tick();
};

// Studio's blocks: text block and image block.
const Block = defineComponent('studio/block', { order: 'string', kind: 'string' });
const Image = defineComponent('studio/image', { src: 'string', width: 'f64', height: 'f64' });
const Body = defineTextComponent('studio/body');
const components = [Block, Image, Body] as const;

const engineFor = (clientId: number): DocumentEngine => createDocumentEngine({ clientId, components });

describe('document engine', () => {
  it('creates entities with components and text; reads back through the world', () => {
    const engine = engineFor(1);
    const created = engine.createEntity([withComponent(Block, { order: 'a', kind: 'text' }), withText(Body, 'Hello')]);
    expect(created.ok).toBe(true);
    const id = created.ok ? created.value : '';
    expect(id).toBe('1-1');
    expect(engine.has(id)).toBe(true);
    expect(engine.get(id, Block)).toEqual({ order: 'a', kind: 'text' });
    expect(engine.text(id, Body)).toBe('Hello');
    expect(engine.insertText(id, Body, 5, ', world').ok).toBe(true);
    expect(engine.deleteText(id, Body, 0, 1).ok).toBe(true);
    expect(engine.text(id, Body)).toBe('ello, world');
    expect(engine.set(id, Block, { order: 'b' }).ok).toBe(true);
    expect(engine.get(id, Block)).toEqual({ order: 'b', kind: 'text' });
    expect(engine.query([Block, Body])).toEqual([id]);
    expect(engine.remove(id, Body).ok).toBe(true);
    expect(engine.text(id, Body)).toBeUndefined();
    expect(engine.destroy(id).ok).toBe(true);
    expect(engine.has(id)).toBe(false);
    expect(engine.view()).toEqual({ entities: {} });
  });

  it('validates writes (SF-DOC-001..004)', () => {
    const engine = engineFor(1);
    const Unregistered = defineComponent('test/other', { a: 'f64' });
    const id = engine.createEntity([withText(Body, 'abc')]);
    const e = id.ok ? id.value : '';
    const codes = [
      engine.createEntity([withComponent(Unregistered, { a: 1 })]),
      engine.set('nope', Block, { order: 'x' }),
      engine.set(e, Block, { order: 1 as unknown as string }),
      engine.insertText(e, Body, 10, 'x'),
      engine.deleteText(e, Body, 2, 5),
      engine.createEntity([{ component: Block, value: 'text-for-struct' }]),
      engine.createEntity([{ component: Body, value: { not: 'text' } }]),
      engine.insertText(e, Block as never, 0, 'x'),
      engine.destroy('nope'),
      engine.remove('nope', Block),
    ].map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes).toEqual(['SF-DOC-001', 'SF-DOC-002', 'SF-DOC-003', 'SF-DOC-004', 'SF-DOC-004', 'SF-DOC-004', 'SF-DOC-004', 'SF-DOC-004', 'SF-DOC-002', 'SF-DOC-002']);
    expect(engine.text(e, Body)).toBe('abc');
  });

  it('transactions are all-or-nothing and produce one update + one change set', () => {
    const engine = engineFor(1);
    const updates: Uint8Array[] = [];
    const sets: ChangeSet[] = [];
    engine.onLocalUpdate((u) => updates.push(u));
    engine.observe((s) => sets.push(s));
    const result = engine.transact((tx) => {
      const a = tx.createEntity([withComponent(Block, { order: 'a', kind: 'text' }), withText(Body)]);
      if (!a.ok) return a;
      tx.insertText(a.value, Body, 0, 'one');
      tx.insertText(a.value, Body, 3, ' two');
      return tx.createEntity([withComponent(Image, { src: 'cat.png', width: 100 })]);
    });
    expect(result.ok && result.value.changes.map((c) => c.type)).toEqual([
      'entity.created',
      'component.set',
      'text.changed',
      'entity.created',
      'component.set',
    ]);
    expect(updates).toHaveLength(1);
    expect(sets).toHaveLength(1);
    const failed = engine.transact((tx) => {
      tx.createEntity([withComponent(Block, { order: 'z' })]);
      tx.set('missing', Block, { order: 'y' });
    });
    expect(!failed.ok && failed.error.code).toBe('SF-DOC-002');
    expect(engine.query([Block])).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(engine.transact(() => undefined)).toEqual(ok({ origin: 'local', changes: [] }));
  });

  it('runs systems on relevant change sets', () => {
    const counts: number[] = [];
    const wordCount = defineSystem<ChangeSet>({
      id: 'studio/word-count',
      query: [Body],
      run: ({ world, entities }) => {
        counts.push(entities.reduce((n, e) => n + (world.text(e, Body) ?? '').split(/\s+/).filter(Boolean).length, 0));
      },
    });
    const imageSystem = vi.fn();
    const engine = createDocumentEngine({ clientId: 1, components, systems: [wordCount] });
    const removeImages = engine.addSystem(defineSystem<ChangeSet>({ id: 'studio/images', query: [Image], watches: [Image], run: imageSystem }));
    const id = engine.createEntity([withText(Body, 'a b c')]);
    if (id.ok) engine.insertText(id.value, Body, 5, ' d');
    expect(counts).toEqual([3, 4]);
    expect(imageSystem).toHaveBeenCalledTimes(1); // entity creation is always relevant
    removeImages();
  });

  it('is a ReplicableSource: snapshot view, patches, intents', () => {
    const engine = engineFor(1);
    const patches: unknown[] = [];
    engine.onPatches((p) => patches.push(...p));
    const created = engine.applyIntent('createEntity', { components: { 'studio/block': { order: 'a' }, 'studio/body': 'hi' } });
    expect(created).toEqual(ok('1-1'));
    expect(engine.applyIntent('insertText', { entity: '1-1', component: 'studio/body', index: 2, text: '!' })).toEqual(ok(null));
    expect(engine.applyIntent('set', { entity: '1-1', component: 'studio/block', values: { kind: 'text' } })).toEqual(ok(null));
    expect(engine.applyIntent('deleteText', { entity: '1-1', component: 'studio/body', index: 0, length: 1 })).toEqual(ok(null));
    expect(engine.getSnapshot()).toEqual({
      entities: { '1-1': { 'studio/block': { kind: 'struct', values: { order: 'a', kind: 'text' } }, 'studio/body': { kind: 'text', text: 'i!' } } },
    });
    expect(patches[0]).toMatchObject({ op: 'add', path: ['entities', '1-1'] });
    expect(engine.applyIntent('remove', { entity: '1-1', component: 'studio/body' })).toEqual(ok(null));
    expect(engine.applyIntent('destroy', { entity: '1-1' })).toEqual(ok(null));
    expect(patches.at(-1)).toEqual({ op: 'remove', path: ['entities', '1-1'] });
    const unknown = engine.applyIntent('explode', {});
    expect(!unknown.ok && unknown.error.code).toBe('SF-WK-014');
    const badComponent = engine.applyIntent('set', { entity: '1-1', component: 'x/y', values: {} });
    expect(!badComponent.ok && badComponent.error.code).toBe('SF-DOC-001');
    const textAsStruct = engine.applyIntent('set', { entity: '1-1', component: 'studio/body', values: {} });
    expect(!textAsStruct.ok && textAsStruct.error.code).toBe('SF-DOC-004');
  });

  it('snapshot/restore round-trips and continues deterministic ids', () => {
    const engine = engineFor(7);
    engine.createEntity([withComponent(Block, { order: 'a' }), withText(Body, 'persisted')]);
    engine.createEntity([withComponent(Image, { src: 'x.png' })]);
    const archive = engine.snapshot();
    expect(archive.ok && isDocumentArchive(archive.value)).toBe(true);
    if (!archive.ok) return;
    const restored = restoreDocumentEngine(archive.value, { clientId: 7, components });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.view()).toEqual(engine.view());
    const next = restored.value.createEntity([]);
    expect(next.ok && next.value).toBe('7-3');
    expect(restoreDocumentEngine({ format: 'other' }, { clientId: 1, components }).ok).toBe(false);
    const bad = restoreDocumentEngine({ ...archive.value, update: new Uint8Array([1, 2, 3]) }, { clientId: 1, components });
    expect(!bad.ok && bad.error.code).toBe('SF-DOC-006');
    expect(engine.restore({} as never).ok).toBe(false);
  });

  it('rejects malformed updates (SF-DOC-006)', () => {
    const engine = engineFor(1);
    for (const bytes of [new Uint8Array([0x53, 0x46, 0x01, 0, 0, 0, 99]), new Uint8Array([0x53, 0x46, 0x01, 0, 0, 0, 1, 0x7b])]) {
      const result = engine.applyRemote(bytes);
      expect(!result.ok && result.error.code).toBe('SF-DOC-006');
    }
    const crdt = createYjsDocumentCRDT({ clientId: 1 });
    expect(crdt.encodeUpdate(new Uint8Array([9])).ok).toBe(false);
    expect(mergeDocumentUpdates([new Uint8Array([1])]).ok).toBe(false);
  });

  it('emits telemetry for transactions', () => {
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'verbose' });
    telemetry.addSink(sink);
    const engine = createDocumentEngine({ clientId: 1, components, telemetry });
    engine.createEntity([withText(Body, 'x')]);
    expect(sink.records.some((r) => r.type === 'span' && r.name === 'document.transact')).toBe(true);
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'document/ops')).toBe(true);
  });
});

describe('convergence (co-editing)', () => {
  const pairOfEngines = async () => {
    const network = createMockCollaborationNetwork();
    const a = engineFor(1);
    const b = engineFor(2);
    const sa = await network.transport.join('studio/doc-42', 'alice');
    const sb = await network.transport.join('studio/doc-42', 'bob');
    if (!sa.ok || !sb.ok) throw new Error('join failed');
    connectCollaboration({ engine: a, session: sa.value });
    connectCollaboration({ engine: b, session: sb.value });
    await settle();
    return { network, a, b, sa: sa.value, sb: sb.value };
  };

  it('two engines converge after concurrent edits to the same text and properties', async () => {
    const { network, a, b } = await pairOfEngines();
    const id = a.createEntity([withComponent(Block, { order: 'a', kind: 'text' }), withText(Body, 'Hello')]);
    await settle();
    const e = id.ok ? id.value : '';
    expect(b.text(e, Body)).toBe('Hello');

    network.partition('alice', 'bob');
    a.insertText(e, Body, 5, ' Alice');
    b.insertText(e, Body, 0, 'Bob: ');
    a.set(e, Block, { order: 'from-a' });
    b.set(e, Block, { order: 'from-b' });
    b.createEntity([withComponent(Image, { src: 'b.png', width: 10, height: 10 })]);
    await settle();
    expect(a.view()).not.toEqual(b.view());
    network.heal('alice', 'bob');
    await settle();
    expect(a.view()).toEqual(b.view());
    expect(a.text(e, Body)).toContain('Alice');
    expect(a.text(e, Body)).toContain('Bob: ');
    // LWW per property: same clock → higher client id wins on both peers.
    expect(a.get(e, Block)?.order).toBe('from-b');
    expect(a.query([Image])).toHaveLength(1);
  });

  it('delete vs concurrent edit: deletion wins deterministically on every peer', async () => {
    const { network, a, b } = await pairOfEngines();
    const id = a.createEntity([withText(Body, 'doomed')]);
    await settle();
    const e = id.ok ? id.value : '';
    network.partition('alice', 'bob');
    a.destroy(e);
    b.insertText(e, Body, 0, 'still ');
    network.heal('alice', 'bob');
    await settle();
    expect(a.view()).toEqual(b.view());
  });

  it('a late joiner syncs the full state; presence travels separately', async () => {
    const network = createMockCollaborationNetwork();
    const a = engineFor(1);
    const presenceA = createPresenceStore({ localId: 'alice', now: () => 1000 });
    presenceA.setLocal({ name: 'Alice', cursor: { entity: '1-1', index: 0 } });
    const sa = await network.transport.join('studio/doc-1', 'alice');
    if (!sa.ok) throw new Error('join');
    connectCollaboration({ engine: a, session: sa.value, presence: presenceA });
    a.createEntity([withText(Body, 'early content')]);
    await settle();

    const c = engineFor(3);
    const presenceC = createPresenceStore({ localId: 'carol', now: () => 1000 });
    const sc = await network.transport.join('studio/doc-1', 'carol');
    if (!sc.ok) throw new Error('join');
    const binding = connectCollaboration({ engine: c, session: sc.value, presence: presenceC });
    await settle();
    expect(c.view()).toEqual(a.view());
    expect(presenceC.participants().map((p) => p.id)).toEqual(['alice']);
    presenceC.setLocal({ name: 'Carol', selection: { entity: '1-1', anchor: 0, head: 5 } });
    await settle();
    expect(presenceA.participants().find((p) => p.id === 'carol')?.state.name).toBe('Carol');
    expect(sa.value.peers()).toEqual(['carol']);
    sc.value.leave();
    await settle();
    expect(presenceA.participants().map((p) => p.id)).toEqual(['alice']);
    expect(sc.value.closed).toBe(true);
    if (binding.ok) binding.value.disconnect();
    expect(connectCollaboration({ engine: c, session: sc.value }).ok).toBe(false);
  });

  it('three peers converge regardless of delivery order', async () => {
    const network = createMockCollaborationNetwork();
    const engines = [engineFor(1), engineFor(2), engineFor(3)];
    const names = ['p1', 'p2', 'p3'];
    for (const [i, engine] of engines.entries()) {
      const s = await network.transport.join('studio/doc-3', names[i] as string);
      if (s.ok) connectCollaboration({ engine, session: s.value });
    }
    await settle();
    const root = engines[0]?.createEntity([withText(Body, '')]);
    await settle();
    const e = root?.ok ? root.value : '';
    network.partition('p1', 'p3');
    engines.forEach((engine, i) => engine.insertText(e, Body, 0, `[${i}]`));
    await settle();
    network.heal('p1', 'p3');
    await settle();
    const [v1, v2, v3] = engines.map((engine) => engine.view());
    expect(v1).toEqual(v2);
    expect(v2).toEqual(v3);
    expect(engines[0]?.text(e, Body)?.length).toBe(9);
  });

  it('merged updates apply like the individual ones', () => {
    const a = engineFor(1);
    const updates: Uint8Array[] = [];
    a.onLocalUpdate((u) => updates.push(u));
    const id = a.createEntity([withText(Body, 'x')]);
    if (id.ok) a.insertText(id.value, Body, 1, 'y');
    const merged = mergeDocumentUpdates(updates);
    const b = engineFor(2);
    expect(merged.ok && b.applyRemote(merged.value).ok).toBe(true);
    expect(b.view()).toEqual(a.view());
  });
});

describe('projections', () => {
  it('a view projection follows an in-thread engine', () => {
    const engine = engineFor(1);
    engine.createEntity([withComponent(Block, { order: 'a' })]);
    const projection = createViewProjection();
    const off = bindProjection(engine, projection);
    expect(projection.entities()).toEqual(['1-1']);
    const id = engine.createEntity([withText(Body, 'hi')]);
    const e = id.ok ? id.value : '';
    expect(projection.text(e, 'studio/body')).toBe('hi');
    engine.set('1-1', Block, { kind: 'image' });
    expect(projection.values('1-1', 'studio/block')).toEqual({ order: 'a', kind: 'image' });
    engine.remove(e, Body);
    expect(projection.entity(e)).toEqual({});
    engine.destroy(e);
    expect(projection.entity(e)).toBeUndefined();
    expect(projection.revision).toBeGreaterThan(1);
    off();
  });
});

describe('DI units', () => {
  it('documentEngineUnit and collaborationTransportUnit', async () => {
    const DocToken = token('studio/doc-engine').type<DocumentEngine>();
    const network = createMockCollaborationNetwork();
    const injector = createInjector({
      units: [
        documentEngineUnit({ id: 'studio/doc-engine-unit', provides: DocToken, scope: 'app', engine: () => ({ clientId: 9, components }) }),
        collaborationTransportUnit({ id: 'studio/collab-unit', scope: 'app', transport: () => network.transport }),
      ],
    });
    const engine = await injector.get(DocToken);
    expect(engine.ok && engine.value.clientId).toBe(9);
    expect((await injector.get(CollaborationTransportToken)).ok).toBe(true);
    expect(documentReplica('studio/doc-42').channel).toBe('sf/replica/studio/doc-42');
    await injector.scope.dispose();
  });
});
