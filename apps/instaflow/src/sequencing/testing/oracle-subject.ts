/**
 * The sequencing modules as a subject of the testkit oracle suite (`runSequencingOracleContract`):
 *
 * - `createSequencingReference` — the single-threaded reference: the same `EditorCore` over the
 *   same scene, no pipes, plus a simulated remote peer that produces real CRDT updates.
 * - `createInProcessSequencingSubject` — boots the real pipeline (`bootSequencing` +
 *   `hostSequencingWorker`) with in-memory "workers" on any topology × medium, a fake rAF and the
 *   digesting render port, so every presented frame can be compared with the reference.
 *
 * Structurally typed against testkit (app source never imports testkit). Test-only module.
 */
import type { CrdtEngine, NodeId, PeerId } from '@staticflux/document/v2';
import { type CompactInputEvent } from '@staticflux/surface';
import { encodeInputRecord } from '@staticflux/surface/input-ring';
import { inMemorySpawner } from '@staticflux/worker';
import { bootSequencing, type SequencingSession } from '../boot.js';
import type { ScheduledRemoteUpdate } from '../control.js';
import { createDigestRenderer } from '../digest-renderer.js';
import { createEditorCore, type EditorCore } from '../editor-core.js';
import { hostSequencingWorker, type SequencingWorkerHost } from '../host.js';
import { DEFAULT_RENDER_PACING, type RafLike, type RenderPacing } from '../pacing.js';
import type { PresentedRecord } from '../render-module.js';
import type { RenderPortFactory } from '../render-port.js';
import { DEFAULT_SEQUENCING_SETTINGS, type SequencingSettings, type Topology } from '../topology.js';

type Medium = 'local' | 'shared' | 'message';

/** Peer id every copy of the scene uses, so local commits get identical op ids everywhere (see README). */
export const ORACLE_PEER: PeerId = '7';
const REMOTE_PEER: PeerId = '99';

export interface ReferenceOptions {
  readonly engine: CrdtEngine;
  readonly scene: Uint8Array;
  readonly peer?: PeerId;
}

export interface OracleDisplay {
  readonly digest: number;
  readonly camera: readonly [number, number, number];
}

export interface OracleFinal {
  readonly committedDigest: number;
  readonly docVersion: number;
  readonly commits: number;
  readonly cancels: number;
  readonly errors: number;
}

export interface RemoteRequest {
  readonly kind: 'move' | 'delete';
  readonly target?: number;
  readonly dx: number;
  readonly dy: number;
  readonly random: () => number;
}

export interface SequencingReferenceHandle {
  readonly core: EditorCore;
  input(event: CompactInputEvent): void;
  remote(update: unknown): void;
  display(): OracleDisplay;
  probe(x: number, y: number): boolean;
  dragTargets(): readonly number[];
  makeRemote(request: RemoteRequest): unknown;
  zoom(): number;
  contentCenter(): readonly [number, number];
  final(): OracleFinal;
  dispose(): void;
}

/** What the input ring does to an event (f32 coordinates). */
export function throughRing(event: CompactInputEvent): CompactInputEvent {
  return {
    ...event,
    x: Math.fround(event.x),
    y: Math.fround(event.y),
    ...(event.dx === undefined ? {} : { dx: Math.fround(event.dx) }),
    ...(event.dy === undefined ? {} : { dy: Math.fround(event.dy) }),
  };
}

