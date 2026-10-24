// S2 main thread: DOM input capture → binary input ring; scripted gesture driver; end-of-run verification.
import { T, F, K, N } from './model.js';
import { generate, GESTURES } from './script.js';
import { C, makeControl, makeInputRing, makeViewFrame, makeDeltaRing, InputWriter, absNow } from './channels.js';

const q = new URLSearchParams(location.search);
const P = {
  mode: q.get('mode') ?? 'split',            // split | fast | colo
  gfx: q.get('gfx') ?? 'webgpu',             // webgpu | 2d | none
  gestures: +(q.get('gestures') ?? 10000),
  pace: +(q.get('pace') ?? 4),               // ms between input events (0 = burst)
  burst: +(q.get('burst') ?? 20),
  seed: +(q.get('seed') ?? 1),
  naive: +(q.get('naive') ?? 0),             // 1 = render ignores the docVersion rule (detector validation)
  seqlock: +(q.get('seqlock') ?? 1),         // 0 = read view frames without the seqlock (torn-read validation)
  gapEvery: +(q.get('gapEvery') ?? 0),       // drop every Nth delta (E-1 gap → resnapshot)
  editorLoad: +(q.get('editorLoad') ?? 0),   // ms of busy work per editor batch
  align: q.get('align') ?? 'raf',            // raf = dispatch in main rAF (Chrome rAF-aligns pointermove/wheel) | none = timer-paced
  present: q.get('present') ?? 'raf',        // raf = render draws in its rAF | eager = draws on wake-up (Atomics.waitAsync)
  eagerCap: +(q.get('eagerCap') ?? 0),       // eager: max draws per vsync interval (0 = unlimited)
  eagerDelay: +(q.get('eagerDelay') ?? 0),   // eager: ms to wait after a wake-up before drawing (burst coalescing)
  rafDraw: +(q.get('rafDraw') ?? 1),         // 0 (with eager) = never draw from rAF, to prove eager frames reach the screen
  latch: +(q.get('latch') ?? 0),             // ms the render worker may wait in rAF for the editor to catch up
};
const out = document.getElementById('out');
const say = (s) => { out.textContent += s + '\n'; };
const pct = (a, p) => { if (!a.length) return null; const s = Float64Array.from(a).sort(); return +s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))].toFixed(2); };
const stats = (a) => ({ n: a.length, median: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: pct(a, 1) });

