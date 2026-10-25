// Round-trip contract suite (research 05 A3, IF-6.4): for every codec,
//   parse(project(s)) == model(s)                         (lossless for the vocabulary)
//   compile(diff(project(s), parse(project(s)))) == []    (an unchanged fragment of the WHOLE view emits no ops)
//   apply([]) leaves the canonical state byte-identical   (no field is ever written by rounding)
//   apply(edit) ⇒ project reflects the edit, untouched fields keep full precision (unround)
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { fresh, norm, scopes, replicaState } from './helpers.js';
import { parseLayoutMarkup, parseLayoutJson, parseTimelineJson, parseGraphJson } from '../src/views.js';
import { parseMarkupFragment, parseJsonFragment, fragmentToOps } from '../src/fragment.js';
import { Replica } from '../src/store.js';
import { AgentSession } from '../src/session.js';

function bodyOf(kind, text) {
  if (kind === 'markup') return text;
  return text; // JSON views are full JSON documents
}
function parsedModel(kind, text) {
  if (kind === 'markup') return norm(parseLayoutMarkup(text));
  if (kind === 'json') return norm(parseLayoutJson(text));
  if (kind === 'timeline') return norm(parseTimelineJson(text));
  const g = parseGraphJson(text); return { steps: norm(g.steps), edges: norm(g.edges) };
}
function projectedModel(kind, m) {
  if (kind === 'markup' || kind === 'json') return norm(m.pages);
  if (kind === 'timeline') return norm(m.tracks);
  return { steps: norm(m.steps), edges: norm(m.edges) };
}
function wholeFragmentOps(kind, text, index) {
  if (kind === 'markup') return fragmentToOps(parseMarkupFragment(text).filter((n) => n.kind !== 'lints'), index);
  if (kind === 'json') return fragmentToOps(parseJsonFragment({ upsert: JSON.parse(text).pages }, 'layout'), index);
  if (kind === 'timeline') return fragmentToOps(parseJsonFragment({ upsert: JSON.parse(text).tracks }, 'timeline'), index);
  const g = JSON.parse(text);
  return fragmentToOps(parseJsonFragment({ upsert: g.steps.map(({ in: _i, out: _o, ...s }) => ({ ...s, kind: 'step' })) }, 'layout'), index);
}

for (const [seed, list] of Object.entries(scopes)) {
  for (const [kind, scope] of list) {
    test(`round-trip ${seed} ${kind} ${scope}`, () => {
      const { human, agent } = fresh(seed);
      const before = replicaState(human);
      const v = agent.readView(kind, scope);
      // 1. lossless parse
      assert.deepEqual(parsedModel(kind, bodyOf(kind, v.text)), projectedModel(kind, v.model));
      // 2. re-projection is stable (same hash) — determinism, prompt-cache friendly
      assert.equal(agent.readView(kind, scope).hash, v.hash);
      // 3. the whole view sent back as a fragment compiles to zero ops
      const inner = kind === 'markup' ? v.text.replace(/^<view[^>]*>\n/, '').replace(/\n<\/view>$/, '').replace(/<lints>[\s\S]*<\/lints>/, '') : v.text;
      const ops = wholeFragmentOps(kind, inner, v.model.index);
      const r = agent.apply({ base: v.base, ops });
      assert.equal(r.canon.length, 0, 'no canonical ops: ' + JSON.stringify(r.canon.slice(0, 3)));
      assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
      // 4. state byte-identical (no rounding writes)
      assert.equal(replicaState(human), before);
      agent.free(); human.free();
    });
  }
}

test('unround: changing x writes only x; untouched floats keep full precision', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  // n4 = headline at stored y=196.73, x=80.4 (view shows 80, 197)
  const r = agent.apply({ base: v.base, ops: [{ op: 'set', id: 'n4', attrs: { x: 100, y: 197, w: 920 } }] });
  assert.equal(r.applied, 1);
  assert.deepEqual(r.canon.map((c) => c.set), [{ 'spatial.x': 100 }]);
  const rec = agent.stage.node('fl-headline');
  assert.equal(rec.props['spatial.y'], 196.73);
  assert.equal(rec.props['spatial.x'], 100);
  agent.free(); human.free();
});

