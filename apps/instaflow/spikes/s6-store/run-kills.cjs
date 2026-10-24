// Leader-failover torture: N pages in ONE browser context share one OPFS workspace. Repeatedly kill the
// leader tab (page.close() or a renderer crash via CDP Page.crash) while every tab is committing, then verify
// with a fresh reader that every commit any client saw acknowledged is present and the head was never torn.
//
//   NODE_PATH=/opt/node-tools/node_modules node run-kills.cjs [--kills=100] [--pages=4] [--backend=sync|async]
//        [--rate=10] [--compact=150] [--slowHead] [--headed] [--real-gpu ignored]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const KILLS = Number(arg('kills', 100)), PAGES = Number(arg('pages', 4)), BACKEND = arg('backend', 'sync');
const RATE = Number(arg('rate', 10)), COMPACT = Number(arg('compact', 150));
const SLOW = process.argv.includes('--slowHead'), HEADED = process.argv.includes('--headed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '../_harness/serve-and-run.cjs'), __dirname, 'leader.html', '--serve-only']);
  const base = await new Promise((res) => srv.stdout.on('data', (d) => { const m = /at (http:\/\/\S+)\/leader\.html/.exec(String(d)); if (m) res(m[1]); }));
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext();
  const ws = `ws_kill_${BACKEND}_${Date.now()}`;
  const url = (extra = '') => `${base}/leader.html?ws=${ws}&backend=${BACKEND}&rate=${RATE}&compact=${COMPACT}${SLOW ? '&slowHead=1' : ''}${extra}`;

  const acked = new Set();
  const leaders = []; const errors = []; const probes = new Map(); const latMed = []; const latP95 = []; const leaderStats = new Map();
  const pagePeer = new Map(); let verify = null; let collateral = 0;
  await context.exposeBinding('__report', ({ page }, m) => {
    if (m.type === 'hello') pagePeer.set(page, m.peer);
    else if (m.type === 'ack') for (const id of m.ids) acked.add(id);
    else if (m.type === 'leader') leaders.push({ ...m, page });
    else if (m.type === 'stats') { probes.set(m.peer, m.probe); if (m.lat) { latMed.push(m.lat.median); latP95.push(m.lat.p95); } if (m.tornSamples?.length) errors.push({ torn: m.tornSamples }); }
    else if (m.type === 'leaderStats') leaderStats.set(m.peer, m);
    else if (m.type === 'error') errors.push(m);
    else if (m.type === 'verify') verify = m;
  });
  const pages = new Set();
  const open = async () => {
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push({ pageerror: e.message }));
    p.on('crash', () => { p.__crashed = true; });
    await p.goto(url()); pages.add(p); return p;
  };
  for (let i = 0; i < PAGES; i++) await open();
  const waitLeader = async (after, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const l = leaders.slice(after).find((x) => pages.has(x.page)); if (l) return l; await sleep(5); }
    throw new Error('no leader elected');
  };
  let cur = await waitLeader(0);
  const failover = []; const recoveryMs = []; const kills = { close: 0, crash: 0 };
  const recov = [];
  for (let i = 0; i < KILLS; i++) {
    await sleep(100 + Math.random() * 500);           // let commits + compactions run, then kill at a random point
    const victim = cur.page; const mode = i % 2 ? 'crash' : 'close'; kills[mode]++;
    const before = leaders.length; const tKill = Date.now();
    pages.delete(victim);
    if (mode === 'crash') {
      const cdp = await context.newCDPSession(victim);
      cdp.send('Page.crash').catch(() => {});
      const t = Date.now(); while (!victim.__crashed && Date.now() - t < 5000) await sleep(5);
      victim.close().catch(() => {});
    } else await victim.close();
    for (const p of [...pages]) if (p.__crashed) { pages.delete(p); collateral++; p.close().catch(() => {}); }
    open().catch((e) => errors.push({ open: String(e) }));
    cur = await waitLeader(before);
    failover.push(cur.t - tKill); recoveryMs.push(cur.rec.ms);
    recov.push({ i, mode, segments: cur.rec.segments, dirtyAfterRecovery: cur.rec.dirtyParts, headStatus: cur.rec.headStatus, gen: cur.rec.generation, tornTails: cur.rec.tornTails, staleSegments: cur.rec.staleSegments, partsMissing: cur.rec.partsMissing, partsBadDigest: cur.rec.partsBadDigest, recovered: cur.rec.recoveredIds, tmpCleaned: cur.rec.tmpCleaned });
    if ((i + 1) % 10 === 0) console.error(`kill ${i + 1}/${KILLS}: acked=${acked.size} gen=${cur.rec.generation} failover=${failover.at(-1)}ms`);
    while (pages.size < PAGES) await sleep(10);
  }
  // drain: stop generators, wait until no client has unacked commits
  await sleep(500);
  for (const p of pages) await p.evaluate(() => window.__stop()).catch(() => {});
  let drained = false;
  for (let t = 0; t < 100 && !drained; t++) {
    const ns = await Promise.all([...pages].map((p) => p.evaluate(() => window.__pending()).then((x) => x.n).catch(() => 0)));
    drained = ns.every((n) => n === 0); await sleep(100);
  }
  await sleep(300);
  const ackedFinal = new Set(acked);
  for (const p of [...pages]) await p.close();
  const vp = await context.newPage();
  await vp.goto(url('&mode=verify'));
  for (let t = 0; t < 600 && !verify; t++) await sleep(50);
  const state = new Set(verify?.ids ?? []);
  const missing = [...ackedFinal].filter((id) => !state.has(id));
  const probeTot = [...probes.values()].reduce((a, p) => ({ reads: a.reads + p.reads, ok: a.ok + p.ok, torn: a.torn + p.torn, regress: a.regress + p.regress, missing: a.missing + p.missing }), { reads: 0, ok: 0, torn: 0, regress: 0, missing: 0 });
  const gens = recov.map((r) => r.gen);
  const result = {
    config: { kills: KILLS, pages: PAGES, backend: BACKEND, rateMs: RATE, compactEveryMs: COMPACT, slowHead: SLOW, chromium: browser.version() },
    kills, collateralCrashes: collateral,
    ackedCommits: ackedFinal.size, recoveredCommits: state.size, missingAcked: missing.length, missingSample: missing.slice(0, 10),
    drained,
    recoveries: { count: recov.length, headTorn: recov.filter((r) => r.headStatus === 'torn').length, headMissing: recov.filter((r) => r.headStatus === 'missing').length,
      partsMissing: recov.reduce((a, r) => a + r.partsMissing, 0), partsBadDigest: recov.reduce((a, r) => a + r.partsBadDigest, 0),
      tornLogTails: recov.reduce((a, r) => a + r.tornTails, 0), staleSegmentsCleaned: recov.reduce((a, r) => a + r.staleSegments, 0),
      tmpHeadsCleaned: recov.reduce((a, r) => a + r.tmpCleaned, 0), generationMonotonic: gens.every((g, i) => i === 0 || g >= gens[i - 1]), finalGeneration: verify?.rec.generation },
    finalVerify: verify ? { headStatus: verify.rec.headStatus, liveSegments: verify.rec.segments, recoveryMs: verify.rec.ms, tornTails: verify.rec.tornTails, partsMissing: verify.rec.partsMissing, partsBadDigest: verify.rec.partsBadDigest } : null,
    headProbe: probeTot,
    failoverMs: { median: q(failover, 0.5), p95: q(failover, 0.95), max: Math.max(...failover) },
    recoveryMs: { median: q(recoveryMs, 0.5), p95: q(recoveryMs, 0.95), max: Math.max(...recoveryMs) },
    commitAckLatencyMs: { medianOfPerSecondMedians: q(latMed, 0.5), p95OfPerSecondP95: q(latP95, 0.95) },
    leaderDutyCycle: q([...leaderStats.values()].map((s) => s.dutyCycle), 0.5),
    compactionsPerLeader: q([...leaderStats.values()].map((s) => s.compactions), 0.5), leaderStatsLast: [...leaderStats.values()].slice(-5).map(({ generation, compactions, appended, casConflicts }) => ({ generation, compactions, appended, casConflicts })),
    errors: errors.slice(0, 20), errorCount: errors.length,
    pass: missing.length === 0 && probeTot.torn === 0 && probeTot.regress === 0 && recov.every((r) => r.headStatus !== 'torn' && r.partsMissing === 0 && r.partsBadDigest === 0) && !!verify,
  };
  console.log(JSON.stringify(result, null, 2));
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', `kills-${BACKEND}${SLOW ? '-slowhead' : ''}.json`), JSON.stringify({ ...result, recoveriesDetail: recov }, null, 2));
  await browser.close(); srv.kill();
})().catch((e) => { console.error(e); process.exit(1); });