/** The single-threaded reference (see the module header). Throws on a broken scene: test-only. */
export function createSequencingReference(options: ReferenceOptions): SequencingReferenceHandle {
  const loaded = options.engine.load(options.scene, { peer: options.peer ?? ORACLE_PEER });
  if (!loaded.ok) throw loaded.error;
  const part = loaded.value;
  const created = createEditorCore({ part });
  if (!created.ok) throw created.error;
  const core = created.value;
  const peerLoaded = options.engine.load(options.scene, { peer: REMOTE_PEER });
  if (!peerLoaded.ok) throw peerLoaded.error;
  const peer = peerLoaded.value;
  const meta = { actor: { kind: 'user', id: 'remote-collaborator' }, label: 'Remote edit' };

  // Centre of the initial content's bounding box (document units).
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  core.scene.forEach((slot) => {
    const x = core.scene.column('x')[slot] as number;
    const y = core.scene.column('y')[slot] as number;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x + (core.scene.column('w')[slot] as number));
    bounds.maxY = Math.max(bounds.maxY, y + (core.scene.column('h')[slot] as number));
  });
  const center: readonly [number, number] = Number.isFinite(bounds.minX) ? [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2] : [0, 0];

  const liveSlots = (): number[] => {
    const out: number[] = [];
    core.scene.forEach((slot) => out.push(slot));
    return out;
  };

  return {
    core,
    input: (event) => core.input(throughRing(event)),
    remote(update) {
      const applied = core.remote(update as Uint8Array);
      if (!applied.ok) throw applied.error;
    },
    display: () => ({ digest: core.displayDigest(), camera: [core.camera.tx, core.camera.ty, core.camera.zoom] }),
    probe: (x, y) => core.probe(Math.fround(x), Math.fround(y)),
    dragTargets: () => core.dragTargets(),
    makeRemote(request) {
      const synced = peer.import(part.exportUpdates(peer.version()));
      if (!synced.ok) throw synced.error;
      let slot = request.target;
      if (slot === undefined) {
        const live = liveSlots();
        if (live.length === 0) return undefined;
        slot = live[Math.floor(request.random() * live.length)] as number;
      }
      const node: NodeId | undefined = core.projector.nodeOf(slot);
      if (node === undefined || !peer.has(node)) return undefined;
      const before = peer.version();
      const x = peer.prop(node, 'spatial.x');
      const y = peer.prop(node, 'spatial.y');
      const ops =
        request.kind === 'delete'
          ? [{ op: 'delete', node } as const]
          : [
              { op: 'set', node, path: 'spatial.x', value: (typeof x === 'number' ? x : 0) + request.dx } as const,
              { op: 'set', node, path: 'spatial.y', value: (typeof y === 'number' ? y : 0) + request.dy } as const,
            ];
      const committed = peer.transact(meta, ops);
      if (!committed.ok) throw committed.error;
      return peer.exportUpdates(before);
    },
    zoom: () => core.camera.zoom,
    contentCenter: () => center,
    final: () => core.final(),
    dispose() {
      part.dispose();
      peer.dispose();
    },
  };
}

/** A fake rAF: callbacks run when the test calls `flush(time)`. */
export interface FakeRaf {
  readonly raf: RafLike;
  flush(time: number): void;
}

export function createFakeRaf(): FakeRaf {
  let queue: ((time: number) => void)[] = [];
  return {
    raf: (callback) => {
      queue.push(callback);
      return queue.length;
    },
    flush(time) {
      const run = queue;
      queue = [];
      for (const callback of run) callback(time);
    },
  };
}

