/**
 * Studio's canvas pipeline (B8; IF-27.1–27.4, B9 IF-33.4–33.6): B1's element render source — built over B7's repeat
 * view, so live repeat instances draw like any element — runs through **A7's sequencing ports**: one ordered delta
 * stream of scene records, then one view-state frame that references them; A7's render module applies records only up
 * to the frame's `docVersion` and calls the render port with a consistent pair.
 *
 * **Resources travel ahead of projection deltas** (B1, IF-27.2): every record is one frame of six sections, in
 * this order — the resource batch (`ResourceTable.take()`, looks and paths), an asset IR batch (image pixels the
 * library placed, B4), the image table (asset key → scene image ids, so the encoder on the render side resolves image
 * paints wherever the uploads were made, B9), the projection payload, a scene IR batch (B2 text glyph runs and fonts, which are not
 * projection columns), then the **overlay** IR batches (B3's selection frame, handles, guides and the page edge, B9).
 * The render side applies them in that order, so a delta never references a look, path or image the render side has
 * not seen, even across a resnapshot, and the overlay is drawn in the same frame as the content it frames (E-2).
 *
 * Placement (D15, B9): the publisher runs in the editor module and outlives page switches (`attach` a page's
 * sources: a snapshot follows); the render module runs in the render module's worker. Pipes are created by the
 * editor (`createCanvasPipes`, any medium) and attached by the render side (`attachCanvasRender`): direct in one
 * worker (`local`), relayed by main across two (`shared` or `message`). Neither side asks which.
 *
 * Machine `instaflow/canvas-pipeline` (LIFECYCLES §29): starting → running → stopped (the render side's attachment).
 */
import { createMachine, defineMachine, err, ok, type Result, type SfError } from '@staticflux/core';
import type { RenderProjector, SceneApplyReport } from '@staticflux/document/render-projection';
import type { NodeId } from '@staticflux/document/v2';
import {
  attachCell,
  attachDeltaStream,
  type CellWriter,
  createCell,
  createDeltaStream,
  defineDeltaStream,
  type DeltaStreamWriter,
  type PipeMedium,
  type RegionEndpoint,
  regionTransferList,
} from '@staticflux/worker/pipeline';
import type { ElementField, ElementRenderSource } from '../elements/projection.js';
import { ElementProjection } from '../elements/projection.js';
import { createSceneResources, type SceneResources } from '../elements/scene.js';
import { DEFAULT_RENDER_PACING, type RenderPacing, type TickSource } from '../sequencing/pacing.js';
import { MAX_VIEW_IDS, ViewFrameCell, type ViewFrameFields } from '../sequencing/protocol.js';
import { createRenderModule, type RenderModule, type RenderSceneAdapter } from '../sequencing/render-module.js';
import type { RenderPort } from '../sequencing/render-port.js';
import { PipelineStartError, SceneRecordError } from './errors.js';

/** The element scene record stream (editor → render; same capacity as A7's scene deltas). */
export const ElementSceneDeltas = /* @__PURE__ */ defineDeltaStream({ id: 'instaflow/element-scene', capacityBytes: 1 << 23 });

/** Record frame: magic, format, then the byte lengths of the five sections in order. */
export const SCENE_RECORD_MAGIC = 0x52534649; // 'IFSR' little-endian
/** 2: the image table and overlay sections (B9). */
export const SCENE_RECORD_FORMAT = 2;
const SECTIONS = 6;
const HEADER = 8 + SECTIONS * 4;
const EMPTY = new Uint8Array(0);

/** One uploaded image: the scene image ids of an asset key (straight RGBA and its luminance matte). */
export interface ImageBinding {
  readonly asset: string;
  readonly rgba: number;
  readonly luma: number;
}

export interface SceneRecord {
  /** B1 resource batch (applied first). */
  readonly resources?: Uint8Array;
  /** Scene IR applied before the element encoder's batch (image uploads the elements reference). */
  readonly assets?: Uint8Array;
  /** Image ids of the uploads (`assets`), for the element encoder. */
  readonly images?: readonly ImageBinding[];
  /** Projection payload (`ElementProjection`). */
  readonly projection?: Uint8Array;
  /** Scene IR applied after the element encoder's batch (B2 text). */
  readonly ir?: Uint8Array;
  /** Scene IR batches applied last (B3's overlay: editor chrome above the content). */
  readonly overlay?: readonly Uint8Array[];
}

