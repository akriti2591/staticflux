import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, byName, replicaState } from './helpers.js';
import { Stage } from '../src/stage.js';
import { parseMarkupFragment, fragmentToOps, parseJsonFragment } from '../src/fragment.js';
import { ticksToSec } from '../src/units.js';

const absOf = (agent, scope, name) => { const v = agent.readView('markup', scope, { changedSince: false }); return v.model.index.get(byName(v, name)).node; };
const tl = (agent) => agent.readView('timeline', 'page:rl-page', { changedSince: false });
const item = (v, name) => v.model.index.get(byName(v, name)).node;

test('set / text / insert / delete / move / reorder', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  const H = (n) => byName(v, n);
  const r = agent.apply({ base: v.base, intent: 'misc', ops: [
    { op: 'set', id: H('subhead'), attrs: { fill: '@accent' } },
    { op: 'text', id: H('date'), find: 'Sat 14 Nov', replace: 'Sun 15 Nov' },
    { op: 'insert', tempId: 'new:badge', parent: H('Night market flyer'), el: { kind: 'ellipse', x: 880, y: 40, w: 160, h: 160, fill: '@accent' } },
    { op: 'insert', tempId: 'new:badgeText', parent: H('Night market flyer'), after: 'new:badge', el: '<text x="880" y="100" w="160" h="40" size="28" align="center">Free entry</text>' },
    { op: 'delete', id: H('placeholder copy') },
    { op: 'move', id: H('sponsor logo 3'), parent: H('Night market flyer') },
    { op: 'reorder', id: H('headline'), to: 'front' },
  ] });
  assert.equal(r.status, 'applied', JSON.stringify(r.errors));
  assert.equal(r.applied, 7);
  assert.deepEqual(Object.keys(r.created).sort(), ['new:badge', 'new:badgeText']);
  const v2 = agent.readView('markup', 'page:fl-page');
  assert.equal(item(v2, 'subhead').attrs.fill, '@accent');
  assert.equal(item(v2, 'date').text, 'Sun 15 Nov · 6–11 pm');
  assert.throws(() => byName(v2, 'placeholder copy'));
  const sp3 = item(v2, 'sponsor logo 3');
  assert.deepEqual([sp3.attrs.x, sp3.attrs.y], [761, 1194], 'moved out of the frame but kept its page position');
  const page = v2.model.pages[0];
  assert.equal(page.children.at(-1).attrs.name, 'headline', 'headline is front-most');
  // the human replica (Latest) got the same state through sync
  const hs = new Stage(human); assert.equal(hs.node('fl-sp3').parent, 'fl-page');
  agent.free(); human.free();
});

test('relational ops: align, distribute, stack, place relativeTo', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  const H = (n) => byName(v, n);
  const r = agent.apply({ base: v.base, ops: [
    { op: 'align', ids: [H('sponsor logo 1'), H('sponsor logo 2'), H('sponsor logo 3')], edge: 'top', to: H('sponsor logo 1') },
    { op: 'distribute', ids: [H('sponsor logo 1'), H('sponsor logo 2'), H('sponsor logo 3')], axis: 'x' },
    { op: 'stack', ids: [H('bullet 1'), H('bullet 2'), H('bullet 3')], direction: 'vertical', gap: 24, align: 'start' },
    { op: 'place', id: H('ticket button'), relativeTo: H('bullet 3'), side: 'below', gap: 40, align: 'start' },
  ] });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const st = agent.stage;
  const sp = ['fl-sp1', 'fl-sp2', 'fl-sp3'].map((id) => st.node(id).props);
  assert.ok(sp.every((p) => Math.abs(p['spatial.y'] - 50.2) < 1e-9));
  assert.ok(Math.abs((sp[1]['spatial.x'] - sp[0]['spatial.x']) - (sp[2]['spatial.x'] - sp[1]['spatial.x'])) < 1e-9);
  const b = ['fl-b1', 'fl-b2', 'fl-b3'].map((id) => st.node(id).props);
  assert.ok(Math.abs(b[1]['spatial.y'] - (b[0]['spatial.y'] + 40 + 24)) < 1e-9 && Math.abs(b[2]['spatial.y'] - (b[1]['spatial.y'] + 64)) < 1e-9);
  assert.ok(b.every((p) => p['spatial.x'] === b[0]['spatial.x']));
  const cta = st.node('fl-cta').props;
  assert.ok(Math.abs(cta['spatial.y'] - (b[2]['spatial.y'] + 40 + 40)) < 1e-9 && cta['spatial.x'] === b[0]['spatial.x']);
  agent.free(); human.free();
});

