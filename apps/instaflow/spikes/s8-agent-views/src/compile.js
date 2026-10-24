// Agent ops (view level, DOCUMENT-FORMAT §7.3) → canonical change-set ops (§7.4), with validation (IF-CS-*),
// unrounding, seconds→ticks, page-relative→parent-relative geometry, and expansion of relational / timeline /
// graph ops. Compilation reads the CURRENT composed stage of the agent's replica (which already holds concurrent
// human edits) and the BASE view the agent read (for unrounding and fragment diffs). Stale detection happens per
// agent op right after it compiles, against what other peers changed since `base`.
import { ATTRS, KINDS, CHILDREN, MEDIA_KINDS, TIMED_KINDS, CAPABILITIES, TEXT_PATH } from './schema.js';
import { fromView, toView, checkType, parseXml, elToNode } from './codec.js';
import { sfError, ticksToSec, secToTicks, sha256 } from './units.js';

const POS_ATTRS = new Set(['x', 'y', 'rotate']);
const EPS = 1e-6;

export class Compiler {
  constructor({ session, stage, base, changeSetId, changed }) {
    this.session = session; this.stage = stage; this.base = base; this.csId = changeSetId;
    this.changed = changed;           // partId → changedSince facts (other peers since base)
    this.temps = new Map();           // 'new:x' → { nid, partId, kind, parent nid, props }
    this.dropped = new Set();         // temp ids whose creating op was dropped
    this.pending = new Map();         // nid → { path: value } written by earlier ops of this change set (for chained relational ops)
  }

  // ---------------------------------------------------------------------------------------------- resolution
  ref(r) {
    if (typeof r !== 'string') throw sfError('IF-CS-001', `expected a handle string, got ${JSON.stringify(r)}`, 'use an id from the view, e.g. "n4"');
    if (r.startsWith('new:')) {
      if (this.dropped.has(r)) throw sfError('IF-CS-002', `${r} was not created (its op was dropped)`, 'fix the op that creates it');
      const t = this.temps.get(r);
      if (!t) throw sfError('IF-CS-002', `temp id ${r} used before it is created`, 'create it first with insert');
      return { ...t, temp: true };
    }
    const nid = this.session.handles.nid(r);
    if (!nid) throw sfError('IF-CS-002', `unknown id ${r}`, 'use an id that appears in the view');
    const partId = this.stage.partOf(nid);
    const rec = partId && this.stage.part(partId).get(nid);
    if (!rec) throw sfError('IF-CS-010', `${r} was deleted after your view was taken`, 're-read the view', { stale: [{ id: r, field: '*', theirs: 'deleted' }] });
    return { nid, partId, kind: rec.kind, rec, handle: r };
  }
  /** effective canonical prop (pending writes of this change set first, then the current stage) */
  prop(t, path) {
    const p = this.pending.get(t.nid);
    if (p && path in p) return p[path];
    return t.temp ? t.props[path] : t.rec.props[path];
  }
  parentOf(t) {
    if (t.temp) return t.parent;
    return t.rec.parent;
  }
  /** absolute origin of a node's parent (sum of ancestor x/y below the page), full precision */
  parentOrigin(t) {
    let x = 0, y = 0; let pid = this.parentOf(t);
    while (pid) {
      const p = this.nodeT(pid);
      if (!p || p.kind === 'page') break;
      x += this.prop(p, 'spatial.x') ?? 0; y += this.prop(p, 'spatial.y') ?? 0;
      pid = this.parentOf(p);
    }
    return { x, y };
  }
  nodeT(nid) {
    for (const t of this.temps.values()) if (t.nid === nid) return { ...t, temp: true };
    const partId = this.stage.partOf(nid); const rec = partId && this.stage.part(partId).get(nid);
    return rec ? { nid, partId, kind: rec.kind, rec } : null;
  }
  box(t) {
    const o = this.parentOrigin(t);
    return { x: o.x + (this.prop(t, 'spatial.x') ?? 0), y: o.y + (this.prop(t, 'spatial.y') ?? 0), w: this.prop(t, 'spatial.w') ?? 0, h: this.prop(t, 'spatial.h') ?? 0 };
  }
  pageBox(t) {
    let cur = t; while (cur && cur.kind !== 'page') cur = this.nodeT(this.parentOf(cur));
    return { x: 0, y: 0, w: this.prop(cur, 'spatial.w'), h: this.prop(cur, 'spatial.h') };
  }
  baseValue(handle, attr) { return this.base.index.get(handle)?.node.attrs[attr]; }

