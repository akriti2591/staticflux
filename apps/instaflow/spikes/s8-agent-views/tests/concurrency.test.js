// Concurrency: a human edit and an agent change set touching overlapping elements must never clobber each other.
// "Clobber" = a value a human wrote after the agent's base is overwritten by the agent (or a human text insert lost),
// or an agent op reported as applied whose effect is not in the final state. Stale fields must be FLAGGED (IF-CS-010).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fresh, byName } from './helpers.js';
import { Stage } from '../src/stage.js';
import { Replica, TREE, linkReplicas } from '../src/store.js';
import { AgentSession } from '../src/session.js';
import { flyerSeed, deckSeed } from '../src/seeds.js';
import { fragmentToOps, parseMarkupFragment } from '../src/fragment.js';
import { nodeToMarkup } from '../src/codec.js';
import { prng } from '../src/units.js';

/** human-side edits straight on the Latest replica (what the human's tab does), one commit per gesture */
function humanEdit(human, fn) {
  const st = new Stage(human);
  const ctx = {
    set(nid, path, v) { const pid = st.partOf(nid); const t = human.part(pid).getTree(TREE); const n = t.getNodeByID(st.part(pid).get(nid).tid); const d = n.data; d.set(path, v); d.free(); n.free(); ctx.pids.add(pid); },
    insertText(nid, at, s) { const pid = st.partOf(nid); const t = human.part(pid).getTree(TREE); const n = t.getNodeByID(st.part(pid).get(nid).tid); const d = n.data; const tx = d.get('text.content'); tx.insert(at < 0 ? tx.length : at, s); tx.free(); d.free(); n.free(); ctx.pids.add(pid); },
    del(nid) { const pid = st.partOf(nid); human.part(pid).getTree(TREE).delete(st.part(pid).get(nid).tid); ctx.pids.add(pid); },
    pids: new Set(),
  };
  fn(ctx);
  for (const pid of ctx.pids) human.part(pid).commit({ message: '{"actor":"human:guest"}' });
}
const P = (human, nid) => new Stage(human).node(nid);

test('same element, different fields: both survive', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  humanEdit(human, (h) => { h.set('fl-headline', 'spatial.x', 95.5); h.set('fl-headline', 'spatial.y', 210.25); });
  const r = agent.apply({ base: v.base, ops: [{ op: 'set', id: byName(v, 'headline'), attrs: { size: 70 } }] });
  assert.equal(r.applied, 1); assert.equal(r.stale.length, 0);
  const n = P(human, 'fl-headline').props;
  assert.deepEqual([n['spatial.x'], n['spatial.y'], n['text.size']], [95.5, 210.25, 70]);
});

test('same field: agent op is flagged stale with theirs/yours, human value kept, other ops still apply', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  humanEdit(human, (h) => h.set('fl-headline', 'text.size', 90));
  const r = agent.apply({ base: v.base, ops: [{ op: 'set', id: byName(v, 'headline'), attrs: { size: 70 } }, { op: 'set', id: byName(v, 'subhead'), attrs: { size: 40 } }] });
  assert.deepEqual(r.results.map((x) => x.status), ['stale', 'ok']);
  assert.deepEqual(r.stale, [{ id: byName(v, 'headline'), field: 'size', theirs: 90, yours: 70 }]);
  assert.equal(r.results[0].error.code, 'IF-CS-010');
  assert.equal(P(human, 'fl-headline').props['text.size'], 90);
  assert.equal(P(human, 'fl-subhead').props['text.size'], 40);
});

test('text: find/replace merges with a concurrent insert; whole-value replace is flagged', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  humanEdit(human, (h) => h.insertText('fl-date', -1, ' (rain or shine)'));
  const r = agent.apply({ base: v.base, ops: [{ op: 'text', id: byName(v, 'date'), find: 'Sat 14 Nov', replace: 'Sun 15 Nov' }, { op: 'text', id: byName(v, 'date'), value: 'Sunday' }] });
  assert.deepEqual(r.results.map((x) => x.status), ['ok', 'stale']);
  assert.equal(P(human, 'fl-date').text, 'Sun 15 Nov · 6–11 pm (rain or shine)');
});

test('deletes: agent edit of a human-deleted node is flagged; agent delete of a human-edited node is refused', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  humanEdit(human, (h) => { h.del('fl-lorem'); h.set('fl-b1', 'text.size', 34); });
  const r = agent.apply({ base: v.base, ops: [{ op: 'set', id: byName(v, 'placeholder copy'), attrs: { size: 20 } }, { op: 'delete', id: byName(v, 'bullet 1') }] });
  assert.deepEqual(r.results.map((x) => x.status), ['stale', 'stale']);
  assert.ok(P(human, 'fl-b1'), 'human-edited node not deleted');
  assert.equal(P(human, 'fl-b1').props['text.size'], 34);
});

