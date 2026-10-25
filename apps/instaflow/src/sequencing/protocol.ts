/**
 * The fixed ports between main, the editor module and the render module (D15, ARCHITECTURE §4).
 * Topology-neutral: every pipe runs on the `local` medium when both modules share a worker and on
 * `shared` (or `message`) when they do not. This file is data only (pipe declarations), so every
 * thread imports it without pulling in module code.
 *
 *   main ──input ring──▶ editor module ──scene deltas (first)──▶ render module ──▶ RenderPort
 *                                     └──view-state frame (then)─┘
 *   main ──render tick (main-rAF experiment)──────────────────────▶ render module
 */
import { defineRenderProjection } from '@staticflux/document/render-projection';
import { defineInputRing, type InputRecordFields } from '@staticflux/surface/input-ring';
import { defineLayout, type Layout, type LayoutRecord } from '@staticflux/worker/channels';
import { defineCell, defineDeltaStream, type RecordRingDefinition } from '@staticflux/worker/pipeline';

/** Most targets / selected elements one view frame carries (S2 cap). Larger selections draw their first 1024. */
export const MAX_VIEW_IDS = 1024;

/**
 * View-state frame (editor → render, latest wins, seqlock + checksum). Element references are
 * projection slots, so they index the render module's scene store directly.
 */
export const ViewFrameLayout = /* @__PURE__ */ defineLayout({
  name: 'ViewFrame',
  fields: {
    /** Committed document version this frame was computed on (E-1/E-2: draw only at equality). */
    docVersion: 'f64',
    /** Overlay offset of the active drag gesture, relative to committed state (E-3). */
    dx: 'f64',
    dy: 'f64',
    /** Camera: screen = document × zoom + t. */
    tx: 'f64',
    ty: 'f64',
    zoom: 'f64',
    /** Absolute timestamp of the newest consumed input (latency metrics). */
    inputTs: 'f64',
    viewSeq: 'u32',
    /** Input records consumed (E-4: the camera of this frame is the camera after exactly these inputs). */
    inputSeq: 'u32',
    /** Forwarder batch of the newest consumed input. */
    batchSeq: 'u32',
    /** Remote updates applied. */
    peerSeq: 'u32',
    epoch: 'u32',
    /** Active gesture (0 = none). */
    gestureId: 'u32',
    overlayCount: 'u32',
    selectionCount: 'u32',
    /** 1 when `marquee` holds a rectangle. */
    marqueeOn: 'u32',
    /** The editor's own digest of this display (render-side self-check). */
    digest: 'u32',
    marquee: { type: 'i32', count: 4 },
    targets: { type: 'u32', count: MAX_VIEW_IDS },
    selection: { type: 'u32', count: MAX_VIEW_IDS },
  },
});
export type ViewFrameFields = typeof ViewFrameLayout extends Layout<infer F> ? F : never;
export type ViewFrameRecord = LayoutRecord<ViewFrameFields>;

export const ViewFrameCell = /* @__PURE__ */ defineCell({ id: 'instaflow/view-frame', layout: ViewFrameLayout, checksum: true });

/** Scene deltas (editor → render): render projection payloads, sequenced by docVersion. */
export const SceneDeltas = /* @__PURE__ */ defineDeltaStream({ id: 'instaflow/scene-deltas', capacityBytes: 1 << 22 });

/** Lossless binary input ring (main → editor). */
export const EditorInputRing: RecordRingDefinition<InputRecordFields> = /* @__PURE__ */ defineInputRing({ id: 'instaflow/input', readers: 1, capacity: 4096 });

/** Main-thread render tick (the main-rAF experiment): written in main rAF after input is forwarded. */
export const RenderTickLayout = /* @__PURE__ */ defineLayout({
  name: 'RenderTick',
  fields: {
    /** rAF timestamp, absolute ms. */
    frameTime: 'f64',
    /** Input records pushed into the ring when the tick was written. */
    inputTarget: 'u32',
    tick: 'u32',
  },
});
export type RenderTickFields = typeof RenderTickLayout extends Layout<infer F> ? F : never;
export const RenderTickCell = /* @__PURE__ */ defineCell({ id: 'instaflow/render-tick', layout: RenderTickLayout });

/** What the render module draws of the document (SF-Δ25 binary render projection). */
export const SceneProjection = /* @__PURE__ */ defineRenderProjection({
  id: 'instaflow/scene',
  kinds: ['shape', 'image', 'text', 'vector', 'video'],
  fields: {
    x: { path: 'spatial.x' },
    y: { path: 'spatial.y' },
    w: { path: 'spatial.w' },
    h: { path: 'spatial.h' },
  },
});
export type SceneField = 'x' | 'y' | 'w' | 'h';