  // ---------------------------------------------------------------------------------------------- guards
  guardWrite(t, attr) {
    const K = KINDS[t.kind];
    if (attr !== 'text' && !K.attrs.includes(attr)) throw sfError('IF-CS-001', `<${K.tag}> has no attribute "${attr}"`, `valid attributes: ${K.attrs.filter((a) => !ATTRS[a].readonly).join(', ')}`);
    if (attr !== 'text' && ATTRS[attr].readonly) throw sfError('IF-CS-001', `"${attr}" is read-only`, 'it is an annotation from composition or policy');
    if (attr === 'text' && !K.text) throw sfError('IF-CS-001', `<${K.tag}> has no text`, 'only <text> has text content');
    if (t.temp) return;
    const from = t.rec.props['policy.from'];
    if (from) throw sfError('IF-CS-013', `${t.handle} comes from the ${from} (final)`, 'leave it unchanged, or ask the user to detach it');
    const lock = t.rec.props['lock.scope'];
    if (lock === 'all' || (lock === 'position' && POS_ATTRS.has(attr)) || (lock === 'content' && (attr === 'text' || attr === 'src')))
      throw sfError('IF-CS-004', `${t.handle} is locked (${lock})`, 'ask the user to unlock it, or edit something else');
  }

  // ---------------------------------------------------------------------------------------------- set
  /** attrs in VIEW units → one canonical update (or none if every value equals what the agent saw: unrounding) */
  setAttrs(t, attrs, { fromBaseCheck = true, exact = false } = {}) {
    const out = [];
    const set = {};
    const tokens = this.stage.tokens();
    const media = MEDIA_KINDS.has(t.kind);
    const timeEdit = {};
    for (const [a, v] of Object.entries(attrs)) {
      if (a === 'text') { out.push(...this.textOp(t, { value: v })); continue; }
      this.guardWrite(t, a);
      const err = checkType(a, v, tokens);
      if (err) throw sfError('IF-CS-001', err, `fix the value of ${a}`);
      // unround: a value equal to the one in the base view means "unchanged" → never written (keeps full precision)
      if (fromBaseCheck && !t.temp && !exact) {
        const bv = this.baseValue(t.handle, a);
        const shown = bv !== undefined ? bv : ATTRS[a].def;
        if (shown !== undefined && JSON.stringify(shown) === JSON.stringify(v)) continue;
      }
      if (media && (a === 'in' || a === 'out' || a === 'dur')) { timeEdit[a] = v; continue; }
      let cv;
      if (ATTRS[a].geom) cv = v - (a === 'x' ? this.parentOrigin(t).x : this.parentOrigin(t).y);
      else cv = fromView(a, v);
      set[ATTRS[a].path] = cv;
    }
    if (Object.keys(timeEdit).length) Object.assign(set, this.mediaTimes(t, timeEdit));
    if (Object.keys(set).length) {
      out.unshift({ op: 'update', part: t.partId, node: t.nid, set });
      const p = this.pending.get(t.nid) ?? {}; Object.assign(p, set); this.pending.set(t.nid, p);
      if (t.temp) Object.assign(t.props, set);
    }
    return out;
  }
  /** source in/out/duration coupling for media clips (speed 1): returns canonical paths; IF-CS-011 on bad ranges */
  mediaTimes(t, e) {
    let inn = this.prop(t, 'source.in'), out = this.prop(t, 'source.out'), dur = this.prop(t, 'temporal.duration');
    if (e.in !== undefined) inn = secToTicks(e.in);
    if (e.out !== undefined) out = secToTicks(e.out);
    if (e.dur !== undefined) dur = secToTicks(e.dur);
    if (e.dur !== undefined && e.out === undefined) out = inn + dur;
    else if (e.out !== undefined && e.dur === undefined) dur = out - inn;
    else if (e.in !== undefined && e.dur === undefined && e.out === undefined) dur = out - inn;
    else if (Math.abs(out - inn - dur) > secToTicks(0.0015)) throw sfError('IF-CS-011', `dur (${ticksToSec(dur)}) must equal out - in (${ticksToSec(out - inn)})`, 'send only two of in/out/dur, or make them consistent');
    const asset = this.stage.assets()[this.prop(t, 'source.asset')];
    if (inn < 0 || out <= inn) throw sfError('IF-CS-011', `need 0 <= in < out (in=${ticksToSec(inn)}, out=${ticksToSec(out)})`, 'fix in/out');
    if (asset && out > asset.dur + 1) throw sfError('IF-CS-011', `out=${ticksToSec(out)} is past the media end (${ticksToSec(asset.dur)})`, `keep out <= ${ticksToSec(asset.dur)}`);
    return { 'source.in': inn, 'source.out': out, 'temporal.duration': dur };
  }
  textOp(t, { value, find, replace }) {
    this.guardWrite(t, 'text');
    if (value !== undefined) {
      if (typeof value !== 'string') throw sfError('IF-CS-001', 'text value must be a string', 'send {op:"text", id, value:"..."}');
      const bv = t.temp ? undefined : this.base.index.get(t.handle)?.node.text;
      if (bv === value) return [];
      return [{ op: 'text.set', part: t.partId, node: t.nid, value, baseText: bv }];
    }
    if (typeof find !== 'string' || typeof replace !== 'string' || !find) throw sfError('IF-CS-001', 'text find/replace must be non-empty strings', 'send {op:"text", id, find, replace}');
    return [{ op: 'text.replace', part: t.partId, node: t.nid, find, replace }];
  }

