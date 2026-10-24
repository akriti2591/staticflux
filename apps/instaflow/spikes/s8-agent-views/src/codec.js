// Shared codec core: canonical value <-> view value per attribute (driven by schema.ATTRS), the layout view model
// (built from the composed stage), and the two serializers of that ONE model: markup (primary) and JSON (fallback,
// IF-6.16). Plus the markup parser (closed vocabulary, no HTML/CSS semantics).
import { ATTRS, KINDS, TAG_TO_KIND, TEXT_PATH } from './schema.js';
import { roundPx, ticksToSec, secToTicks } from './units.js';

// ------------------------------------------------------------------------------------------------ value codec
export function toView(attr, v) {
  const A = ATTRS[attr];
  if (v === undefined || v === null) return undefined;
  switch (A.type) {
    case 'px': return roundPx(v);
    case 's': return ticksToSec(v);
    case 'num': return Math.round(v * 100) / 100 || 0;
    case 'color': return typeof v === 'object' && v.token ? '@' + v.token : v;
    default: return v;
  }
}
export function isDefault(attr, viewV) {
  const d = ATTRS[attr].def;
  if (d === undefined) return false;
  return typeof d === 'object' ? JSON.stringify(d) === JSON.stringify(viewV) : d === viewV;
}
/** view value → canonical value (not geometry-offset; callers handle parent-relative x/y). */
export function fromView(attr, v) {
  const A = ATTRS[attr];
  switch (A.type) {
    case 's': return secToTicks(v);
    case 'color': return typeof v === 'string' && v.startsWith('@') ? { token: v.slice(1) } : v;
    default: return v;
  }
}
/** type check of an agent-supplied view value; returns an error message or null. */
export function checkType(attr, v, tokens) {
  const A = ATTRS[attr];
  const num = typeof v === 'number' && Number.isFinite(v);
  switch (A.type) {
    case 'px': case 'num': case 's':
      if (!num) return `${attr} must be a number`;
      if (A.min !== undefined && v < A.min) return `${attr} must be >= ${A.min}`;
      if (A.max !== undefined && v > A.max) return `${attr} must be <= ${A.max}`;
      return null;
    case 'bool': return typeof v === 'boolean' ? null : `${attr} must be true or false`;
    case 'enum': return A.values.includes(v) ? null : `${attr} must be one of ${A.values.join('|')}`;
    case 'color':
      if (typeof v !== 'string') return `${attr} must be a string`;
      if (v.startsWith('@')) return tokens && !(v.slice(1) in tokens) ? `unknown token ${v}; tokens: ${Object.keys(tokens).map((t) => '@' + t).join(', ')}` : null;
      if (attr === 'font') return null;
      return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? null : `${attr} must be #RRGGBB or @token`;
    case 'json': return typeof v === 'object' && v !== null ? null : `${attr} must be an object`;
    default: return typeof v === 'string' ? null : `${attr} must be a string`;
  }
}

// ------------------------------------------------------------------------------------------------ layout model
/**
 * Build the layout view model of one part from the composed stage.
 * Node: { id: handle, kind, attrs: {attr: viewValue}, text?, children?: Node[] }. Geometry is PAGE-relative
 * (canonical x/y are parent-relative; the codec adds parent offsets). Defaults omitted.
 * Also fills `index`: handle → { nid, partId, kind, parent: handle|null, ox, oy (parent absolute origin, full precision) }.
 */
export function layoutModel(partStage, handles, index) {
  // per-node cache keyed by (composed version, parent offset): unchanged nodes reuse their attrs object, and the
  // serializers/lints cache their output per attrs object (WeakMaps below) — research 05 §5.3 "per-node line cache"
  const cache = partStage.viewCache ??= new Map();
  const build = (nid, parentH, ox, oy) => {
    const rec = partStage.get(nid);
    const K = KINDS[rec.kind];
    const h = handles.of(nid);
    const key = rec.ver + ':' + ox + ':' + oy;
    let c = cache.get(nid);
    if (!c || c.key !== key) {
      const attrs = {};
      for (const a of K.attrs) {
        const path = ATTRS[a].path;
        let v = rec.props[path];
        if (v === undefined) continue;
        if (a === 'x') v += ox; else if (a === 'y') v += oy;
        const vv = toView(a, v);
        if (isDefault(a, vv)) continue;
        attrs[a] = vv;
      }
      c = { key, attrs }; cache.set(nid, c);
    }
    const node = { id: h, kind: rec.kind, attrs: c.attrs };
    if (K.text) node.text = rec.text ?? '';
    index?.set(h, { nid, partId: partStage.partId, kind: rec.kind, parent: parentH, ox, oy, node });
    if (K.container) {
      const cx = ox + (rec.props['spatial.x'] ?? 0), cy = oy + (rec.props['spatial.y'] ?? 0);
      node.children = rec.children.map((c) => build(c, h, rec.kind === 'page' ? 0 : cx, rec.kind === 'page' ? 0 : cy));
    }
    return node;
  };
  return build(partStage.rootId, null, 0, 0);
}

