const log = [];
const now = () => performance.now();
self.onmessage = async (ev) => {
  try {
    const mod = await import('./pkg/gpu.js');
    await mod.default({ module_or_path: new URL('./pkg/gpu_bg.wasm', import.meta.url) });
    const e = (w) => log.push(`${w}: errs=${JSON.stringify(mod.take_errors())} t=${now().toFixed(0)}`);
    const eng = await mod.create_engine(ev.data.canvas, 1280, 720, ev.data.count, 64);
    e('created');
    await new Promise((r) => setTimeout(r, 500)); e('after 500ms');
    eng.set_camera(2400, 2600, 1);
    const mode = +(new URLSearchParams(self.location.search).get('mode') ?? 9);
    for (const m of [0, 1, 2]) { eng.frame_debug(m); await eng.gpu_done(); e('debug mode ' + m); }
    const st = eng.frame_full(); e('frame_full submitted ' + st);
    await eng.gpu_done(); e('gpu_done');
    await eng.begin_readback(); const px = eng.finish_readback(); e('readback ' + px.length + ' ' + px.slice(0, 8));
    for (let i = 0; i < 3; i++) { const t = now(); eng.frame_full(); await eng.gpu_done(); e(`frame ${i} ${(now() - t).toFixed(1)}ms`); }
    postMessage({ log });
  } catch (err) { log.push('ERR ' + err); postMessage({ log }); }
};