  // ---------------------------------------------------------------------------------------------- structure
  newNid(temp) { return `${this.csId}-${sha256(this.csId + temp).slice(7, 15)}`; }
  insert(op) {
    const tempId = op.tempId ?? op.id;
    if (typeof tempId !== 'string' || !tempId.startsWith('new:')) throw sfError('IF-CS-001', 'insert needs tempId "new:<name>"', 'e.g. {"op":"insert","tempId":"new:badge",...}');
    if (this.temps.has(tempId)) throw sfError('IF-CS-003', `duplicate temp id ${tempId}`, 'use a unique new:<name>');
    let el = op.el ?? op.element;
    if (typeof el === 'string') { const parsed = parseXml(el); if (parsed.length !== 1) throw sfError('IF-CS-001', 'el must be one element', 'send one element'); el = elToNode(parsed[0]); }
    if (!el || typeof el !== 'object') throw sfError('IF-CS-001', 'insert needs el', 'el: {kind, ...attributes}');
    if (el.attrs === undefined) { const { kind, tag, text, children, ...attrs } = el; el = { kind: kind ?? tag, attrs, text, children }; }
    const parent = this.ref(op.parent);
    return this.createTree(tempId, el, parent, op.after, op.before);
  }
  createTree(tempId, el, parent, after, before) {
    const kind = el.kind;
    if (!KINDS[kind]) throw sfError('IF-CS-001', `unknown element kind "${kind}"`, `kinds: ${Object.keys(KINDS).join(', ')}`);
    if (!(CHILDREN[parent.kind] ?? []).includes(kind)) throw sfError('IF-CS-005', `<${KINDS[parent.kind].tag}> cannot hold <${KINDS[kind].tag}>`, `allowed: ${(CHILDREN[parent.kind] ?? []).join(', ') || 'none'}`);
    if (!parent.temp && parent.rec.props['lock.scope'] === 'all') throw sfError('IF-CS-004', `${parent.handle} is locked`, 'insert elsewhere');
    const nid = this.newNid(tempId);
    const t = { nid, partId: parent.partId, kind, parent: parent.nid, props: {}, temp: true, handle: tempId };
    this.temps.set(tempId, t);
    const ops = [{ op: 'create', part: parent.partId, node: nid, temp: tempId, kind, parent: parent.nid, after: this.afterRef(parent, after, before), props: {}, text: KINDS[kind].text ? (el.text ?? '') : undefined }];
    const tokens = this.stage.tokens();
    const origin = this.parentOrigin(t);
    for (const [a, v] of Object.entries(el.attrs ?? {})) {
      if (!KINDS[kind].attrs.includes(a) || ATTRS[a].readonly) throw sfError('IF-CS-001', `<${KINDS[kind].tag}> has no writable attribute "${a}"`, `valid: ${KINDS[kind].attrs.filter((x) => !ATTRS[x].readonly).join(', ')}`);
      const err = checkType(a, v, tokens); if (err) throw sfError('IF-CS-001', err, `fix ${a}`);
      ops[0].props[ATTRS[a].path] = ATTRS[a].geom ? v - (a === 'x' ? origin.x : origin.y) : fromView(a, v);
    }
    t.props = ops[0].props;
    if (MEDIA_KINDS.has(kind)) {
      const p = ops[0].props;
      if (p['source.in'] === undefined) p['source.in'] = 0;
      if (p['temporal.duration'] === undefined && p['source.out'] !== undefined) p['temporal.duration'] = p['source.out'] - p['source.in'];
      if (p['source.out'] === undefined && p['temporal.duration'] !== undefined) p['source.out'] = p['source.in'] + p['temporal.duration'];
      Object.assign(p, this.mediaTimes(t, {}));
    }
    if (TIMED_KINDS.has(kind) && parent.kind === 'track' && (ops[0].props['temporal.start'] === undefined || ops[0].props['temporal.duration'] === undefined))
      throw sfError('IF-CS-001', 'items on a track need start and dur', 'add start and dur (seconds)');
    let prev = null;
    (el.children ?? []).forEach((c, i) => {
      const ct = c.id && c.id.startsWith('new:') ? c.id : `${tempId}/${i}`;
      ops.push(...this.createTree(ct, c, t, prev ?? null));
      prev = ct;
    });
    return ops;
  }
  /** `after` in canonical terms: null = first (back-most), undefined = last (front-most), else a NodeId */
  afterRef(parent, after, before) {
    if (after === null || after === '') return null;
    if (after !== undefined) {
      const a = this.ref(after);
      if (this.parentOf(a) !== parent.nid) throw sfError('IF-CS-005', `${after} is not a child of ${parent.handle}`, 'after must be a sibling');
      return a.nid;
    }
    if (before !== undefined) {
      const b = this.ref(before);
      const sibs = this.children(parent);
      const i = sibs.indexOf(b.nid);
      if (i < 0) throw sfError('IF-CS-005', `${before} is not a child of ${parent.handle}`, 'before must be a sibling');
      return i === 0 ? null : sibs[i - 1];
    }
    return undefined;
  }
  children(t) { return t.temp ? [...this.temps.values()].filter((x) => x.parent === t.nid).map((x) => x.nid) : t.rec.children; }

