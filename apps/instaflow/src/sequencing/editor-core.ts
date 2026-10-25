/**
 * The editor module's state machine, free of threads and pipes: document part (CRDT peer),
 * spatial index, render projection, view state (camera, selection, gesture overlay) and the
 * minimal tool set the S2 oracle needs — pan, zoom, drag one, drag a group, marquee, nudge,
 * Esc. Real tools (snapping, handles, kurbo hit tests) are B3; this file only has to be exact.
 *
 * The same core runs in the editor module (behind the input ring and the delta stream) and as
 * the single-threaded reference of the oracle suite, so "pipeline equals reference" checks
 * the sequencing, not two implementations of the tools.
 *
 * Rules it implements (ARCHITECTURE §4):
 * - E-3 overlays are offsets over committed state; a remote move of a target composes, a remote
 *   delete of a target cancels the gesture with IF-ENG-001 (a value in `errors`, never a throw).
 * - E-4 hit tests use the camera after exactly the inputs before them.
 * - E-5 one transaction per gesture (pointerup) or per nudge, never per move.
 * - Every applied transaction (local or remote) becomes one delta in docVersion order.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { createRenderProjector, createSceneStore, type RenderProjector, type SceneStore } from '@staticflux/document/render-projection';
import { bindSpatialIndex, type SpatialIndexSystem } from '@staticflux/document/spatial-index';
import type { ActorRecord, DocumentCRDTv2, NodeId, PartChange, PartOp, TransactionMeta } from '@staticflux/document/v2';
import { type CompactInputEvent, InputCode, InputFlag, InputModifier } from '@staticflux/surface';
import { committedDigest as sceneCommittedDigest, displayDigest, elementTerm } from './digest.js';
import { GestureTargetGoneError } from './errors.js';
import { MAX_VIEW_IDS, type SceneField, SceneProjection, type ViewFrameRecord } from './protocol.js';
import { comparePaintKeys, elementBounds, paintKey } from './scene.js';

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

export interface Camera {
  tx: number;
  ty: number;
  zoom: number;
}

/** Apply a wheel event to a camera (pan, or zoom about the pointer with Ctrl). */
export function applyWheel(camera: Camera, x: number, y: number, dx: number, dy: number, modifiers: number): void {
  if ((modifiers & InputModifier.ctrl) !== 0) {
    const z1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom * Math.exp(-dy * 0.01)));
    const f = z1 / camera.zoom;
    camera.tx = x - (x - camera.tx) * f;
    camera.ty = y - (y - camera.ty) * f;
    camera.zoom = z1;
    return;
  }
  camera.tx -= dx;
  camera.ty -= dy;
}

export type Gesture =
  | { readonly id: number; readonly kind: 'drag'; readonly targets: readonly number[]; readonly ox: number; readonly oy: number; dx: number; dy: number }
  | { readonly id: number; readonly kind: 'marquee'; readonly ox: number; readonly oy: number; marquee: readonly [number, number, number, number] };

export interface EditorDelta {
  /** docVersion after this delta. */
  readonly version: number;
  readonly payload: Uint8Array;
  readonly supersedes: readonly number[];
}

export interface EditorCoreOptions {
  readonly part: DocumentCRDTv2;
  readonly actor?: ActorRecord;
  /** Called for every applied transaction, in docVersion order. */
  readonly onDelta?: (delta: EditorDelta) => void;
}

export interface EditorFinal {
  readonly committedDigest: number;
  readonly docVersion: number;
  readonly commits: number;
  readonly cancels: number;
  readonly errors: number;
}

export interface FrameMeta {
  readonly viewSeq: number;
  readonly inputSeq: number;
  readonly batchSeq: number;
  readonly epoch: number;
  readonly inputTs: number;
}

