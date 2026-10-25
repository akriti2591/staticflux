// Agent session = its own Loro peer (S4/D14) + handle table + view registry + proposal/apply pipeline.
//   readView(kind, scope)  → { text, base, hash }     (IF-6.1–6.3)
//   apply(edit)            → result { status per op, stale, errors, created, proposal|applied }   (IF-6.6–6.10)
//   accept(proposal)       → re-check stale at accept time, apply to Latest as ONE commit per part, one undo step
//   undo()                 → reverts the last accepted change set (all parts it touched) via the agent peer's UndoManagers
import { L, TREE, writeNode } from './store.js';
import { Stage, PartStage, sameFrontiers as sameFrontierList } from './stage.js';
import { TEXT_PATH, vocabulary } from './schema.js';
import { layoutScopeModel, layoutMarkup, layoutJson, timelineModel, timelineJson, graphModel, graphJson } from './views.js';
import { Compiler } from './compile.js';
import { sha256, stableStringify, sfError } from './units.js';

export class Handles {
  constructor() { this.toH = new Map(); this.toN = new Map(); this.next = 1; }
  of(nid) { let h = this.toH.get(nid); if (!h) { h = 'n' + this.next++; this.toH.set(nid, h); this.toN.set(h, nid); } return h; }
  has(nid) { return this.toH.has(nid); }
  nid(h) { return this.toN.get(h); }
}

export const VIEW_KINDS = ['markup', 'json', 'timeline', 'graph'];

export class AgentSession {
  constructor(latest, { peer, name = 'agent', mode = 'accept-edits' } = {}) {
    this.latest = latest; this.peer = String(peer); this.name = name; this.mode = mode;
    this.replica = latest.openPeer(peer, 'agent:' + name);
    this.stage = new Stage(this.replica);
    this.handles = new Handles();
    this.views = new Map();          // base token → { kind, scope, frontiers, index, flowHandle }
    this.lastBase = new Map();       // scope → base token (for changed-since)
    this.undo = new Map();           // partId → UndoManager on the agent peer
    for (const [pid, d] of this.replica.parts) this.undo.set(pid, new L.UndoManager(d, { mergeInterval: 0, maxUndoSteps: 200 }));
    this.undoGroups = [];            // [{ cs, parts }]
    this.seq = 0;
  }

  /** Project a view. kind: markup | json (layout) | timeline | graph. scope: 'page:<id>' | 'doc' | 'flow:<id>'. */
  readView(kind, scope, { changedSince = true } = {}) {
    // memo by (kind, scope, frontier): an unchanged document returns the identical view (same base, same hash),
    // which also keeps provider prompt caching effective (research 05 §5.3)
    const memoKey = kind + '|' + scope;
    const memo = this.memo?.get(memoKey);
    if (memo) {
      for (const pid of memo.parts) this.stage.part(pid);            // refresh mirrors (cheap when unchanged)
      if (memo.parts.every((pid) => sameFrontierList(this.replica.part(pid).frontiers(), memo.frontiers[pid]))) {
        if (!this.views.has(memo.result.base)) this.views.set(memo.result.base, memo.view);   // evicted from the LRU
        return memo.result;
      }
    }
    const result = this.project(kind, scope, { changedSince });
    const view = this.views.get(result.base);
    (this.memo ??= new Map()).set(memoKey, { parts: result.model.parts, frontiers: view.frontiers, view, result });
    return result;
  }