  del(op) {
    const t = this.ref(op.id);
    if (t.kind === 'page') throw sfError('IF-CS-005', 'cannot delete a page here', 'delete its elements');
    if (!t.temp && t.rec.props['policy.from']) throw sfError('IF-CS-013', `${op.id} comes from the ${t.rec.props['policy.from']}`, 'leave it');
    if (!t.temp && t.rec.props['lock.scope'] === 'all') throw sfError('IF-CS-004', `${op.id} is locked`, 'ask the user');
    const ops = [{ op: 'delete', part: t.partId, node: t.nid }];
    if (op.ripple) {
      const parent = this.nodeT(this.parentOf(t));
      if (parent.kind !== 'track') throw sfError('IF-CS-001', 'ripple applies to track items only', 'drop ripple');
      ops.push(...this.shiftAfter(parent, this.prop(t, 'temporal.start'), -this.prop(t, 'temporal.duration'), t.nid));
    }
    return ops;
  }
  move(op) {
    const t = this.ref(op.id); const parent = this.ref(op.parent);
    if (t.partId !== parent.partId) throw sfError('IF-CS-005', 'moving between pages is not supported in this spike', 'delete and insert instead');
    if (!(CHILDREN[parent.kind] ?? []).includes(t.kind)) throw sfError('IF-CS-005', `<${KINDS[parent.kind].tag}> cannot hold <${KINDS[t.kind].tag}>`, 'pick another parent');
    for (let p = parent; p; p = this.nodeT(this.parentOf(p))) if (p.nid === t.nid) throw sfError('IF-CS-005', 'move would create a cycle', 'pick a parent outside the moved subtree');
    this.guardWrite(t, 'x');
    const abs = this.box(t);
    const ops = [{ op: 'move', part: t.partId, node: t.nid, parent: parent.nid, after: this.afterRef(parent, op.after, op.before) }];
    // keep the element where it is on the page: re-express x/y relative to the new parent
    const origin = (() => { let x = 0, y = 0; for (let p = parent; p && p.kind !== 'page'; p = this.nodeT(this.parentOf(p))) { x += this.prop(p, 'spatial.x') ?? 0; y += this.prop(p, 'spatial.y') ?? 0; } return { x, y }; })();
    if (this.prop(t, 'spatial.x') !== undefined) {
      const set = { 'spatial.x': abs.x - origin.x, 'spatial.y': abs.y - origin.y };
      ops.push({ op: 'update', part: t.partId, node: t.nid, set, implied: true });
    }
    if (t.temp) t.parent = parent.nid; else t.rec = { ...t.rec, parent: parent.nid };
    return ops;
  }
  reorder(op) {
    const t = this.ref(op.id);
    const parent = this.nodeT(this.parentOf(t));
    const sibs = this.children(parent).filter((n) => n !== t.nid);
    const cur = this.children(parent).indexOf(t.nid);
    let after;
    if (op.to === 'front') after = undefined;
    else if (op.to === 'back') after = null;
    else if (op.to === 'forward') after = sibs[Math.min(cur, sibs.length - 1)] ?? undefined;
    else if (op.to === 'backward') after = cur - 2 >= 0 ? sibs[cur - 2] : null;
    else if (op.after !== undefined || op.before !== undefined) after = this.afterRef(parent.temp ? parent : { ...parent, handle: this.session.handles.of(parent.nid) }, op.after, op.before);
    else throw sfError('IF-CS-001', 'reorder needs after, before or to', 'to: front|back|forward|backward');
    return [{ op: 'move', part: t.partId, node: t.nid, parent: parent.nid, after, reorder: true }];
  }

