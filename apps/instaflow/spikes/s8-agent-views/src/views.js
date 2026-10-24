// Agent views = pure projections of the composed stage (IF-6.1/6.2). Each returns { text, model, index }.
// The session adds the header (base, viewHash) and the changed-since section.
import { KINDS, ATTRS, MEDIA_KINDS, CAPABILITIES } from './schema.js';
import { layoutModel, nodeToMarkup, nodeToJsonLines, parseXml, elToNode, jsonToNode, toView, isDefault } from './codec.js';
import { lint } from './lints.js';
import { ticksToSec, TICKS_PER_SECOND } from './units.js';
import { TREE } from './store.js';

// ------------------------------------------------------------------------------------------------ layout
/** Flatten a layout model into absolute boxes for lints. */
function boxes(node, out = []) {
  const a = node.attrs;
  out.push({ key: node.attrs, h: node.id, kind: node.kind, role: a.role, x: a.x ?? 0, y: a.y ?? 0, w: a.w, hgt: a.h, text: node.text, size: a.size, weight: a.weight, lineHeight: a.lineHeight });
  for (const c of node.children ?? []) boxes(c, out);
  return out;
}
export function layoutLints(pageModel) {
  return lint(boxes(pageModel).slice(1), { w: pageModel.attrs.w, h: pageModel.attrs.h });
}

/** Model for a layout scope: one page, or 'doc' (every page in story order). */
export function layoutScopeModel(stage, handles, scope) {
  const index = new Map();
  const pids = scope === 'doc' ? stage.replica.pageIds().map((p) => 'page:' + p) : [scope];
  const pages = pids.map((pid) => layoutModel(stage.part(pid), handles, index));
  const lints = pages.flatMap(layoutLints);
  return { pages, lints, index, parts: pids };
}

export function layoutMarkup(m) {
  const lines = [];
  for (const p of m.pages) nodeToMarkup(p, '', lines);
  if (m.lints.length) {
    lines.push('<lints>');
    for (const l of m.lints) lines.push(`  <lint on="${l.on}" code="${l.code}" detail="${l.detail}"${l.fix ? ` fix="${l.fix}"` : ''}/>`);
    lines.push('</lints>');
  }
  return lines.join('\n');
}
export function layoutJson(m) {
  const lines = ['"pages":['];
  m.pages.forEach((p, i) => nodeToJsonLines(p, '', lines, i === m.pages.length - 1));
  lines.push(']');
  if (m.lints.length) lines.push(',"lints":' + JSON.stringify(m.lints));
  return lines.join('\n');
}

/** Parse a full layout markup view back into pages (round-trip suite). Header/lints/changed-since are skipped. */
export function parseLayoutMarkup(text) {
  const els = parseXml(text);
  const view = els.find((e) => e.tag === 'view');
  const top = view ? view.children : els;
  return top.filter((e) => e.tag === 'page').map(elToNode);
}
export function parseLayoutJson(text) {
  const o = JSON.parse(text);
  return o.pages.map(jsonToNode);
}

// ------------------------------------------------------------------------------------------------ timeline
const TL_ATTRS = new Set(['name', 'role', 'src', 'start', 'dur', 'in', 'out', 'volume', 'fadeIn', 'fadeOut', 'track', 'muted', 'locked', 'from']);
export const TL_DERIVED = ['mediaDur', 'beats'];

