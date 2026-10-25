/**
 * The render module behind its fixed ports (D15): view-state frames and scene deltas in, one
 * `RenderPort.draw` per new consistent frame out. It decides nothing about the document; it only
 * enforces the S2 protocol rules:
 *
 * - **Apply deltas only up to the frame's version.** Read frame F, apply deltas with
 *   `upTo: F.docVersion`, and draw F only when the committed state is exactly F.docVersion.
 *   Otherwise keep the last good frame (E-1, E-2: an overlay disappears in exactly the frame that
 *   applies the delta committing it). A gap or epoch change resyncs from a snapshot meanwhile.
 * - **Draw on arrival** with a small coalescing delay; ticks (worker rAF or the main-rAF tick
 *   cell) pace presentation and catch-up draws (`pacing.ts`).
 *
 * Machine `instaflow/render-module` (docs/LIFECYCLES.md): waiting → presenting ⇄ holding; * → disposed.
 */
import { AbortedError, anySignal, createMachine, defineMachine, ok, type Result, sleep, toSfError } from '@staticflux/core';
import { createSceneStore, type SceneStore } from '@staticflux/document/render-projection';
import type { CellReader, DeltaStreamReader } from '@staticflux/worker/pipeline';
import { committedDigest } from './digest.js';
import type { RenderPacing, TickSource } from './pacing.js';
import { type SceneField, SceneProjection, type ViewFrameFields } from './protocol.js';
import type { DrawReason, RenderFrame, RenderPort } from './render-port.js';