test('relational op over a human-moved element: the whole op is flagged, human position kept', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  humanEdit(human, (h) => h.set('fl-sp2', 'spatial.y', 30));
  const r = agent.apply({ base: v.base, ops: [{ op: 'align', ids: ['sponsor logo 1', 'sponsor logo 2', 'sponsor logo 3'].map((n) => byName(v, n)), edge: 'top', to: byName(v, 'sponsor logo 1') }] });
  assert.equal(r.results[0].status, 'stale');
  assert.equal(P(human, 'fl-sp2').props['spatial.y'], 30);
  assert.equal(P(human, 'fl-sp3').props['spatial.y'], 43.6, 'no partial align');
});

test('fragment carrying a stale copy of a human-moved element does not revert the move (base-view diff)', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  humanEdit(human, (h) => h.set('fl-logo', 'spatial.x', 300));               // human drags the logo
  // agent regenerates the logo element from ITS view (x=60) and changes only the height
  const logo = v.model.index.get(byName(v, 'market logo')).node;
  const frag = nodeToMarkup({ ...logo, attrs: { ...logo.attrs, h: 80 } }).join('\n');
  const r = agent.apply({ base: v.base, ops: fragmentToOps(parseMarkupFragment(frag), v.model.index) });
  assert.equal(r.applied, 1);
  const n = P(human, 'fl-logo').props;
  assert.deepEqual([n['spatial.x'], n['spatial.h']], [300, 80]);
});

test('accept-time conflict (Ask mode): human edits while the proposal waits → flagged at accept, human kept', () => {
  const { human, agent } = fresh('flyer', { mode: 'ask' });
  const v = agent.readView('markup', 'page:fl-page');
  const p = agent.apply({ base: v.base, ops: [{ op: 'set', id: byName(v, 'headline'), attrs: { size: 70 } }, { op: 'set', id: byName(v, 'subhead'), attrs: { size: 40 } }] });
  assert.equal(p.status, 'proposed'); assert.equal(p.stale.length, 0);
  humanEdit(human, (h) => h.set('fl-headline', 'text.size', 100));
  const a = agent.accept(p);
  assert.deepEqual(a.results.map((x) => x.status), ['stale', 'ok']);
  assert.equal(P(human, 'fl-headline').props['text.size'], 100);
  assert.equal(P(human, 'fl-subhead').props['text.size'], 40);
});

test('undo of the agent change set after a later human edit keeps the human edit', () => {
  const { human, agent } = fresh('flyer');
  const v = agent.readView('markup', 'page:fl-page');
  agent.apply({ base: v.base, ops: [{ op: 'set', id: byName(v, 'headline'), attrs: { size: 70 } }, { op: 'set', id: byName(v, 'subhead'), attrs: { size: 40 } }] });
  humanEdit(human, (h) => h.set('fl-subhead', 'spatial.y', 380));
  assert.ok(agent.undoLast());
  const s = P(human, 'fl-subhead').props;
  assert.deepEqual([s['text.size'], s['spatial.y'], P(human, 'fl-headline').props['text.size']], [44, 380, 140]);
});

test('delayed sync (unlinked peers, truly concurrent same-field writes): every collision is detectable after merge', () => {
  const seed = flyerSeed();
  const human = Replica.fromSeed(seed, 7001);
  const agent = new AgentSession(human, { peer: 7002 });
  agent.replica._unlink();                                   // simulate the agent running offline / remote
  const v = agent.readView('markup', 'page:fl-page');
  humanEdit(human, (h) => { h.set('fl-headline', 'text.size', 90); h.set('fl-subhead', 'spatial.y', 380); });
  const r = agent.apply({ base: v.base, ops: [{ op: 'set', id: byName(v, 'headline'), attrs: { size: 70 } }, { op: 'set', id: byName(v, 'subhead'), attrs: { size: 40 } }] });
  assert.equal(r.applied, 2, 'agent could not see the human edit yet');
  linkReplicas(human, agent.replica);
  const pid = 'page:fl-page';
  human.part(pid).import(agent.replica.part(pid).export({ mode: 'update' }));
  agent.replica.part(pid).import(human.part(pid).export({ mode: 'update' }));
  // post-merge check (accept-time rule IF-6.11): fields written by both sides since base
  const ps = new Stage(human).part(pid);
  const humanSide = ps.changedSince(v.model.index.size && agent.views.get(v.base).frontiers[pid], agent.peer);
  const agentFields = new Set(r.canon.flatMap((c) => Object.keys(c.set ?? {}).map((k) => c.node + '|' + k)));
  const collisions = [...humanSide.fields].filter((f) => agentFields.has(f));
  assert.deepEqual(collisions, ['fl-headline|text.size']);
  assert.equal(P(human, 'fl-subhead').props['spatial.y'], 380);
});