/** OTIO-shaped model: page → tracks → items, seconds only. Derived read-only facts: mediaDur, beats (timeline s). */
export function timelineModel(stage, handles, scope) {
  const ps = stage.part(scope);
  const index = new Map();
  const assets = stage.assets();
  const page = ps.get(ps.rootId);
  const tracks = [];
  for (const tid of page.children) {
    const t = ps.get(tid);
    if (t.kind !== 'track') continue;
    const th = handles.of(tid);
    const tnode = { id: th, kind: 'track', attrs: attrsOf(t, (a) => TL_ATTRS.has(a)), children: [] };
    index.set(th, { nid: tid, partId: scope, kind: 'track', parent: handles.of(page.id), ox: 0, oy: 0, node: tnode });
    for (const cid of t.children) {
      const c = ps.get(cid);
      const ch = handles.of(cid);
      const node = { id: ch, kind: c.kind, attrs: attrsOf(c, (a) => TL_ATTRS.has(a)) };
      if (KINDS[c.kind].text) node.text = c.text ?? '';
      const asset = assets[c.props['source.asset']];
      if (MEDIA_KINDS.has(c.kind) && asset) {
        node.ro = { mediaDur: ticksToSec(asset.dur) };
        if (asset.beats) {
          const st = c.props['temporal.start'], inn = c.props['source.in'], out = c.props['source.out'];
          node.ro.beats = asset.beats.filter((b) => b >= inn && b <= out).map((b) => ticksToSec(st + b - inn));
        }
      }
      tnode.children.push(node);
      index.set(ch, { nid: cid, partId: scope, kind: c.kind, parent: th, ox: 0, oy: 0, node });
    }
    tracks.push(tnode);
  }
  const ph = handles.of(page.id);
  index.set(ph, { nid: page.id, partId: scope, kind: 'page', parent: null, ox: 0, oy: 0, node: { id: ph, kind: 'page', attrs: {} } });
  return { page: { id: ph, name: page.props.name, dur: toView('dur', page.props['temporal.duration']) }, tracks, index, parts: [scope], lints: timelineLints(tracks) };
}
function attrsOf(rec, filter) {
  const attrs = {};
  for (const a of KINDS[rec.kind].attrs) {
    if (!filter(a)) continue;
    const v = rec.props[ATTRS[a].path]; if (v === undefined) continue;
    const vv = toView(a, v); if (isDefault(a, vv)) continue;
    attrs[a] = vv;
  }
  return attrs;
}
function timelineLints(tracks) {
  const out = [];
  for (const t of tracks) {
    const items = [...t.children].sort((a, b) => a.attrs.start - b.attrs.start);
    for (let i = 1; i < items.length; i++) {
      const p = items[i - 1], c = items[i];
      if (c.attrs.start < p.attrs.start + p.attrs.dur - 1e-9) out.push({ on: c.id, code: 'overlap', detail: `overlaps ${p.id}` });
    }
  }
  return out;
}
export function itemJson(n) {
  const o = { id: n.id, kind: n.kind, ...n.attrs };
  if (n.text !== undefined) o.text = n.text;
  if (n.ro) Object.assign(o, n.ro);
  return JSON.stringify(o);
}
export function timelineJson(m) {
  const lines = [`"page":${JSON.stringify(m.page)},`, '"tracks":['];
  m.tracks.forEach((t, ti) => {
    lines.push(` ${JSON.stringify({ id: t.id, kind: 'track', ...t.attrs }).slice(0, -1)},"items":[`);
    t.children.forEach((c, i) => lines.push(`  ${itemJson(c)}${i === t.children.length - 1 ? '' : ','}`));
    lines.push(` ]}${ti === m.tracks.length - 1 ? '' : ','}`);
  });
  lines.push(']');
  if (m.lints.length) lines.push(',"lints":' + JSON.stringify(m.lints));
  return lines.join('\n');
}
export function parseTimelineJson(text) {
  const o = JSON.parse(text);
  return o.tracks.map((t) => {
    const { id, kind, items, ...attrs } = t;
    return { id, kind: 'track', attrs, children: (items ?? []).map(itemFromJson) };
  });
}
export function itemFromJson(o) {
  const { id, kind, text, mediaDur, beats, parent, after, ...attrs } = o;
  const n = { id, kind, attrs };
  if (parent !== undefined) n.parent = parent;
  if (after !== undefined) n.after = after;
  if (KINDS[kind]?.text) n.text = text ?? '';
  if (mediaDur !== undefined || beats !== undefined) n.ro = { ...(mediaDur !== undefined ? { mediaDur } : {}), ...(beats !== undefined ? { beats } : {}) };
  return n;
}

