// S1 render worker: owns the transferred OffscreenCanvas and the vello_gpu/wgpu engine.
// Runs the scripted benchmark and posts timings + readbacks to the main page.
const W = 1280, H = 720;
const now = () => performance.now();
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))].toFixed(2); };
const summary = (a) => ({ n: a.length, median: pct(a, 0.5), p95: pct(a, 0.95), max: pct(a, 1), mean: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null });

let log = [];
let modRef = null;
const say = (m) => { log.push(m); postMessage({ type: 'log', msg: m }); };

self.onmessage = async (ev) => {
  const { canvas, count, maxTiles, frames, budget, variant } = ev.data;
  try {
    const out = await run(canvas, count, maxTiles, frames, budget, variant);
    postMessage({ type: 'done', out }, out.transfer);
  } catch (e) {
    try { if (modRef) say('wgpu errors: ' + modRef.take_errors().slice(0, 5).join(' | ')); } catch {}
    postMessage({ type: 'error', error: String(e && e.stack || e) + '\nLOG:\n' + log.join('\n') });
  }
};

async function run(canvas, count, maxTiles, FRAMES, BUDGET, variant) {
  const R = { init: {}, perf: {}, frames: {}, info: {} };
  const transfer = [];
  const readbacks = [];
  const t0 = now();
  const mod = await import(`./pkg/${variant}.js`);
  modRef = mod;
  R.init.import_js_ms = +(now() - t0).toFixed(2);
  const t1 = now();
  const wasm = await mod.default({ module_or_path: new URL(`./pkg/${variant}_bg.wasm`, import.meta.url) });
  R.init.wasm_fetch_compile_instantiate_ms = +(now() - t1).toFixed(2);
  const t2 = now();
  const eng = await mod.create_engine(canvas, W, H, count, maxTiles);
  R.init.create_engine_ms = +(now() - t2).toFixed(2);
  R.init.create_engine_marks = JSON.parse(eng.init_marks());
  const t3 = now();
  eng.set_camera(2400, 2600, 1);
  eng.frame_full();
  await eng.gpu_done();
  R.init.first_frame_ms = +(now() - t3).toFixed(2);
  R.init.total_to_first_frame_ms = +(now() - t0).toFixed(2);
  say(`init done ${JSON.stringify(R.init)}`);

  const errs = (where) => { const e = mod.take_errors(); if (e.length) { say(`wgpu errors @${where}: ${e.slice(0, 5).join(' | ')}`); R.info.wgpu_errors = (R.info.wgpu_errors ?? 0) + e.length; } };
  errs('init');
  const grab = async (name, meta) => {
    errs(name);
    await eng.begin_readback();
    const px = eng.finish_readback();
    readbacks.push({ name, w: W, h: H, ...meta, px });
    transfer.push(px.buffer);
  };
  const untilSharp = async (reraster = false, budget = 1000) => {
    const ts = now();
    let frames = 0, tiles = 0, st;
    for (;;) {
      st = eng.frame_tiled(budget, reraster);
      await eng.gpu_done();
      frames++; tiles += st[1];
      if (st[2] === 0) break;
      if (frames > 2000) throw new Error('never sharp');
    }
    return { ms: +(now() - ts).toFixed(2), frames, tiles };
  };

  // ---------------------------------------------------------------- correctness frames
  const cams = { A: [2400, 2600, 1], B: [600, 900, 0.5], C: [5800, 6000, 2], Z: [0, 0, 0.25] };
  for (const [k, c] of Object.entries(cams)) {
    eng.set_camera(...c);
    eng.frame_full(); await eng.gpu_done();
    await grab(`${k}_full`, { cam: c, lifted: 0, drag: [0, 0] });
    eng.clear_tiles();
    const s = await untilSharp();
    R.frames[`${k}_tiled_cold_sharp`] = s;
    await grab(`${k}_tiled`, { cam: c, lifted: 0, drag: [0, 0] });
  }
  // lifted layer correctness at camera A
  eng.set_camera(...cams.A);
  eng.clear_tiles();
  await untilSharp();
  eng.lift(100);
  eng.set_drag(37, -23);
  await untilSharp(false);
  await grab('D_tiled_lifted_cached', { cam: cams.A, lifted: 100, drag: [37, -23] });
  await untilSharp(true);
  await grab('D_tiled_lifted_reraster', { cam: cams.A, lifted: 100, drag: [37, -23] });
  eng.frame_full(); await eng.gpu_done();
  await grab('D_full_lifted', { cam: cams.A, lifted: 100, drag: [37, -23] });
  eng.drop_lift();
  eng.clear_tiles();
  say('correctness frames done');

  // ---------------------------------------------------------------- perf sequences
  const seq = async (name, setup, step, frameFn) => {
    await setup();
    const tot = [], ex = [];
    for (let i = 0; i < FRAMES; i++) {
      step(i);
      const ts = now();
      const st = frameFn();
      await eng.gpu_done();
      tot.push(now() - ts); ex.push(st);
    }
    const col = (k) => ex.map((s) => s[k]);
    const P = { frame_ms: summary(tot) };
    if (ex[0].length > 3) {
      // tiled: [cpu_ms, tiles_rendered, missing, visible, lifted_ms, tiles_cpu_ms]
      P.cpu_total_ms = summary(col(0));
      P.cpu_tile_raster_ms = summary(col(5));
      P.cpu_lifted_ms = summary(col(4));
      P.tiles_rendered = col(1).reduce((a, b) => a + b, 0);
      P.frames_with_missing_tiles = col(2).filter((x) => x > 0).length;
      P.visible_tiles_median = pct(col(3), 0.5);
      const comp = tot.filter((_, i) => ex[i][1] === 0 && ex[i][4] < 0.5);
      P.composite_only_frame_ms = summary(comp);
    } else {
      // full: [scene_encode_ms, render_submit_ms, drawn]
      P.cpu_scene_encode_ms = summary(col(0));
      P.cpu_render_submit_ms = summary(col(1));
      P.elements_drawn_median = pct(col(2), 0.5);
    }
    R.perf[name] = P;
    say(`${name}: ${JSON.stringify(P)}`);
  };
  const resetDoc = async () => { eng.clear_tiles(); };
  for (const z of [1, 0.25]) {
    const ox0 = z === 1 ? 2000 : 100, oy0 = z === 1 ? 2400 : 300;
    await seq(`pan_full_z${z}`, resetDoc, (i) => eng.set_camera(ox0 + i * 8, oy0 + i * 3, z), () => eng.frame_full());
    await seq(`pan_tiled_z${z}`, async () => { eng.clear_tiles(); eng.set_camera(ox0, oy0, z); await untilSharp(); }, (i) => eng.set_camera(ox0 + i * 8, oy0 + i * 3, z), () => eng.frame_tiled(BUDGET, false));
  }
  // zoom: continuous zoom 0.25 → 2 over FRAMES frames (tiles at nearest √2 level, scaled)
  await seq('zoom_tiled_continuous', async () => { eng.clear_tiles(); eng.set_camera(0, 0, 0.25); await untilSharp(); },
    (i) => { const z = 0.25 * Math.pow(8, i / (FRAMES - 1)); const cx = 3000, cy = 3000; eng.set_camera(cx * z - W / 2, cy * z - H / 2, z); },
    () => eng.frame_tiled(BUDGET, false));
  await seq('zoom_full_continuous', resetDoc,
    (i) => { const z = 0.25 * Math.pow(8, i / (FRAMES - 1)); const cx = 3000, cy = 3000; eng.set_camera(cx * z - W / 2, cy * z - H / 2, z); },
    () => eng.frame_full());
  // time to sharp after a discrete zoom step (each √2 level), with the per-frame budget
  R.perf.time_to_sharp = [];
  eng.clear_tiles();
  for (let k = -4; k <= 2; k++) {
    const z = Math.pow(2, k / 2), cx = 3000, cy = 3000;
    eng.set_camera(cx * z - W / 2, cy * z - H / 2, z);
    const s = await untilSharp(false, BUDGET);
    R.perf.time_to_sharp.push({ zoom: +z.toFixed(3), ...s });
  }
  say(`time_to_sharp ${JSON.stringify(R.perf.time_to_sharp)}`);
  R.info.stats_after_zoom_sweep = JSON.parse(eng.stats());

  // drag of 100 elements
  const camA = cams.A;
  await seq('drag100_full', async () => { eng.set_camera(...camA); eng.lift(100); },
    (i) => eng.set_drag(i * 2, i), () => eng.frame_full());
  eng.drop_lift();
  R.perf.lift_resharp = null;
  await seq('drag100_tiled_cached_layer', async () => {
    eng.clear_tiles(); eng.set_camera(...camA); await untilSharp();
    eng.lift(100); R.perf.lift_resharp = await untilSharp(false, BUDGET);
  }, (i) => eng.set_drag(i * 2, i), () => eng.frame_tiled(BUDGET, false));
  R.perf.drop_resharp = (eng.drop_lift(), await untilSharp(false, BUDGET));
  await seq('drag100_tiled_reraster_layer', async () => {
    eng.clear_tiles(); eng.set_camera(...camA); await untilSharp(); eng.lift(100); await untilSharp(true, 1000);
  }, (i) => eng.set_drag(i * 2, i), () => eng.frame_tiled(BUDGET, true));
  eng.drop_lift();
  // memory after a 0.25 → 2 sweep with full cache
  R.info.stats_end = JSON.parse(eng.stats());
  R.info.wasm_memory_bytes = wasm.memory.buffer.byteLength;
  say('perf done');

  // ---------------------------------------------------------------- corpus (S7)
  const corpus = [];
  const tc = now();
  for (let i = 0; i < 200; i++) {
    await eng.begin_corpus(i);
    const px = eng.finish_readback();
    corpus.push(px); transfer.push(px.buffer);
  }
  R.info.corpus_gpu_ms = +(now() - tc).toFixed(1);
  R.info.wasm_memory_bytes_end = wasm.memory.buffer.byteLength;
  return { R, readbacks, corpus, log, transfer };
}
