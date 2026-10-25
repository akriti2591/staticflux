// Scripted gestures G-1…G-6 + simulated remote edits, generated against a single-threaded oracle
// (the same reducer, applied in order, no threads). For every input seq s the oracle records the display hash
// and camera that a correct pipeline must show after consuming exactly inputs ≤ s.
import { Editor, T, F, K, VIEW_W, VIEW_H, ZMIN, ZMAX, toDocX, toDocY, SIZE, N, PITCH, COLS } from './model.js';

export const GESTURES = ['G1-pan', 'G2-zoom', 'G3-drag1', 'G4-drag100', 'G5-marquee', 'G6-nudge'];
const MIX = [0.18, 0.14, 0.26, 0.10, 0.12, 0.20];

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function generate(nGestures, seed = 1) {
  const R = rng(seed), ri = (a, b) => a + Math.floor(R() * (b - a + 1)), sg = () => (R() < 0.5 ? -1 : 1);
  const o = new Editor();
  const ev = [];            // {type,x,y,dx,dy,flags,g}  g = gesture index
  const hashes = [o.displayHash()], cams = [o.cam.tx, o.cam.ty, o.cam.z];
  const kinds = [0]; // gesture kind per seq
  const counts = Object.fromEntries(GESTURES.map((g) => [g, 0]));
  const stat = { remoteMoves: 0, remoteDels: 0, remoteMidDrag: 0, escCancels: 0, missedTargets: 0 };
  let gk = 0;
  const push = (type, x = 0, y = 0, dx = 0, dy = 0, flags = 0) => {
    const r = { seq: ev.length + 1, type, x, y, dx, dy, flags };
    o.apply(r); ev.push({ type, x, y, dx, dy, flags, k: gk });
    hashes.push(o.displayHash()); cams.push(o.cam.tx, o.cam.ty, o.cam.z); kinds.push(gk);
  };
  const docCenter = (COLS * PITCH) / 2;
  const viewCenter = () => [toDocX(o.cam, VIEW_W / 2), toDocY(o.cam, VIEW_H / 2)];
  const randScreen = () => [ri(20, VIEW_W - 20), ri(20, VIEW_H - 20)];
  const findHit = () => { for (let t = 0; t < 40; t++) { const [x, y] = randScreen(); if (o.index.hit(toDocX(o.cam, x), toDocY(o.cam, y), o.x, o.y) >= 0) return [x, y]; } return null; };
  const findEmpty = () => { for (let t = 0; t < 40; t++) { const [x, y] = randScreen(); if (o.index.hit(toDocX(o.cam, x), toDocY(o.cam, y), o.x, o.y) < 0) return [x, y]; } return null; };
  const randAlive = () => { for (;;) { const i = ri(0, N - 1); if (o.alive[i]) return i; } };
  const pan = (n) => { for (let i = 0; i < n; i++) { const [cx, cy] = viewCenter(); const bx = cx < docCenter ? 1 : -1, by = cy < docCenter ? 1 : -1; push(T.WHEEL, ri(0, VIEW_W), ri(0, VIEW_H), (R() < 0.7 ? bx : -bx) * ri(10, 120), (R() < 0.7 ? by : -by) * ri(10, 120), 0); } };

  for (let gi = 0; gi < nGestures; gi++) {
    let k = 0; { let u = R(), acc = 0; for (; k < MIX.length - 1; k++) { acc += MIX[k]; if (u < acc) break; } }
    gk = k; counts[GESTURES[k]]++;
    // remote edits between gestures (a simulated CRDT peer; delivered through the same ordered channel)
    if (R() < 0.25) { push(T.REMOTE_MOVE, randAlive(), 0, sg() * ri(1, 30), sg() * ri(1, 30)); stat.remoteMoves++; }
    if (R() < 0.01) { push(T.REMOTE_DEL, randAlive()); stat.remoteDels++; }
    switch (k) {
      case 0: pan(ri(3, 6)); break;
      case 1: { const n = ri(2, 4); const x = ri(100, VIEW_W - 100), y = ri(100, VIEW_H - 100); const dir = o.cam.z > 2 ? 1 : o.cam.z < 0.4 ? -1 : sg(); for (let i = 0; i < n; i++) push(T.WHEEL, x, y, 0, dir * ri(20, 90), F.CTRL); break; }
      case 2: case 3: {
        const p = findHit(); if (!p) { stat.missedTargets++; pan(2); break; }
        let [x, y] = p; const flags = k === 3 ? F.ALT : 0;
        push(T.DOWN, x, y, 0, 0, flags);
        const n = ri(3, 8);
        for (let i = 0; i < n; i++) {
          x += ri(-40, 40); y += ri(-40, 40); push(T.MOVE, x, y, 0, 0, flags);
          if (o.g && R() < 0.04) { const tg = o.g.targets[ri(0, o.g.targets.length - 1)]; push(T.REMOTE_MOVE, tg, 0, sg() * ri(1, 20), sg() * ri(1, 20)); stat.remoteMoves++; stat.remoteMidDrag++; }
          if (o.g && R() < 0.004) { const tg = o.g.targets[ri(0, o.g.targets.length - 1)]; push(T.REMOTE_DEL, tg); stat.remoteDels++; stat.remoteMidDrag++; }
        }
        if (o.g && R() < 0.05) { push(T.KEY, K.ESC); stat.escCancels++; }
        push(T.UP, x, y, 0, 0, flags);
        break;
      }
      case 4: {
        const p = findEmpty(); if (!p) { stat.missedTargets++; pan(2); break; }
        const [x0, y0] = p; push(T.DOWN, x0, y0);
        const n = ri(3, 6), mx = Math.min(240 * o.cam.z, 300), sx = sg(), sy = sg();
        let x = x0, y = y0;
        for (let i = 1; i <= n; i++) { x = Math.round(x0 + sx * (mx * i) / n); y = Math.round(y0 + sy * (mx * 0.7 * i) / n); push(T.MOVE, x, y); }
        push(T.UP, x, y);
        break;
      }
      case 5: { const n = ri(1, 3); for (let i = 0; i < n; i++) push(T.KEY, ri(1, 4), 0, 0, 0, R() < 0.3 ? F.SHIFT : 0); break; }
    }
  }
  return {
    events: ev, hashes: Uint32Array.from(hashes), cams: Float64Array.from(cams), kinds: Uint8Array.from(kinds), counts, stat,
    final: { x: o.x, y: o.y, alive: o.alive, docVersion: o.docVersion, commits: o.commits, cancels: o.cancels, hash: o.committedHash(), errors: o.errors.length },
  };
}