  // ---------------------------------------------------------------------------------------------- relational (layout)
  setAbs(t, abs) {
    const o = this.parentOrigin(t); const set = {};
    if (abs.x !== undefined) { this.guardWrite(t, 'x'); if (Math.abs(abs.x - o.x - (this.prop(t, 'spatial.x') ?? 0)) > EPS) set['spatial.x'] = abs.x - o.x; }
    if (abs.y !== undefined) { this.guardWrite(t, 'y'); if (Math.abs(abs.y - o.y - (this.prop(t, 'spatial.y') ?? 0)) > EPS) set['spatial.y'] = abs.y - o.y; }
    if (!Object.keys(set).length) return [];
    const p = this.pending.get(t.nid) ?? {}; Object.assign(p, set); this.pending.set(t.nid, p);
    if (t.temp) Object.assign(t.props, set);
    return [{ op: 'update', part: t.partId, node: t.nid, set }];
  }
  refs(ids, min) {
    if (!Array.isArray(ids) || ids.length < min) throw sfError('IF-CS-001', `needs ids: at least ${min} handles`, 'ids: ["n3","n4",...]');
    return ids.map((i) => this.ref(i));
  }
  target(to, ts) {
    if (to === undefined || to === 'bounds') {
      const bs = ts.map((t) => this.box(t));
      const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
      return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
    }
    if (to === 'page') return this.pageBox(ts[0]);
    if (to === 'first') return this.box(ts[0]);
    return this.box(this.ref(to));
  }
  align(op) {
    const ts = this.refs(op.ids, op.to && op.to !== 'bounds' ? 1 : 2);
    const T = this.target(op.to, ts);
    const ops = [];
    for (const t of ts) {
      const b = this.box(t);
      switch (op.edge) {
        case 'left': ops.push(...this.setAbs(t, { x: T.x })); break;
        case 'right': ops.push(...this.setAbs(t, { x: T.x + T.w - b.w })); break;
        case 'centerX': ops.push(...this.setAbs(t, { x: T.x + T.w / 2 - b.w / 2 })); break;
        case 'top': ops.push(...this.setAbs(t, { y: T.y })); break;
        case 'bottom': ops.push(...this.setAbs(t, { y: T.y + T.h - b.h })); break;
        case 'centerY': ops.push(...this.setAbs(t, { y: T.y + T.h / 2 - b.h / 2 })); break;
        default: throw sfError('IF-CS-001', `unknown edge ${op.edge}`, 'edge: left|right|centerX|top|bottom|centerY');
      }
    }
    return ops;
  }
  distribute(op) {
    const ts = this.refs(op.ids, 3);
    const ax = op.axis === 'y' ? 'y' : op.axis === 'x' ? 'x' : null;
    if (!ax) throw sfError('IF-CS-001', 'axis must be x or y', 'axis: "x" | "y"');
    const sz = ax === 'x' ? 'w' : 'h';
    const items = ts.map((t) => ({ t, b: this.box(t) })).sort((a, b) => a.b[ax] - b.b[ax]);
    const first = items[0].b, last = items[items.length - 1].b;
    const total = items.reduce((s, i) => s + i.b[sz], 0);
    const gap = (last[ax] + last[sz] - first[ax] - total) / (items.length - 1);
    let pos = first[ax]; const ops = [];
    for (const i of items) { ops.push(...this.setAbs(i.t, { [ax]: pos })); pos += i.b[sz] + gap; }
    return ops;
  }
  stack(op) {
    const ts = this.refs(op.ids, 2);
    const vertical = (op.direction ?? 'vertical') === 'vertical';
    if (!['vertical', 'horizontal', undefined].includes(op.direction)) throw sfError('IF-CS-001', 'direction must be vertical or horizontal', 'direction: "vertical"');
    const gap = op.gap ?? 0;
    if (typeof gap !== 'number') throw sfError('IF-CS-001', 'gap must be a number', 'gap: 24');
    const ops = []; const first = this.box(ts[0]);
    let pos = vertical ? first.y + first.h + gap : first.x + first.w + gap;
    for (const t of ts.slice(1)) {
      const b = this.box(t); const abs = {};
      if (vertical) { abs.y = pos; pos += b.h + gap; } else { abs.x = pos; pos += b.w + gap; }
      if (op.align) {
        const k = vertical ? 'x' : 'y', s = vertical ? 'w' : 'h';
        abs[k] = op.align === 'start' ? first[k] : op.align === 'end' ? first[k] + first[s] - b[s] : first[k] + first[s] / 2 - b[s] / 2;
      }
      ops.push(...this.setAbs(t, abs));
    }
    return ops;
  }
  placeRel(op) {
    const t = this.ref(op.id); const b = this.box(t);
    const R = op.relativeTo === 'page' ? this.pageBox(t) : this.box(this.ref(op.relativeTo));
    const gap = op.gap ?? 0; const al = op.align ?? 'center';
    const cross = (k, s) => (al === 'start' ? R[k] : al === 'end' ? R[k] + R[s] - b[s] : R[k] + R[s] / 2 - b[s] / 2);
    let abs;
    switch (op.side) {
      case 'below': abs = { y: R.y + R.h + gap, x: cross('x', 'w') }; break;
      case 'above': abs = { y: R.y - gap - b.h, x: cross('x', 'w') }; break;
      case 'right': abs = { x: R.x + R.w + gap, y: cross('y', 'h') }; break;
      case 'left': abs = { x: R.x - gap - b.w, y: cross('y', 'h') }; break;
      case 'inside': {
        const c = op.corner ?? 'center';
        const xs = c.includes('left') ? R.x + gap : c.includes('right') ? R.x + R.w - gap - b.w : R.x + R.w / 2 - b.w / 2;
        const ys = c.includes('top') ? R.y + gap : c.includes('bottom') ? R.y + R.h - gap - b.h : R.y + R.h / 2 - b.h / 2;
        abs = { x: xs, y: ys }; break;
      }
      default: throw sfError('IF-CS-001', `unknown side ${op.side}`, 'side: above|below|left|right|inside');
    }
    return this.setAbs(t, abs);
  }