test('validation: codes with fixes, returned per op; valid ops still apply (partial)', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  const H = (n) => byName(v, n);
  const r = agent.apply({ base: v.base, ops: [
    { op: 'set', id: 'n999', attrs: { x: 1 } },                              // IF-CS-002
    { op: 'set', id: H('headline'), attrs: { colour: 'red' } },              // IF-CS-001 unknown attr
    { op: 'set', id: H('headline'), attrs: { fill: '@nope' } },              // IF-CS-001 unknown token
    { op: 'set', id: H('background'), attrs: { x: 10 } },                    // IF-CS-004 locked position
    { op: 'set', id: H('legal line'), attrs: { size: 20 } },                 // IF-CS-013 template final
    { op: 'move', id: H('ticket button'), parent: H('button shape') },       // IF-CS-005 rect can't hold
    { op: 'move', id: H('sponsor bar'), parent: H('sponsor bar') },          // IF-CS-005 cycle
    { op: 'insert', tempId: 'new:a', parent: H('Night market flyer'), el: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 } },
    { op: 'insert', tempId: 'new:a', parent: H('Night market flyer'), el: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 } },  // IF-CS-003
    { op: 'set', id: 'new:zzz', attrs: { x: 1 } },                           // IF-CS-002 temp before create
    { op: 'set', id: H('subhead'), attrs: { size: 40 } },                    // ok
  ] });
  const codes = r.results.map((x) => x.error?.code ?? 'ok');
  assert.deepEqual(codes, ['IF-CS-002', 'IF-CS-001', 'IF-CS-001', 'IF-CS-004', 'IF-CS-013', 'IF-CS-005', 'IF-CS-005', 'ok', 'IF-CS-003', 'IF-CS-002', 'ok']);
  assert.ok(r.errors.every((e) => e.fix && e.code), 'every error has code + fix');
  assert.equal(agent.stage.node('fl-subhead').props['text.size'], 40);
  const big = agent.apply({ base: v.base, ops: Array.from({ length: 2001 }, () => ({ op: 'set', id: H('subhead'), attrs: { size: 41 } })) });
  assert.equal(big.errors[0].code, 'IF-CS-008');
  agent.free(); human.free();
});

test('atomic mode: one bad op → nothing applies', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  const before = replicaState(human);
  const r = agent.apply({ base: v.base, mode: 'atomic', ops: [{ op: 'set', id: byName(v, 'subhead'), attrs: { size: 40 } }, { op: 'set', id: 'n999', attrs: { x: 1 } }] });
  assert.equal(r.status, 'rejected-atomic');
  assert.equal(replicaState(human), before);
  agent.free(); human.free();
});

test('proposal layer (Ask mode): preview on a fork, Latest untouched until accept; accept = one commit = one undo step', () => {
  const { human, agent } = fresh('flyer', { mode: 'ask' });
  const v = agent.readView('markup', 'page:fl-page');
  const H = (n) => byName(v, n);
  const before = replicaState(human);
  const p = agent.apply({ base: v.base, ops: [
    { op: 'set', id: H('headline'), attrs: { size: 70 } },
    { op: 'align', ids: [H('sponsor logo 1'), H('sponsor logo 2'), H('sponsor logo 3')], edge: 'top' },
    { op: 'insert', tempId: 'new:r', parent: H('Night market flyer'), el: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 } },
  ] });
  assert.equal(p.status, 'proposed');
  assert.equal(replicaState(human), before, 'Latest untouched by a proposal');
  // the preview layer is a real fork with the change applied
  const fork = p.forks.get('page:fl-page');
  const fs = new Stage({ part: () => fork, parts: new Map([['page:fl-page', fork]]), tokens: () => ({}), assets: () => ({}) });
  assert.equal(fs.part('page:fl-page').get('fl-headline').props['text.size'], 70);
  const commitsBefore = human.part('page:fl-page').getAllChanges().size;
  const a = agent.accept(p);
  assert.equal(a.status, 'applied');
  assert.notEqual(replicaState(human), before);
  // one commit by the agent peer
  const changes = human.part('page:fl-page').getAllChanges().get(agent.peer);
  assert.equal(changes.length, 1, 'one commit per change set');
  assert.match(changes[0].message, /"cs":"cs001/);
  assert.ok(commitsBefore >= 1);
  assert.ok(agent.undoLast());
  assert.equal(replicaState(human), before, 'one undo step reverts the whole change set');
  agent.free(); human.free();
});