  project(kind, scope, { changedSince }) {
    let m, body;
    if (kind === 'markup' || kind === 'json') { m = layoutScopeModel(this.stage, this.handles, scope); body = kind === 'markup' ? layoutMarkup(m) : layoutJson(m); }
    else if (kind === 'timeline') { m = timelineModel(this.stage, this.handles, scope); body = timelineJson(m); }
    else if (kind === 'graph') { m = graphModel(this.stage, this.handles, scope); body = graphJson(m); }
    else throw new Error('unknown view kind ' + kind);
    const frontiers = this.replica.frontiers(m.parts);
    const base = 'fr:' + sha256(stableStringify(frontiers)).slice(7, 15);
    const hash = sha256(body);
    let since = '';
    const prev = changedSince && this.lastBase.get(kind + scope);
    if (prev && prev !== base) since = this.changedSinceSection(kind, this.views.get(prev));
    this.views.delete(base);
    this.views.set(base, { kind, scope, frontiers, index: m.index, flowHandle: m.flow?.id });
    if (this.views.size > 64) this.views.delete(this.views.keys().next().value);   // LRU: older bases → IF-CS-007
    this.lastBase.set(kind + scope, base);
    const head = { base, hash, scope };
    const text = kind === 'markup'
      ? `<view kind="layout" base="${base}" hash="${hash}" scope="${scope}" units="px,s" coords="page">\n${body}${since ? '\n' + since : ''}\n</view>`
      : `{"view":"${kind === 'json' ? 'layout' : kind}","base":"${base}","hash":"${hash}","scope":"${scope}","units":"${kind === 'graph' ? '' : 'px,s'}",\n${body}${since ? ',\n"changedSince":' + since : ''}}`;
    return { text, ...head, model: m };
  }

  changedSinceSection(kind, prev) {
    const items = [];
    for (const pid of Object.keys(prev.frontiers)) {
      const ps = this.stage.part(pid);
      const ch = ps.changedSince(prev.frontiers[pid], this.peer);
      const per = new Map();
      const add = (nid, f) => { if (!per.has(nid)) per.set(nid, new Set()); per.get(nid).add(f); };
      for (const f of ch.fields) { const [nid, path] = f.split('|'); add(nid, path.split('.').pop()); }
      for (const n of ch.text) add(n, 'text');
      for (const n of ch.moved) add(n, 'moved');
      for (const n of ch.created) add(n, 'added');
      for (const n of ch.deleted) add(n, 'removed');
      for (const [nid, fs] of per) if (this.handles.has(nid) || ps.get(nid)) items.push({ id: this.handles.of(nid), changed: [...fs].join(',') });
    }
    if (!items.length) return '';
    return kind === 'markup' ? `<changed-since by="others">${items.map((i) => `<changed id="${i.id}" fields="${i.changed}"/>`).join('')}</changed-since>` : JSON.stringify(items);
  }

  /**
   * Compile + validate + stale-check an AgentEdit, then (by autonomy mode) apply it as a proposal or straight to
   * Latest. Returns the per-op result as data (errors carry code + fix).
   */
  apply(edit, { accept } = {}) {
    const p = this.propose(edit);
    if (p.status === 'invalid') return p;
    const doAccept = accept ?? this.mode !== 'ask';
    return doAccept ? this.accept(p) : p;
  }

  propose(edit) {
    const t0 = performance.now();
    const view = this.views.get(edit?.base);
    if (!view) return { status: 'invalid', errors: [sfError('IF-CS-007', `unknown base ${edit?.base}`, 'read a view first and send its base')], results: [] };
    const ops = Array.isArray(edit.ops) ? edit.ops : [];
    if (ops.length > 2000) return { status: 'invalid', errors: [sfError('IF-CS-008', 'more than 2,000 ops', 'split the change')], results: [] };
    const csId = `cs${String(++this.seq).padStart(3, '0')}${this.peer.slice(-3)}`;
    const compiled = this.stage.frozenDuring(() => this.compile(view, ops, csId));
    const proposal = { id: csId, base: edit.base, view, intent: edit.intent ?? '', mode: edit.mode ?? 'partial', ops, ...compiled, compileMs: performance.now() - t0 };
    if (proposal.mode === 'atomic' && proposal.results.some((r) => r.status !== 'ok')) {
      proposal.status = 'rejected-atomic'; proposal.canon = []; return summarize(proposal);
    }
    // preview layer: fork the touched parts (agent replica, current state) and apply there; validate invariants
    proposal.forks = new Map();
    for (const pid of new Set(proposal.canon.map((c) => c.part))) {
      const f = this.replica.part(pid).fork(); f.setPeerId(this.peer);
      const ps = this.stage.part(pid);
      applyCanon(f, ps, proposal.canon.filter((c) => c.part === pid));
      f.commit({ message: JSON.stringify({ actor: 'agent:' + this.name, cs: csId, proposal: true }) });
      proposal.forks.set(pid, f);
      // preview stage of the fork: restored from the mirror's cache + the one proposal commit (no per-node Wasm reads)
      const inv = invariants(new PartStage(f, pid, { cache: ps.toCache() }));
      if (inv.length) {
        proposal.status = 'invalid';
        proposal.errors = inv.map((i) => sfError('IF-CS-011', i, 'keep items on one track from overlapping'));
        proposal.canon = [];
        for (const f2 of proposal.forks.values()) f2.free(); proposal.forks.clear();
        return summarize(proposal);
      }
    }
    proposal.status = 'proposed';
    return summarize(proposal);
  }