export interface EditorCore {
  readonly part: DocumentCRDTv2;
  /** The editor's own decoded copy of the projection (what the render side must end up with). */
  readonly scene: SceneStore<SceneField>;
  readonly projector: RenderProjector;
  readonly spatial: SpatialIndexSystem;
  readonly docVersion: number;
  readonly commits: number;
  readonly cancels: number;
  readonly peerSeq: number;
  readonly camera: Readonly<Camera>;
  readonly selection: readonly number[];
  readonly gesture: Gesture | undefined;
  /** Typed errors raised as values (IF-ENG-001 cancels). */
  readonly errors: readonly SfError[];
  input(event: CompactInputEvent): void;
  /** Import a remote CRDT update (another tab, agent or collaborator). */
  remote(update: Uint8Array): Result<void>;
  /** Projection snapshot of the committed scene (delta stream resnapshot). */
  snapshot(): Uint8Array;
  /** True when the screen point hits an element (current camera). */
  probe(x: number, y: number): boolean;
  /** Slots of the active drag gesture. */
  dragTargets(): readonly number[];
  displayDigest(): number;
  committedDigest(): number;
  writeFrame(record: ViewFrameRecord, meta: FrameMeta): void;
  final(): EditorFinal;
}

const DEFAULT_ACTOR: ActorRecord = { kind: 'user', id: 'local' };
const NUDGE: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Create the editor core over a loaded part (see the module header). */
export function createEditorCore(options: EditorCoreOptions): Result<EditorCore> {
  const { part } = options;
  const actor = options.actor ?? DEFAULT_ACTOR;
  const projector = createRenderProjector(SceneProjection, part);
  const scene = createSceneStore(SceneProjection);
  const spatial = bindSpatialIndex({ part, bounds: elementBounds, paths: ['spatial.', 'style.'] });
  const errors: SfError[] = [];
  const camera: Camera = { tx: 40, ty: 40, zoom: 1 };
  let selection: number[] = [];
  let gesture: Gesture | undefined;
  let docVersion = 0;
  let commits = 0;
  let cancels = 0;
  let peerSeq = 0;
  let gestureSeq = 0;
  let committed = 0;

  // Initial state: the projection mirror and the spatial index from the loaded part.
  const initial = scene.apply(projector.snapshot());
  if (!initial.ok) return initial;
  spatial.rebuild();
  committed = sceneCommittedDigest(scene);

  const xs = (): ArrayLike<number> => scene.column('x');
  const ys = (): ArrayLike<number> => scene.column('y');
  const toDocX = (sx: number): number => (sx - camera.tx) / camera.zoom;
  const toDocY = (sy: number): number => (sy - camera.ty) / camera.zoom;

  /** Additive digest terms of `slots` as the mirror holds them now (incremental committed digest). */
  const terms = (slots: Iterable<number>): number => {
    let h = 0;
    for (const slot of slots) if (scene.alive(slot)) h = (h + elementTerm(slot, xs()[slot] as number, ys()[slot] as number)) >>> 0;
    return h;
  };

  const applyChange = (change: PartChange, supersedes: readonly number[]): void => {
    spatial.apply(change);
    const removed = new Set<number>();
    for (const node of change.deleted) {
      const slot = projector.slotOf(node);
      if (slot !== undefined) removed.add(slot);
    }
    const payload = projector.project(change, { supersedes });
    if (payload === undefined) return;
    const touched = new Set<number>(removed);
    for (const node of [...change.created, ...change.moved, ...change.updated.keys()]) {
      const slot = projector.slotOf(node);
      if (slot !== undefined) touched.add(slot);
    }
    const before = terms(touched);
    const applied = scene.apply(payload);
    if (!applied.ok) errors.push(applied.error); // cannot happen: the projection is ours on both sides
    committed = (committed - before + terms(touched)) >>> 0;
    docVersion += 1;
    options.onDelta?.({ version: docVersion, payload, supersedes });
  };

  const meta = (label: string): TransactionMeta => ({ actor, label, via: 'direct' });

  const commitMove = (targets: readonly number[], dx: number, dy: number, gestureId: number, label: string): void => {
    const ops: PartOp[] = [];
    for (const slot of targets) {
      const node = projector.nodeOf(slot);
      if (node === undefined) continue;
      const x = part.prop(node, 'spatial.x');
      const y = part.prop(node, 'spatial.y');
      ops.push({ op: 'set', node, path: 'spatial.x', value: (typeof x === 'number' ? x : 0) + dx });
      ops.push({ op: 'set', node, path: 'spatial.y', value: (typeof y === 'number' ? y : 0) + dy });
    }
    if (ops.length === 0) return;
    const result = part.transact(meta(label), ops);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    commits += 1;
    applyChange(result.value.change, [gestureId]);
  };

  const hitTest = (sx: number, sy: number): { node: NodeId; slot: number } | undefined => {
    const px = toDocX(sx);
    const py = toDocY(sy);
    let best: { node: NodeId; slot: number; key: readonly string[] } | undefined;
    const w = scene.column('w');
    const h = scene.column('h');
    for (const node of spatial.index.hit(px, py)) {
      const slot = projector.slotOf(node);
      if (slot === undefined) continue;
      const x = xs()[slot] as number;
      const y = ys()[slot] as number;
      if (!(px >= x && px < x + (w[slot] as number) && py >= y && py < y + (h[slot] as number))) continue; // precise test (kurbo in B3)
      const key = paintKey(part, node);
      if (best === undefined || comparePaintKeys(key, best.key) > 0) best = { node, slot, key };
    }
    return best;
  };

  const groupOf = (node: NodeId, slot: number): number[] => {
    const parent = part.node(node)?.parent ?? null;
    if (parent === null) return [slot];
    const out: number[] = [];
    for (const child of part.children(parent)) {
      const s = projector.slotOf(child);
      if (s !== undefined) out.push(s);
    }
    return out;
  };

  const marqueeSelection = (x0: number, y0: number, x1: number, y1: number): number[] => {
    const w = scene.column('w');
    const h = scene.column('h');
    const out: number[] = [];
    for (const node of spatial.index.search({ minX: x0, minY: y0, maxX: x1, maxY: y1 })) {
      const slot = projector.slotOf(node);
      if (slot === undefined) continue;
      const x = xs()[slot] as number;
      const y = ys()[slot] as number;
      if (x < x1 && x + (w[slot] as number) > x0 && y < y1 && y + (h[slot] as number) > y0) out.push(slot);
    }
    out.sort((a, b) => a - b);
    return out.length > MAX_VIEW_IDS ? out.slice(0, MAX_VIEW_IDS) : out;
  };

  const down = (event: CompactInputEvent): void => {
    const hit = hitTest(event.x, event.y); // E-4: the camera after exactly the earlier inputs
    const px = toDocX(event.x);
    const py = toDocY(event.y);
    gestureSeq += 1;
    if (hit === undefined) {
      const r = [Math.round(px), Math.round(py), Math.round(px), Math.round(py)] as const;
      gesture = { id: gestureSeq, kind: 'marquee', ox: px, oy: py, marquee: r };
      selection = [];
      return;
    }
    const targets = (event.m & InputModifier.alt) !== 0 ? groupOf(hit.node, hit.slot) : [hit.slot];
    selection = targets.slice();
    gesture = { id: gestureSeq, kind: 'drag', targets, ox: px, oy: py, dx: 0, dy: 0 };
  };

  const move = (event: CompactInputEvent): void => {
    const g = gesture;
    if (g === undefined) return;
    const px = toDocX(event.x);
    const py = toDocY(event.y);
    if (g.kind === 'drag') {
      g.dx = Math.round(px - g.ox);
      g.dy = Math.round(py - g.oy);
      return;
    }
    g.marquee = [Math.round(Math.min(g.ox, px)), Math.round(Math.min(g.oy, py)), Math.round(Math.max(g.ox, px)), Math.round(Math.max(g.oy, py))];
    selection = marqueeSelection(...g.marquee);
  };

  const up = (): void => {
    const g = gesture;
    if (g === undefined) return;
    gesture = undefined;
    if (g.kind === 'drag' && (g.dx !== 0 || g.dy !== 0)) commitMove(g.targets, g.dx, g.dy, g.id, 'Move'); // E-5
  };

  const cancel = (): void => {
    if (gesture === undefined) return;
    gesture = undefined;
    cancels += 1;
  };

  const key = (event: CompactInputEvent): void => {
    if (event.key === 'Escape') return cancel();
    const step = event.key === undefined ? undefined : NUDGE[event.key];
    if (step === undefined || gesture !== undefined || selection.length === 0) return;
    const s = (event.m & InputModifier.shift) !== 0 ? 10 : 1;
    gestureSeq += 1;
    commitMove(selection, step[0] * s, step[1] * s, gestureSeq, 'Nudge');
  };

  const digestNow = (): number => {
    const g = gesture;
    return displayDigest(
      scene,
      {
        overlay: g?.kind === 'drag' ? g.targets : [],
        overlayCount: overlayCount(),
        dx: g?.kind === 'drag' ? g.dx : 0,
        dy: g?.kind === 'drag' ? g.dy : 0,
        selection,
        selectionCount: Math.min(selection.length, MAX_VIEW_IDS),
        marquee: g?.kind === 'marquee' ? g.marquee : undefined,
      },
      committed,
    );
  };

  const overlayCount = (): number => (gesture?.kind === 'drag' && (gesture.dx !== 0 || gesture.dy !== 0) ? Math.min(gesture.targets.length, MAX_VIEW_IDS) : 0);

  return ok({
    part,
    scene,
    projector,
    spatial,
    get docVersion() {
      return docVersion;
    },
    get commits() {
      return commits;
    },
    get cancels() {
      return cancels;
    },
    get peerSeq() {
      return peerSeq;
    },
    get camera() {
      return camera;
    },
    get selection() {
      return selection;
    },
    get gesture() {
      return gesture;
    },
    errors,
    input(event) {
      if (((event.f ?? 0) & InputFlag.predicted) !== 0) return; // predicted samples are never committed
      switch (event.t) {
        case InputCode.wheel:
          applyWheel(camera, event.x, event.y, event.dx ?? 0, event.dy ?? 0, event.m);
          return;
        case InputCode.pointerDown:
          return down(event);
        case InputCode.pointerMove:
          return move(event);
        case InputCode.pointerUp:
          return up();
        case InputCode.pointerCancel:
          return cancel();
        case InputCode.keyDown:
          return key(event);
        default:
          return;
      }
    },
    remote(update) {
      const imported = part.import(update);
      if (!imported.ok) return err(imported.error);
      peerSeq += 1;
      const change = imported.value.change;
      const gone = new Set<number>();
      for (const node of change.deleted) {
        const slot = projector.slotOf(node);
        if (slot !== undefined) gone.add(slot);
      }
      applyChange(change, []);
      if (gone.size === 0) return ok();
      selection = selection.filter((slot) => !gone.has(slot));
      const g = gesture;
      if (g?.kind === 'drag' && g.targets.some((slot) => gone.has(slot))) {
        // E-3: the target is gone mid-gesture → cancel, report as a value (toast in the app).
        errors.push(GestureTargetGoneError({ details: { gesture: g.id, targets: g.targets.filter((slot) => gone.has(slot)) } }));
        gesture = undefined;
        cancels += 1;
      }
      return ok();
    },
    snapshot: () => projector.snapshot(),
    probe: (x, y) => hitTest(x, y) !== undefined,
    dragTargets: () => (gesture?.kind === 'drag' ? gesture.targets : []),
    displayDigest: digestNow,
    committedDigest: () => sceneCommittedDigest(scene),
    writeFrame(record, frame) {
      const g = gesture;
      record.docVersion = docVersion;
      record.viewSeq = frame.viewSeq;
      record.inputSeq = frame.inputSeq;
      record.batchSeq = frame.batchSeq;
      record.epoch = frame.epoch;
      record.inputTs = frame.inputTs;
      record.peerSeq = peerSeq;
      record.tx = camera.tx;
      record.ty = camera.ty;
      record.zoom = camera.zoom;
      record.gestureId = g?.id ?? 0;
      const count = overlayCount();
      record.overlayCount = count;
      record.dx = g?.kind === 'drag' ? g.dx : 0;
      record.dy = g?.kind === 'drag' ? g.dy : 0;
      if (g?.kind === 'drag') for (let i = 0; i < count; i++) record.targets[i] = g.targets[i] as number;
      const selected = Math.min(selection.length, MAX_VIEW_IDS);
      record.selectionCount = selected;
      for (let i = 0; i < selected; i++) record.selection[i] = selection[i] as number;
      record.marqueeOn = g?.kind === 'marquee' ? 1 : 0;
      if (g?.kind === 'marquee') record.marquee.set(g.marquee);
      record.digest = digestNow();
    },
    final: () => ({ committedDigest: sceneCommittedDigest(scene), docVersion, commits, cancels, errors: errors.length }),
  });
}
