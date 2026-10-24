// Prints the headline numbers (median / p95 across runs) from results/node.json and results/browser.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const st = (xs) => { xs = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!xs.length) return '–'; const q = (p) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))]; return `${q(0.5).toFixed(0)} / ${q(0.95).toFixed(0)} (n=${xs.length})`; };
for (const name of ['node', 'browser']) {
  const f = path.join(root, `results/${name}.json`);
  if (!fs.existsSync(f)) continue;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  const R = r.result ?? r;
  console.log(`\n## ${name}`);
  const ol = R.openLoro ?? [], oy = R.openYjs ?? [];
  const row = (k, v) => console.log(`| ${k} | ${v} |`);
  row('loro import (lazy), first in fresh instance ms', st(ol.map((o) => o.first.importMs)));
  row('loro import + world cache ms (first)', st(ol.map((o) => o.first.importPlusCacheMs)));
  row('loro import + world cache ms (repeat)', st(ol.flatMap((o) => [o.repeat.importPlusCacheMs.median])));
  row('loro first edit+commit after open ms', st(ol.map((o) => o.first.firstEditCommitMs)));
  row('loro full toJSON materialize ms (first)', st(ol.map((o) => o.first.fullToJSONMs)));
  row('loro import + full materialize (repeat) ms', st(ol.map((o) => o.repeat.importPlusFullMs.median)));
  row('loro 50 page parts import + materialize 1 page ms', st(ol.map((o) => o.partitioned.import50PagesPlusMaterialize1Ms.median)));
  row('loro mem after lazy+cache: jsHeap / wasm MB', st(ol.map((o) => o.mem.afterLazyPlusCache.jsHeapMB)) + ' / ' + st(ol.map((o) => o.mem.afterLazyPlusCache.wasmMB)));
  row('loro mem after full: jsHeap / wasm MB', st(ol.map((o) => o.mem.afterFullMaterialize.jsHeapMB)) + ' / ' + st(ol.map((o) => o.mem.afterFullMaterialize.wasmMB)));
  row('loro UA memory lazy / full MB', st(ol.map((o) => o.mem.uaLazy?.totalMB)) + ' / ' + st(ol.map((o) => o.mem.uaFull?.totalMB)));
  row('yjs applyUpdate ms (first)', st(oy.map((o) => o.first.importMs)));
  row('yjs applyUpdate + materialize ms (first)', st(oy.map((o) => o.first.totalMs)));
  row('yjs mem after: jsHeap MB', st(oy.map((o) => o.mem.after.jsHeapMB)));
  row('yjs UA memory MB', st(oy.map((o) => o.mem.ua?.totalMB)));
  for (const [k, v] of Object.entries(R.merge ?? {})) row(`merge ${k} import ms`, st(v.map((o) => o.importMs ?? o.importMsTotal)) + `; reverse ${st(v.map((o) => o.reverseMs ?? o.reverseMsTotal))}; converged ${v.map((o) => o.converged).join(',')}; updKB ${v[0]?.updateKB}` + (v[0]?.warmupMs != null ? `; warmup ${st(v.map((o) => o.warmupMs))}` : '') + (v[0]?.worstPartMs != null ? `; worst part ${st(v.map((o) => o.worstPartMs))}` : '') + (v[0]?.diffSinceBaseMs != null ? `; diff ${st(v.map((o) => o.diffSinceBaseMs))}` : '') + (v[0]?.opsSinceBaseJsonMs != null ? `; opsSinceJSON ${st(v.map((o) => o.opsSinceBaseJsonMs))}` : ''));
  const g = (R.gestures ?? []).map((x) => x.gestures ?? x.out?.gestures).filter(Boolean);
  if (g.length) for (const k of Object.keys(g[0])) row(`gesture ${k}`, JSON.stringify(g[0][k]) + (g[0][k].ms !== undefined ? ` ms ${st(g.map((x) => x[k].ms))}` : ''));
  const gy = (R.gestures ?? []).map((x) => x.gesturesYjs ?? x.out?.gesturesYjs).filter(Boolean);
  if (gy.length) row('gestures yjs', JSON.stringify(gy[0]));
  for (const h of R.history ?? []) { const o = h.out ?? h; for (const row2 of o.historyGrowth ?? []) console.log('| history | ' + JSON.stringify(row2) + ' |'); if (o.milestoneFork) console.log('| milestoneFork | ' + JSON.stringify(o.milestoneFork) + ' |'); }
  if (R.boot) console.log('| boot | ' + JSON.stringify(R.boot) + ' |');
  if (R.build) console.log('| build | ' + JSON.stringify(R.build) + ' |');
}