  compile(view, ops, csId) {
    const changed = new Map();
    for (const pid of this.replica.parts.keys()) {
      const base = view.frontiers[pid];
      if (base) changed.set(pid, this.stage.part(pid).changedSince(base, this.peer));
    }
    const C = new Compiler({ session: this, stage: this.stage, base: view, changeSetId: csId, changed });
    const canon = []; const results = [];
    ops.forEach((op, i) => {
      C.beginOp();
      const drop = () => C.dropOp();
      try {
        const c = C.compileOp(op);
        const stale = C.staleOf(c);
        if (stale.length) { drop(); results.push({ i, status: 'stale', error: sfError('IF-CS-010', 'stale-field', 're-read the view or resend with expect=theirs', { stale }) }); return; }
        c.forEach((x) => (x.src = i));
        canon.push(...c);
        results.push({ i, status: 'ok', canon: c.length });
      } catch (e) {
        drop();
        const err = e.code ? e : sfError('IF-CS-001', String(e.message ?? e), 'check the op shape');
        results.push({ i, status: err.code === 'IF-CS-010' ? 'stale' : 'error', error: err });
      }
    });
    const created = {};
    for (const [temp, t] of C.temps) if (!C.dropped.has(temp) && !temp.startsWith('new:edge:')) created[temp] = t.nid;
    return { canon, results, created };
  }

  /** Accept a proposal (all ops): re-check stale fields at accept time (IF-6.11), apply as one commit per part. */
  accept(p) {
    if (p.status !== 'proposed') return p;
    const view = p.view;
    // accept-time re-check: humans may have edited while the proposal waited
    const recheck = this.stage.frozenDuring(() => this.compile(view, p.ops, p.id));
    const canon = recheck.canon;
    const parts = [...new Set(canon.map((c) => c.part))];
    for (const pid of parts) {
      applyCanon(this.replica.part(pid), this.stage.part(pid), canon.filter((c) => c.part === pid));
      this.replica.part(pid).commit({ message: JSON.stringify({ actor: 'agent:' + this.name, cs: p.id, intent: p.intent, acceptedBy: this.mode === 'ask' ? 'human' : 'auto' }) });
    }
    for (const f of p.forks?.values() ?? []) f.free();
    if (parts.length) this.undoGroups.push({ cs: p.id, parts });
    const created = {};
    for (const [temp, nid] of Object.entries(recheck.created)) created[temp] = this.handles.of(nid);
    return summarize({ ...p, ...recheck, created, status: 'applied', parts, forks: undefined });
  }

  /** One undo step for the last applied change set, across every part it touched (D14: cross-part = one step). */
  undoLast() {
    const g = this.undoGroups.pop(); if (!g) return false;
    let ok = true;
    for (const pid of g.parts) ok = this.undo.get(pid).undo() && ok;
    return ok;
  }

  describe(kindList) { return vocabulary(kindList); }
  free() { for (const u of this.undo.values()) u.free?.(); this.replica.free(); }
}

function summarize(p) {
  const results = p.results.map((r) => ({ op: r.i, status: r.status, ...(r.error ? { error: r.error } : {}) }));
  return {
    status: p.status, id: p.id, results,
    applied: results.filter((r) => r.status === 'ok').length,
    stale: results.filter((r) => r.status === 'stale').flatMap((r) => r.error.stale ?? []),
    errors: [...(p.errors ?? []), ...results.filter((r) => r.status === 'error').map((r) => ({ op: r.op, ...r.error }))],
    created: p.created ?? {}, canon: p.canon, parts: p.parts, compileMs: p.compileMs,
    // keep the proposal internals for accept()
    view: p.view, ops: p.ops, intent: p.intent, mode: p.mode, forks: p.forks,
  };
}

