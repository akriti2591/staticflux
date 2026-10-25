/**
 * Studio's canvas pipeline (B8; IF-27.1–27.4): B1's element render source — built over B7's repeat view, so live
 * repeat instances draw like any element — runs through **A7's sequencing ports**: one ordered delta stream of
 * scene records, then one view-state frame that references them; A7's render module applies records only up to the
 * frame's `docVersion` and calls the render port with a consistent pair.
 *
 * **Resources travel ahead of projection deltas** (B1, IF-27.2): every record is one frame of four sections, in
 * this order — the resource batch (`ResourceTable.take()`, looks and paths), an asset IR batch (image pixels the
 * library placed, B4), the projection payload, then a scene IR batch (B2 text glyph runs and fonts, which are not
 * projection columns). The render side applies them in that order, so a delta never references a look, path or
 * image the render side has not seen, even across a resnapshot.
 *
 * Placement (D15): the publisher (editor side) and the render module run on the `local` medium in one realm, the
 * one-worker default with the editor services kept next to the DOM pieces that need them (B6 accessibility, B2
 * text input). Moving both into the pipeline worker is a boot setting change once the stage, tools and a11y
 * snapshots cross the worker boundary (B8 follow-up); the modules already talk only through these ports.
 *
 * Machine `instaflow/canvas-pipeline` (LIFECYCLES §29): starting → running → stopped.
 */
import { createMachine, defineMachine, err, ok, type Result, type SfError } from '@staticflux/core';
import type { RenderProjector, SceneApplyReport } from '@staticflux/document/render-projection';
import type { NodeId } from '@staticflux/document/v2';
import { attachCell, attachDeltaStream, type CellWriter, createCell, createDeltaStream, defineDeltaStream, type DeltaStreamWriter } from '@staticflux/worker/pipeline';
import type { ElementField, ElementRenderSource } from '../elements/projection.js';
import { ElementProjection } from '../elements/projection.js';
import { createSceneResources, type SceneResources } from '../elements/scene.js';
import { DEFAULT_RENDER_PACING, type RenderPacing } from '../sequencing/pacing.js';
import { MAX_VIEW_IDS, ViewFrameCell, type ViewFrameFields } from '../sequencing/protocol.js';
import { createRenderModule, type RenderModule, type RenderSceneAdapter } from '../sequencing/render-module.js';
import type { RenderPort } from '../sequencing/render-port.js';
import { PipelineStartError, SceneRecordError } from './errors.js';

/** The element scene record stream (editor → render; same capacity as A7's scene deltas). */
export const ElementSceneDeltas = /* @__PURE__ */ defineDeltaStream({ id: 'instaflow/element-scene', capacityBytes: 1 << 23 });

/** Record frame: magic, format, then the byte lengths of the four sections in order. */
export const SCENE_RECORD_MAGIC = 0x52534649; // 'IFSR' little-endian
export const SCENE_RECORD_FORMAT = 1;
const SECTIONS = 4;
const HEADER = 8 + SECTIONS * 4;
const EMPTY = new Uint8Array(0);

export interface SceneRecord {
  /** B1 resource batch (applied first). */
  readonly resources?: Uint8Array;
  /** Scene IR applied before the element encoder's batch (image uploads the elements reference). */
  readonly assets?: Uint8Array;
  /** Projection payload (`ElementProjection`). */
  readonly projection?: Uint8Array;
  /** Scene IR applied after the element encoder's batch (B2 text). */
  readonly ir?: Uint8Array;
}

/** Frame one record (sections in their fixed order). */
export function encodeSceneRecord(record: SceneRecord): Uint8Array {
  const parts = [record.resources ?? EMPTY, record.assets ?? EMPTY, record.projection ?? EMPTY, record.ir ?? EMPTY];
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
export function decodeSceneRecord(payload: Uint8Array): Result<Required<SceneRecord>> {
  if (payload.length < HEADER) return err(SceneRecordError({ details: { bytes: payload.length } }));
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint32(0, true) !== SCENE_RECORD_MAGIC || view.getUint32(4, true) !== SCENE_RECORD_FORMAT) return err(SceneRecordError({ details: { bytes: payload.length } }));
  const lengths = Array.from({ length: SECTIONS }, (_, i) => view.getUint32(8 + i * 4, true));
  if (HEADER + lengths.reduce((n, l) => n + l, 0) !== payload.length) return err(SceneRecordError({ details: { bytes: payload.length, lengths } }));
  let at = HEADER;
  const [resources, assets, projection, ir] = lengths.map((l) => {
    const section = payload.subarray(at, at + l);
    at += l;
    return section;
  }) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  return ok({ resources, assets, projection, ir });
}