// ------------------------------------------------------------------------------------------------ markup
const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const escT = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function attrStr(attrs) {
  let s = '';
  for (const k in attrs) { const v = attrs[k]; s += ` ${k}="${escA(typeof v === 'object' ? JSON.stringify(v) : v)}"`; }
  return s;
}
const HEAD = new WeakMap();   // attrs object → { id, s }: the element's opening tag, reused while the node is unchanged
export function nodeToMarkup(n, indent = '', out = []) {
  const tag = KINDS[n.kind].tag;
  let hc = HEAD.get(n.attrs);
  if (!hc || hc.id !== n.id) { hc = { id: n.id, s: `<${tag} id="${n.id}"${attrStr(n.attrs)}` }; HEAD.set(n.attrs, hc); }
  const head = indent + hc.s;
  if (n.children && n.children.length) {
    out.push(head + '>');
    for (const c of n.children) nodeToMarkup(c, indent + '  ', out);
    out.push(`${indent}</${tag}>`);
  } else {
    // whole-line cache for leaves (the per-node line cache of research 05 §5.3)
    if (hc.indent !== indent || hc.text !== n.text) { hc.indent = indent; hc.text = n.text; hc.line = n.text !== undefined ? `${head}>${escT(n.text)}</${tag}>` : head + '/>'; }
    out.push(hc.line);
  }
  return out;
}

/** Tiny XML-subset parser: elements, double-quoted attributes, text, the 5 entities. Returns a list of elements. */
export function parseXml(src) {
  let i = 0; const s = src;
  const err = (m) => { throw Object.assign(new Error(`markup parse error at ${i}: ${m}`), { code: 'IF-CS-001' }); };
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const parseEl = () => {
    if (s[i] !== '<') err('expected <');
    i++;
    const m = /^[A-Za-z][\w-]*/.exec(s.slice(i)); if (!m) err('expected tag name');
    const tag = m[0]; i += tag.length;
    const attrs = {};
    for (;;) {
      ws();
      if (s.startsWith('/>', i)) { i += 2; return { tag, attrs, children: [], text: undefined, selfClosing: true }; }
      if (s[i] === '>') { i++; break; }
      const am = /^[A-Za-z_][\w.:-]*/.exec(s.slice(i)); if (!am) err('expected attribute');
      i += am[0].length; ws();
      if (s[i] !== '=') err('expected =');
      i++; ws();
      const q = s[i]; if (q !== '"' && q !== "'") err('expected quote');
      const end = s.indexOf(q, i + 1); if (end < 0) err('unterminated attribute');
      attrs[am[0]] = unesc(s.slice(i + 1, end)); i = end + 1;
    }
    const children = []; let text = '';
    for (;;) {
      if (i >= s.length) err(`unclosed <${tag}>`);
      if (s.startsWith('</', i)) {
        const end = s.indexOf('>', i); const close = s.slice(i + 2, end).trim();
        if (close !== tag) err(`mismatched </${close}> for <${tag}>`);
        i = end + 1; break;
      }
      if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i); i = e < 0 ? s.length : e + 3; continue; }
      if (s[i] === '<') { children.push(parseEl()); continue; }
      const next = s.indexOf('<', i); const chunk = s.slice(i, next < 0 ? s.length : next); text += chunk; i = next < 0 ? s.length : next;
    }
    return { tag, attrs, children, text: children.length ? undefined : unesc(text), selfClosing: false };
  };
  const out = [];
  for (;;) {
    ws();
    if (i >= s.length) break;
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i); i = e < 0 ? s.length : e + 3; continue; }
    if (s.startsWith('<?', i)) { const e = s.indexOf('?>', i); i = e + 2; continue; }
    out.push(parseEl());
  }
  return out;
}

/** markup string attribute → typed view value */
export function typedAttr(attr, raw) {
  const A = ATTRS[attr];
  if (!A) return raw;
  switch (A.type) {
    case 'px': case 'num': case 's': { const n = Number(raw); return raw.trim() === '' || Number.isNaN(n) ? raw : n; }
    case 'bool': return raw === 'true' ? true : raw === 'false' ? false : raw;
    case 'json': try { return JSON.parse(raw); } catch { return raw; }
    default: return raw;
  }
}

/** parsed XML element → view model node (unknown tags/attrs kept so validation can report them). */
export function elToNode(el) {
  const kind = TAG_TO_KIND[el.tag] ?? el.tag;
  const attrs = {}; let id; const extra = {};
  for (const [k, v] of Object.entries(el.attrs)) {
    if (k === 'id') id = v;
    else if (k === 'parent' || k === 'after' || k === 'before') extra[k] = v;
    else attrs[k] = typedAttr(k, v);
  }
  const node = { id, kind, attrs, ...extra };
  if (KINDS[kind]?.text) node.text = el.text ?? '';
  if (el.children.length) node.children = el.children.map(elToNode);
  else if (KINDS[kind]?.container && !el.selfClosing) node.children = [];
  return node;
}

// ------------------------------------------------------------------------------------------------ JSON serializer
/** One node per line, so the JSON view stays diff-friendly and comparable to markup. */
export function nodeToJsonLines(n, indent = '', out = [], last = true) {
  const { children, ...rest } = n;
  const flat = { id: rest.id, kind: rest.kind, ...rest.attrs };
  if (rest.text !== undefined) flat.text = rest.text;
  const body = JSON.stringify(flat);
  if (children && children.length) {
    out.push(`${indent}${body.slice(0, -1)},"children":[`);
    children.forEach((c, i) => nodeToJsonLines(c, indent + ' ', out, i === children.length - 1));
    out.push(`${indent}]}${last ? '' : ','}`);
  } else out.push(`${indent}${body}${last ? '' : ','}`);
  return out;
}
export function jsonToNode(o) {
  const { id, kind, text, children, parent, after, before, ...attrs } = o;
  const node = { id, kind, attrs };
  if (parent !== undefined) node.parent = parent;
  if (after !== undefined) node.after = after;
  if (before !== undefined) node.before = before;
  if (KINDS[kind]?.text) node.text = text ?? '';
  if (Array.isArray(children)) node.children = children.map(jsonToNode);
  return node;
}

export { TEXT_PATH };