export const RenderModuleLifecycle = defineMachine({
  id: 'instaflow/render-module',
  initial: 'waiting',
  states: ['waiting', 'presenting', 'holding', 'disposed'],
  transitions: {
    waiting: { draw: 'presenting', hold: 'holding', dispose: 'disposed' },
    presenting: { hold: 'holding', dispose: 'disposed' },
    holding: { draw: 'presenting', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});
export type RenderModuleState = (typeof RenderModuleLifecycle.states)[number];

export interface RenderModulePorts {
  readonly frames: CellReader<ViewFrameFields>;
  readonly deltas: DeltaStreamReader;
  readonly port: RenderPort;
  /** Display ticks (worker rAF or main tick cell); none = draw on arrival only. */
  readonly ticks?: TickSource;
}

/** One presented frame (diagnostics, the oracle suite and the bench). */
export interface PresentedRecord {
  readonly viewSeq: number;
  readonly inputSeq: number;
  readonly docVersion: number;
  readonly frameDocVersion: number;
  readonly gestureId: number;
  readonly camera: readonly [number, number, number];
  readonly overlayAfterCommit: boolean;
  readonly digest: number;
  readonly reason: DrawReason;
  /** Newest input timestamp the frame consumed (absolute ms). */
  readonly inputTs: number;
  readonly drawStart: number;
  readonly submitted: number;
  /** First tick at or after submit (present estimate, S2); 0 until that tick. */
  presented: number;
}

export interface RenderModuleOptions {
  readonly ports: RenderModulePorts;
  readonly pacing: RenderPacing;
  /** Absolute ms clock (timeOrigin + performance.now in browsers). */
  readonly now?: () => number;
  /** Keep a `PresentedRecord` per draw (default false: counters only). */
  readonly record?: boolean;
  /** Digest of a drawn frame for the log (the oracle's fake renderer). */
  readonly digest?: (frame: RenderFrame) => number;
}

export interface RenderModuleStats {
  readonly draws: number;
  readonly holds: number;
  readonly unchanged: number;
  readonly drawFailures: number;
  readonly payloadErrors: number;
  readonly overlayAfterCommit: number;
  readonly orderViolations: number;
  readonly tornReads: number;
  readonly gaps: number;
  readonly resnapshots: number;
  readonly ticks: number;
  readonly wakes: number;
  /** Exceptions thrown while updating (a bug in a port or a decoder); the loop keeps running. */
  readonly exceptions: number;
  readonly lastException: string | undefined;
}

export type UpdateOutcome = 'drawn' | 'held' | 'unchanged' | 'empty' | 'failed';

export interface RenderFinal {
  readonly committedDigest: number;
  readonly docVersion: number;
  readonly resnapshots: number;
  readonly gaps: number;
  readonly tornReads: number;
  readonly orderViolations: number;
}

export interface RenderModule {
  readonly scene: SceneStore<SceneField>;
  readonly state: RenderModuleState;
  readonly stats: RenderModuleStats;
  readonly presented: readonly PresentedRecord[];
  /** Read the latest frame, apply deltas up to it and draw if consistent and new. */
  update(reason: DrawReason): UpdateOutcome;
  /** A display tick at `time`: frames submitted before it count as presented at it. */
  vsync(time: number): void;
  run(signal: AbortSignal): Promise<Result<void>>;
  final(): RenderFinal;
  dispose(): void;
}

const performanceNow = (): number => (globalThis.performance === undefined ? Date.now() : globalThis.performance.timeOrigin + globalThis.performance.now());

/** Create the render module (see the module header). */
export function createRenderModule(options: RenderModuleOptions): RenderModule {
  const { ports, pacing } = options;
  const now = options.now ?? performanceNow;
  const scene = createSceneStore(SceneProjection);
  const machine = createMachine(RenderModuleLifecycle);
  const superseded = new Set<number>();
  const presented: PresentedRecord[] = [];
  let pending: PresentedRecord[] = [];
  const stats = { draws: 0, holds: 0, unchanged: 0, drawFailures: 0, payloadErrors: 0, overlayAfterCommit: 0, orderViolations: 0, ticks: 0, wakes: 0, exceptions: 0 };
  let lastException: string | undefined;
  let applied = -1;
  let last = { viewSeq: -1, docVersion: -1 };

  const transition = (event: 'draw' | 'hold'): void => {
    if (machine.can(event)) machine.send(event);
  };

  /** `update` for the run loops: an exception is counted and reported, never ends the loop. */
  const safeUpdate = (reason: DrawReason): void => {
    try {
      update(reason);
    } catch (error) {
      stats.exceptions += 1;
      lastException = toSfError(error).message;
    }
  };

  const update = (reason: DrawReason): UpdateOutcome => {
    if (machine.state === 'disposed') return 'empty';
    const snapshot = ports.frames.read();
    if (snapshot === undefined) return 'empty';
    const view = snapshot.record;
    ports.deltas.apply(
      (record) => {
        const result = scene.apply(record.payload);
        if (!result.ok) {
          stats.payloadErrors += 1;
          return;
        }
        if (record.kind === 'snapshot') {
          superseded.clear();
          ports.port.reset?.();
        } else if (record.version <= applied) stats.orderViolations += 1;
        for (const gesture of result.value.supersedes) superseded.add(gesture);
        applied = record.version;
      },
      { upTo: view.docVersion },
    );
    if (ports.deltas.state !== 'live' || ports.deltas.version !== view.docVersion) {
      stats.holds += 1; // keep the last good frame (E-1/E-2)
      transition('hold');
      return 'held';
    }
    if (view.viewSeq === last.viewSeq && ports.deltas.version === last.docVersion) {
      stats.unchanged += 1;
      return 'unchanged';
    }
    const overlayAfterCommit = view.gestureId !== 0 && view.overlayCount > 0 && superseded.has(view.gestureId);
    if (overlayAfterCommit) stats.overlayAfterCommit += 1;
    const frame: RenderFrame = { scene, view, docVersion: ports.deltas.version, reason };
    const drawStart = now();
    const drawn = ports.port.draw(frame);
    const submitted = now();
    if (!drawn.ok) {
      stats.drawFailures += 1;
      return 'failed';
    }
    stats.draws += 1;
    last = { viewSeq: view.viewSeq, docVersion: ports.deltas.version };
    transition('draw');
    if (options.record === true) {
      const entry: PresentedRecord = {
        viewSeq: view.viewSeq,
        inputSeq: view.inputSeq,
        docVersion: ports.deltas.version,
        frameDocVersion: view.docVersion,
        gestureId: view.gestureId,
        camera: [view.tx, view.ty, view.zoom],
        overlayAfterCommit,
        digest: options.digest?.(frame) ?? 0,
        reason,
        inputTs: view.inputTs,
        drawStart,
        submitted,
        presented: 0,
      };
      presented.push(entry);
      pending.push(entry);
    }
    return 'drawn';
  };

  const vsync = (time: number): void => {
    stats.ticks += 1;
    if (pending.length === 0) return;
    // A frame submitted after this vsync's timestamp cannot be on screen at it (S2 present estimate).
    pending = pending.filter((entry) => {
      if (entry.submitted > time) return true;
      entry.presented = time;
      return false;
    });
  };

  /** Wait for the next frame, or (while holding) for the next frame or delta. */
  const waitForWork = async (signal: AbortSignal): Promise<Result<boolean>> => {
    if (machine.state !== 'holding') return ports.frames.wait({ signal });
    const race = new AbortController();
    const both = anySignal(signal, race.signal);
    try {
      return await Promise.race([ports.frames.wait({ signal: both }), ports.deltas.wait({ signal: both })]);
    } finally {
      race.abort();
    }
  };

  const latch = async (target: number, signal: AbortSignal): Promise<void> => {
    const deadline = now() + pacing.latchMs;
    for (;;) {
      const consumed = ports.frames.read()?.record.inputSeq ?? 0;
      const remaining = deadline - now();
      if (consumed >= target || remaining <= 0) return;
      const waited = await ports.frames.wait({ signal, timeoutMs: remaining });
      if (!waited.ok) return;
    }
  };

  const tickLoop = async (ticks: TickSource, signal: AbortSignal): Promise<Result<void>> => {
    for (;;) {
      const tick = await ticks.next(signal);
      if (!tick.ok) return tick.error.code === AbortedError.code ? ok() : tick;
      vsync(tick.value.time);
      if (pacing.latchMs > 0 && tick.value.inputTarget !== undefined) await latch(tick.value.inputTarget, signal);
      safeUpdate('tick');
    }
  };

  const arrivalLoop = async (signal: AbortSignal): Promise<Result<void>> => {
    for (;;) {
      const woke = await waitForWork(signal);
      if (!woke.ok) return woke.error.code === AbortedError.code || ports.frames.closed ? ok() : woke;
      stats.wakes += 1;
      if (pacing.coalesceMs > 0) {
        const slept = await sleep(pacing.coalesceMs, signal);
        if (!slept.ok) return ok();
      }
      safeUpdate('arrival');
    }
  };

  return {
    scene,
    get state() {
      return machine.state;
    },
    get stats() {
      const delta = ports.deltas.stats;
      return { ...stats, lastException, tornReads: ports.frames.stats.torn, gaps: delta.gaps, resnapshots: Math.max(0, delta.snapshots - 1) };
    },
    presented,
    update,
    vsync,
    async run(signal) {
      safeUpdate('arrival');
      const loops: Promise<Result<void>>[] = [];
      if (ports.ticks !== undefined) loops.push(tickLoop(ports.ticks, signal));
      if (pacing.arrival || ports.ticks === undefined) loops.push(arrivalLoop(signal));
      const results = await Promise.all(loops);
      return results.find((result) => !result.ok) ?? ok();
    },
    final() {
      const delta = ports.deltas.stats;
      return {
        committedDigest: committedDigest(scene),
        docVersion: ports.deltas.version,
        resnapshots: Math.max(0, delta.snapshots - 1),
        gaps: delta.gaps,
        tornReads: ports.frames.stats.torn,
        orderViolations: stats.orderViolations,
      };
    },
    dispose() {
      if (!machine.can('dispose')) return;
      machine.send('dispose');
      ports.port.dispose();
    },
  };
}
