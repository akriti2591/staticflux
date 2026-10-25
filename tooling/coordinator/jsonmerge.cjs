// Structural merge of a conflicted JSON file: base(:1) ours(:2) theirs(:3). Objects merge by key (theirs adds/overrides
// keys ours did not change), arrays union by `name`/`path`/JSON identity, appended in order.
const { execSync } = require('child_process'); const fs = require('fs');
const f = process.argv[2];
const get = (n) => { try { return JSON.parse(execSync(`git show :${n}:${f}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })); } catch { return undefined; } };
const base = get(1), ours = get(2), theirs = get(3);
const id = (x) => (x && typeof x === 'object' && (x.name ?? x.path)) ?? JSON.stringify(x);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function merge(b, o, t) {
  if (eq(o, t)) return o;
  if (eq(b, t)) return o;
  if (eq(b, o)) return t;
  if (Array.isArray(o) && Array.isArray(t)) {
    const seen = new Map(o.map((x) => [id(x), x])); const out = [...o];
    for (const x of t) if (!seen.has(id(x))) out.push(x); else { const i = out.findIndex((y) => id(y) === id(x)); const bx = Array.isArray(b) ? b.find((y) => id(y) === id(x)) : undefined; out[i] = merge(bx, out[i], x); }
    return out;
  }
  if (o && t && typeof o === 'object' && typeof t === 'object') {
    const out = { ...o };
    for (const k of Object.keys(t)) out[k] = k in o ? merge(b?.[k], o[k], t[k]) : t[k];
    return out;
  }
  console.error(`conflict at scalar in ${f}: ours=${JSON.stringify(o)} theirs=${JSON.stringify(t)} -> taking theirs`); return t;
}
fs.writeFileSync(f, JSON.stringify(merge(base, ours, theirs), null, 2) + '\n'); console.log('merged', f);