// ---------------------------------------------------------------------------------------------- canonical apply
/** Apply canonical ops of ONE part to a Loro doc (no commit). Frees every handle. */
export function applyCanon(doc, ps, ops) {
  const tree = doc.getTree(TREE);
  const created = new Map();
  const tidOf = (nid) => created.get(nid) ?? ps.get(nid)?.tid;
  const childTids = (ptid) => { const h = tree.getNodeByID(ptid); try { const ks = h.children() ?? []; const ids = ks.map((k) => k.id); ks.forEach((k) => k.free?.()); return ids; } finally { h.free?.(); } };
  const indexFor = (ptid, after, moving) => {
    const sibs = childTids(ptid).filter((t) => t !== moving);
    if (after === null) return 0;
    if (after === undefined) return sibs.length;
    const i = sibs.indexOf(tidOf(after));
    return i < 0 ? sibs.length : i + 1;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'update': {
        const tid = tidOf(op.node); if (!tid || tree.isNodeDeleted(tid)) break;
        const h = tree.getNodeByID(tid); const d = h.data;
        try { for (const [k, v] of Object.entries(op.set)) v === null ? d.delete(k) : d.set(k, v); } finally { d.free?.(); h.free?.(); }
        break;
      }
      case 'create': {
        const ptid = tidOf(op.parent);
        const tid = writeNode(doc, ptid, indexFor(ptid, op.after), { id: op.node, kind: op.kind, props: op.props, text: op.text });
        created.set(op.node, tid);
        break;
      }
      case 'delete': { const tid = tidOf(op.node); if (tid && !tree.isNodeDeleted(tid)) tree.delete(tid); break; }
      case 'move': {
        const tid = tidOf(op.node), ptid = tidOf(op.parent);
        tree.move(tid, ptid, indexFor(ptid, op.after, tid));
        break;
      }
      case 'text.set': case 'text.replace': case 'text.splice': {
        const tid = tidOf(op.node); const h = tree.getNodeByID(tid); const d = h.data; const t = d.get(TEXT_PATH);
        try {
          const cur = t.toString();
          if (op.op === 'text.splice') { if (op.del) t.delete(op.at, op.del); if (op.ins) t.insert(op.at, op.ins); }
          else if (op.op === 'text.replace') { const at = cur.indexOf(op.find); if (at >= 0) { t.delete(at, op.find.length); t.insert(at, op.replace); } }
          else {
            // minimal splice (common prefix/suffix) so concurrent edits elsewhere in the string merge
            let a = 0; while (a < cur.length && a < op.value.length && cur[a] === op.value[a]) a++;
            let b = 0; while (b < cur.length - a && b < op.value.length - a && cur[cur.length - 1 - b] === op.value[op.value.length - 1 - b]) b++;
            if (cur.length - a - b > 0) t.delete(a, cur.length - a - b);
            if (op.value.length - a - b > 0) t.insert(a, op.value.slice(a, op.value.length - b));
          }
        } finally { t.free?.(); d.free?.(); h.free?.(); }
        break;
      }
    }
  }
}

/** Mode invariants checked on the proposal fork: no overlaps within a video or caption track. */
function invariants(ps) {
  const out = [];
  for (const rec of ps.nodes.values()) {
    if (rec.kind !== 'track' || rec.props['track.kind'] === 'audio' || rec.props['track.kind'] === 'overlay') continue;
    const items = rec.children.map((c) => ps.get(c)).sort((a, b) => a.props['temporal.start'] - b.props['temporal.start']);
    for (let i = 1; i < items.length; i++) {
      const p = items[i - 1], c = items[i];
      if (c.props['temporal.start'] < p.props['temporal.start'] + p.props['temporal.duration'] - 1) out.push(`items overlap on track "${rec.props.name}": ${p.props.name ?? p.id} and ${c.props.name ?? c.id}`);
    }
  }
  return out;
}
