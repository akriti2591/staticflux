// Synthetic Instaflow document part (DOCUMENT-FORMAT.md §3): composition root → pages → groups → elements.
// Deterministic (seeded) so Loro and Yjs get the identical document and op stream.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLES = ['headline', 'subhead', 'body', 'cta', 'logo', 'hero', 'price', 'caption', 'background'];
const KINDS = ['shape', 'image', 'vector', 'video', 'text'];
const WORDS = 'the quick brown fox jumps over a lazy dog while agents propose bold layouts for every page'.split(' ');

export function words(r, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + WORDS[Math.floor(r() * WORDS.length)];
  return s;
}

/**
 * Produces a flat list of node specs in creation (pre-)order: parents before children.
 * spec = { id, kind, parentIdx (index into list or -1), props: {path: value}, text?: { content, marks: [{start,end,key,value}] } }
 */
export function generateNodes(target = 50_000, seed = 42) {
  const r = rng(seed);
  const pages = 50;
  const groupsPerPage = 20;
  const perGroup = Math.max(1, Math.round((target - 1 - pages - pages * groupsPerPage) / (pages * groupsPerPage)));
  const nodes = [];
  let n = 0;
  const id = () => `k3x9q-${(n++).toString(36)}`; // `<peer36>-<n36>` like createIdGenerator
  nodes.push({ id: id(), kind: 'composition', parentIdx: -1, props: { 'format.width': 1080, 'format.height': 1350, primaryLens: 'pages' } });
  for (let p = 0; p < pages; p++) {
    const pi = nodes.length;
    nodes.push({ id: id(), kind: 'page', parentIdx: 0, props: { name: `Page ${p + 1}`, 'page.canvas.x': p * 1200, 'page.canvas.y': 0, 'page.advance': 'click', 'temporal.duration': 705_600_000 * 5 } });
    for (let g = 0; g < groupsPerPage; g++) {
      const gi = nodes.length;
      nodes.push({ id: id(), kind: 'group', parentIdx: pi, props: { name: `Group ${g}`, 'spatial.x': Math.round(r() * 1000), 'spatial.y': Math.round(r() * 1000) } });
      for (let e = 0; e < perGroup; e++) {
        const kind = r() < 0.15 ? 'text' : KINDS[Math.floor(r() * 4)]; // ~15% rich-text nodes
        const props = {
          name: `${kind} ${e}`,
          'spatial.x': Math.round(r() * 1080 * 100) / 100,
          'spatial.y': Math.round(r() * 1350 * 100) / 100,
          'spatial.w': Math.round(50 + r() * 500),
          'spatial.h': Math.round(50 + r() * 500),
          'spatial.rotation': r() < 0.2 ? Math.round(r() * 360) : 0,
          'spatial.opacity': r() < 0.2 ? Math.round(r() * 100) / 100 : 1,
          'style.fill.color': `#${Math.floor(r() * 0xffffff).toString(16).padStart(6, '0')}`,
        };
        if (r() < 0.3) props.role = ROLES[Math.floor(r() * ROLES.length)];
        if (r() < 0.3) { props['temporal.start'] = Math.floor(r() * 10) * 70_560_000; props['temporal.duration'] = 705_600_000; }
        const spec = { id: id(), kind, parentIdx: gi, props };
        if (kind === 'text') {
          const content = words(r, 6 + Math.floor(r() * 10));
          const end = Math.min(content.length, 3 + Math.floor(r() * 10));
          spec.text = { content, marks: [{ start: 0, end, key: 'bold', value: true }] };
          props['text.box'] = 'auto-height';
          props['text.align'] = 'start';
        }
        nodes.push(spec);
      }
    }
  }
  return nodes;
}

const PROP_KEYS = ['spatial.x', 'spatial.y', 'spatial.w', 'spatial.h', 'spatial.rotation', 'style.fill.color'];

/**
 * A deterministic mixed op stream over an existing document (indices into `nodes`).
 * op kinds: set (60%), move (15%), text.insert (10%), text.mark (5%), create (5%), delete (5%)
 */
export function generateOps(nodes, count, seed) {
  const r = rng(seed);
  const elements = [];
  const groups = [];
  const texts = [];
  nodes.forEach((s, i) => {
    if (s.kind === 'group') groups.push(i);
    else if (s.kind !== 'page' && s.kind !== 'composition') { elements.push(i); if (s.text) texts.push(i); }
  });
  const ops = [];
  for (let i = 0; i < count; i++) {
    const x = r();
    if (x < 0.6) {
      const k = PROP_KEYS[Math.floor(r() * PROP_KEYS.length)];
      ops.push({ op: 'set', node: elements[Math.floor(r() * elements.length)], key: k, value: k === 'style.fill.color' ? '#' + Math.floor(r() * 0xffffff).toString(16).padStart(6, '0') : Math.round(r() * 100000) / 100 });
    } else if (x < 0.75) {
      ops.push({ op: 'move', node: elements[Math.floor(r() * elements.length)], parent: groups[Math.floor(r() * groups.length)], index: Math.floor(r() * 40) });
    } else if (x < 0.85) {
      ops.push({ op: 'text.insert', node: texts[Math.floor(r() * texts.length)], at: Math.floor(r() * 20), insert: words(r, 1) + ' ' });
    } else if (x < 0.9) {
      ops.push({ op: 'text.mark', node: texts[Math.floor(r() * texts.length)], start: 0, end: 2 + Math.floor(r() * 5), key: r() < 0.5 ? 'italic' : 'bold', value: true });
    } else if (x < 0.95) {
      ops.push({ op: 'create', parent: groups[Math.floor(r() * groups.length)], seq: i, props: { name: 'new', 'spatial.x': Math.round(r() * 1000), 'spatial.y': Math.round(r() * 1000), 'style.fill.color': '#ff0000' } });
    } else {
      ops.push({ op: 'delete', node: elements[Math.floor(r() * elements.length)] });
    }
  }
  return ops;
}

export function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  const r2 = (v) => Math.round(v * 100) / 100;
  return { n: s.length, median: r2(q(0.5)), p95: r2(q(0.95)), min: r2(s[0]), max: r2(s[s.length - 1]) };
}
