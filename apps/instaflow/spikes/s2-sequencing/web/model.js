// S2 shared model: document, camera math, hit index, display hash and the tool reducer.
// Used by: the oracle (main thread, single-threaded reference), the editor worker, and the co-located worker.
// The render side does NOT use the reducer: it rebuilds the display from scene deltas + view-state frames.

export const N = 10_000;          // elements
export const GROUP = 100;         // alt+pointerdown drags the element's group of 100 (G-4)
export const PITCH = 60, SIZE = 40, COLS = 100;
export const VIEW_W = 1280, VIEW_H = 720;
export const ZMIN = 0.25, ZMAX = 4;
export const MAX_IDS = 1024;      // max overlay targets / selection ids per view-state frame

// Input record types (input ring)
export const T = { DOWN: 1, MOVE: 2, UP: 3, WHEEL: 4, KEY: 5, REMOTE_MOVE: 6, REMOTE_DEL: 7 };
// flags bits
export const F = { SHIFT: 1, ALT: 2, CTRL: 4 };
// key codes in records
export const K = { LEFT: 1, RIGHT: 2, UP: 3, DOWN: 4, ESC: 5 };

// ---- camera: screen = doc * z + t ----
export function camPan(cam, dx, dy) { cam.tx -= dx; cam.ty -= dy; }
export function camZoom(cam, px, py, wheelDy) {
  const z1 = Math.min(ZMAX, Math.max(ZMIN, cam.z * Math.exp(-wheelDy * 0.01)));
  const f = z1 / cam.z;
  cam.tx = px - (px - cam.tx) * f; cam.ty = py - (py - cam.ty) * f; cam.z = z1;
}
/** Apply a wheel record to a camera. Same function on editor, oracle and the render fast path (bit-identical). */
export function camApplyWheel(cam, x, y, dx, dy, flags) {
  if (flags & F.CTRL) camZoom(cam, x, y, dy); else camPan(cam, dx, dy);
}
export const toDocX = (cam, sx) => (sx - cam.tx) / cam.z;
export const toDocY = (cam, sy) => (sy - cam.ty) / cam.z;

// ---- hashing (additive set hash so overlays/deltas update it incrementally) ----
export function mix(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}
export const SEL_SALT = 0x5e1ec7, MQ_SALT = 0x3a7c11;
/** Hash of the view-only part: selection chrome + marquee. Shared by editor and render. */
export function viewPartHash(sel, nSel, mq) {
  let h = mix(nSel, SEL_SALT, 1);
  for (let i = 0; i < nSel; i++) h = (h + mix(sel[i], SEL_SALT, 2)) >>> 0;
  if (mq) h = (h + mix(mix(mq[0], mq[1], MQ_SALT), mq[2], mq[3])) >>> 0;
  return h;
}

export function initialLayout() {
  const x = new Int32Array(N), y = new Int32Array(N), alive = new Uint8Array(N).fill(1);
  for (let i = 0; i < N; i++) { x[i] = (i % COLS) * PITCH; y[i] = Math.floor(i / COLS) * PITCH; }
  return { x, y, alive };
}
export function color(i) { return (mix(i, 17, 31) & 0x00ffffff) | 0xff000000; }