test('group children: page-relative view coordinates compile to parent-relative storage', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  const r = agent.apply({ base: v.base, ops: [{ op: 'set', id: 'n17', attrs: { y: 1210 } }] });   // sponsor logo 1 in the footer frame (y=1150)
  assert.equal(r.applied, 1);
  assert.equal(agent.stage.node('fl-sp1').props['spatial.y'], 60);
  assert.equal(agent.readView('markup', 'page:fl-page').model.index.get('n17').node.attrs.y, 1210);
  agent.free(); human.free();
});

// ---------------------------------------------------------------------------------------------- property tests
const KIND_ARB = fc.constantFrom('rect', 'ellipse', 'text', 'image', 'group', 'frame');
const TEXT_ARB = fc.oneof(fc.string({ maxLength: 30 }), fc.constantFrom('a < b & "c"', 'line1\nline2', '  padded  ', 'émoji 🎉 ü', '</text>', '&amp;', ''));
const num = fc.double({ min: -500, max: 2500, noNaN: true, noDefaultInfinity: true });
const FIELDS = {
  kind: KIND_ARB, x: num, y: num, w: fc.double({ min: 1, max: 2000, noNaN: true }), h: fc.double({ min: 1, max: 2000, noNaN: true }),
  fill: fc.constantFrom(undefined, '#ff0000', { token: 'primary' }, { token: 'ink' }),
  name: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }), text: TEXT_ARB,
  size: fc.integer({ min: 8, max: 200 }), opacity: fc.constantFrom(undefined, 1, 0.5, 0.123),
};
const level = (inner) => fc.record({ ...FIELDS, children: inner ? fc.array(inner, { maxLength: 3 }) : fc.constant([]) });
const nodeArb = level(level(level(null)));   // up to 3 levels of nesting
let uid = 0;
function toSpec(n) {
  const id = 'p' + uid++;
  const props = { name: n.name, 'spatial.x': n.x, 'spatial.y': n.y, 'spatial.w': n.w, 'spatial.h': n.h, 'spatial.opacity': n.opacity };
  if (n.kind !== 'group' && n.kind !== 'image' && n.fill !== undefined) props['style.fill'] = n.fill;
  if (n.kind === 'text') props['text.size'] = n.size;
  if (n.kind === 'image') props['source.asset'] = 'as_x';
  const spec = { id, kind: n.kind, props };
  if (n.kind === 'text') spec.text = n.text;
  if (n.kind === 'group' || n.kind === 'frame') spec.children = n.children.map(toSpec);
  return spec;
}
const pageArb = fc.array(nodeArb, { minLength: 1, maxLength: 8 });

test('property: random pages round-trip through markup and JSON, and an unchanged fragment emits no ops', () => {
  let peer = 50000;
  fc.assert(fc.property(pageArb, (nodes) => {
    const seed = { title: 't', kind: 'x', tokens: { primary: '#E4572E', ink: '#111111' }, assets: {}, pages: [{ id: 'pp', kind: 'page', props: { 'spatial.w': 1000, 'spatial.h': 1000 }, children: nodes.map(toSpec) }] };
    const human = Replica.fromSeed(seed, peer++); const agent = new AgentSession(human, { peer: peer++ });
    try {
      const before = replicaState(human);
      for (const kind of ['markup', 'json']) {
        const v = agent.readView(kind, 'page:pp');
        assert.deepEqual(parsedModel(kind, v.text), projectedModel(kind, v.model));
        const inner = kind === 'markup' ? v.text.replace(/^<view[^>]*>\n/, '').replace(/\n<\/view>$/, '').replace(/<lints>[\s\S]*<\/lints>/, '') : v.text;
        const r = agent.apply({ base: v.base, ops: wholeFragmentOps(kind, inner, v.model.index) });
        assert.equal(r.canon.length, 0);
      }
      assert.equal(replicaState(human), before);
    } finally { agent.free(); human.free(); }
  }), { numRuns: 150, seed: 42 });
});