// ---------------------------------------------------------------- render side

/** Scene IR received since the last draw, in order; `full`: a snapshot replaced the scene. */
export interface QueuedSceneIr {
  readonly full: boolean;
  /** Applied before the element batch. */
  readonly assets: readonly Uint8Array[];
  /** Applied after it. */
  readonly ir: readonly Uint8Array[];
}

/** Render-side state the element port reads: B1 resources, and the IR batches queued since the last draw. */
export interface ElementSceneSide {
  readonly adapter: RenderSceneAdapter<ElementField>;
  readonly resources: SceneResources;
  take(): QueuedSceneIr;
}

export function createElementSceneSide(): ElementSceneSide {
  const resources = createSceneResources();
  let queued: Uint8Array[] = [];
  let assetQueue: Uint8Array[] = [];
  let full = false;
  const adapter: RenderSceneAdapter<ElementField> = {
    projection: ElementProjection,
    apply(store, payload, kind): Result<SceneApplyReport> {
      const record = decodeSceneRecord(payload);
      if (!record.ok) return record;
      const { resources: res, assets, projection, ir } = record.value;
      if (kind === 'snapshot') {
        resources.clear();
        queued = [];
        assetQueue = [];
        full = true;
      }
      if (assets.length > 0) assetQueue.push(assets.slice());
      if (res.length > 0 && !resources.apply(res.slice())) return err(SceneRecordError({ message: 'The resource batch could not be read.', details: { bytes: res.length } }));
      const report = projection.length > 0 ? store.apply(projection) : ok<SceneApplyReport>({ kind, upserts: 0, deletes: 0, supersedes: [] });
      if (!report.ok) return report;
      if (ir.length > 0) queued.push(ir.slice());
      return report;
    },
  };
  return {
    adapter,
    resources,
    take() {
      const out = { full, assets: assetQueue, ir: queued };
      queued = [];
      assetQueue = [];
      full = false;
      return out;
    },
  };
}

// ---------------------------------------------------------------- editor side

/** A source of extra scene IR (B2 text, B4 image uploads) that changes with the document. */
export interface SceneIrSource {
  /** IR for what changed since the last call (undefined: nothing); `full` re-sends everything (after a snapshot). */
  changes(full: boolean): { readonly assets?: Uint8Array; readonly ir?: Uint8Array } | undefined;
}

/** What the publisher reads of the tab's view state each step. */
export interface PublishedView {
  readonly camera: { readonly tx: number; readonly ty: number; readonly zoom: number };
  readonly selection: readonly NodeId[];
}

export interface CanvasPublisherOptions {
  readonly source: Pick<ElementRenderSource, 'changes' | 'takeResources' | 'resources'>;
  readonly projector: Pick<RenderProjector, 'project' | 'snapshot' | 'slotOf'>;
  readonly ir?: SceneIrSource;
  readonly deltas: DeltaStreamWriter;
  readonly frames: CellWriter<ViewFrameFields>;
  readonly view: () => PublishedView;
}

export interface CanvasPublisher {
  readonly docVersion: number;
  readonly records: number;
  /** Publish what changed: one record (resources, projection, IR) if anything did, then one view frame. */
  step(): void;
}

/** The editor-side half of the pipeline (see the module header). Writes the initial snapshot and frame at once. */
export function createCanvasPublisher(options: CanvasPublisherOptions): CanvasPublisher {
  const { deltas, frames, source, projector } = options;
  let docVersion = 0;
  let viewSeq = 0;
  let records = 0;
  let snapshotOwed = true;

  const snapshot = (): void => {
    snapshotOwed = false;
    // The snapshot reflects the current source: drop pending changes, project everything, then take every live
    // resource (the projection just interned them) and clear the pending batch.
    source.changes();
    const projection = projector.snapshot();
    const resources = source.resources.snapshot();
    source.takeResources();
    docVersion += 1;
    const payload = encodeSceneRecord({ resources, projection, ...(options.ir?.changes(true) ?? {}) });
    if (deltas.snapshot({ version: docVersion, payload }).ok) records += 1;
  };
  const writeFrame = (): void => {
    const view = options.view();
    viewSeq += 1;
    const slots = view.selection.flatMap((n) => projector.slotOf(n) ?? []).slice(0, MAX_VIEW_IDS);
    frames.write(({ record }) => {
      record.docVersion = docVersion;
      record.dx = 0;
      record.dy = 0;
      record.tx = view.camera.tx;
      record.ty = view.camera.ty;
      record.zoom = view.camera.zoom;
      record.viewSeq = viewSeq;
      record.inputSeq = viewSeq;
      record.gestureId = 0;
      record.overlayCount = 0;
      record.selectionCount = slots.length;
      record.marqueeOn = 0;
      for (let i = 0; i < slots.length; i++) record.selection[i] = slots[i] as number;
    });
  };
  const step = (): void => {
    if (snapshotOwed) snapshot();
    else {
      const change = source.changes();
      // Resources first: the projection of `change` may reference looks and paths interned just now.
      const resources = source.takeResources();
      const projection = change === undefined ? undefined : projector.project(change);
      const extra = options.ir?.changes(false);
      if (resources !== undefined || projection !== undefined || extra?.assets !== undefined || extra?.ir !== undefined) {
        docVersion += 1;
        const payload = encodeSceneRecord({ ...(resources === undefined ? {} : { resources }), ...(projection === undefined ? {} : { projection }), ...extra });
        if (deltas.append({ version: docVersion, base: docVersion - 1, payload }).ok) records += 1;
        else snapshotOwed = true;
      }
      if (snapshotOwed) snapshot();
    }
    deltas.flush(); // records first …
    writeFrame(); // … then the frame that references them
  };
  deltas.onResnapshot(() => {
    snapshotOwed = true;
    queueMicrotask(step);
  });
  step();
  return {
    get docVersion() {
      return docVersion;
    },
    get records() {
      return records;
    },
    step,
  };
}