// ------------------------------------------------------------------------------------------------ graph
/** Flow part → steps with typed ports, edges as separate records with ids, and a one-line outline. */
export function graphModel(stage, handles, scope) {
  const ps = stage.part(scope);
  const flow = ps.get(ps.rootId);
  const index = new Map();
  const fh = handles.of(flow.id);
  index.set(fh, { nid: flow.id, partId: scope, kind: 'flow', parent: null, node: { id: fh, kind: 'flow', attrs: {} } });
  const steps = []; const edges = [];
  for (const cid of flow.children) {
    const c = ps.get(cid); const h = handles.of(cid);
    if (c.kind === 'step') {
      const cap = c.props['step.capability'];
      const node = { id: h, kind: 'step', attrs: { cap, ...(c.props['step.params'] && Object.keys(c.props['step.params']).length ? { params: c.props['step.params'] } : {}) } };
      if (c.props.name) node.attrs.name = c.props.name;
      node.ro = { in: Object.keys(CAPABILITIES[cap]?.in ?? {}), out: Object.keys(CAPABILITIES[cap]?.out ?? {}) };
      steps.push(node); index.set(h, { nid: cid, partId: scope, kind: 'step', parent: fh, node });
    } else if (c.kind === 'edge') {
      const conv = (ref) => { const [n, port] = ref.split('.'); return handles.of(n) + '.' + port; };
      const node = { id: h, kind: 'edge', attrs: { from: conv(c.props['edge.from']), to: conv(c.props['edge.to']) } };
      edges.push(node); index.set(h, { nid: cid, partId: scope, kind: 'edge', parent: fh, node });
    }
  }
  const byH = new Map(steps.map((s) => [s.id, s]));
  const next = new Map(edges.map((e) => [e.attrs.from.split('.')[0], e.attrs.to.split('.')[0]]));
  const targets = new Set(edges.map((e) => e.attrs.to.split('.')[0]));
  const outline = steps.filter((s) => !targets.has(s.id)).map((s) => {
    const chain = []; let cur = s.id; const seen = new Set();
    while (cur && !seen.has(cur)) { seen.add(cur); chain.push(`${cur} ${byH.get(cur)?.attrs.cap.split('/')[1]}`); cur = next.get(cur); }
    return chain.join(' → ');
  }).join('; ');
  return { flow: { id: fh, name: flow.props.name }, steps, edges, outline, index, parts: [scope], lints: [] };
}
export function graphJson(m) {
  const lines = [`"flow":${JSON.stringify(m.flow)},`, '"steps":['];
  m.steps.forEach((s, i) => lines.push(` ${JSON.stringify({ id: s.id, ...s.attrs, ...s.ro })}${i === m.steps.length - 1 ? '' : ','}`));
  lines.push('],', '"edges":[');
  m.edges.forEach((e, i) => lines.push(` ${JSON.stringify({ id: e.id, ...e.attrs })}${i === m.edges.length - 1 ? '' : ','}`));
  lines.push('],', `"outline":${JSON.stringify(m.outline)}`);
  return lines.join('\n');
}
export function parseGraphJson(text) {
  const o = JSON.parse(text);
  return {
    steps: o.steps.map(({ id, in: _i, out: _o, ...attrs }) => ({ id, kind: 'step', attrs })),
    edges: o.edges.map(({ id, ...attrs }) => ({ id, kind: 'edge', attrs })),
  };
}

// ------------------------------------------------------------------------------------------------ raw canonical JSON (comparison only)
/** What an agent would see without a projection: the part's tree as stored (fractional keys, ticks, floats, token objects). */
export function canonicalJson(stage, scope) {
  const pids = scope === 'doc' ? stage.replica.pageIds().map((p) => 'page:' + p) : [scope];
  return JSON.stringify({ tokens: stage.tokens(), assets: stage.assets(), parts: Object.fromEntries(pids.map((p) => [p, stage.replica.part(p).getTree(TREE).toJSON()])) });
}

export { TICKS_PER_SECOND };
