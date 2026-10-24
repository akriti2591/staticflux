// Node driver: each phase runs in a fresh process (fresh Wasm instance / heap). Writes results/node.json.
//   node node/run.mjs [--runs=3] [--reps=5] [--only=sizes,boot,open,gestures,merge,history,build,correctness]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sizes } from './sizes.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const runs = Number(arg('runs', 3)), reps = Number(arg('reps', 5));
const only = arg('only', 'sizes,boot,open,gestures,merge,history,milestone,build,correctness').split(',');
const run = (...a) => {
  const t = Date.now();
  const extraEnv = typeof a.at(-1) === 'object' ? a.pop() : {};
  const r = spawnSync(process.execPath, ['--expose-gc', path.join(root, 'node/bench.mjs'), ...a], { cwd: root, env: { ...process.env, REPS: String(reps), ...extraEnv }, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`phase ${a.join(' ')} failed (${r.status})`);
  console.error(`  ${a.join(' ')} done in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  return JSON.parse(r.stdout);
};
if (!fs.existsSync(path.join(root, 'fixtures/loro-pages.ids.json'))) { console.error('building fixtures…'); run('fixtures'); }
const out = { node: process.version, cpus: (await import('node:os')).cpus().length, runs, reps, at: new Date().toISOString() };
const file = path.join(root, 'results/node.json');
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const save = () => fs.writeFileSync(file, JSON.stringify({ ...prev, ...out }, null, 2));
if (only.includes('sizes')) out.sizes = await sizes();
if (only.includes('boot')) { out.boot = []; for (let i = 0; i < Math.max(5, runs); i++) out.boot.push(run('instantiate').out); save(); }
if (only.includes('open')) { out.openLoro = []; out.openYjs = []; for (let i = 0; i < runs; i++) { out.openLoro.push(run('open-loro').out); out.openYjs.push(run('open-yjs').out); save(); } }
if (only.includes('merge')) {
  out.merge = {};
  for (const N of [1000, 10000]) for (const k of ['loro-cold', 'loro-warm', 'loro-pages', 'yjs']) {
    out.merge[`${k}_${N}`] = [];
    for (let i = 0; i < runs; i++) out.merge[`${k}_${N}`].push(run('merge1', k, String(N)).out);
    save();
  }
}
if (only.includes('history')) {
  out.history = [];
  for (const [cps, ms] of [['0,10000,50000', '0'], ['100000', '0'], ['200000', '0']]) { out.history.push(run('perf', 'history', { CPS: cps, MILESTONE: ms }).out); save(); }
}
for (const p of ['gestures', 'milestone', 'build']) if (only.includes(p)) { out[p] = []; for (let i = 0; i < (p === 'gestures' ? runs : 1); i++) { out[p].push(run('perf', p).out); save(); } }
if (only.includes('correctness')) out.correctness = run('correctness').out;
save();
console.error('wrote results/node.json');
