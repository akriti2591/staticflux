/**
 * BENCH (not a unit test): S4's measurements ported to the production adapter.
 * Run on demand — timings are machine- and load-dependent, never asserted in CI:
 *
 *   pnpm vitest bench --run packages/document/src/loro-crdt.bench.ts
 *
 * (Vitest 5 benchmarks: each `test` registers benchmarks on its `bench` fixture and runs them.)
 *
 * S4 reference numbers (4-core cloud container, Node | browser, median):
 * - open a 50k-node Latest ≤ 1 s: lazy import 61 | 30 ms; 50 page parts + visible page 108 | 115 ms;
 * - 1k-move drag commit ≤ 20 KB: 12.8 KB reparent, 9.8 KB reorder (one commit per gesture);
 * - 10k-op divergent merge: ≤ 200 ms per page off the main thread (D14): worst page 124 | 24 ms.
 * Sizes are deterministic and printed once per run with the S4 budget next to them.
 */
import { describe, test } from 'vitest';
import type { DocumentCRDTv2, PartOp, PeerId, TransactionMeta } from './crdt-v2.js';
import { createGesture } from './gesture.js';
import { createLoroEngine } from './loro-crdt.js';

const engine = createLoroEngine();
const meta: TransactionMeta = { actor: { kind: 'human', id: 'bench' }, label: 'Bench' };
const KINDS = ['shape', 'image', 'vector', 'video'] as const;
const ROLES = ['headline', 'subhead', 'body', 'cta', 'logo', 'hero', 'price', 'caption', 'background'] as const;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** S4's synthetic part: one page with `groups` groups of `perGroup` elements (~11 props, ~15% rich text with a bold mark). */
function pageOps(page: number, groups: number, perGroup: number, seed: number): PartOp[] {
  const r = rng(seed);
  const pageId = `p${page}`;
  const ops: PartOp[] = [{ op: 'create', node: pageId, kind: 'page', parent: null, props: { name: `Page ${page + 1}`, 'page.canvasX': page * 1200, 'temporal.duration': 705_600_000 * 5 } }];
  for (let g = 0; g < groups; g += 1) {
    const group = `${pageId}g${g}`;
    ops.push({ op: 'create', node: group, kind: 'group', parent: pageId, props: { name: `Group ${g}`, 'spatial.x': Math.round(r() * 1000), 'spatial.y': Math.round(r() * 1000) } });
    for (let e = 0; e < perGroup; e += 1) {
      const text = r() < 0.15;
      const props: Record<string, string | number> = {
        name: `el ${e}`,
        'spatial.x': Math.round(r() * 108000) / 100,
        'spatial.y': Math.round(r() * 135000) / 100,
        'spatial.w': Math.round(50 + r() * 500),
        'spatial.h': Math.round(50 + r() * 500),
        'spatial.rotation': r() < 0.2 ? Math.round(r() * 360) : 0,
        'spatial.opacity': r() < 0.2 ? Math.round(r() * 100) / 100 : 1,
        'style.fill': `#${Math.floor(r() * 0xffffff).toString(16).padStart(6, '0')}`,
      };
      if (r() < 0.3) props['role'] = ROLES[Math.floor(r() * ROLES.length)] as string;
      if (r() < 0.3) {
        props['temporal.start'] = Math.floor(r() * 10) * 70_560_000;
        props['temporal.duration'] = 705_600_000;
      }
      ops.push({
        op: 'create',
        node: `${group}e${e}`,
        kind: text ? 'text' : (KINDS[Math.floor(r() * KINDS.length)] as string),
        parent: group,
        props,
        ...(text ? { texts: { 'text.content': { text: 'the quick brown fox jumps over', spans: [{ start: 0, end: 9, marks: { bold: true } }] } } } : {}),
      });
    }
  }
  return ops;
}

function buildPart(ops: readonly PartOp[], peer: PeerId = '1'): DocumentCRDTv2 {
  const doc = engine.create({ peer });
  const r = doc.transact(meta, ops);
  if (!r.ok) throw new Error(r.error.message);
  return doc;
}

