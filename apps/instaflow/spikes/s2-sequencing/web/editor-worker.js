// Editor worker: blocks on the control WAKE word (Atomics.wait), applies input batches as soon as they land.
import { EditorHost } from './editor-core.js';
import { C } from './channels.js';

self.onmessage = (e) => {
  const { sabs, params } = e.data;
  const host = new EditorHost(sabs, params);
  const ctl = sabs.ctl;
  Atomics.store(ctl, C.EDITOR_READY, 1);
  postMessage({ type: 'ready' });
  for (;;) {
    const w = Atomics.load(ctl, C.WAKE);
    host.step();
    if (Atomics.load(ctl, C.STOP)) break;
    Atomics.wait(ctl, C.WAKE, w, 50);
  }
  host.step();
  const f = host.final();
  postMessage({ type: 'final', final: f }, [f.x.buffer, f.y.buffer, f.alive.buffer]);
};