test('property: a random set edit is reflected by the next projection and touches nothing else', () => {
  let peer = 60000;
  fc.assert(fc.property(pageArb, fc.nat(), fc.constantFrom('x', 'y', 'w', 'h'), fc.integer({ min: -400, max: 2400 }), (nodes, pick, attr, value) => {
    const seed = { title: 't', kind: 'x', tokens: { primary: '#E4572E', ink: '#111111' }, assets: {}, pages: [{ id: 'pp', kind: 'page', props: { 'spatial.w': 1000, 'spatial.h': 1000 }, children: nodes.map(toSpec) }] };
    const human = Replica.fromSeed(seed, peer++); const agent = new AgentSession(human, { peer: peer++ });
    try {
      const v = agent.readView('markup', 'page:pp');
      const handles = [...v.model.index.keys()].filter((h) => v.model.index.get(h).kind !== 'page');
      const h = handles[pick % handles.length];
      if ((attr === 'w' || attr === 'h') && value < 1) value = 1;
      const before = JSON.parse(JSON.stringify(v.model.pages));
      const r = agent.apply({ base: v.base, ops: [{ op: 'set', id: h, attrs: { [attr]: value } }] });
      assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
      const v2 = agent.readView('markup', 'page:pp');
      assert.equal(v2.model.index.get(h).node.attrs[attr], value);
      // every other node: unchanged, except children of a moved container (they move with it)
      const moved = new Set();
      if (attr === 'x' || attr === 'y') { const mark = (n) => { for (const c of n.children ?? []) { moved.add(c.id); mark(c); } }; mark(v2.model.index.get(h).node); }
      const flat = (ns, out = new Map()) => { for (const n of ns) { out.set(n.id, n); flat(n.children ?? [], out); } return out; };
      const A = flat(before), B = flat(v2.model.pages);
      for (const [id, n] of A) {
        if (id === h) continue;
        const m = B.get(id);
        if (moved.has(id)) { const { x, y, ...ra } = n.attrs; const { x: _x, y: _y, ...rb } = m.attrs; assert.deepEqual(rb, ra); }
        else assert.deepEqual(m.attrs, n.attrs);
      }
    } finally { agent.free(); human.free(); }
  }), { numRuns: 150, seed: 7 });
});

test('world cache: a stage restored from its cache + later ops equals a fresh build', async () => {
  const { PartStage } = await import('../src/stage.js');
  const { humanEdit } = await import('../src/human.js');
  const { human, agent } = fresh('flyer');
  const doc = human.part('page:fl-page');
  const cache = new PartStage(doc, 'page:fl-page').toCache();
  humanEdit(human, (h) => { h.set('fl-headline', 'text.size', 99); h.insertText('fl-date', 0, 'NEW '); });
  const a = new PartStage(doc, 'page:fl-page', { cache }), b = new PartStage(doc, 'page:fl-page');
  const strip = (s) => JSON.stringify([...s.nodes.values()].map(({ ver, ...r }) => r).sort((x, y) => (x.id < y.id ? -1 : 1)));
  assert.equal(strip(a), strip(b));
  assert.equal(a.get('fl-headline').props['text.size'], 99);
  agent.free(); human.free();
});