export interface SubjectConfig {
  readonly name: string;
  readonly topology: Topology;
  readonly medium: Medium;
  readonly inputMedium: Medium;
  readonly dropDeltaEvery?: number;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface PresentedFrameView {
  readonly viewSeq: number;
  readonly inputSeq: number;
  readonly docVersion: number;
  readonly frameDocVersion: number;
  readonly gestureId: number;
  readonly digest: number;
  readonly camera: readonly [number, number, number];
  readonly overlayAfterCommit: boolean;
}

export function toPresentedFrame(entry: PresentedRecord): PresentedFrameView {
  return {
    viewSeq: entry.viewSeq,
    inputSeq: entry.inputSeq,
    docVersion: entry.docVersion,
    frameDocVersion: entry.frameDocVersion,
    gestureId: entry.gestureId,
    digest: entry.digest,
    camera: entry.camera,
    overlayAfterCommit: entry.overlayAfterCommit,
  };
}

export interface InProcessPipeline {
  readonly session: SequencingSession;
  readonly hosts: readonly SequencingWorkerHost[];
  push(batch: readonly CompactInputEvent[]): void;
  vsync(): void;
  settled(inputs: number, timeoutMs: number): Promise<boolean>;
  presented(): readonly PresentedFrameView[];
  finish(): Promise<{
    editor: OracleFinal;
    render: { committedDigest: number; docVersion: number; resnapshots: number; gaps: number; tornReads: number; orderViolations: number };
    droppedDeltas: number;
  }>;
  dispose(): Promise<void>;
}

export interface InProcessSubjectOptions {
  readonly engine: CrdtEngine;
  readonly scene: Uint8Array;
  /** Wrap the digesting renderer around a real port (A6) — the oracle then checks that port's inputs. */
  readonly renderPort?: RenderPortFactory;
}

const pacingOf = (config: SubjectConfig): RenderPacing => (config.options?.['pacing'] as RenderPacing | undefined) ?? DEFAULT_RENDER_PACING;

/** Boot the real pipeline in-process for one oracle configuration. */
export async function bootInProcessPipeline(options: InProcessSubjectOptions, config: SubjectConfig, remote: readonly ScheduledRemoteUpdate[]): Promise<InProcessPipeline> {
  const frames = createFakeRaf();
  const hosts: SequencingWorkerHost[] = [];
  let clock = 0;
  const settings: SequencingSettings = { ...DEFAULT_SEQUENCING_SETTINGS, topology: config.topology, pacing: pacingOf(config), renderPort: 'oracle' };
  const renderPorts = { oracle: () => createDigestRenderer(options.renderPort?.()) };
  const booted = await bootSequencing({
    settings,
    spawn: () => inMemorySpawner((port) => void hosts.push(hostSequencingWorker({ port, engine: options.engine, renderPorts, raf: frames.raf, timeOrigin: 0, now: () => clock })), { clone: false }),
    scene: options.scene,
    peer: ORACLE_PEER,
    media: { input: config.inputMedium, modules: config.medium, tick: config.inputMedium },
    remote,
    ...(config.dropDeltaEvery === undefined ? {} : { dropDeltaEvery: config.dropDeltaEvery }),
    record: true,
  });
  if (!booted.ok) throw booted.error;
  const session = booted.value;
  let batch = 0;
  let pushed = 0;
  const renderHost = (): SequencingWorkerHost | undefined => hosts.find((host) => host.render !== undefined);
  const lastInput = (): number => {
    const log = renderHost()?.render?.presented ?? [];
    return log.length === 0 ? -1 : (log[log.length - 1] as PresentedRecord).inputSeq;
  };
  return {
    session,
    hosts,
    push(events) {
      batch += 1;
      for (const event of events) {
        const written = session.input.push((record) => encodeInputRecord(record, event, batch));
        if (!written.ok) throw written.error;
      }
      pushed += events.length;
    },
    vsync() {
      clock += 16;
      frames.flush(clock);
      session.tick.pulse(clock, pushed);
    },
    async settled(inputs, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (lastInput() < inputs) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return true;
    },
    presented: () => (renderHost()?.render?.presented ?? []).map(toPresentedFrame),
    async finish() {
      const finals = await session.finish();
      if (!finals.ok) throw finals.error;
      const editor = finals.value.workers.find((w) => w.editor !== undefined)?.editor;
      const render = finals.value.workers.find((w) => w.render !== undefined)?.render;
      if (editor === undefined || render === undefined) throw new Error('missing module finals');
      return {
        editor: { committedDigest: editor.committedDigest, docVersion: editor.docVersion, commits: editor.commits, cancels: editor.cancels, errors: editor.errors },
        render: { committedDigest: render.committedDigest, docVersion: render.docVersion, resnapshots: render.resnapshots, gaps: render.gaps, tornReads: render.tornReads, orderViolations: render.orderViolations },
        droppedDeltas: editor.stats.droppedDeltas,
      };
    },
    dispose: () => session.stop(),
  };
}

/** The oracle subject (structurally a testkit `SequencingSubject`). */
export function createInProcessSequencingSubject(options: InProcessSubjectOptions): {
  reference(): SequencingReferenceHandle;
  boot(boot: { readonly config: SubjectConfig; readonly remote: readonly { readonly after: number; readonly update: unknown }[] }): Promise<InProcessPipeline>;
} {
  return {
    reference: () => createSequencingReference({ engine: options.engine, scene: options.scene }),
    boot: ({ config, remote }) => bootInProcessPipeline(options, config, remote as readonly ScheduledRemoteUpdate[]),
  };
}