test('cross-page change set (deck) → one commit per page, one undo step across pages', () => {
  const { human, agent } = fresh('deck');
  const v = agent.readView('markup', 'doc');
  const before = replicaState(human);
  const ops = [2, 3, 4, 5].map((s) => ({ op: 'set', id: byName(v, `title slide ${s}`), attrs: { size: 72 } }));
  ops.push(...[1, 2, 3, 4, 5].map((s) => ({ op: 'text', id: byName(v, `title slide ${s}`), find: 'Q3', replace: 'Q4' })).filter((_, i) => i === 0 || i === 3));
  const r = agent.apply({ base: v.base, ops });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.parts.length, 4);
  for (const pid of r.parts) assert.equal(human.part(pid).getAllChanges().get(agent.peer).length, 1);
  assert.equal(agent.stage.node('dk-1-title').text, 'Q4 Product Update');
  assert.ok(agent.undoLast());
  assert.equal(replicaState(human), before);
  agent.free(); human.free();
});

test('timeline ops: trim (+ripple), place, split, delete ripple, insert caption; invariants', () => {
  const { human, agent } = fresh('reel');
  let v = tl(agent);
  const H = (n) => byName(v, n);
  let r = agent.apply({ base: v.base, ops: [{ op: 'trim', id: H('clip 2 food stalls'), end: 8.812, ripple: true }] });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  v = tl(agent);
  assert.equal(item(v, 'clip 2 food stalls').attrs.out, 5.612);
  assert.equal(item(v, 'clip 3 live stage').attrs.start, 8.812);
  assert.equal(item(v, 'clip 5 night lights').attrs.start, 16.212);
  r = agent.apply({ base: v.base, ops: [{ op: 'split', id: byName(v, 'clip 1 city skyline'), at: 2 }] });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  v = tl(agent);
  const parts = v.model.tracks[0].children.slice(0, 2).map((c) => c.attrs);
  assert.deepEqual(parts.map((p) => [p.start, p.dur, p.in, p.out]), [[0, 2, 3, 5], [2, 2.2, 5, 7.2]]);
  r = agent.apply({ base: v.base, ops: [{ op: 'delete', id: byName(v, 'clip 4 crowd'), ripple: true }] });
  v = tl(agent);
  assert.equal(item(v, 'clip 5 night lights').attrs.start, 13.212);
  r = agent.apply({ base: v.base, ops: [{ op: 'insert', tempId: 'new:cap', parent: v.model.tracks[1].id, el: { kind: 'text', start: 18.8, dur: 1.2, text: 'Link in bio' } }] });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  // invariant: overlapping captions are rejected (IF-CS-011) and nothing applies
  v = tl(agent);
  const before = replicaState(human);
  r = agent.apply({ base: v.base, ops: [{ op: 'place', id: byName(v, 'caption 4'), start: 9.6 }] });
  assert.equal(r.status, 'invalid'); assert.equal(r.errors[0].code, 'IF-CS-011');
  assert.equal(replicaState(human), before);
  // range checks
  r = agent.apply({ base: v.base, ops: [{ op: 'set', id: byName(v, 'clip 3 live stage'), attrs: { out: 99 } }] });
  assert.equal(r.errors[0].code, 'IF-CS-011');
  agent.free(); human.free();
});

test('timeline fragment (JSON upsert) diffed against base', () => {
  const { human, agent } = fresh('reel');
  const v = tl(agent);
  const c2 = item(v, 'caption 2');
  const frag = parseJsonFragment({ upsert: [{ ...c2.attrs, id: c2.id, kind: 'text', text: 'The best street food in town' }] }, 'timeline');
  const ops = fragmentToOps(frag, v.model.index);
  assert.deepEqual(ops, [{ op: 'text', id: c2.id, value: 'The best street food in town' }]);
  agent.free(); human.free();
});

