// @vitest-environment node
import { createScope } from '@staticflux/core';
import { createMemoryDocumentStore } from '@staticflux/document/v2';
import { createLoroEngine } from '@staticflux/document/loro-crdt';
import { describe, expect, it } from 'vitest';
import { authoringBuilt, unwrap } from '../app/test-helpers.js';
import { openSnapshotDocument, readOnlyOpenDocument } from './snapshot-document.js';
import { createExportFixture } from './testing/fixtures.js';

describe('read-only snapshot document', () => {
  it('refuses every write (IF-EXP-003) and reads only the parts it holds', async () => {
    const engine = createLoroEngine();
    const part = engine.create({ peer: '1' as never });
    const doc = readOnlyOpenDocument('as_x', 1, new Map([['root', part]]));
    expect(doc.partIds()).toEqual(['root']);
    expect(doc.partState('root')).toBe('loaded');
    expect(doc.partState('page:p1')).toBe('unloaded');
    expect(doc.loadedPart('root')).toBe(part);
    expect((await doc.part('root', new AbortController().signal)).ok).toBe(true);
    expect((await doc.part('nope', new AbortController().signal)).ok).toBe(false);
    const meta = { actor: { kind: 'system', id: 't' }, label: 'x' } as never;
    for (const r of [doc.commit(meta, {}), doc.createPart('p'), doc.gesture(meta, 'root'), doc.moveAcross(meta, { node: 'n', from: 'a', to: 'b', parent: null }), doc.evict('root'), await doc.transact(meta, {}, new AbortController().signal), await doc.compact(new AbortController().signal)]) {
      expect(!r.ok && r.error.code).toBe('IF-EXP-003');
    }
    expect(doc.undoHistory()).toEqual([]);
    expect(doc.head().asset).toBe('as_x');
    doc.onCommit(() => undefined)();
    expect((await doc.flush(new AbortController().signal)).ok).toBe(true);
    part.dispose();
  });

  it.skipIf(!authoringBuilt)('composes a frozen snapshot like Studio does (pages, elements, text)', { timeout: 30_000 }, async () => {
    const f = await createExportFixture();
    const snapshot = await f.freeze();
    const scope = createScope('snapshot-test');
    const doc = unwrap(await openSnapshotDocument({ store: f.studio.workspace.store, snapshot, engine: f.env.engine, geometry: f.env.geometry, signal: scope.signal, scope }));
    expect(doc.pages.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(doc.view.read('star')?.kind).toBe('shape');
    expect(doc.view.read('hello')?.kind).toBe('text');
    // writes through the document are refused
    expect(doc.commitOps('p1', { kind: 'system', id: 't' } as never, 'x', [{ op: 'delete', node: 'star' }]).ok).toBe(false);
    await scope.dispose();
    // a store without the snapshot's parts: IF-EXP-003
    const broken = await openSnapshotDocument({ store: createMemoryDocumentStore(), snapshot, engine: f.env.engine, geometry: f.env.geometry, signal: new AbortController().signal, scope: createScope('x') });
    expect(!broken.ok && broken.error.code).toBe('IF-EXP-003');
  });
});
