/**
 * Latest (D2, IF-5.1–5.2): continuous save, no save button. Every commit of the open document is
 * durable once the store acknowledges it; this service turns that into the top bar's save state:
 *
 * - `saving`  — a commit is not acknowledged yet. After `stallAfterMs` (2 s, IF-5.2) without an
 *   acknowledgement, or when an append failed, `stalled` is true and `cause` says why ("Not saved
 *   yet: <cause>"). A failed flush is retried every `retryMs` until it succeeds.
 * - `saved`   — every commit is durable in the browser store and the folder mirror (if any) is
 *   keeping up.
 * - `offline-mirror-behind` — everything is durable in the browser store, but the folder mirror is
 *   paused (permission lapsed) or failing, so the folder lags behind.
 *
 * Local states are the machine `instaflow/latest-save`: saved → saving (commit) → saved (acked);
 * saving → stalled (timeout or append error) → saving (retry) | saved (acked); any → disposed.
 */
import { box, createMachine, defineMachine, type Result, type SfError } from '@staticflux/core';
import type { CommitRecord } from '@staticflux/document/v2';

export const LatestSaveMachine = /* @__PURE__ */ defineMachine({
  id: 'instaflow/latest-save',
  initial: 'saved',
  states: ['saved', 'saving', 'stalled', 'disposed'],
  transitions: {
    saved: { commit: 'saving', dispose: 'disposed' },
    saving: { commit: 'saving', acked: 'saved', stall: 'stalled', dispose: 'disposed' },
    stalled: { commit: 'stalled', retry: 'saving', acked: 'saved', stall: 'stalled', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type SaveStatus = 'saving' | 'saved' | 'offline-mirror-behind';

export interface SaveState {
  readonly status: SaveStatus;
  /** True after `stallAfterMs` without an acknowledgement or after an append failed ("Not saved yet"). */
  readonly stalled: boolean;
  /** Why it is stalled or why the mirror is behind. */
  readonly cause?: SfError;
  /** When the current status began (clock ms). */
  readonly since: number;
}

/** The open document (structurally a `DocumentRepo` `OpenDocument`). */
export interface LatestSource {
  onCommit(listener: (record: CommitRecord) => void): () => void;
  flush(signal: AbortSignal): Promise<Result<void>>;
}

/** The folder mirror's status (structurally `@staticflux/blob` `FolderMirror`). */
export interface MirrorStatusSource {
  readonly state: string;
  readonly readOnly: boolean;
  readonly pending: number;
  readonly lastError: SfError | undefined;
  onStateChange(listener: () => void): () => void;
}

export interface SaveClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: SaveClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface LatestServiceOptions {
  readonly doc: LatestSource;
  readonly mirror?: MirrorStatusSource;
  readonly clock?: SaveClock;
  /** Default 2000 ms (IF-5.2). */
  readonly stallAfterMs?: number;
  /** Default 1000 ms. */
  readonly retryMs?: number;
}

export interface LatestService {
  /** The current save state (reactive: reads are tracked). */
  state(): SaveState;
  onChange(listener: (state: SaveState) => void): () => void;
  /** Wait until every commit so far is durable. */
  flush(signal: AbortSignal): Promise<Result<void>>;
  dispose(): void;
}

/** Derive the top-bar status from the local machine and the mirror (pure). */
export function deriveSaveState(local: (typeof LatestSaveMachine.states)[number], mirror: MirrorStatusSource | undefined, cause: SfError | undefined, since: number): SaveState {
  if (local === 'saving' || local === 'stalled') return { status: 'saving', stalled: local === 'stalled', ...(cause === undefined ? {} : { cause }), since };
  const behind = mirror !== undefined && (mirror.state === 'paused' || mirror.readOnly || (mirror.lastError !== undefined && mirror.pending > 0));
  if (behind) return { status: 'offline-mirror-behind', stalled: false, ...(mirror.lastError === undefined ? {} : { cause: mirror.lastError }), since };
  return { status: 'saved', stalled: false, since };
}

function sameState(a: SaveState, b: SaveState): boolean {
  return a.status === b.status && a.stalled === b.stalled && a.cause?.code === b.cause?.code;
}

export function createLatestService(options: LatestServiceOptions): LatestService {
  const clock = options.clock ?? systemClock;
  const stallAfterMs = options.stallAfterMs ?? 2000;
  const retryMs = options.retryMs ?? 1000;
  const machine = createMachine(LatestSaveMachine);
  const listeners = new Set<(state: SaveState) => void>();
  const current = box<SaveState>({ status: 'saved', stalled: false, since: clock.now() });
  const lifetime = new AbortController();
  let epoch = 0;
  let cause: SfError | undefined;
  let stallTimer: unknown;
  let retryTimer: unknown;

  const publish = (): void => {
    const previous = current.get();
    const next = deriveSaveState(machine.state === 'disposed' ? 'saved' : machine.state, options.mirror, cause, clock.now());
    if (sameState(previous, next)) return;
    current.set(next);
    for (const listener of [...listeners]) listener(next);
  };

  const clearTimers = (): void => {
    if (stallTimer !== undefined) clock.clearTimeout(stallTimer);
    if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
    stallTimer = undefined;
    retryTimer = undefined;
  };

  const stall = (reason: SfError | undefined): void => {
    if (machine.state === 'disposed') return;
    if (reason !== undefined) cause = reason;
    machine.send('stall');
    publish();
  };

  const settle = (): void => {
    const mine = epoch;
    void options.doc.flush(lifetime.signal).then((result) => {
      if (machine.state === 'disposed') return;
      if (!result.ok) {
        stall(result.error);
        if (retryTimer === undefined) {
          retryTimer = clock.setTimeout(() => {
            retryTimer = undefined;
            if (machine.state !== 'stalled') return;
            machine.send('retry');
            publish();
            settle();
          }, retryMs);
        }
        return;
      }
      if (mine !== epoch) return; // a newer commit is still on its way
      clearTimers();
      cause = undefined;
      machine.send('acked');
      publish();
    });
  };

  const unsubscribeCommits = options.doc.onCommit(() => {
    if (machine.state === 'disposed') return;
    epoch += 1;
    const wasSaved = machine.state === 'saved';
    machine.send('commit');
    if (wasSaved) {
      stallTimer = clock.setTimeout(() => {
        stallTimer = undefined;
        if (machine.state === 'saving') stall(undefined);
      }, stallAfterMs);
    }
    publish();
    settle();
  });
  const unsubscribeMirror = options.mirror?.onStateChange(() => publish());

  return {
    state: () => current.get(),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush: (signal) => options.doc.flush(signal),
    dispose() {
      if (machine.state === 'disposed') return;
      clearTimers();
      unsubscribeCommits();
      unsubscribeMirror?.();
      lifetime.abort();
      machine.send('dispose');
      listeners.clear();
    },
  };
}
