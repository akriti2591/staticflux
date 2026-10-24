// Render worker (split + fast modes) and co-located editor+render worker (colo mode).
// Owns the transferred OffscreenCanvas; one RenderCore.tick per worker rAF.
import { RenderCore } from './render-core.js';
import { EditorHost } from './editor-core.js';
import { makeGfx } from './gfx.js';
import { C } from './channels.js';

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const gfx = await makeGfx(m.params.gfx, m.canvas);
      // colo: the editor lives here, behind the same SAB ports; it drains input at the start of every rAF.
      const editor = m.params.mode === 'colo' ? new EditorHost(m.sabs, m.params) : null;
      const rc = new RenderCore(m.sabs, m.params, gfx);
      self.__rc = rc; self.__ed = editor;
      const loop = (ts) => {
        if (self.__stopped) return;
        const abs = performance.timeOrigin + ts;
        if (editor) editor.step();
        rc.tick(abs);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      Atomics.store(m.sabs.ctl, C.RENDER_READY, 1);
      postMessage({ type: 'ready', info: gfx.info, colo: !!editor });
    } catch (err) { postMessage({ type: 'error', error: String(err?.stack ?? err) }); }
  } else if (m.type === 'finish') {
    // let pending onSubmittedWorkDone callbacks land, then stop and report
    await new Promise((r) => setTimeout(r, 300));
    self.__stopped = true;
    const out = { render: self.__rc.final(), editor: self.__ed ? (self.__ed.step(), self.__ed.final()) : null };
    postMessage({ type: 'final', ...out });
  }
};