// ---------------------------------------------------------------- the pipeline

export const CanvasPipelineLifecycle = /* @__PURE__ */ defineMachine({
  id: 'instaflow/canvas-pipeline',
  initial: 'starting',
  states: ['starting', 'running', 'stopped'],
  transitions: { starting: { run: 'running', stop: 'stopped' }, running: { stop: 'stopped' } },
  terminal: ['stopped'],
});
export type CanvasPipelineState = (typeof CanvasPipelineLifecycle.states)[number];

export interface CanvasPipelineOptions extends Omit<CanvasPublisherOptions, 'deltas' | 'frames'> {
  /** The render port (element port over Vello in the browser; a recording port in tests). */
  readonly port: RenderPort<ElementField>;
  readonly side: ElementSceneSide;
  readonly pacing?: RenderPacing;
  readonly signal: AbortSignal;
}

export interface CanvasPipeline {
  readonly state: CanvasPipelineState;
  readonly publisher: CanvasPublisher;
  readonly render: RenderModule<ElementField>;
  /** Publish now (stage invalidations and view changes call it; cheap when nothing changed). */
  publish(): void;
  stop(): void;
}

/** Start the in-realm pipeline (local medium; see the module header). Failures are IF-INT-001. */
export async function startCanvasPipeline(options: CanvasPipelineOptions): Promise<Result<CanvasPipeline>> {
  const machine = createMachine(CanvasPipelineLifecycle);
  const failed = (step: string, cause: SfError): Result<never> => err(PipelineStartError({ cause, details: { step } }));
  const deltas = createDeltaStream(ElementSceneDeltas, { medium: 'local' });
  if (!deltas.ok) return failed('create scene records', deltas.error);
  const frames = createCell(ViewFrameCell, { medium: 'local' });
  if (!frames.ok) return failed('create view frames', frames.error);
  const deltasEnd = deltas.value.endpoint();
  if (!deltasEnd.ok) return failed('scene records endpoint', deltasEnd.error);
  const framesEnd = frames.value.endpoint();
  if (!framesEnd.ok) return failed('view frames endpoint', framesEnd.error);
  const reader = await attachDeltaStream(ElementSceneDeltas, deltasEnd.value);
  if (!reader.ok) return failed('attach scene records', reader.error);
  const frameReader = await attachCell(ViewFrameCell, framesEnd.value);
  if (!frameReader.ok) return failed('attach view frames', frameReader.error);
  const render = createRenderModule<ElementField>({ ports: { frames: frameReader.value, deltas: reader.value, port: options.port }, scene: options.side.adapter, pacing: options.pacing ?? DEFAULT_RENDER_PACING });
  const publisher = createCanvasPublisher({ ...options, deltas: deltas.value, frames: frames.value as CellWriter<ViewFrameFields> });
  const lifetime = new AbortController();
  const stop = (): void => {
    if (!machine.can('stop')) return;
    machine.send('stop');
    lifetime.abort();
    render.dispose();
    reader.value.close();
    frameReader.value.close();
    deltas.value.close();
    frames.value.close();
  };
  options.signal.addEventListener('abort', stop, { once: true, signal: lifetime.signal });
  machine.send('run');
  void render.run(lifetime.signal);
  return ok({
    get state() {
      return machine.state;
    },
    publisher,
    render,
    publish: () => {
      if (machine.is('running')) publisher.step();
    },
    stop,
  });
}

