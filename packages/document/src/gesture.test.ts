import { describe, expect, it } from 'vitest';
import type { PartOp, TransactionMeta } from './crdt-v2.js';
import { coalesceOps, createGesture } from './gesture.js';
import { createLoroEngine } from './loro-crdt.js';

const meta: TransactionMeta = { actor: { kind: 'human', id: 'h' }, label: 'Drag' };
const engine = createLoroEngine();

function seeded() {
  const doc = engine.create({ peer: '1' });
  const ops: PartOp[] = [{ op: 'create', node: 'root', kind: 'page', parent: null }, { op: 'create', node: 'g', kind: 'group', parent: 'root' }];
  for (let i = 0; i < 100; i += 1) ops.push({ op: 'create', node: `n${i}`, kind: 'shape', parent: 'root', props: { 'spatial.x': 0 } });
  const r = doc.transact(meta, ops);
  if (!r.ok) throw new Error(r.error.message);
  return doc;
}

describe('coalesceOps', () => {
  it('keeps the last set per path and the last move per node, at the last position', () => {
    const ops: PartOp[] = [
      { op: 'set', node: 'a', path: 'x', value: 1 },
      { op: 'move', node: 'a', parent: 'p1' },
      { op: 'set', node: 'a', path: 'y', value: 1 },
      { op: 'create', node: 'p2', kind: 'group', parent: null },
      { op: 'set', node: 'a', path: 'x', value: 2 },
      { op: 'move', node: 'a', parent: 'p2' },
      { op: 'text.insert', node: 't', path: 'c', at: 0, text: 'a' },
      { op: 'text.insert', node: 't', path: 'c', at: 1, text: 'b' },
    ];
    expect(coalesceOps(ops)).toEqual([ops[2], ops[3], ops[4], ops[5], ops[6], ops[7]]);
  });
});

describe('createGesture', () => {
  it('stages frames and commits the end state once', () => {
    const doc = seeded();
    const before = doc.frontier();
    const g = createGesture(doc, meta);
    for (let frame = 1; frame <= 30; frame += 1) {
      expect(g.stage(Array.from({ length: 100 }, (_, i): PartOp => ({ op: 'set', node: `n${i}`, path: 'spatial.x', value: frame }))).ok).toBe(true);
    }
    expect(g.pending()).toHaveLength(100);
    expect(doc.prop('n5', 'spatial.x')).toBe(0); // previews come from pending(), not the CRDT
    const committed = g.commit();
    expect(committed.ok).toBe(true);
    expect(g.state).toBe('committed');
    expect(doc.prop('n5', 'spatial.x')).toBe(30);
    const summary = doc.changedSince(before);
    expect(summary.ok && summary.value.commits).toHaveLength(1);
    expect(g.stage([]).ok).toBe(false);
    const again = g.commit();
    expect(again.ok ? '' : again.error.code).toBe('SF-DOC-014');
    doc.dispose();
  });

  it('one coalesced commit is much smaller than a commit per frame (S4: 12.8 KB vs 146 KB)', () => {
    const coalesced = seeded();
    const perFrame = seeded();
    const g = createGesture(coalesced, meta);
    let perFrameBytes = 0;
    for (let frame = 1; frame <= 20; frame += 1) {
      const ops = Array.from({ length: 100 }, (_, i): PartOp => ({ op: 'set', node: `n${i}`, path: 'spatial.x', value: frame }));
      g.stage(ops);
      const r = perFrame.transact(meta, ops);
      if (r.ok) perFrameBytes += r.value.update.byteLength;
    }
    const r = g.commit();
    const once = r.ok && r.value !== undefined ? r.value.update.byteLength : Number.POSITIVE_INFINITY;
    expect(once * 5).toBeLessThan(perFrameBytes);
    coalesced.dispose();
    perFrame.dispose();
  });

  it('commits nothing for an empty gesture; abort drops staged ops; a failed commit stays open', () => {
    const doc = seeded();
    const before = doc.frontier();
    const empty = createGesture(doc, meta);
    const r = empty.commit();
    expect(r.ok && r.value).toBeUndefined();
    expect(doc.frontier()).toBe(before);

    const aborted = createGesture(doc, meta);
    aborted.stage([{ op: 'set', node: 'n1', path: 'spatial.x', value: 9 }]);
    aborted.abort();
    expect(aborted.state).toBe('aborted');
    expect(aborted.pending()).toEqual([]);
    expect(doc.prop('n1', 'spatial.x')).toBe(0);
    aborted.abort();

    const failing = createGesture(doc, meta);
    failing.stage([{ op: 'set', node: 'missing', path: 'spatial.x', value: 1 }]);
    expect(failing.commit().ok).toBe(false);
    expect(failing.state).toBe('open');
    failing.abort();
    doc.dispose();
  });
});