/** Mixed op stream on one page (S4 mix: 60% set, 15% move, 10% text insert, 5% mark, 5% create, 5% delete). */
function mixedOps(doc: DocumentCRDTv2, count: number, seed: number, prefix: string): PartOp[][] {
  const r = rng(seed);
  const page = doc.children(null)[0] as string;
  const groups = doc.children(page);
  const elements = groups.flatMap((g) => doc.children(g));
  const texts = elements.filter((id) => doc.node(id)?.kind === 'text');
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)] as T;
  const batches: PartOp[][] = [];
  let created = 0;
  for (let i = 0; i < count; i += 10) {
    const batch: PartOp[] = [];
    for (let j = 0; j < 10; j += 1) {
      const roll = r();
      if (roll < 0.6) batch.push({ op: 'set', node: pick(elements), path: pick(['spatial.x', 'spatial.y', 'spatial.w', 'style.fill']), value: Math.round(r() * 1000) });
      else if (roll < 0.75) batch.push({ op: 'move', node: pick(elements), parent: pick(groups) });
      else if (roll < 0.85 && texts.length > 0) batch.push({ op: 'text.insert', node: pick(texts), path: 'text.content', at: 0, text: 'x' });
      else if (roll < 0.9 && texts.length > 0) batch.push({ op: 'text.mark', node: pick(texts), path: 'text.content', from: 0, to: 3, key: 'italic', value: true });
      else if (roll < 0.95) batch.push({ op: 'create', node: `${prefix}${(created += 1)}`, kind: 'shape', parent: pick(groups), props: { 'spatial.x': 1 } });
      else batch.push({ op: 'set', node: pick(elements), path: 'spatial.opacity', value: 0.5 });
    }
    batches.push(batch);
  }
  return batches;
}