test('incremental mirror: inserts, moves, reorders and deletes (human and agent) match a fresh build', async () => {
  const { PartStage } = await import('../src/stage.js');
  const { humanEdit } = await import('../src/human.js');
  const { human, agent } = fresh('flyer');
  const pid = 'page:fl-page';
  const inc = agent.stage.part(pid);          // the agent's long-lived mirror
  const v = agent.readView('markup', pid);
  const H = (n) => { for (const [h, e] of v.model.index) if (e.node.attrs.name === n) return h; };
  agent.apply({ base: v.base, ops: [
    { op: 'insert', tempId: 'new:g', parent: H('Night market flyer'), el: { kind: 'group', x: 10, y: 10, w: 100, h: 100, children: [{ kind: 'rect', attrs: { x: 10, y: 10, w: 5, h: 5 } }] } },
    { op: 'move', id: H('sponsor logo 2'), parent: 'new:g' },
    { op: 'reorder', id: H('headline'), to: 'back' },
    { op: 'delete', id: H('sponsor bar') },
  ] });
  humanEdit(human, (h) => { h.del('fl-b2'); h.set('fl-b1', 'spatial.x', 1); });
  agent.stage.part(pid);
  const strip = (s) => JSON.stringify([...s.nodes.values()].map(({ ver, ...r }) => r).sort((x, y) => (x.id < y.id ? -1 : 1)));
  assert.equal(strip(inc), strip(new PartStage(agent.replica.part(pid), pid)));
  // and the view from the incremental mirror equals a fresh session's view text (modulo handles/base)
  const v2 = agent.readView('markup', pid);
  assert.ok(!v2.text.includes('sponsor bar') && v2.text.includes('sponsor logo 2'));
  agent.free(); human.free();
});

test('incremental mirror fuzz: 100 rounds × 6 random structural/property edits (agent + human) == fresh build', async () => {
  const { PartStage } = await import('../src/stage.js');
  const { humanEdit } = await import('../src/human.js');
  const { prng } = await import('../src/units.js');
  const strip = (s) => JSON.stringify([...s.nodes.values()].map(({ ver, ...r }) => r).sort((x, y) => (x.id < y.id ? -1 : 1)));
  const r = prng(99); const pick = (a) => a[Math.floor(r() * a.length)];
  let rebuilds = 0;
  for (let round = 0; round < 100; round++) {
    const { human, agent } = fresh('flyer');
    const pid = 'page:fl-page';
    for (let step = 0; step < 6; step++) {
      const v = agent.readView('markup', pid, { changedSince: false });
      const all = [...v.model.index.entries()].filter(([, e]) => e.kind !== 'page' && !e.node.attrs.locked && !e.node.attrs.from);
      const containers = [...v.model.index.entries()].filter(([, e]) => ['page', 'group', 'frame'].includes(e.kind)).map(([h]) => h);
      if (!all.length) break;
      const [h, e] = pick(all);
      const k = r();
      const op = k < 0.25 ? { op: 'delete', id: h }
        : k < 0.5 ? { op: 'move', id: h, parent: pick(containers) }
        : k < 0.7 ? { op: 'reorder', id: h, to: pick(['front', 'back', 'forward', 'backward']) }
        : k < 0.85 ? { op: 'insert', tempId: 'new:x' + step, parent: pick(containers), el: { kind: 'rect', x: 1, y: 2, w: 3, h: 4 } }
        : { op: 'set', id: h, attrs: { x: Math.round(r() * 500) } };
      agent.apply({ base: v.base, ops: [op] });
      if (r() < 0.4) {
        const live = [...agent.stage.part(pid).nodes.values()].filter((n) => n.kind !== 'page' && !n.props['lock.scope'] && n.parent);
        if (live.length) { const n = pick(live); humanEdit(human, (hh) => (r() < 0.5 ? hh.del(n.id) : hh.set(n.id, 'spatial.y', 7))); }
      }
      assert.equal(strip(agent.stage.part(pid)), strip(new PartStage(agent.replica.part(pid), pid)), `round ${round} step ${step} op ${JSON.stringify(op)}`);
    }
    rebuilds += agent.stage.part(pid).rebuilds;
    agent.free(); human.free();
  }
  assert.equal(rebuilds, 0, 'every structural change was applied incrementally');
});