// ---------------------------------------------------------------------------------------------- fuzz
const FIELDS = [['spatial.x', 'x'], ['spatial.y', 'y'], ['text.size', 'size'], ['spatial.w', 'w']];
function fuzz(seedFn, scope, rounds, { naive = false, seed = 1 } = {}) {
  const r = prng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const stats = { rounds, humanWrites: 0, agentOps: 0, applied: 0, staleFlagged: 0, clobbered: 0, lostAgentOps: 0, textLost: 0 };
  for (let k = 0; k < rounds; k++) {
    const human = Replica.fromSeed(seedFn(), 100000 + k * 2);
    const agent = new AgentSession(human, { peer: 100001 + k * 2 });
    const v = agent.readView('markup', scope, { changedSince: false });
    const texts = [...v.model.index.entries()].filter(([, e]) => e.kind === 'text' && !e.node.attrs.from);
    const movables = [...v.model.index.entries()].filter(([, e]) => e.kind !== 'page' && !e.node.attrs.locked && !e.node.attrs.from && e.node.attrs.x !== undefined);
    // the overlap is forced: agent and human pick from the same small pool of elements
    const pool = Array.from({ length: 3 }, () => pick(movables));
    const humanW = new Map(); let humanText = null;
    humanEdit(human, (h) => {
      for (let i = 0; i < 2; i++) {
        const [, e] = pick(pool); const [path] = pick(FIELDS);
        if (path === 'text.size' && e.kind !== 'text') continue;
        const val = Math.round(r() * 500) + 0.5;
        h.set(e.nid, path, val); humanW.set(e.nid + '|' + path, val); stats.humanWrites++;
      }
      if (r() < 0.5 && texts.length) { const [, e] = pick(texts); h.insertText(e.nid, 0, '«H»'); humanText = e.nid; }
    });
    let ops = [];
    for (let i = 0; i < 3; i++) {
      const [hd, e] = pick(pool); const [, attr] = pick(FIELDS);
      if (attr === 'size' && e.kind !== 'text') continue;
      ops.push({ op: 'set', id: hd, attrs: { [attr]: Math.round(r() * 800) + 1 } });
    }
    if (r() < 0.4) ops.push({ op: 'align', ids: pool.map(([hd]) => hd).filter((x, i, a) => a.indexOf(x) === i), edge: 'left' });
    if (texts.length && r() < 0.5) { const [hd, e] = pick(texts); const word = (e.node.text.split(' ')[0] || 'x'); ops.push({ op: 'text', id: hd, find: word, replace: word.toUpperCase() + '!' }); }
    stats.agentOps += ops.length;
    let res;
    if (naive) {
      // baseline: the agent's stale element copies (base view + its changes) diffed against CURRENT state
      const cur = agent.readView('markup', scope, { changedSince: false });
      const frags = [];
      for (const op of ops) {
        if (op.op !== 'set') continue;
        const n = v.model.index.get(op.id).node;
        frags.push({ ...n, children: undefined, attrs: { ...n.attrs, ...op.attrs } });
      }
      res = agent.apply({ base: cur.base, ops: fragmentToOps(frags, cur.model.index) });
    } else res = agent.apply({ base: v.base, ops });
    stats.applied += res.applied; stats.staleFlagged += res.stale.length ? res.results.filter((x) => x.status === 'stale').length : 0;
    const st = new Stage(human);
    for (const [key, val] of humanW) {
      const [nid, path] = key.split('|'); const n = st.node(nid);
      if (n && n.props[path] !== val) stats.clobbered++;
    }
    if (humanText && !st.node(humanText).text.includes('«H»')) stats.textLost++;
    // every op reported applied must be visible (set ops only; others are checked by the targeted tests)
    if (!naive) res.results.forEach((x, i) => {
      const op = ops[i]; if (x.status !== 'ok' || op.op !== 'set') return;
      const nv = agent.readView('markup', scope, { changedSince: false }).model.index.get(op.id).node;
      const later = ops.slice(i + 1).some((o, j) => res.results[i + 1 + j].status === 'ok' && (o.op === 'align' || (o.op === 'set' && o.id === op.id)));
      for (const [a, val] of Object.entries(op.attrs)) if (!later && nv.attrs[a] !== val) stats.lostAgentOps++;
    });
    agent.free(); human.free();
  }
  return stats;
}

test('fuzz: 300 rounds of overlapping human + agent edits → zero clobbers, zero lost agent ops (base-view diff + stale check)', () => {
  const a = fuzz(flyerSeed, 'page:fl-page', 200, { seed: 11 });
  const b = fuzz(deckSeed, 'doc', 100, { seed: 12 });
  const naiveA = fuzz(flyerSeed, 'page:fl-page', 200, { seed: 11, naive: true });
  const out = { flyer: a, deck: b, naiveBaselineFlyer: naiveA };
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../results/concurrency.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
  for (const s of [a, b]) { assert.equal(s.clobbered, 0); assert.equal(s.textLost, 0); assert.equal(s.lostAgentOps, 0); assert.ok(s.staleFlagged > 0, 'the fuzz really produced conflicts'); }
  assert.ok(naiveA.clobbered > 0, 'the naive baseline clobbers (the test can detect clobbers)');
});