function applyBatches(doc: DocumentCRDTv2, batches: readonly PartOp[][]): void {
  for (const batch of batches) {
    const valid = batch.filter((op) => doc.check([op]).ok);
    if (valid.length > 0) doc.transact(meta, valid);
  }
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

// ---------------------------------------------------------------- fixtures (built once)

const PAGES = 50;
const pageSnapshots: Uint8Array[] = [];
let whole: Uint8Array;
{
  const all: PartOp[] = [{ op: 'create', node: 'comp', kind: 'composition', parent: null }];
  for (let p = 0; p < PAGES; p += 1) {
    const ops = pageOps(p, 20, 49, 42 + p);
    const part = buildPart(ops, `${p + 10}` as PeerId);
    pageSnapshots.push(part.exportSnapshot());
    part.dispose();
    all.push(...ops.map((op, i) => (i === 0 && op.op === 'create' ? { ...op, parent: 'comp' } : op)));
  }
  const big = buildPart(all);
  whole = big.exportSnapshot();
  console.log(`[bench] 50k fixture: ${big.size()} nodes, full snapshot ${kb(whole.byteLength)}; page part ≈ ${kb(pageSnapshots[0]?.byteLength ?? 0)}`);
  big.dispose();
}

// ---------------------------------------------------------------- 1. open

describe('open (S4: ≤ 1 s for 50k nodes; never materialize the whole doc)', () => {
  test('open', async ({ bench }) => {
    await bench.compare(
      bench('single 50k-node part: lazy load + read one node + first edit', () => {
        const doc = engine.load(whole, { peer: '2' });
        if (!doc.ok) throw new Error(doc.error.message);
        doc.value.node('p7g3e5');
        doc.value.transact(meta, [{ op: 'set', node: 'p7g3e5', path: 'spatial.x', value: 3 }]);
        doc.value.dispose();
      }),
      bench('50 page parts (D14): load all + read the visible page (1k nodes)', () => {
        const parts = pageSnapshots.map((bytes, i) => engine.load(bytes, { peer: `${i + 100}` as PeerId }));
        const visible = parts[7];
        if (visible?.ok === true) visible.value.forEachNode(() => undefined);
        for (const p of parts) if (p.ok) p.value.dispose();
      }),
      { iterations: 5, time: 0 },
    );
  });
});

// ---------------------------------------------------------------- 2. drag commit size

describe('1k-move drag commit (S4: ≤ 20 KB, one commit per gesture)', () => {
  const page = engine.load(pageSnapshots[0] as Uint8Array, { peer: '3' });
  if (!page.ok) throw new Error(page.error.message);
  const doc = page.value;
  const groups = doc.children('p0');
  const elements = groups.flatMap((g) => doc.children(g)).slice(0, 1000);
  const frames = 30;
  const reparent = (): number => {
    const fork = doc.fork('4');
    if (!fork.ok) throw new Error(fork.error.message);
    const g = createGesture(fork.value, meta);
    for (let f = 0; f < frames; f += 1) g.stage(elements.map((node, i): PartOp => ({ op: 'move', node, parent: groups[(i + f + 1) % groups.length] as string })));
    const r = g.commit();
    const bytes = r.ok && r.value !== undefined ? r.value.update.byteLength : -1;
    fork.value.dispose();
    return bytes;
  };
  const translate = (): number => {
    const fork = doc.fork('5');
    if (!fork.ok) throw new Error(fork.error.message);
    const g = createGesture(fork.value, meta);
    for (let f = 0; f < frames; f += 1) g.stage(elements.map((node): PartOp => ({ op: 'set', node, path: 'spatial.x', value: f })));
    const r = g.commit();
    const bytes = r.ok && r.value !== undefined ? r.value.update.byteLength : -1;
    fork.value.dispose();
    return bytes;
  };
  console.log(`[bench] 1k reparent drag (${frames} frames, 1 commit): ${kb(reparent())} (S4 12.8 KB, budget 20 KB)`);
  console.log(`[bench] 1k translate drag (${frames} frames, 1 commit): ${kb(translate())} (S4 15.8 KB, budget 20 KB)`);

  test('drag', async ({ bench }) => {
    await bench('stage 30 frames × 1k moves and commit once', () => {
      reparent();
    }).run({ iterations: 5, time: 0 });
  });
});

// ---------------------------------------------------------------- 3. merge

describe('divergent merge (D14: ≤ 200 ms per page, off the main thread)', () => {
  const make = (bytes: Uint8Array, peer: PeerId): DocumentCRDTv2 => {
    const r = engine.load(bytes, { peer });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  /** Two peers diverge from `bytes` by `ops` mixed ops each; returns A's diverged snapshot and B's update. */
  const diverge = (bytes: Uint8Array, ops: number, seed: number): { a: Uint8Array; fromB: Uint8Array } => {
    const a = make(bytes, '6');
    const b = make(bytes, '7');
    const base = a.version();
    applyBatches(a, mixedOps(a, ops, seed, 'a'));
    applyBatches(b, mixedOps(b, ops, seed + 1, 'b'));
    const out = { a: a.exportSnapshot(), fromB: b.exportUpdates(base) };
    a.dispose();
    b.dispose();
    return out;
  };

  // S4's partitioned case: 10k ops per peer spread over the 50 pages (~200 per page); report the worst page.
  const perPage = pageSnapshots.map((bytes, i) => diverge(bytes, 200, 3000 + i * 2));
  let worst = 0;
  for (const { a, fromB } of perPage) {
    const doc = make(a, '8');
    const t = performance.now();
    doc.import(fromB);
    worst = Math.max(worst, performance.now() - t);
    doc.dispose();
  }
  console.log(`[bench] 10k ops/peer over 50 pages: worst page import ${worst.toFixed(1)} ms (S4 124 ms Node, budget 200 ms)`);

  // Stress: 10k ops per peer on ONE 1k-node page.
  const stress = diverge(pageSnapshots[3] as Uint8Array, 10_000, 1001);
  const sample = perPage[0] as { a: Uint8Array; fromB: Uint8Array };
  console.log(`[bench] 10k-op update from peer B on one page: ${kb(stress.fromB.byteLength)}`);

  test('merge', async ({ bench }) => {
    let doc: DocumentCRDTv2 | undefined;
    const freshFrom = (bytes: Uint8Array) => ({
      beforeEach: () => {
        doc = make(bytes, '9');
      },
      afterEach: () => doc?.dispose(),
    });
    await bench.compare(
      bench('import 10k remote ops into one page (load excluded)', freshFrom(stress.a), () => {
        doc?.import(stress.fromB);
      }),
      bench('import ~200 remote ops into one page (S4 partitioned share)', freshFrom(sample.a), () => {
        doc?.import(sample.fromB);
      }),
      { iterations: 5, time: 0 },
    );
  });
});