// ---- uniform grid spatial index (stand-in for rbush) ----
const CELL = 128;
const ckey = (cx, cy) => (cx + 4096) * 8192 + (cy + 4096);
export class GridIndex {
  constructor() { this.cells = new Map(); }
  _cells(x, y, cb) {
    const x0 = Math.floor(x / CELL), x1 = Math.floor((x + SIZE) / CELL), y0 = Math.floor(y / CELL), y1 = Math.floor((y + SIZE) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) cb(ckey(cx, cy));
  }
  insert(id, x, y) { this._cells(x, y, (k) => { let s = this.cells.get(k); if (!s) this.cells.set(k, (s = new Set())); s.add(id); }); }
  remove(id, x, y) { this._cells(x, y, (k) => { this.cells.get(k)?.delete(id); }); }
  /** Topmost (highest id) alive element containing doc point, or -1. */
  hit(px, py, X, Y) {
    const s = this.cells.get(ckey(Math.floor(px / CELL), Math.floor(py / CELL)));
    let best = -1;
    if (s) for (const id of s) if (id > best && px >= X[id] && px < X[id] + SIZE && py >= Y[id] && py < Y[id] + SIZE) best = id;
    return best;
  }
  /** Sorted ids intersecting rect, capped at MAX_IDS. */
  query(x0, y0, x1, y1, X, Y) {
    const out = new Set();
    for (let cx = Math.floor((x0 - SIZE) / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cy = Math.floor((y0 - SIZE) / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const s = this.cells.get(ckey(cx, cy));
        if (s) for (const id of s) if (X[id] < x1 && X[id] + SIZE > x0 && Y[id] < y1 && Y[id] + SIZE > y0) out.add(id);
      }
    const a = [...out].sort((p, q) => p - q);
    return a.length > MAX_IDS ? a.slice(0, MAX_IDS) : a;
  }
}

/**
 * Tool reducer: the editor's document + view state. Deterministic in the order of applied input records,
 * independent of how records are batched. Emits scene deltas through `emit(delta)`.
 * delta = { v, commits: number[], ids: Int32Array, xs, ys, dead: number[] }
 */
export class Editor {
  constructor(emit = () => {}) {
    const L = initialLayout();
    this.x = L.x; this.y = L.y; this.alive = L.alive;
    this.index = new GridIndex();
    this.sum = 0;
    for (let i = 0; i < N; i++) { this.index.insert(i, this.x[i], this.y[i]); this.sum = (this.sum + mix(i, this.x[i], this.y[i])) >>> 0; }
    this.docVersion = 0; this.gestureSeq = 0; this.commits = 0; this.cancels = { esc: 0, targetGone: 0 };
    this.cam = { tx: 40, ty: 40, z: 1 };
    this.sel = [];
    this.g = null;  // { id, kind:'drag'|'marquee', targets, ox, oy, dx, dy, mq }
    this.emit = emit;
    this.inputSeq = 0;
    this.errors = []; // typed errors (IF-ENG-001) as values
  }
  apply(r) { // r: { seq, type, x, y, dx, dy, flags }
    this.inputSeq = r.seq;
    switch (r.type) {
      case T.WHEEL: camApplyWheel(this.cam, r.x, r.y, r.dx, r.dy, r.flags); break;
      case T.DOWN: this._down(r); break;
      case T.MOVE: this._move(r); break;
      case T.UP: this._up(r); break;
      case T.KEY: this._key(r); break;
      case T.REMOTE_MOVE: this._remoteMove(r.x | 0, r.dx | 0, r.dy | 0); break;
      case T.REMOTE_DEL: this._remoteDel(r.x | 0); break;
    }
  }
  _down(r) {
    // E-4: hit test with the camera as of this event (all earlier records applied, nothing later).
    const px = toDocX(this.cam, r.x), py = toDocY(this.cam, r.y);
    const hit = this.index.hit(px, py, this.x, this.y);
    const id = ++this.gestureSeq;
    if (hit < 0) { this.g = { id, kind: 'marquee', ox: px, oy: py, mq: [Math.round(px), Math.round(py), Math.round(px), Math.round(py)] }; this.sel = []; return; }
    let targets;
    if (r.flags & F.ALT) { const b = Math.floor(hit / GROUP) * GROUP; targets = []; for (let i = b; i < b + GROUP; i++) if (this.alive[i]) targets.push(i); }
    else targets = [hit];
    this.sel = targets.slice();
    this.g = { id, kind: 'drag', targets, ox: px, oy: py, dx: 0, dy: 0 };
  }
  _move(r) {
    const g = this.g; if (!g) return;
    const px = toDocX(this.cam, r.x), py = toDocY(this.cam, r.y);
    if (g.kind === 'drag') { g.dx = Math.round(px - g.ox); g.dy = Math.round(py - g.oy); }
    else { g.mq = [Math.round(Math.min(g.ox, px)), Math.round(Math.min(g.oy, py)), Math.round(Math.max(g.ox, px)), Math.round(Math.max(g.oy, py))]; this.sel = this.index.query(g.mq[0], g.mq[1], g.mq[2], g.mq[3], this.x, this.y); }
  }
  _up() {
    const g = this.g; if (!g) return;
    this.g = null;
    if (g.kind === 'drag' && (g.dx || g.dy)) this._commit(g.targets, g.dx, g.dy, [g.id]); // E-5: one transaction at gesture end
  }
  _key(r) {
    if (r.x === K.ESC) { if (this.g) { this.g = null; this.cancels.esc++; } return; }
    if (this.g || !this.sel.length) return;
    const s = (r.flags & F.SHIFT) ? 10 : 1;
    const dx = r.x === K.LEFT ? -s : r.x === K.RIGHT ? s : 0, dy = r.x === K.UP ? -s : r.x === K.DOWN ? s : 0;
    this._commit(this.sel, dx, dy, [++this.gestureSeq]);
  }
  _setPos(i, nx, ny) {
    this.index.remove(i, this.x[i], this.y[i]);
    this.sum = (this.sum - mix(i, this.x[i], this.y[i]) + mix(i, nx, ny)) >>> 0;
    this.x[i] = nx; this.y[i] = ny; this.index.insert(i, nx, ny);
  }
  _commit(ids, dx, dy, commits) {
    const n = ids.length, I = new Int32Array(n), X = new Int32Array(n), Y = new Int32Array(n);
    for (let k = 0; k < n; k++) { const i = ids[k]; this._setPos(i, this.x[i] + dx, this.y[i] + dy); I[k] = i; X[k] = this.x[i]; Y[k] = this.y[i]; }
    this.docVersion++; this.commits++;
    this.emit({ v: this.docVersion, commits, ids: I, xs: X, ys: Y, dead: [] });
  }
  // Remote CRDT updates (simulated peer). E-3: overlays are relative, so a moved target composes.
  _remoteMove(i, dx, dy) {
    if (!this.alive[i]) return;
    this._setPos(i, this.x[i] + dx, this.y[i] + dy);
    this.docVersion++;
    this.emit({ v: this.docVersion, commits: [], ids: Int32Array.of(i), xs: Int32Array.of(this.x[i]), ys: Int32Array.of(this.y[i]), dead: [] });
  }
  _remoteDel(i) {
    if (!this.alive[i]) return;
    this.index.remove(i, this.x[i], this.y[i]);
    this.sum = (this.sum - mix(i, this.x[i], this.y[i])) >>> 0;
    this.alive[i] = 0;
    this.docVersion++;
    this.sel = this.sel.filter((s) => s !== i);
    if (this.g && this.g.kind === 'drag' && this.g.targets.includes(i)) {
      // E-3: target gone mid-gesture → cancel with a typed error value (toast in the app)
      this.errors.push({ code: 'IF-ENG-001', gesture: this.g.id, target: i, fix: 'Target was deleted by a collaborator; gesture cancelled.' });
      this.g = null; this.cancels.targetGone++;
    }
    this.emit({ v: this.docVersion, commits: [], ids: new Int32Array(0), xs: new Int32Array(0), ys: new Int32Array(0), dead: [i] });
  }
  /** Displayed-doc hash (committed + overlay + selection + marquee); camera is checked separately. */
  displayHash() {
    let h = this.sum;
    const g = this.g;
    if (g && g.kind === 'drag' && (g.dx || g.dy)) for (const i of g.targets) h = (h - mix(i, this.x[i], this.y[i]) + mix(i, this.x[i] + g.dx, this.y[i] + g.dy)) >>> 0;
    return (h + viewPartHash(this.sel, Math.min(this.sel.length, MAX_IDS), g && g.kind === 'marquee' ? g.mq : null)) >>> 0;
  }
  committedHash() { // full recompute (final-state check)
    let h = 0; for (let i = 0; i < N; i++) if (this.alive[i]) h = (h + mix(i, this.x[i], this.y[i])) >>> 0; return h;
  }
}