  // ---------------------------------------------------------------------------------------------- timeline
  trackItems(track) { return this.children(track).map((n) => this.nodeT(n)); }
  shiftAfter(track, at, delta, exclude) {
    const ops = [];
    for (const it of this.trackItems(track)) {
      if (it.nid === exclude) continue;
      const st = this.prop(it, 'temporal.start');
      if (st >= at - 1) {
        const set = { 'temporal.start': Math.max(0, st + delta) };
        const p = this.pending.get(it.nid) ?? {}; Object.assign(p, set); this.pending.set(it.nid, p);
        ops.push({ op: 'update', part: it.partId, node: it.nid, set, implied: true });
      }
    }
    return ops;
  }
  trim(op) {
    const t = this.ref(op.id);
    if (!TIMED_KINDS.has(t.kind)) throw sfError('IF-CS-001', 'trim applies to clips and captions', 'use set for other elements');
    const e = {};
    if (op.in !== undefined) e.in = op.in;
    if (op.out !== undefined) e.out = op.out;
    const oldEnd = this.prop(t, 'temporal.start') + this.prop(t, 'temporal.duration');
    if (op.end !== undefined) {
      if (typeof op.end !== 'number') throw sfError('IF-CS-001', 'end must be seconds', 'end: 3.5');
      e.dur = Math.round((op.end - ticksToSec(this.prop(t, 'temporal.start'))) * 1000) / 1000;
      if (e.dur <= 0) throw sfError('IF-CS-011', 'end must be after start', 'pick a later end');
    }
    if (!Object.keys(e).length) throw sfError('IF-CS-001', 'trim needs in, out or end', 'e.g. {op:"trim", id, end: 3.5}');
    let ops;
    if (MEDIA_KINDS.has(t.kind)) {
      this.guardWrite(t, 'dur');
      const set = this.mediaTimes(t, e);
      const p = this.pending.get(t.nid) ?? {}; Object.assign(p, set); this.pending.set(t.nid, p);
      ops = [{ op: 'update', part: t.partId, node: t.nid, set }];
    } else ops = this.setAttrs(t, { dur: e.dur }, { exact: true });
    if (op.ripple) {
      const newEnd = this.prop(t, 'temporal.start') + this.prop(t, 'temporal.duration');
      ops.push(...this.shiftAfter(this.nodeT(this.parentOf(t)), oldEnd, newEnd - oldEnd, t.nid));
    }
    return ops;
  }
  placeTime(op) {
    const t = this.ref(op.id);
    if (typeof op.start !== 'number' || op.start < 0) throw sfError('IF-CS-001', 'start must be seconds >= 0', 'start: 4.2');
    const ops = [];
    if (op.track !== undefined) {
      const tr = this.ref(op.track);
      if (tr.kind !== 'track') throw sfError('IF-CS-005', `${op.track} is not a track`, 'use a track id');
      if (tr.nid !== this.parentOf(t)) ops.push({ op: 'move', part: t.partId, node: t.nid, parent: tr.nid, after: undefined });
    }
    this.guardWrite(t, 'start');
    const set = { 'temporal.start': secToTicks(op.start) };
    const p = this.pending.get(t.nid) ?? {}; Object.assign(p, set); this.pending.set(t.nid, p);
    ops.push({ op: 'update', part: t.partId, node: t.nid, set });
    return ops;
  }
  split(op) {
    const t = this.ref(op.id);
    if (!TIMED_KINDS.has(t.kind)) throw sfError('IF-CS-001', 'split applies to clips and captions', 'pick a clip');
    const at = secToTicks(op.at); const st = this.prop(t, 'temporal.start'); const dur = this.prop(t, 'temporal.duration');
    if (!(at > st && at < st + dur)) throw sfError('IF-CS-011', `split point ${op.at}s is outside ${ticksToSec(st)}–${ticksToSec(st + dur)}s`, 'pick a time inside the clip');
    this.guardWrite(t, 'dur');
    const first = at - st; const ops = [];
    const tempId = op.tempId ?? `new:${t.handle}b`;
    const props = { ...(t.temp ? t.props : t.rec.props), ...(this.pending.get(t.nid) ?? {}) };
    const set = { 'temporal.duration': first };
    if (MEDIA_KINDS.has(t.kind)) set['source.out'] = props['source.in'] + first;
    ops.push({ op: 'update', part: t.partId, node: t.nid, set });
    const parent = this.nodeT(this.parentOf(t));
    const nid = this.newNid(tempId);
    const np = { ...props, 'temporal.start': at, 'temporal.duration': dur - first };
    delete np['lock.scope'];
    if (MEDIA_KINDS.has(t.kind)) np['source.in'] = props['source.in'] + first;
    if (np.name) np.name = np.name + ' (b)';
    this.temps.set(tempId, { nid, partId: t.partId, kind: t.kind, parent: parent.nid, props: np, temp: true, handle: tempId });
    ops.push({ op: 'create', part: t.partId, node: nid, temp: tempId, kind: t.kind, parent: parent.nid, after: t.nid, props: np, text: t.kind === 'text' ? (t.rec?.text ?? '') : undefined });
    const p = this.pending.get(t.nid) ?? {}; Object.assign(p, set); this.pending.set(t.nid, p);
    return ops;
  }

