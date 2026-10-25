/**
 * Optimistic intents with supersede-on-ack (SF-Δ19; ARCHITECTURE §4 E-2, E-3, E-5).
 *
 * A gesture shows its effect immediately as an **overlay** over committed state
 * (ephemeral edits: drag offsets, resize previews, text being typed). At gesture
 * end the intent is **committed** to the owner; the overlay stays until the
 * owner's acknowledged version has been **applied locally** — then it disappears
 * in exactly the same step that shows the committed result (no snap-back, no
 * double draw). Newer intents on the same key supersede older ones: a late ack
 * of an older intent never removes a newer overlay.
 *
 *   stage(key, o) ─► staged ─commit(key, o, send)─► pending ─ack{version}─► acked ─advance(≥ version)─► removed
 *                                                       └─ error / cancel ─────────────────────────────► removed
 *
 * The render module calls `advance(appliedVersion)` after applying deltas up to
 * the view frame's docVersion and composes `overlays` on top; main-thread
 * replicas use `replicaSender` (an intent resolves after its patches are applied,
 * so the overlay is superseded at the ack).
 *
 * @example
 * const drags = createOptimisticIntents<DragOverlay>();
 * drags.stage(gesture.id, { targets, dx, dy });                       // every pointermove
 * await drags.commit(gesture.id, { targets, dx, dy }, (signal) => editor.request(Move, { targets, dx, dy }, { signal }));
 * drags.advance(frame.docVersion);                                     // render: after applying deltas
 */
import { AbortedError, createNoopTelemetry, err, ok, type Result, type Telemetry } from '@staticflux/core';
import type { IntentMap, Replica } from './replication.js';

export type OptimisticPhase = 'staged' | 'pending' | 'acked';

export interface OptimisticAck<R = unknown> {
  /** Owner version that contains the intent's effect. */
  readonly version: number;
  readonly value?: R;
}

/** Sends the intent to the owner; resolves with the version that contains it. */
export type OptimisticSender<R = unknown> = (signal: AbortSignal) => Promise<Result<OptimisticAck<R>>>;

export interface OptimisticEntry<O> {
  readonly key: string;
  readonly overlay: O;
  readonly phase: OptimisticPhase;
  /** Set once acked. */
  readonly ackVersion: number | undefined;
}

export type OverlayRemoval = 'superseded-by-ack' | 'rejected' | 'cancelled' | 'reset';

export interface OverlayChange {
  readonly removed: readonly string[];
  readonly reason: OverlayRemoval | 'staged' | 'committed';
}

export interface OptimisticIntents<O> {
  /** Committed version known locally (last `advance`). */
  readonly version: number;
  /** Current overlays by key, in staging order. */
  readonly overlays: ReadonlyMap<string, O>;
  /** Intents sent and not yet superseded. */
  readonly pending: number;
  entries(): readonly OptimisticEntry<O>[];
  /** Show `overlay` for `key` without sending (supersedes any earlier intent on the key). */
  stage(key: string, overlay: O): void;
  /** Send the intent; the overlay stays until the acked version is applied (`advance`). */
  commit<R>(key: string, overlay: O, send: OptimisticSender<R>, options?: { readonly signal?: AbortSignal }): Promise<Result<R | undefined>>;
  /** Drop the key's overlay (Esc, target deleted mid-gesture); aborts its in-flight send. */
  cancel(key: string): boolean;
  /** The local state reached `version`: remove acked overlays it contains. Returns removed keys. */
  advance(version: number): readonly string[];
  /**
   * Drop overlays after a resnapshot / epoch change (versions are meaningless across epochs);
   * in-flight sends are aborted. `keepStaged` keeps gestures in progress (E-3: overlays are relative).
   */
  reset(version?: number, options?: { readonly keepStaged?: boolean }): void;
  subscribe(listener: (change: OverlayChange) => void): () => void;
  dispose(): void;
}

interface MutableEntry<O> {
  key: string;
  overlay: O;
  phase: OptimisticPhase;
  ackVersion: number | undefined;
  token: number;
  controller: AbortController | undefined;
}

const SUBSYSTEM = 'worker/optimistic';