async function run() {
  const t0 = performance.now();
  const S = generate(P.gestures, P.seed);
  const M = S.events.length;
  const genMs = performance.now() - t0;
  say(`params ${JSON.stringify(P)}\nscript: ${P.gestures} gestures, ${M} input records, oracle ${genMs.toFixed(0)} ms`);

  const sabs = { ctl: makeControl(), input: makeInputRing(), view: makeViewFrame(), delta: makeDeltaRing() };
  if (P.mode === 'fast') Atomics.store(sabs.input.hdr, 3, 1); // second reader (render) participates in flow control
  const iw = new InputWriter(sabs.input, sabs.ctl);
  const tIn = new Float64Array(M + 1), typeOf = new Uint8Array(M + 1), flagsOf = new Uint8Array(M + 1);
  let seq = 0;
  const rec = (type, x, y, dx, dy, flags) => {
    const t = absNow(); seq++; tIn[seq] = t; typeOf[seq] = type; flagsOf[seq] = flags;
    iw.push(seq, t, type, x, y, dx, dy, flags);
  };

  // ---- capture: real DOM listeners on the canvas (synthetic events are dispatched to it) ----
  const cv = document.getElementById('cv');
  const fl = (e) => (e.shiftKey ? F.SHIFT : 0) | (e.altKey ? F.ALT : 0) | (e.ctrlKey ? F.CTRL : 0);
  const ptr = (type) => (e) => { const list = e.getCoalescedEvents?.(); for (const p of (list && list.length ? list : [e])) rec(type, p.clientX, p.clientY, 0, 0, fl(e)); };
  cv.addEventListener('pointerdown', ptr(T.DOWN));
  cv.addEventListener('pointermove', ptr(T.MOVE));
  cv.addEventListener('pointerup', ptr(T.UP));
  cv.addEventListener('wheel', (e) => { e.preventDefault(); rec(T.WHEEL, e.clientX, e.clientY, e.deltaX, e.deltaY, fl(e)); }, { passive: false });
  const KEYS = { ArrowLeft: K.LEFT, ArrowRight: K.RIGHT, ArrowUp: K.UP, ArrowDown: K.DOWN, Escape: K.ESC };
  const KEYN = Object.fromEntries(Object.entries(KEYS).map(([a, b]) => [b, a]));
  cv.addEventListener('keydown', (e) => { if (KEYS[e.key]) { e.preventDefault(); rec(T.KEY, KEYS[e.key], 0, 0, 0, fl(e)); } });

  // ---- workers ----
  const off = cv.transferControlToOffscreen();
  const rw = new Worker('./render-worker.js', { type: 'module' });
  const ew = P.mode === 'colo' ? null : new Worker('./editor-worker.js', { type: 'module' });
  const msg = (w, type) => new Promise((res, rej) => { const h = (e) => { if (e.data.type === type) { w.removeEventListener('message', h); res(e.data); } else if (e.data.type === 'error') rej(new Error(e.data.error)); }; w.addEventListener('message', h); });
  const editorFinal = ew ? msg(ew, 'final') : null;
  const rr = msg(rw, 'ready');
  rw.postMessage({ type: 'init', canvas: off, sabs, params: P }, [off]);
  if (ew) { const er = msg(ew, 'ready'); ew.postMessage({ sabs, params: P }); await er; }
  const ready = await rr;
  say(`render ready: ${JSON.stringify(ready.info)} colo=${ready.colo}`);
  await new Promise((r) => setTimeout(r, 500)); // let the first frames (pipeline compile) settle

  // ---- drive the script ----
  const ev = S.events;
  const dispatch = (e) => {
    const o = { clientX: e.x, clientY: e.y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, shiftKey: !!(e.flags & F.SHIFT), altKey: !!(e.flags & F.ALT), ctrlKey: !!(e.flags & F.CTRL) };
    switch (e.type) {
      case T.DOWN: cv.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 })); break;
      case T.MOVE: cv.dispatchEvent(new PointerEvent('pointermove', { ...o, buttons: 1 })); break;
      case T.UP: cv.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); break;
      case T.WHEEL: cv.dispatchEvent(new WheelEvent('wheel', { ...o, deltaX: e.dx, deltaY: e.dy, deltaMode: 0 })); break;
      case T.KEY: cv.dispatchEvent(new KeyboardEvent('keydown', { key: KEYN[e.x], bubbles: true, cancelable: true, shiftKey: !!(e.flags & F.SHIFT) })); break;
      default: rec(e.type, e.x, e.y, e.dx, e.dy, e.flags); // simulated remote CRDT update (not DOM input)
    }
  };
  const tStart = performance.now(), mainRaf = [], mainCbLag = [];
  await new Promise((done) => {
    let i = 0;
    const tick = (ts) => {
      if (P.align === 'raf') { mainRaf.push(performance.timeOrigin + ts); mainCbLag.push(performance.now() - ts); }
      iw.flush();
      const now = performance.now();
      let k = 0;
      while (i < M && (P.pace === 0 ? k < P.burst : tStart + i * P.pace <= now)) { dispatch(ev[i++]); k++; }
      if (i < M) { if (P.align === 'raf') requestAnimationFrame(tick); else setTimeout(tick, P.pace === 0 ? 0 : Math.max(0, tStart + i * P.pace - performance.now())); }
      else done();
      if ((i & 4095) === 0) out.dataset.progress = String(i);
    };
    if (P.align === 'raf') requestAnimationFrame(tick); else tick();
  });
  const driveMs = performance.now() - tStart;
  if (seq !== M) throw new Error(`captured ${seq} records, script has ${M} (event capture mismatch)`);
  // wait until the last input is on screen
  const tw = performance.now();
  while (iw.pending.length || Atomics.load(sabs.ctl, C.DRAWN_IN) < M || (P.mode === 'fast' && Atomics.load(sabs.ctl, C.DRAWN_CAM) < M)) {
    iw.flush();
    if (performance.now() - tw > 20000) { say('TIMEOUT waiting for last frame'); break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  Atomics.store(sabs.ctl, C.STOP, 1); Atomics.add(sabs.ctl, C.WAKE, 1); Atomics.notify(sabs.ctl, C.WAKE);
  const rf = msg(rw, 'final'); rw.postMessage({ type: 'finish' });
  const R = await rf;
  const E = ew ? (await editorFinal).final : R.editor;
  return analyze(S, M, tIn, typeOf, flagsOf, R.render, E, { genMs, driveMs, maxInputPending: iw.maxPending, mainRaf, mainCbLag });
}

function analyze(S, M, tIn, typeOf, flagsOf, Rn, E, extra) {
  const L = Rn.log, nf = L.viewSeq.length;
  // ---- correctness: every drawn frame equals the oracle display at its consumed input seq ----
  let hashBad = 0, camBad = 0, mono = 0, snapBack = 0, doubleDraw = 0, otherBad = 0, expBad = 0;
  const firstBad = [];
  for (let j = 0; j < nf; j++) {
    const s = L.inSeq[j], c = L.camSeq[j];
    if (j && (L.viewSeq[j] < L.viewSeq[j - 1] || s < L.inSeq[j - 1] || c < L.camSeq[j - 1] || L.docV[j] < L.docV[j - 1] || (L.viewSeq[j] === L.viewSeq[j - 1] && c === L.camSeq[j - 1]))) mono++;
    if (L.hash[j] !== L.exp[j]) expBad++;
    if (L.hash[j] !== S.hashes[s]) {
      hashBad++;
      if (L.docV[j] > L.fDocV[j]) doubleDraw++; else if (L.docV[j] < L.fDocV[j]) snapBack++; else otherBad++;
      if (firstBad.length < 3) firstBad.push({ frame: j, inSeq: s, docV: L.docV[j], frameDocV: L.fDocV[j] });
    }
    if (L.tx[j] !== S.cams[3 * c] || L.ty[j] !== S.cams[3 * c + 1] || L.z[j] !== S.cams[3 * c + 2]) camBad++;
  }
  const eq = (a, b) => { for (let i = 0; i < N; i++) if (a.x[i] !== b.x[i] || a.y[i] !== b.y[i] || a.alive[i] !== b.alive[i]) return false; return true; };
  const lastJ = nf - 1;
  const correctness = {
    framesDrawn: nf,
    framesNotEqualOracle: hashBad, snapBackFrames: snapBack, doubleDrawFrames: doubleDraw, otherMismatch: otherBad,
    framesRenderHashNotEqualEditorHash: expBad,
    cameraMismatchFrames: camBad,
    generationNonMonotonic: mono,
    firstBad,
    overlayAfterCommit: Rn.counters.overlayAfterCommit,
    finalEditorEqualsOracle: eq(E, S.final), finalRenderEqualsOracle: eq(Rn, S.final),
    finalHash: { oracle: S.final.hash, editor: E.finalHash, render: Rn.finalHash },
    lastFrame: { inSeq: L.inSeq[lastJ], camSeq: L.camSeq[lastJ], equalsOracleFinalDisplay: L.hash[lastJ] === S.hashes[M] && L.inSeq[lastJ] === M },
    docVersion: { oracle: S.final.docVersion, editor: E.docVersion, render: Rn.docVersion },
    commits: { oracle: S.final.commits, editor: E.commits }, cancels: { oracle: S.final.cancels, editor: E.cancels },
    typedErrors: { oracle: S.final.errors, editor: E.errors, sample: E.errorSample },
    render: Rn.counters,
    editor: { viewFrames: E.viewFrames, deltasWritten: E.deltasWritten, deltasDroppedByFault: E.dropped, snapshots: E.snapshots, batches: E.batches, maxBatch: E.maxBatch },
  };
  correctness.pass = hashBad === 0 && camBad === 0 && mono === 0 && correctness.finalEditorEqualsOracle && correctness.finalRenderEqualsOracle && correctness.lastFrame.equalsOracleFinalDisplay && Rn.counters.tornAccepted === 0 && Rn.counters.orderViolations === 0;

  // ---- latency: each DOM input → first drawn frame that includes it ----
  const fast = P.mode === 'fast';
  const groups = { all: [], wheelPan: [], wheelZoom: [], pointer: [], key: [] };
  const gDraw = { all: [], wheelPan: [], wheelZoom: [], pointer: [] }, gEd = [], gGpu = [];
  const jIn = new Int32Array(M + 1).fill(-1);
  for (const which of ['in', 'cam']) {
    let j = 0, run = -1;
    const seqs = which === 'in' ? L.inSeq : L.camSeq;
    for (let s = 1; s <= M; s++) {
      const isWheel = typeOf[s] === T.WHEEL;
      if ((which === 'cam') !== (fast && isWheel)) continue;
      while (j < nf && Math.max(run, seqs[j]) < s) { run = Math.max(run, seqs[j]); j++; }
      if (j < nf) jIn[s] = j;
    }
  }
  for (let s = 1; s <= M; s++) {
    const t = typeOf[s], j = jIn[s];
    if (t >= T.REMOTE_MOVE || j < 0 || !L.tPresent[j]) continue;
    const lat = L.tPresent[j] - tIn[s], ld = L.tSubmit[j] - tIn[s];
    const g = t === T.WHEEL ? (flagsOf[s] & F.CTRL ? 'wheelZoom' : 'wheelPan') : t === T.KEY ? 'key' : 'pointer';
    groups.all.push(lat); groups[g].push(lat);
    gDraw.all.push(ld); if (gDraw[g]) gDraw[g].push(ld);
    if (!(fast && t === T.WHEEL)) gEd.push(L.tWritten[j] - tIn[s]);
    if (L.tGpu[j]) gGpu.push(L.tGpu[j] - tIn[s]);
  }
  const frameMs = pct(Rn.tickDt, 0.5);
  const lat = {
    rafIntervalMs: stats(Rn.tickDt), budgetMs: frameMs != null ? +(frameMs + 4).toFixed(2) : null,
    inputToPresentEst: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, stats(v)])),
    inputToSubmit: Object.fromEntries(Object.entries(gDraw).map(([k, v]) => [k, stats(v)])),
    inputToViewFrameWritten: stats(gEd), inputToGpuDone: stats(gGpu),
    drawCpuMs: stats(L.tSubmit.map((x, i) => x - L.tDraw[i])),
    rafToDrawStartMs: stats(L.tDraw.map((x, i) => x - L.tRaf[i])),
  };
  // phase of worker rAF relative to the latest main rAF before it (aligned dispatch only)
  const mr = extra.mainRaf; delete extra.mainRaf;
  if (mr.length) { const ph = []; let k = 0; for (const t of Rn.tickAbs) { while (k + 1 < mr.length && mr[k + 1] <= t) k++; if (mr[k] <= t && t - mr[k] < 40) ph.push(t - mr[k]); } lat.workerRafAfterMainRafMs = stats(ph); }
  lat.latchWaitMs = stats(Rn.latchWaits);
  lat.callbackAfterFrameTs = { main: stats(extra.mainCbLag), worker: stats(Rn.cbLag) }; delete extra.mainCbLag;
  lat.inputToPresentFrames = groups.all.length ? { median: +(lat.inputToPresentEst.all.median / frameMs).toFixed(2), p95: +(lat.inputToPresentEst.all.p95 / frameMs).toFixed(2) } : null;
  lat.p95WithinBudget = lat.inputToPresentEst.all.p95 != null && lat.inputToPresentEst.all.p95 <= lat.budgetMs;
  // E-4 exposure: pointerdowns that happened while the displayed camera lagged a wheel event already sent
  let downs = 0, stale = 0, jj = 0, lastWheel = 0;
  for (let s = 1; s <= M; s++) {
    if (typeOf[s] === T.WHEEL) lastWheel = s;
    if (typeOf[s] !== T.DOWN) continue;
    downs++;
    while (jj + 1 < nf && L.tPresent[jj + 1] && L.tPresent[jj + 1] <= tIn[s]) jj++;
    if (L.camSeq[jj] < lastWheel) stale++;
  }
  return { params: P, gestures: S.counts, records: M, scriptStats: S.stat, correctness, latency: lat, e4: { pointerdowns: downs, displayedCameraStaleAtDown: stale }, gfx: Rn.gfx, extra, ua: navigator.userAgent };
}

run().then((r) => {
  window.__result = r;
  say(JSON.stringify({ pass: r.correctness.pass, framesNotEqualOracle: r.correctness.framesNotEqualOracle, p50: r.latency.inputToPresentEst.all.median, p95: r.latency.inputToPresentEst.all.p95, budget: r.latency.budgetMs }, null, 1));
}).catch((e) => { window.__result = { error: String(e?.stack ?? e) }; say('ERROR ' + e); });