  // ---------------------------------------------------------------------------------------------- graph
  step(op) {
    const tempId = op.tempId; const cap = op.cap ?? op.capability;
    if (!tempId?.startsWith('new:')) throw sfError('IF-CS-001', 'step needs tempId new:<name>', 'tempId: "new:s4"');
    if (!CAPABILITIES[cap]) throw sfError('IF-CS-012', `unknown capability ${cap}`, `use one of: ${Object.keys(CAPABILITIES).join(', ')}`);
    const flow = this.ref(op.flow ?? this.base.flowHandle);
    return this.createTree(tempId, { kind: 'step', attrs: { cap, ...(op.params ? { params: op.params } : {}) } }, flow, op.after);
  }
  port(ref, dir) {
    const [h, port] = String(ref).split('.');
    const t = this.ref(h);
    if (t.kind !== 'step') throw sfError('IF-CS-001', `${h} is not a step`, 'connect step ports: "n3.captions"');
    const cap = CAPABILITIES[this.prop(t, 'step.capability')];
    const type = cap?.[dir]?.[port];
    if (!type) throw sfError('IF-CS-011', `${h} has no ${dir === 'in' ? 'input' : 'output'} port "${port}"`, `ports: ${Object.keys(cap?.[dir] ?? {}).join(', ')}`);
    return { t, port, type };
  }
  connect(op) {
    const from = this.port(op.from, 'out'), to = this.port(op.to, 'in');
    if (from.type !== to.type) throw sfError('IF-CS-011', `port types differ: ${from.type} → ${to.type}`, 'connect ports of the same type');
    const flow = this.nodeT(this.parentOf(from.t));
    const ops = [];
    // connecting an already-bound input replaces the old edge
    for (const e of this.children(flow).map((n) => this.nodeT(n))) {
      if (e.kind === 'edge' && this.prop(e, 'edge.to') === `${to.t.nid}.${to.port}`) ops.push({ op: 'delete', part: e.partId, node: e.nid });
    }
    const tempId = `new:edge:${op.from}->${op.to}`;
    const nid = this.newNid(tempId);
    const props = { 'edge.from': `${from.t.nid}.${from.port}`, 'edge.to': `${to.t.nid}.${to.port}` };
    this.temps.set(tempId, { nid, partId: flow.partId, kind: 'edge', parent: flow.nid, props, temp: true });
    ops.push({ op: 'create', part: flow.partId, node: nid, temp: tempId, kind: 'edge', parent: flow.nid, props });
    return ops;
  }
  disconnect(op) {
    const from = this.port(op.from, 'out'), to = this.port(op.to, 'in');
    const flow = this.nodeT(this.parentOf(from.t));
    const e = this.children(flow).map((n) => this.nodeT(n)).find((x) => x.kind === 'edge' && this.prop(x, 'edge.from') === `${from.t.nid}.${from.port}` && this.prop(x, 'edge.to') === `${to.t.nid}.${to.port}`);
    if (!e) throw sfError('IF-CS-002', `no edge ${op.from} → ${op.to}`, 'check the edges list');
    return [{ op: 'delete', part: e.partId, node: e.nid }];
  }

