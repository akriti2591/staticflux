// Synthetic 200-page document: canonical parts shaped like DOCUMENT-FORMAT §6.2 (instaflow.part/1).
export function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WORDS = 'diwali sale lamps festive offer limited bright cream gold launch campaign story slide brand hero price legal valid until november shop now'.split(' ');

function node(r, page, i) {
  const kind = ['text', 'shape', 'image', 'group', 'text', 'vector'][Math.floor(r() * 6)];
  const n = { id: `${page.toString(36)}a-${i.toString(36)}`, kind, parent: i < 4 ? `pg-${page}` : `${page.toString(36)}a-${Math.floor(r() * 4).toString(36)}`,
    order: `a${Math.floor(r() * 1e6).toString(36)}`, props: {
      spatial: { x: Math.round(r() * 1080), y: Math.round(r() * 1350), w: Math.round(r() * 900) + 20, h: Math.round(r() * 600) + 20, rotation: r() < 0.2 ? Math.round(r() * 360) : 0, opacity: r() < 0.3 ? Math.round(r() * 100) / 100 : 1 },
      style: { fill: { color: '#' + Math.floor(r() * 0xffffff).toString(16).padStart(6, '0') }, radius: Math.round(r() * 24) },
    } };
  if (kind === 'text') {
    const text = Array.from({ length: 6 + Math.floor(r() * 20) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
    n.role = ['headline', 'body', 'caption', 'cta'][Math.floor(r() * 4)];
    n.props.text = { content: { text, spans: [{ start: 0, end: Math.min(text.length, 12), style: { weight: 700, size: 48 } }], paragraphs: [{ start: 0 }] }, box: 'auto-height', align: 'start', verticalAlign: 'top' };
  }
  if (kind === 'image') n.props.source = { asset: { asset: `as_img${Math.floor(r() * 50)}` }, fit: 'cover' };
  if (kind === 'vector') n.props.geometry = { shape: 'path', path: Array.from({ length: 12 }, () => `L${Math.round(r() * 500)} ${Math.round(r() * 500)}`).join('') };
  return n;
}
export function makeDoc(pages = 200, nodesPerPage = 60, seed = 1) {
  const r = prng(seed); const parts = new Map();
  parts.set('root', { schema: 'instaflow.part/1', part: 'root', treeSchema: 1, nodes: [{ id: 'root', kind: 'composition', parent: null, order: 'a0',
    props: { composition: { format: { width: 1080, height: 1350, fps: [30, 1], sampleRate: 48000 }, primaryLens: 'pages' } } },
    ...Array.from({ length: pages }, (_, p) => ({ id: `pg-${p}`, kind: 'page', parent: 'root', order: `a${p.toString(36).padStart(3, '0')}`, props: { page: { canvas: { x: (p % 20) * 1200, y: Math.floor(p / 20) * 1500 }, advance: 'click' } } }))] });
  for (let p = 0; p < pages; p++) {
    const nodes = Array.from({ length: nodesPerPage }, (_, i) => node(r, p, i)).sort((a, b) => (a.id < b.id ? -1 : 1));
    parts.set(`page:pg-${p}`, { schema: 'instaflow.part/1', part: `page:pg-${p}`, treeSchema: 1, nodes });
  }
  return parts;
}
/** edit k random pages (one property change each), like a working session between milestones */
export function editPages(parts, k, r) {
  const keys = [...parts.keys()].filter((x) => x !== 'root');
  const touched = new Set();
  while (touched.size < Math.min(k, keys.length)) touched.add(keys[Math.floor(r() * keys.length)]);
  for (const key of touched) { const pt = parts.get(key); const n = pt.nodes[Math.floor(r() * pt.nodes.length)]; n.props.spatial.x = Math.round(r() * 1080); }
  return [...touched];
}
