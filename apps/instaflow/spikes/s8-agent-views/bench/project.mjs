// Projection budget (IF-6.5: page ≤ 2 ms, re-project after one change ≤ 0.5 ms, compile ≤ 1 ms, validate 500 ops ≤ 50 ms)
// and prompt-token sizes per view. Each sample set runs in a FRESH child process (S4 finding: long-lived Loro
// instances drift), several processes, pooled median / p95. Usage: node bench/project.mjs [--procs=5] [--iters=300]
import { fork } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Replica, TREE } from '../src/store.js';
import { AgentSession, Handles } from '../src/session.js';
import { Stage } from '../src/stage.js';
import { SEEDS } from '../src/seeds.js';
import { layoutScopeModel, layoutMarkup, layoutJson, canonicalJson } from '../src/views.js';
import { median, pct, sha256 } from '../src/units.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const PROCS = Number(args.procs ?? 5), ITERS = Number(args.iters ?? 300);

function worker() {
  const now = () => performance.now();
  const seed = SEEDS.big();
  const human = Replica.fromSeed(seed, 1);
  const scope = 'page:bp-page';
  const out = { cold: [], coldModel: [], warm: [], oneChange: [], structural: [], serializeOnly: [], hashOnly: [], jsonView: [], canonical: [], compile2: [], validate500: [] };
  const agent = new AgentSession(human, { peer: 2 });
  let v = agent.readView('markup', scope);
  const nodes = [...new Stage(human).part(scope).nodes.keys()].filter((n) => n.includes('-title'));
  for (let i = 0; i < ITERS; i++) {
    // cold: new stage (Loro → mirror), new handle table, model + markup + hash
    let t = now();
    const st = new Stage(agent.replica); const hs = new Handles();
    const m = layoutScopeModel(st, hs, scope); const text = layoutMarkup(m); sha256(text);
    out.cold.push(now() - t);
    t = now(); layoutScopeModel(st, hs, scope); out.coldModel.push(now() - t);
    t = now(); layoutMarkup(m); out.serializeOnly.push(now() - t);
    t = now(); sha256(text); out.hashOnly.push(now() - t);
    t = now(); layoutJson(m); out.jsonView.push(now() - t);
    // warm: full readView (header, base token, hash) with nothing changed
    t = now(); v = agent.readView('markup', scope, { changedSince: false }); out.warm.push(now() - t);
    // one property change by the human, then re-project (incremental mirror refresh from the ops since)
    const nid = nodes[i % nodes.length];
    const pd = human.part(scope); const tr = pd.getTree(TREE); const st0 = new Stage(human).part(scope);
    const nh = tr.getNodeByID(st0.get(nid).tid); const d = nh.data; d.set('spatial.y', 240 + (i % 7)); d.free(); nh.free(); pd.commit();
    t = now(); v = agent.readView('markup', scope, { changedSince: false }); out.oneChange.push(now() - t);
    // structural change (reorder) → mirror rebuild path
    const pageTid = st0.get(st0.rootId).tid; tr.move(st0.get(nid).tid, st0.get(st0.get(nid).parent).tid, 0); pd.commit();
    t = now(); v = agent.readView('markup', scope, { changedSince: false }); out.structural.push(now() - t);
    void pageTid;
    t = now(); canonicalJson(agent.stage, scope); out.canonical.push(now() - t);
    // compile + validate + stale-check (dry: propose in Ask mode, then discard)
    const titles = [...v.model.index.entries()].filter(([, e]) => e.node.attrs.name === 'card title').map(([h]) => h);
    agent.mode = 'ask';
    t = now(); const p = agent.propose({ base: v.base, ops: [{ op: 'set', id: titles[0], attrs: { size: 30 } }, { op: 'align', ids: titles.slice(0, 5), edge: 'top' }] }); out.compile2.push(p.compileMs);
    for (const f of p.forks?.values() ?? []) f.free();
    if (i % 10 === 0) {
      const ops = Array.from({ length: 500 }, (_, k) => ({ op: 'set', id: titles[k % titles.length], attrs: { size: 20 + (k % 30) } }));
      const p5 = agent.propose({ base: v.base, ops }); out.validate500.push(p5.compileMs);
      for (const f of p5.forks?.values() ?? []) f.free();
    }
    void t;
  }
  process.send(out);
  process.exit(0);
}

function tokens() {
  let enc = null;
  return import('gpt-tokenizer').then((m) => { enc = m; }).catch(() => {}).then(() => {
    const rows = [];
    const cases = [['flyer', 'page:fl-page', ['markup', 'json']], ['deck', 'doc', ['markup', 'json']], ['deck', 'page:dk-s3', ['markup', 'json']], ['reel', 'page:rl-page', ['timeline', 'markup', 'json']], ['reel', 'flow:fw-captions', ['graph']], ['big', 'page:bp-page', ['markup', 'json']]];
    for (const [seedName, scope, kinds] of cases) {
      const human = Replica.fromSeed(SEEDS[seedName](), 9);
      const agent = new AgentSession(human, { peer: 10 });
      const measure = (kind, text) => ({ seed: seedName, scope, view: kind, chars: text.length, tokChars4: Math.round(text.length / 4), tokO200k: enc ? enc.encode(text).length : null });
      for (const k of kinds) rows.push(measure(k, agent.readView(k, scope).text));
      if (!scope.startsWith('flow')) rows.push(measure('canonical-json', canonicalJson(agent.stage, scope)));
      agent.free(); human.free();
    }
    return rows;
  });
}

if (process.argv.includes('--child')) worker();
else {
  const self = fileURLToPath(import.meta.url);
  const runs = [];
  for (let p = 0; p < PROCS; p++) {
    runs.push(await new Promise((res, rej) => { const c = fork(self, ['--child', `--iters=${ITERS}`]); c.on('message', res); c.on('error', rej); }));
  }
  const keys = Object.keys(runs[0]);
  const stats = {};
  for (const k of keys) {
    const all = runs.flatMap((r) => r[k]);
    stats[k] = { n: all.length, median: +median(all).toFixed(3), p95: +pct(all, 0.95).toFixed(3), perProcessMedian: runs.map((r) => +median(r[k]).toFixed(3)) };
  }
  const tok = await tokens();
  mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../results/bench.json', import.meta.url), JSON.stringify({ node: process.version, procs: PROCS, iters: ITERS, page: '200 elements (bigPageSeed)', stats, tokens: tok }, null, 2));
  console.log('projection (ms), 200-element page, pooled over', PROCS, 'processes ×', ITERS);
  console.table(Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, { median: s.median, p95: s.p95, n: s.n }])));
  console.table(tok);
}