  // ---------------------------------------------------------------------------------------------- dispatch
  compileOp(op) {
    if (!op || typeof op !== 'object') throw sfError('IF-CS-001', 'op must be an object', 'see the op schema');
    switch (op.op) {
      case 'set': {
        if (!op.attrs || typeof op.attrs !== 'object') throw sfError('IF-CS-001', 'set needs attrs', '{op:"set", id, attrs:{...}}');
        const t = this.ref(op.id);
        this.checkExpect(t, op.expect);
        return this.setAttrs(t, op.attrs);
      }
      case 'text': { const t = this.ref(op.id); this.checkExpect(t, op.expect); return this.textOp(t, op); }
      case 'insert': case 'create': return this.insert(op);
      case 'delete': return this.del(op);
      case 'move': return this.move(op);
      case 'reorder': return this.reorder(op);
      case 'align': return this.align(op);
      case 'distribute': return this.distribute(op);
      case 'stack': return this.stack(op);
      case 'place': return op.relativeTo !== undefined ? this.placeRel(op) : this.placeTime(op);
      case 'trim': return this.trim(op);
      case 'split': return this.split(op);
      case 'step': return this.step(op);
      case 'connect': return this.connect(op);
      case 'disconnect': return this.disconnect(op);
      default: throw sfError('IF-CS-001', `unknown op "${op.op}"`, 'ops: set, text, insert, delete, move, reorder, align, distribute, stack, place, trim, split, step, connect, disconnect');
    }
  }
  checkExpect(t, expect) {
    if (!expect) return;
    for (const [a, ev] of Object.entries(expect)) {
      let cur;
      if (a === 'text') cur = t.rec?.text;
      else if (ATTRS[a]) {
        let v = this.prop(t, ATTRS[a].path);
        if (ATTRS[a].geom && v !== undefined) v += a === 'x' ? this.parentOrigin(t).x : this.parentOrigin(t).y;
        cur = toView(a, v) ?? ATTRS[a].def;
      }
      if (JSON.stringify(cur) !== JSON.stringify(ev)) throw sfError('IF-CS-010', `${t.handle}.${a} is ${JSON.stringify(cur)}, expected ${JSON.stringify(ev)}`, 're-read the view or resend with expect=theirs', { stale: [{ id: t.handle, field: a, theirs: cur, yours: ev }] });
    }
  }

  /**
   * Stale-field check (IF-CS-010) of one agent op's canonical ops against other peers' changes since base.
   * Returns a list of { id, field, theirs, yours } (empty = fresh).
   */
  staleOf(canon) {
    const stale = [];
    for (const c of canon) {
      if (c.op === 'create') {
        const ch = this.changed.get(c.part);
        if (ch && ch.deleted.has(c.parent)) stale.push({ id: this.session.handles.of(c.parent), field: '*', theirs: 'deleted' });
        continue;
      }
      const ch = this.changed.get(c.part); if (!ch) continue;
      const h = this.session.handles.has(c.node) ? this.session.handles.of(c.node) : c.node;
      if (ch.deleted.has(c.node)) { stale.push({ id: h, field: '*', theirs: 'deleted' }); continue; }
      const rec = this.stage.part(c.part).get(c.node);
      if (c.op === 'update') {
        for (const [path, v] of Object.entries(c.set)) {
          if (!ch.fields.has(c.node + '|' + path)) continue;
          const attr = Object.keys(ATTRS).find((a) => ATTRS[a].path === path);
          const geomOff = ATTRS[attr]?.geom ? this.parentOrigin({ nid: c.node, rec, kind: rec.kind })[attr] : 0;
          stale.push({ id: h, field: attr ?? path, theirs: toView(attr, rec.props[path] + (geomOff || 0)) ?? rec.props[path], yours: toView(attr, v + (geomOff || 0)) ?? v });
        }
      } else if (c.op === 'text.set') {
        if (ch.text.has(c.node)) stale.push({ id: h, field: 'text', theirs: rec.text, yours: c.value });
      } else if (c.op === 'text.replace') {
        if (!String(rec.text ?? '').includes(c.find)) stale.push({ id: h, field: 'text', theirs: rec.text, yours: `find ${JSON.stringify(c.find)}` });
      } else if (c.op === 'move') {
        if (ch.moved.has(c.node)) stale.push({ id: h, field: 'parent/order', theirs: 'moved by someone else' });
      } else if (c.op === 'delete') {
        const touched = ch.text.has(c.node) || [...ch.fields].some((f) => f.startsWith(c.node + '|'));
        if (touched) stale.push({ id: h, field: '*', theirs: 'edited after your view; not deleted' });
      }
    }
    return stale;
  }
}
