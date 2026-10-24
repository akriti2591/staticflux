// Worker-side lints (IF-6.3): computed instead of sending pixels. Text metrics are a heuristic stand-in for Parley
// (per-character advance widths in em); the eval predicates use the SAME function, so "fits" is well-defined here.

const NARROW = new Set([...'il.,:;\'!|ftjrI1()[]']);
const WIDE = new Set([...'mwMW@%&']);
export function charEm(c, weight = 400) {
  const bold = weight >= 600 ? 1.06 : 1;
  if (c === ' ') return 0.28;
  if (NARROW.has(c)) return 0.3 * bold;
  if (WIDE.has(c)) return 0.86 * bold;
  if (c >= 'A' && c <= 'Z') return 0.66 * bold;
  if (c >= '0' && c <= '9') return 0.56 * bold;
  return 0.53 * bold;
}
export function textWidth(s, size, weight) { let w = 0; for (const c of s) w += charEm(c, weight); return w * size; }

/** Greedy word wrap in a box of width w. Returns lines, widest line and height. */
export function measureText(text, { size, weight = 400, w, lineHeight = 1.2 }) {
  const paras = String(text ?? '').split('\n');
  const lines = []; let maxW = 0; let wordTooWide = false;
  for (const p of paras) {
    let line = '';
    for (const word of p.split(' ')) {
      const cand = line ? line + ' ' + word : word;
      if (w !== undefined && textWidth(cand, size, weight) > w + 0.01 && line) { lines.push(line); line = word; }
      else line = cand;
      if (w !== undefined && textWidth(word, size, weight) > w + 0.01) wordTooWide = true;
    }
    lines.push(line);
  }
  for (const l of lines) maxW = Math.max(maxW, textWidth(l, size, weight));
  return { lines: lines.length, width: maxW, height: lines.length * size * lineHeight, wordTooWide };
}

/** Largest integer font size at which the text fits the box (no wrap-overflow, no too-wide word). */
export function fitSize(text, box) {
  let lo = 1, hi = Math.floor(box.size);           // binary search for the largest size that fits
  if (!overflows(text, { ...box, size: hi })) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (overflows(text, { ...box, size: mid })) hi = mid; else lo = mid; }
  return lo;
}
export function overflows(text, box) {
  const m = measureText(text, box);
  return m.wordTooWide || (box.h !== undefined && m.height > box.h + 0.5);
}

/**
 * Lints over an absolute-geometry list: [{ h, kind, x, y, w, h, text, size, weight, lineHeight, pageW, pageH }].
 * Returns [{ on, code, detail, fix? }].
 */
const LINT = new WeakMap();   // attrs object (stable while the node is unchanged) → { pw, ph, res }
export function lint(items, page) {
  const out = [];
  for (const it of items) {
    if (it.key) {
      const c = LINT.get(it.key);
      if (c && c.pw === page?.w && c.ph === page?.h) { out.push(...c.res); continue; }
      const res = lintOne(it, page); LINT.set(it.key, { pw: page?.w, ph: page?.h, res }); out.push(...res); continue;
    }
    out.push(...lintOne(it, page));
  }
  return out;
}
function lintOne(it, page) {
  const out = [];
  {
    if (it.kind === 'text' && it.size && it.w !== undefined && it.text !== undefined && it.hgt !== undefined) {
      const box = { size: it.size, weight: it.weight, w: it.w, h: it.hgt, lineHeight: it.lineHeight };
      if (overflows(it.text, box)) {
        const m = measureText(it.text, box);
        out.push({ on: it.h, code: 'text-overflow', detail: `${m.lines} lines need ${Math.round(m.height)}px, box is ${Math.round(it.w)}x${Math.round(it.hgt)}`, fix: `size<=${fitSize(it.text, box)} or a larger box` });
      }
    }
    if (page && it.w !== undefined && it.hgt !== undefined && it.kind !== 'page') {
      if (it.x + it.w < 0 || it.y + it.hgt < 0 || it.x > page.w || it.y > page.h) out.push({ on: it.h, code: 'off-page', detail: 'entirely outside the page' });
      else if (it.x < -0.5 || it.y < -0.5 || it.x + it.w > page.w + 0.5 || it.y + it.hgt > page.h + 0.5) {
        if (it.role !== 'background') out.push({ on: it.h, code: 'past-edge', detail: 'extends past the page edge' });
      }
    }
  }
  return out;
}