export interface DecodedSceneRecord {
  readonly resources: Uint8Array;
  readonly assets: Uint8Array;
  readonly images: readonly ImageBinding[];
  readonly projection: Uint8Array;
  readonly ir: Uint8Array;
  readonly overlay: readonly Uint8Array[];
}

/** Length-prefixed batches (the overlay section). */
function encodeBatches(batches: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(batches.reduce((n, b) => n + 4 + b.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const b of batches) {
    view.setUint32(at, b.length, true);
    out.set(b, at + 4);
    at += 4 + b.length;
  }
  return out;
}

function decodeBatches(section: Uint8Array): Uint8Array[] | undefined {
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < section.length) {
    if (at + 4 > section.length) return undefined;
    const n = view.getUint32(at, true);
    if (at + 4 + n > section.length) return undefined;
    out.push(section.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}

const utf8 = { encoder: new TextEncoder(), decoder: new TextDecoder() };

function decodeImages(section: Uint8Array): ImageBinding[] | undefined {
  if (section.length === 0) return [];
  try {
    // #43: a copy — over the `shared` medium the section views a SharedArrayBuffer, which browsers' TextDecoder refuses.
    const rows = JSON.parse(utf8.decoder.decode(section.slice())) as unknown;
    if (!Array.isArray(rows)) return undefined;
    const out: ImageBinding[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number' || typeof row[2] !== 'number') return undefined;
      out.push({ asset: row[0], rgba: row[1], luma: row[2] });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Frame one record (sections in their fixed order). */
export function encodeSceneRecord(record: SceneRecord): Uint8Array {
  const images = record.images === undefined || record.images.length === 0 ? EMPTY : utf8.encoder.encode(JSON.stringify(record.images.map((b) => [b.asset, b.rgba, b.luma])));
  const parts = [record.resources ?? EMPTY, record.assets ?? EMPTY, images, record.projection ?? EMPTY, record.ir ?? EMPTY, record.overlay === undefined ? EMPTY : encodeBatches(record.overlay)];
  const out = new Uint8Array(HEADER + parts.reduce((n, p) => n + p.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, SCENE_RECORD_MAGIC, true);
  view.setUint32(4, SCENE_RECORD_FORMAT, true);
  let at = HEADER;
  parts.forEach((p, i) => {
    view.setUint32(8 + i * 4, p.length, true);
    out.set(p, at);
    at += p.length;
  });
  return out;
}

/** Split a record into its sections (IF-INT-002 when it is not a scene record). */
export function decodeSceneRecord(payload: Uint8Array): Result<DecodedSceneRecord> {
  if (payload.length < HEADER) return err(SceneRecordError({ details: { bytes: payload.length } }));
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint32(0, true) !== SCENE_RECORD_MAGIC || view.getUint32(4, true) !== SCENE_RECORD_FORMAT) return err(SceneRecordError({ details: { bytes: payload.length } }));
  const lengths = Array.from({ length: SECTIONS }, (_, i) => view.getUint32(8 + i * 4, true));
  if (HEADER + lengths.reduce((n, l) => n + l, 0) !== payload.length) return err(SceneRecordError({ details: { bytes: payload.length, lengths } }));
  let at = HEADER;
  const [resources, assets, table, projection, ir, overlay] = lengths.map((l) => {
    const section = payload.subarray(at, at + l);
    at += l;
    return section;
  }) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  const batches = decodeBatches(overlay);
  if (batches === undefined) return err(SceneRecordError({ message: 'The overlay section of a scene record is truncated.', details: { bytes: overlay.length } }));
  const images = decodeImages(table);
  if (images === undefined) return err(SceneRecordError({ message: 'The image table of a scene record is not readable.', details: { bytes: table.length } }));
  return ok({ resources, assets, images, projection, ir, overlay: batches });
}

// ---------------------------------------------------------------- render side

/** Scene IR received since the last draw, in order; `full`: a snapshot replaced the scene. */
export interface QueuedSceneIr {
  readonly full: boolean;
  /** Applied before the element batch. */
  readonly assets: readonly Uint8Array[];
  /** Applied after it. */
  readonly ir: readonly Uint8Array[];
  /** Applied last (the overlay). */
  readonly overlay: readonly Uint8Array[];
}

/** Render-side state the element port reads: B1 resources, and the IR batches queued since the last draw. */
export interface ElementSceneSide {
  readonly adapter: RenderSceneAdapter<ElementField>;
  readonly resources: SceneResources;
  /** Scene image id of an uploaded asset (the element encoder's `images`), from the records' image tables. */
  images(asset: string, variant: 'rgba' | 'luma'): number | undefined;
  take(): QueuedSceneIr;
}

export function createElementSceneSide(): ElementSceneSide {
  const resources = createSceneResources();
  let queued: Uint8Array[] = [];
  let assetQueue: Uint8Array[] = [];
  let overlayQueue: Uint8Array[] = [];
  const bindings = new Map<string, ImageBinding>();
  let full = false;
  const adapter: RenderSceneAdapter<ElementField> = {
    projection: ElementProjection,
    apply(store, payload, kind): Result<SceneApplyReport> {
      const record = decodeSceneRecord(payload);
      if (!record.ok) return record;
      const { resources: res, assets, images, projection, ir, overlay } = record.value;
      if (kind === 'snapshot') {
        resources.clear();
        queued = [];
        assetQueue = [];
        overlayQueue = [];
        bindings.clear();
        full = true;
      }
      for (const b of images) bindings.set(b.asset, b);
      if (assets.length > 0) assetQueue.push(assets.slice());
      if (res.length > 0 && !resources.apply(res.slice())) return err(SceneRecordError({ message: 'The resource batch could not be read.', details: { bytes: res.length } }));
      const report = projection.length > 0 ? store.apply(projection) : ok<SceneApplyReport>({ kind, upserts: 0, deletes: 0, supersedes: [] });
      if (!report.ok) return report;
      if (ir.length > 0) queued.push(ir.slice());
      for (const batch of overlay) overlayQueue.push(batch.slice());
      return report;
    },
  };
  return {
    adapter,
    resources,
    images(asset, variant) {
      const b = bindings.get(asset);
      return b === undefined ? undefined : variant === 'luma' ? b.luma : b.rgba;
    },
    take() {
      const out = { full, assets: assetQueue, ir: queued, overlay: overlayQueue };
      queued = [];
      assetQueue = [];
      overlayQueue = [];
      full = false;
      return out;
    },
  };
}

// ---------------------------------------------------------------- editor side

/** What a scene IR source adds to a record (B4 image uploads, B2 text, B3 overlay). */
export interface SceneIrChanges {
  readonly assets?: Uint8Array;
  readonly images?: readonly ImageBinding[];
  readonly ir?: Uint8Array;
  readonly overlay?: readonly Uint8Array[];
}

/** A source of extra scene IR that changes with the document or the view. */
export interface SceneIrSource {
  /** IR for what changed since the last call (undefined: nothing); `full` re-sends everything (after a snapshot). */
  changes(full: boolean): SceneIrChanges | undefined;
}

/** What the publisher reads of the tab's view state each step. */
export interface PublishedView {
  readonly camera: { readonly tx: number; readonly ty: number; readonly zoom: number };
  readonly selection: readonly NodeId[];
}

/** The input a step consumed (A7 frame metrics, E-4). */
export interface PublishedInput {
  /** Input records consumed so far. */
  readonly inputSeq: number;
  /** Absolute timestamp of the newest one (0: none). */
  readonly inputTs: number;
  /** Forwarder batch of the newest one. */
  readonly batchSeq: number;
}

/** One page's sources (a tab attaches them; a page switch attaches the next page's). */
export interface PublisherInputs {
  readonly source: Pick<ElementRenderSource, 'changes' | 'takeResources' | 'resources'>;
  readonly projector: Pick<RenderProjector, 'project' | 'snapshot' | 'slotOf'>;
  readonly ir?: SceneIrSource;
  readonly view: () => PublishedView;
}

export interface CanvasPublisherOptions {
  readonly deltas: DeltaStreamWriter;
  readonly frames: CellWriter<ViewFrameFields>;
  /** Consumed input for the frame (default none). */
  readonly input?: () => PublishedInput;
}

export interface CanvasPublisher {
  readonly docVersion: number;
  readonly records: number;
  /** True while a page's sources are attached. */
  readonly attached: boolean;
  /** Publish `inputs` from now on (a snapshot follows at once); returns detach. */
  attach(inputs: PublisherInputs): () => void;
  /** Publish what changed: one record (resources, projection, IR, overlay) if anything did, then one view frame. */
  step(): void;
}

const NO_INPUT: PublishedInput = Object.freeze({ inputSeq: 0, inputTs: 0, batchSeq: 0 });

/** The editor-side half of the pipeline (see the module header). Nothing is published until a page attaches. */
export function createCanvasPublisher(options: CanvasPublisherOptions): CanvasPublisher {
  const { deltas, frames } = options;
  let docVersion = 0;
  let viewSeq = 0;
  let records = 0;
  let snapshotOwed = true;
  let inputs: PublisherInputs | undefined;

  const snapshot = (current: PublisherInputs): void => {
    snapshotOwed = false;
    // The snapshot reflects the current source: drop pending changes, project everything, then take every live
    // resource (the projection just interned them) and clear the pending batch.
    current.source.changes();
    const projection = current.projector.snapshot();
    const resources = current.source.resources.snapshot();
    current.source.takeResources();
    docVersion += 1;
    const payload = encodeSceneRecord({ resources, projection, ...(current.ir?.changes(true) ?? {}) });
    if (deltas.snapshot({ version: docVersion, payload }).ok) records += 1;
  };
  const writeFrame = (current: PublisherInputs): void => {
    const view = current.view();
    const input = options.input?.() ?? NO_INPUT;
    viewSeq += 1;
    const slots = view.selection.flatMap((n) => current.projector.slotOf(n) ?? []).slice(0, MAX_VIEW_IDS);
    frames.write(({ record }) => {
      record.docVersion = docVersion;
      record.dx = 0;
      record.dy = 0;
      record.tx = view.camera.tx;
      record.ty = view.camera.ty;
      record.zoom = view.camera.zoom;
      record.viewSeq = viewSeq;
      record.inputSeq = input.inputSeq;
      record.inputTs = input.inputTs;
      record.batchSeq = input.batchSeq;
      record.epoch = deltas.epoch;
      record.gestureId = 0;
      record.overlayCount = 0;
      record.selectionCount = slots.length;
      record.marqueeOn = 0;
      for (let i = 0; i < slots.length; i++) record.selection[i] = slots[i] as number;
    });
  };
  const step = (): void => {
    const current = inputs;
    if (current === undefined) return;
    if (snapshotOwed) snapshot(current);
    else {
      const change = current.source.changes();
      // Resources first: the projection of `change` may reference looks and paths interned just now.
      const resources = current.source.takeResources();
      const projection = change === undefined ? undefined : current.projector.project(change);
      const extra = current.ir?.changes(false);
      if (resources !== undefined || projection !== undefined || extra?.assets !== undefined || (extra?.images?.length ?? 0) > 0 || extra?.ir !== undefined || (extra?.overlay?.length ?? 0) > 0) {
        docVersion += 1;
        const payload = encodeSceneRecord({ ...(resources === undefined ? {} : { resources }), ...(projection === undefined ? {} : { projection }), ...extra });
        if (deltas.append({ version: docVersion, base: docVersion - 1, payload }).ok) records += 1;
        else snapshotOwed = true;
      }
      if (snapshotOwed) snapshot(current);
    }
    deltas.flush(); // records first …
    writeFrame(current); // … then the frame that references them
  };
  deltas.onResnapshot(() => {
    snapshotOwed = true;
    queueMicrotask(step);
  });
  return {
    get docVersion() {
      return docVersion;
    },
    get records() {
      return records;
    },
    get attached() {
      return inputs !== undefined;
    },
    attach(next) {
      inputs = next;
      snapshotOwed = true;
      step();
      return () => {
        if (inputs === next) inputs = undefined;
      };
    },
    step,
  };
}

// ---------------------------------------------------------------- the pipes

/** Pipe endpoints the render side attaches (posted to it by main when the modules are in two workers). */
export interface CanvasPipeEndpoints {
  readonly deltas: RegionEndpoint;
  readonly frames: RegionEndpoint;
}

/** Transferables of the endpoints (`message` medium: their ports). */
export const canvasPipeTransfer = (pipes: CanvasPipeEndpoints): Transferable[] => [...regionTransferList(pipes.deltas), ...regionTransferList(pipes.frames)];

export interface CanvasPipes {
  readonly publisher: CanvasPublisher;
  readonly endpoints: CanvasPipeEndpoints;
  close(): void;
}

/** Create the editor side of the pipes on `medium` and the publisher over them (IF-INT-001 on failure). */
export function createCanvasPipes(options: { readonly medium: PipeMedium; readonly input?: () => PublishedInput }): Result<CanvasPipes> {
  const failed = (step: string, cause: SfError): Result<never> => err(PipelineStartError({ cause, details: { step } }));
  const deltas = createDeltaStream(ElementSceneDeltas, { medium: options.medium });
  if (!deltas.ok) return failed('create scene records', deltas.error);
  const frames = createCell(ViewFrameCell, { medium: options.medium });
  if (!frames.ok) return failed('create view frames', frames.error);
  const deltasEnd = deltas.value.endpoint();
  if (!deltasEnd.ok) return failed('scene records endpoint', deltasEnd.error);
  const framesEnd = frames.value.endpoint();
  if (!framesEnd.ok) return failed('view frames endpoint', framesEnd.error);
  const publisher = createCanvasPublisher({ deltas: deltas.value, frames: frames.value as CellWriter<ViewFrameFields>, ...(options.input === undefined ? {} : { input: options.input }) });
  return ok({
    publisher,
    endpoints: { deltas: deltasEnd.value, frames: framesEnd.value },
    close() {
      deltas.value.close();
      frames.value.close();
    },
  });
}

export const CanvasPipelineLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/canvas-pipeline',
  initial: 'starting',
  states: ['starting', 'running', 'stopped'],
  transitions: { starting: { run: 'running', stop: 'stopped' }, running: { stop: 'stopped' } },
  terminal: ['stopped'],
});
export type CanvasPipelineState = (typeof CanvasPipelineLifecycle.states)[number];

export interface CanvasRenderOptions {
  readonly pipes: CanvasPipeEndpoints;
  /** The render port (element port over Vello in the browser; a recording port in tests). */
  readonly port: RenderPort<ElementField>;
  readonly side: ElementSceneSide;
  readonly pacing?: RenderPacing;
  readonly ticks?: TickSource;
  /** Keep a presented-frame log (frame metrics, A7). */
  readonly record?: boolean;
  readonly now?: () => number;
  readonly signal: AbortSignal;
}

export interface CanvasRender {
  readonly state: CanvasPipelineState;
  readonly render: RenderModule<ElementField>;
  stop(): void;
}

/** Attach the render module to the pipes and run it (IF-INT-001 on failure). */
export async function attachCanvasRender(options: CanvasRenderOptions): Promise<Result<CanvasRender>> {
  const machine = createMachine(CanvasPipelineLifecycle);
  const failed = (step: string, cause: SfError): Result<never> => err(PipelineStartError({ cause, details: { step } }));
  const reader = await attachDeltaStream(ElementSceneDeltas, options.pipes.deltas);
  if (!reader.ok) return failed('attach scene records', reader.error);
  const frameReader = await attachCell(ViewFrameCell, options.pipes.frames);
  if (!frameReader.ok) return failed('attach view frames', frameReader.error);
  const render = createRenderModule<ElementField>({
    ports: { frames: frameReader.value, deltas: reader.value, port: options.port, ...(options.ticks === undefined ? {} : { ticks: options.ticks }) },
    scene: options.side.adapter,
    pacing: options.pacing ?? DEFAULT_RENDER_PACING,
    record: options.record === true,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const lifetime = new AbortController();
  const stop = (): void => {
    if (!machine.can('stop')) return;
    machine.send('stop');
    lifetime.abort();
    render.dispose();
    reader.value.close();
    frameReader.value.close();
  };
  options.signal.addEventListener('abort', stop, { once: true, signal: lifetime.signal });
  machine.send('run');
  void render.run(lifetime.signal);
  return ok({
    get state() {
      return machine.state;
    },
    render,
    stop,
  });
}