export function createOptimisticIntents<O>(options: { readonly version?: number; readonly telemetry?: Telemetry } = {}): OptimisticIntents<O> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const entries = new Map<string, MutableEntry<O>>();
  const listeners = new Set<(change: OverlayChange) => void>();
  let version = options.version ?? 0;
  let tokens = 0;
  let disposed = false;

  const emit = (change: OverlayChange): void => {
    for (const listener of [...listeners]) listener(change);
  };
  const remove = (key: string, reason: OverlayRemoval): boolean => {
    const entry = entries.get(key);
    if (entry === undefined) return false;
    entries.delete(key);
    entry.controller?.abort(new DOMException('superseded', 'AbortError'));
    emit({ removed: [key], reason });
    return true;
  };
  const place = (key: string, overlay: O, phase: OptimisticPhase): MutableEntry<O> => {
    const previous = entries.get(key);
    // A newer intent supersedes the key's older one (its late ack must not remove this overlay).
    if (previous !== undefined) entries.delete(key);
    tokens += 1;
    const entry: MutableEntry<O> = { key, overlay, phase, ackVersion: undefined, token: tokens, controller: undefined };
    entries.set(key, entry);
    return entry;
  };

  return {
    get version() {
      return version;
    },
    get overlays() {
      return new Map([...entries].map(([key, entry]) => [key, entry.overlay]));
    },
    get pending() {
      return [...entries.values()].filter((entry) => entry.phase !== 'staged').length;
    },
    entries: () => [...entries.values()].map(({ key, overlay, phase, ackVersion }) => ({ key, overlay, phase, ackVersion })),
    stage(key, overlay) {
      if (disposed) return;
      const previous = entries.get(key);
      if (previous?.phase === 'staged') {
        previous.overlay = overlay; // ephemeral edit: same intent, new overlay
      } else {
        place(key, overlay, 'staged');
      }
      emit({ removed: [], reason: 'staged' });
    },
    async commit(key, overlay, send, commitOptions = {}) {
      if (disposed) return err(AbortedError({ message: 'The optimistic intent tracker was disposed.' }));
      const entry = place(key, overlay, 'pending');
      const controller = new AbortController();
      entry.controller = controller;
      const external = commitOptions.signal;
      // Detached once the send settles.
      const detach = new AbortController();
      external?.addEventListener('abort', () => controller.abort(external.reason), { once: true, signal: detach.signal });
      emit({ removed: [], reason: 'committed' });
      let result: Result<OptimisticAck<unknown>>;
      try {
        result = controller.signal.aborted ? err(AbortedError({ cause: controller.signal.reason })) : await send(controller.signal);
      } finally {
        detach.abort();
      }
      const current = entries.get(key);
      const stillOurs = current?.token === entry.token;
      if (stillOurs) entry.controller = undefined;
      if (!result.ok) {
        if (stillOurs) remove(key, result.error.kind === 'aborted' ? 'cancelled' : 'rejected');
        telemetry.event('worker.optimistic.rejected', { subsystem: SUBSYSTEM, level: 'verbose', attrs: { key, code: result.error.code } });
        return result;
      }
      if (stillOurs) {
        entry.phase = 'acked';
        entry.ackVersion = result.value.version;
        if (result.value.version <= version) remove(key, 'superseded-by-ack');
      }
      return ok(result.value.value as never);
    },
    cancel: (key) => remove(key, 'cancelled'),
    advance(next) {
      if (next > version) version = next;
      const removed: string[] = [];
      for (const [key, entry] of [...entries]) {
        if (entry.phase === 'acked' && (entry.ackVersion as number) <= version) {
          entries.delete(key);
          removed.push(key);
        }
      }
      if (removed.length > 0) emit({ removed, reason: 'superseded-by-ack' });
      return removed;
    },
    reset(next, resetOptions = {}) {
      const removed: string[] = [];
      for (const [key, entry] of [...entries]) {
        if (resetOptions.keepStaged === true && entry.phase === 'staged') continue;
        entry.controller?.abort(new DOMException('reset', 'AbortError'));
        entries.delete(key);
        removed.push(key);
      }
      if (next !== undefined) version = next;
      if (removed.length > 0) emit({ removed, reason: 'reset' });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) entry.controller?.abort(new DOMException('disposed', 'AbortError'));
      entries.clear();
      listeners.clear();
    },
  };
}

/** Advance `intents` whenever `replica` applies a version (and once now). Returns unsubscribe. */
export function followReplica<O>(intents: OptimisticIntents<O>, replica: Pick<Replica, 'version' | 'subscribe'>): () => void {
  intents.advance(replica.version);
  return replica.subscribe((event) => {
    if (event.type === 'snapshot') intents.reset(event.version, { keepStaged: true });
    else intents.advance(event.version);
  });
}

/**
 * Sender for a main-thread replica intent: `replica.intent()` resolves after the
 * owner's patches are applied locally, so the ack version is the replica's version.
 */
export function replicaSender<S, I extends IntentMap, K extends keyof I & string>(
  replica: Replica<S, I>,
  action: K,
  args: I[K]['args'],
): OptimisticSender<I[K]['result']> {
  return async (signal) => {
    const result = await replica.intent(action, args, { signal });
    return result.ok ? ok({ version: replica.version, value: result.value }) : result;
  };
}
