// After resolving a JSON conflict: compare the result with HEAD and print every entry that was LOST, CHANGED or NEW.
// Only NEW entries from the incoming side are expected; review every LOST or CHANGED line by hand.
// Usage (repo root): node tooling/coordinator/json-check.cjs .size-limit.json apps/instaflow/package.json
const { execSync } = require('child_process');
const fs = require('fs');
const key = (x) => (x && typeof x === 'object' && (x.name ?? x.path)) ?? JSON.stringify(x);
for (const file of process.argv.slice(2)) {
  const head = JSON.parse(execSync(`git show HEAD:${file}`, { encoding: 'utf8' }));
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  const walk = (h, n, path) => {
    if (Array.isArray(h) && Array.isArray(n)) {
      for (const x of h) { const y = n.find((z) => key(z) === key(x)); if (!y) console.log(`LOST    ${file} ${path}[${key(x)}]`); else if (JSON.stringify(x) !== JSON.stringify(y)) console.log(`CHANGED ${file} ${path}[${key(x)}]`); }
      for (const y of n) if (!h.some((x) => key(x) === key(y))) console.log(`NEW     ${file} ${path}[${key(y)}]`);
    } else if (h && n && typeof h === 'object' && typeof n === 'object') {
      for (const k of Object.keys(h)) { if (!(k in n)) console.log(`LOST    ${file} ${path}.${k}`); else walk(h[k], n[k], `${path}.${k}`); }
      for (const k of Object.keys(n)) if (!(k in h)) console.log(`NEW     ${file} ${path}.${k}`);
    } else if (JSON.stringify(h) !== JSON.stringify(n)) console.log(`CHANGED ${file} ${path}: ${JSON.stringify(h)} -> ${JSON.stringify(n)}`);
  };
  walk(head, now, '');
}
