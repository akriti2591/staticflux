/**
 * The editor module behind its fixed ports (D15): input ring in, scene deltas and view-state
 * frames out, remote CRDT updates from the peer port. Topology-neutral — the same code runs in
 * a worker of its own or next to the render module.
 *
 * One step (S2 protocol):
 * 1. drain **every** input record available (one batch per burst: the editor coalesces per frame);
 *    after each record apply the remote updates scheduled for that point;
 * 2. every applied transaction becomes one delta, appended as it happens;
 * 3. then — after the deltas — write one view frame that references them (`docVersion`).
 * A resnapshot request (reader gap, overflow) is answered at the end of the step, never in the
 * middle of a record, so a snapshot and its frame always describe the same consumed input.
 */
import { AbortedError, ok, type Result, sleep } from '@staticflux/core';
import type { ActorRecord, DocumentCRDTv2 } from '@staticflux/document/v2';
import { decodeInputRecord, type InputRecordFields } from '@staticflux/surface/input-ring';
import type { CellWriter, DeltaStreamWriter, RecordRingReader } from '@staticflux/worker/pipeline';
import { createEditorCore, type EditorCore, type EditorDelta } from './editor-core.js';
import type { ViewFrameFields } from './protocol.js';

/** Where remote CRDT updates come from (store worker fan-out, other tabs, agents). */
export interface RemoteUpdatePort {
  /** Updates to apply now that `consumed` input records were applied (in order). */
  take(consumed: number): readonly Uint8Array[];
}

/** A peer that replays a schedule: update `k` applies right after input `after_k` (the oracle suite). */
export function scriptedPeer(schedule: readonly { readonly after: number; readonly update: Uint8Array }[]): RemoteUpdatePort {
  const ordered = [...schedule].sort((a, b) => a.after - b.after);
  let next = 0;
  return {
    take(consumed) {
      const out: Uint8Array[] = [];
      while (next < ordered.length && (ordered[next] as { after: number }).after <= consumed) out.push((ordered[next++] as { update: Uint8Array }).update);
      return out;
    },
  };
}

/** A peer fed as updates arrive (they apply at the next record boundary). */
export interface QueuedPeer extends RemoteUpdatePort {
  push(update: Uint8Array): void;
  readonly pending: number;
}

export function queuedPeer(): QueuedPeer {
  let queue: Uint8Array[] = [];
  return {
    push: (update) => void queue.push(update),
    get pending() {
      return queue.length;
    },
    take() {
      const out = queue;
      queue = [];
      return out;
    },
  };
}

export interface EditorModulePorts {
  readonly input: RecordRingReader<InputRecordFields>;
  readonly deltas: DeltaStreamWriter;
  readonly frames: CellWriter<ViewFrameFields>;
  readonly peer?: RemoteUpdatePort;
}

export interface EditorModuleOptions {
  readonly part: DocumentCRDTv2;
  readonly ports: EditorModulePorts;
  readonly actor?: ActorRecord;
  /** Wait this long after input arrives before draining (busy-editor coalescing, S2 finding 3). Default 0. */
  readonly coalesceMs?: number;
  /** Fault injection (E-1 tests): lose every Nth delta. */
  readonly dropDeltaEvery?: number;
}

export interface EditorModuleStats {
  readonly inputs: number;
  readonly batches: number;
  readonly maxBatch: number;
  readonly viewFrames: number;
  readonly deltas: number;
  readonly droppedDeltas: number;
  readonly snapshots: number;
  /** Deltas the stream refused (overflow): healed by the resnapshot it requests. */
  readonly appendErrors: number;
  readonly remoteErrors: number;
}

export interface EditorModule {
  readonly core: EditorCore;
  readonly stats: EditorModuleStats;
  /** One step (see the module header). Returns the input records applied. */
  step(): number;
  /** Step whenever input arrives until `signal` aborts or the ring closes. */
  run(signal: AbortSignal): Promise<Result<void>>;
}

/** Create the editor module: writes the initial snapshot and frame immediately. */
export function createEditorModule(options: EditorModuleOptions): Result<EditorModule> {
  const { ports } = options;
  const stats = { inputs: 0, batches: 0, maxBatch: 0, viewFrames: 0, deltas: 0, droppedDeltas: 0, snapshots: 0, appendErrors: 0, remoteErrors: 0 };
  const onDelta = (delta: EditorDelta): void => {
    if (options.dropDeltaEvery !== undefined && delta.version % options.dropDeltaEvery === 0) {
      stats.droppedDeltas += 1; // as if the record was lost on the way: the reader sees a gap (E-1)
      return;
    }
    const appended = ports.deltas.append({ version: delta.version, base: delta.version - 1, payload: delta.payload });
    if (appended.ok) stats.deltas += 1;
    else stats.appendErrors += 1;
  };
  const created = createEditorCore({ part: options.part, onDelta, ...(options.actor === undefined ? {} : { actor: options.actor }) });
  if (!created.ok) return created;
  const core = created.value;
  const peer = ports.peer;
  let consumed = 0;
  let batchSeq = 0;
  let inputTs = 0;
  let viewSeq = 0;
  let stepping = false;
  let snapshotOwed = false;
  let stepQueued = false;

  const snapshot = (): void => {
    snapshotOwed = false;
    const written = ports.deltas.snapshot({ version: core.docVersion, payload: core.snapshot() });
    if (written.ok) stats.snapshots += 1;
  };
  const writeFrame = (): void => {
    viewSeq += 1;
    const written = ports.frames.write(({ record }) => core.writeFrame(record, { viewSeq, inputSeq: consumed, batchSeq, epoch: ports.deltas.epoch, inputTs }));
    if (written.ok) stats.viewFrames += 1;
  };
  const applyRemotes = (): boolean => {
    if (peer === undefined) return false;
    const updates = peer.take(consumed);
    for (const update of updates) {
      const applied = core.remote(update);
      if (!applied.ok) stats.remoteErrors += 1;
    }
    return updates.length > 0;
  };

  const step = (): number => {
    stepping = true;
    try {
      let dirty = applyRemotes();
      const n = ports.input.drain((record) => {
        const { event, seq } = decodeInputRecord(record);
        core.input(event);
        consumed += 1;
        batchSeq = seq;
        inputTs = event.ts;
        applyRemotes();
      });
      if (n > 0) {
        stats.inputs += n;
        stats.batches += 1;
        stats.maxBatch = Math.max(stats.maxBatch, n);
        dirty = true;
      }
      if (snapshotOwed) {
        snapshot();
        dirty = true;
      }
      if (dirty) {
        ports.deltas.flush(); // deltas first …
        writeFrame(); // … then the frame that references them
      }
      return n;
    } finally {
      stepping = false;
    }
  };

  ports.deltas.onResnapshot(() => {
    snapshotOwed = true;
    if (stepping || stepQueued) return;
    stepQueued = true;
    queueMicrotask(() => {
      stepQueued = false;
      step();
    });
  });

  snapshot();
  applyRemotes();
  writeFrame();

  return ok({
    core,
    get stats() {
      return { ...stats };
    },
    step,
    async run(signal) {
      step();
      for (;;) {
        if (signal.aborted) return ok();
        const waited = await ports.input.wait({ signal, timeoutMs: 100 });
        if (!waited.ok) return waited.error.code === AbortedError.code || ports.input.closed ? ok() : waited;
        if ((options.coalesceMs ?? 0) > 0 && ports.input.available > 0) await sleep(options.coalesceMs ?? 0, signal);
        step();
      }
    },
  });
}