test('graph ops: step, connect (replaces bound input), disconnect, port type checks', () => {
  const { human, agent } = fresh('reel');
  let v = agent.readView('graph', 'flow:fw-captions');
  const S = (name) => v.model.steps.find((s) => s.attrs.name === name).id;
  let r = agent.apply({ base: v.base, ops: [
    { op: 'step', tempId: 'new:tr', cap: 'text/translate', params: { to: 'es' } },
    { op: 'connect', from: `${S('style')}.captions`, to: 'new:tr.captions' },
    { op: 'connect', from: 'new:tr.captions', to: `${S('attach')}.captions` },
    { op: 'connect', from: `${S('transcribe')}.words`, to: `${S('attach')}.video` },     // type mismatch
    { op: 'step', tempId: 'new:x', cap: 'image/unknown' },                                 // IF-CS-012
  ] });
  assert.deepEqual(r.results.map((x) => x.error?.code ?? 'ok'), ['ok', 'ok', 'ok', 'IF-CS-011', 'IF-CS-012']);
  v = agent.readView('graph', 'flow:fw-captions');
  assert.match(v.model.outline, /style → n\d+ translate → n\d+ attach/);
  assert.equal(v.model.edges.filter((e) => e.attrs.to.endsWith('.captions') && e.attrs.to.startsWith(S('attach'))).length, 1, 'old edge replaced');
  agent.free(); human.free();
});

test('markup fragment upsert: attrs/text diff, insert by parent, delete, authoritative children', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  const ids = Object.fromEntries(['headline', 'ticket button', 'button shape', 'button label', 'placeholder copy'].map((n) => [n, byName(v, n)]));
  const head = item(v, 'headline');
  const frag = `<text id="${ids.headline}" name="headline" role="headline" x="80" y="197" w="920" h="150" font="@display" size="71" weight="800" fill="@primary" align="center" lineHeight="1.05">MIDSUMMER NIGHT MARKET</text>
<group id="${ids['ticket button']}" name="ticket button" role="cta" x="721" y="780" w="300" h="90">
  <text id="${ids['button label']}" name="button label" role="cta" x="721" y="802" w="300" h="46" size="36" weight="700" fill="#FFFFFF" align="center">Buy tickets</text>
  <rect id="new:glow" x="721" y="780" w="300" h="90" fill="@accent" radius="45"/>
</group>
<delete id="${ids['placeholder copy']}"/>`;
  const ops = fragmentToOps(parseMarkupFragment(frag), v.model.index);
  const kinds = ops.map((o) => o.op);
  assert.deepEqual(kinds, ['set', 'delete', 'text', 'insert', 'delete']);
  assert.deepEqual(ops[0], { op: 'set', id: ids.headline, attrs: { size: 71 } });
  const r = agent.apply({ base: v.base, ops });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const v2 = agent.readView('markup', 'page:fl-page');
  const g = item(v2, 'ticket button');
  assert.deepEqual(g.children.map((c) => c.kind), ['text', 'rect']);
  assert.equal(head.attrs.size, 140);
  agent.free(); human.free();
});

test('changed-since section from the second view on', () => {
  const { human, agent } = fresh('flyer');
  agent.readView('markup', 'page:fl-page');
  const hs = new Stage(human);
  const tree = human.part('page:fl-page').getTree('nodes');
  const n = tree.getNodeByID(hs.part('page:fl-page').get('fl-subhead').tid); n.data.set('text.size', 50); human.part('page:fl-page').commit();
  const v2 = agent.readView('markup', 'page:fl-page');
  assert.match(v2.text, /<changed-since by="others"><changed id="n5" fields="size"\/><\/changed-since>/);
  agent.free(); human.free();
});

test('stale base token is reported, not guessed', () => {
  const { human, agent } = fresh('flyer');
  const r = agent.apply({ base: 'fr:deadbeef', ops: [] });
  assert.equal(r.errors[0].code, 'IF-CS-007');
  agent.free(); human.free();
});

export { absOf, ticksToSec };

test('fragment: omitted text means unchanged, explicit empty body clears (markup and JSON)', () => {
  const { agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  const id = byName(v, 'headline');
  const before = v.model.index.get(id).node.text;
  for (const frags of [
    parseMarkupFragment(`<text id="${id}" size="70"/>`),
    parseJsonFragment({ upsert: [{ id, kind: 'text', size: 70 }] }),
  ]) {
    const ops = fragmentToOps(frags, v.model.index);
    assert.deepEqual(ops, [{ op: 'set', id, attrs: { size: 70 } }]);
  }
  assert.ok(before.length > 0);
  const cleared = fragmentToOps(parseMarkupFragment(`<text id="${id}"></text>`), v.model.index);
  assert.deepEqual(cleared, [{ op: 'text', id, value: '' }]);
});
