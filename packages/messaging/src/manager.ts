/**
 * The surface manager (R13.4–R13.10, LIFECYCLES §8, invariant I-7).
 *
 * One owner for every user-messaging surface. Features `request(def, { owner, props })`
 * and get a `SurfaceHandle`; the manager decides *if* and *when* it shows:
 *
 *   requested ──gate/seen/scope──► rejected
 *       │ enqueue
 *       ▼
 *    queued ──arbitration──► showing ⇄ suspended (higher-priority modal, coach suppression)
 *       └──────────────┬────────┘
 *                      ▼ dismiss (user, timeout, replaced, scope-ended, …)
 *                 dismissing ──exit──► dismissed
 *
 * Arbitration (R13.7):
 * - dialog/sheet: one stack. A queued modal shows when none is showing, or on top
 *   (suspending the current one) when it has a higher priority or `stack: true`.
 * - toast: at most `toastConcurrency` showing (urgent toasts bypass the cap); auto-dismiss.
 * - banner: deduplicated by key; at most `bannerConcurrency` showing.
 * - tooltip: one at a time (a new one replaces the old). popover / inline-alert: immediate.
 * - coach-mark: one at a time; only when its target is registered and visible; suppressed
 *   (queued, or showing → suspended) while a modal or urgent toast shows or the user is busy.
 *
 * Scope-bound lifetime (R13.6, I-7): every request names its owner scope; when that scope
 * is disposed the surface is force-dismissed (`scope-ended`). Requests for a disposed
 * scope, or from an owner longer-lived than the surface's declared scope, are rejected
 * with SF-MSG-001.
 */
import {
  box,
  type Box,
  createMachine,
  type Injector,
  type Machine,
  type Scope,
  type ScopeLevel,
  scopeRank,
  type SfError,
  type Telemetry,
  createNoopTelemetry,
  toSfError,
} from '@staticflux/core';
import { allowAllDecide, type DecidePort, type GateVerdict, type VisibilityObserver, alwaysVisible } from '@staticflux/ui';
import { CoachTargetMissingError, SurfaceGatedError, SurfaceOutlivesScopeError } from './errors.js';
import { type KeyValuePort, createMemoryKeyValue, type MessagingClock, systemClock } from './ports.js';
import {
  type AnySurfaceDef,
  type CoachSequence,
  type CoachTarget,
  type DismissReason,
  MODAL_KINDS,
  priorityRank,
  type SurfaceDef,
  type SurfaceEvent,
  type SurfaceKind,
  surfaceMachine,
  type SurfaceState,
  USER_REASONS,
} from './surface.js';
import { MESSAGING_SUBSYSTEM, messagingMetrics } from './telemetry.js';

// ---------------------------------------------------------------- public types

export interface SurfaceOwner {
  readonly scope: Scope;
  /** Scope level of the owner; checked against the surface's declared `scope` (I-7). */
  readonly level?: ScopeLevel;
}

/** Owner from an injector (its scope and level). */
export function ownerOf(injector: Injector): SurfaceOwner {
  return { scope: injector.scope, level: injector.level };
}

export type RejectReason = 'gated' | 'seen' | 'scope' | 'target-missing' | 'load-failed' | 'cancelled';

export interface SurfaceOutcome<R = unknown> {
  readonly state: 'dismissed' | 'rejected';
  readonly reason: DismissReason | RejectReason;
  readonly result: R | undefined;
  readonly error: SfError | undefined;
  /** Time spent showing (suspended time excluded). */
  readonly dwellMs: number;
  /** The upsell surface shown instead (gated surfaces with `upsell`). */
  readonly redirect: SurfaceHandle | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SurfaceHandle<P = any, R = any> {
  readonly instanceId: string;
  readonly def: SurfaceDef<P, R>;
  readonly props: P;
  readonly owner: SurfaceOwner;
  /** Reactive. */
  readonly state: SurfaceState;
  readonly anchor: Element | undefined;
  readonly titleId: string;
  /** Coach sequences: 1-based step index and total. */
  readonly step: { readonly index: number; readonly total: number } | undefined;
  /** Resolves when dismissed or rejected. */
  readonly closed: Promise<SurfaceOutcome<R>>;
  /** Escape/backdrop may dismiss it. */
  readonly dismissible: boolean;
  dismiss(reason?: DismissReason, result?: R): void;
}

type PropsOption<P> = [P] extends [void] ? { readonly props?: undefined } : { readonly props: P };

export type RequestOptions<P> = {
  readonly owner: SurfaceOwner;
  /** Popovers/tooltips: the element they are anchored to. */
  readonly anchor?: Element;
  /** Modals: show on top of the current modal regardless of priority (confirmations, pickers). */
  readonly stack?: boolean;
  /** Toast duration override (ms, `null` = sticky). */
  readonly durationMs?: number | null;
  /** Cancels the request (queued or showing → dismissed `programmatic`). */
  readonly signal?: AbortSignal;
} & PropsOption<P>;

export interface CoachTargets {
  /** Register the element a coach target points at; returns unregister. Visibility is observed. */
  register(target: CoachTarget, element: Element): () => void;
  /** Reactive: the registered element. */
  element(target: CoachTarget): Element | undefined;
  /** Reactive: registered and visible. */
  available(target: CoachTarget): boolean;
}

export interface SequenceHandle {
  /** Resolves `true` when every step was completed or already seen, `false` if skipped/cancelled. */
  readonly done: Promise<boolean>;
  cancel(): void;
}

export interface SurfaceManager {
  request<P, R>(def: SurfaceDef<P, R>, options: RequestOptions<P>): SurfaceHandle<P, R>;
  /** Reactive: every surface that is queued, showing, suspended or dismissing (request order). */
  readonly active: readonly SurfaceHandle[];
  /** Reactive: showing surfaces of the given kinds. */
  showing(...kinds: readonly SurfaceKind[]): readonly SurfaceHandle[];
  /** Reactive: the top-most showing modal (dialog/sheet). */
  readonly topModal: SurfaceHandle | undefined;
  /** Dismiss the top-most dismissible surface (Escape). Returns false if none. */
  dismissTop(reason?: DismissReason): boolean;
  /** Mid-task signal: suppresses coach marks while true (R13.7). */
  setUserBusy(busy: boolean): void;
  readonly userBusy: boolean;
  readonly targets: CoachTargets;
  /** Run a coach-mark tour step by step (seen steps skipped). */
  startSequence(sequence: CoachSequence, options: { readonly owner: SurfaceOwner }): SequenceHandle;
  /** Listen to every transition (devtools, routable bridge). */
  onTransition(listener: (handle: SurfaceHandle, from: SurfaceState, to: SurfaceState) => void): () => void;
  dispose(): void;
}

export interface SurfaceManagerOptions {
  readonly telemetry?: Telemetry;
  readonly decide?: DecidePort;
  /** Seen-once persistence for coach marks (async; AsyncStore-compatible). */
  readonly seen?: KeyValuePort<boolean>;
  readonly visibility?: VisibilityObserver;
  readonly clock?: MessagingClock;
  readonly toastConcurrency?: number;
  readonly bannerConcurrency?: number;
  readonly defaultToastMs?: number;
  /** Duration of `dismissing` (exit transition). Default 0; reduced motion forces 0. */
  readonly exitMs?: number;
  readonly reducedMotion?: () => boolean;
}

// ---------------------------------------------------------------- implementation

let instanceCounter = 0;

class Entry<P = unknown, R = unknown> implements SurfaceHandle<P, R> {
  readonly instanceId: string;
  readonly machine: Machine<SurfaceState, SurfaceEvent>;
  readonly titleId: string;
  readonly closed: Promise<SurfaceOutcome<R>>;
  resolveClosed!: (outcome: SurfaceOutcome<R>) => void;
  readonly order: number;
  readonly targetReady = box(false);
  showSince: number | undefined;
  dwell = 0;
  result: R | undefined;
  reason: DismissReason | RejectReason | undefined;
  error: SfError | undefined;
  redirectHandle: SurfaceHandle | undefined;
  cleanups: (() => void)[] = [];
  everShown = false;

  constructor(
    readonly def: SurfaceDef<P, R>,
    readonly props: P,
    readonly owner: SurfaceOwner,
    readonly anchor: Element | undefined,
    readonly stack: boolean,
    readonly durationMs: number | null | undefined,
    readonly step: { readonly index: number; readonly total: number } | undefined,
    readonly dismissFn: (entry: Entry, reason: DismissReason, result: unknown) => void,
  ) {
    instanceCounter += 1;
    this.order = instanceCounter;
    this.instanceId = `${def.id}#${instanceCounter}`;
    this.titleId = `sf-surface-title-${instanceCounter}`;
    this.machine = createMachine(surfaceMachine);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get state(): SurfaceState {
    return this.machine.state;
  }

  get dismissible(): boolean {
    return this.def.dismissible !== false;
  }

  dismiss(reason: DismissReason = 'programmatic', result?: R): void {
    this.dismissFn(this as Entry, reason, result);
  }
}

const LIVE: readonly SurfaceState[] = ['queued', 'showing', 'suspended', 'dismissing'];

export function createSurfaceManager(options: SurfaceManagerOptions = {}): SurfaceManager {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const decide = options.decide ?? allowAllDecide;
  const seen = options.seen ?? createMemoryKeyValue<boolean>();
  const visibility = options.visibility ?? alwaysVisible();
  const clock = options.clock ?? systemClock;
  const toastCap = options.toastConcurrency ?? 3;
  const bannerCap = options.bannerConcurrency ?? 2;
  const defaultToastMs = options.defaultToastMs ?? 5_000;
  const exitMs = (): number => (options.reducedMotion?.() === true ? 0 : (options.exitMs ?? 0));

  const entries = box<readonly Entry[]>([]);
  const busy = box(false);
  const listeners = new Set<(handle: SurfaceHandle, from: SurfaceState, to: SurfaceState) => void>();
  let disposed = false;
  let arbitrating = false;
  let rearbitrate = false;

  const publish = (): void => {
    entries.set(entries.get().filter((e) => LIVE.includes(e.state) || e.state === 'requested'));
  };

  const attrs = (entry: Entry, extra: Record<string, string> = {}) => ({ surface: entry.def.id, kind: entry.def.kind, ...extra });

  const send = (entry: Entry, event: SurfaceEvent): boolean => {
    const from = entry.machine.state;
    const result = entry.machine.send(event);
    if (!result.ok) return false;
    const to = result.value;
    const now = clock.now();
    if (from === 'showing' && entry.showSince !== undefined) {
      entry.dwell += now - entry.showSince;
      entry.showSince = undefined;
    }
    if (to === 'showing') {
      entry.showSince = now;
      if (!entry.everShown) {
        entry.everShown = true;
        telemetry.record(messagingMetrics.shown, 1, attrs(entry));
      }
    }
    telemetry.event(`lifecycle.${surfaceMachine.id}.${from}→${to}`, {
      subsystem: MESSAGING_SUBSYSTEM,
      level: 'verbose',
      attrs: { ...attrs(entry), from, to, event },
    });
    for (const listener of [...listeners]) listener(entry, from, to);
    return true;
  };

  const finish = (entry: Entry): void => {
    for (const cleanup of entry.cleanups.splice(0)) cleanup();
    entry.resolveClosed({
      state: entry.state === 'rejected' ? 'rejected' : 'dismissed',
      reason: entry.reason ?? 'programmatic',
      result: entry.result,
      error: entry.error,
      dwellMs: entry.dwell,
      redirect: entry.redirectHandle,
    });
  };

  const reject = (entry: Entry, reason: RejectReason, error?: SfError): void => {
    entry.reason = reason;
    entry.error = error;
    if (!send(entry, 'reject')) return;
    telemetry.record(messagingMetrics.rejected, 1, attrs(entry, { reason }));
    publish();
    finish(entry);
  };

  const dismiss = (entry: Entry, reason: DismissReason, result: unknown): void => {
    if (entry.state === 'requested') {
      // Not yet decided (gate pending): cancel.
      reject(entry, 'cancelled');
      return;
    }
    if (!entry.machine.can('dismiss')) return;
    const wasShown = entry.everShown;
    entry.reason = reason;
    entry.result = result as never;
    send(entry, 'dismiss');
    const complete = (): void => {
      if (!send(entry, 'done')) return;
      telemetry.record(messagingMetrics.dismissed, 1, attrs(entry, { reason }));
      if (wasShown) telemetry.record(messagingMetrics.dwell, entry.dwell, attrs(entry, { reason }));
      if (entry.def.kind === 'coach-mark' && wasShown && USER_REASONS.includes(reason) && entry.def.once !== false) {
        void seen.set(seenKey(entry.def), true);
      }
      publish();
      finish(entry);
      arbitrate();
    };
    const ms = wasShown ? exitMs() : 0;
    if (ms > 0) clock.after(ms, complete);
    else complete();
    arbitrate();
  };

  const seenKey = (def: AnySurfaceDef): string => `messaging/seen/${def.id}`;

  // ------------------------------------------------------------ arbitration

  const live = (): readonly Entry[] => entries.get();
  const isModal = (entry: Entry): boolean => MODAL_KINDS.includes(entry.def.kind);
  const byPriorityThenOrder = (a: Entry, b: Entry): number =>
    priorityRank(b.def.priority) - priorityRank(a.def.priority) || a.order - b.order;

  const show = (entry: Entry): void => {
    if (!send(entry, 'show')) return;
    if (entry.def.kind === 'toast') {
      const duration =
        entry.durationMs !== undefined ? entry.durationMs : entry.def.durationMs !== undefined ? entry.def.durationMs : entry.def.priority === 'urgent' ? null : defaultToastMs;
      if (duration !== null) entry.cleanups.push(clock.after(duration, () => dismiss(entry, 'timeout', undefined)));
    }
  };

  const arbitrateModals = (all: readonly Entry[]): void => {
    const modals = all.filter(isModal);
    const queued = modals.filter((e) => e.state === 'queued').sort(byPriorityThenOrder);
    let top = modals.filter((e) => e.state === 'showing').sort((a, b) => b.order - a.order)[0];
    for (const candidate of queued) {
      if (top === undefined) {
        // Nothing showing: resume a suspended modal unless the candidate outranks it.
        const suspended = modals.filter((e) => e.state === 'suspended').sort((a, b) => b.order - a.order)[0];
        if (suspended !== undefined && priorityRank(candidate.def.priority) <= priorityRank(suspended.def.priority) && !candidate.stack) {
          send(suspended, 'resume');
          top = suspended;
          continue;
        }
        show(candidate);
        top = candidate;
        continue;
      }
      if (candidate.stack || priorityRank(candidate.def.priority) > priorityRank(top.def.priority)) {
        send(top, 'suspend');
        show(candidate);
        top = candidate;
      }
    }
    if (top === undefined) {
      const suspended = modals.filter((e) => e.state === 'suspended').sort((a, b) => b.order - a.order)[0];
      if (suspended !== undefined) send(suspended, 'resume');
    }
  };

  const arbitrateCapped = (all: readonly Entry[], kind: SurfaceKind, cap: number, bypassUrgent: boolean): void => {
    const ofKind = all.filter((e) => e.def.kind === kind);
    let showingCount = ofKind.filter((e) => e.state === 'showing').length;
    for (const candidate of ofKind.filter((e) => e.state === 'queued').sort(byPriorityThenOrder)) {
      if (showingCount < cap || (bypassUrgent && candidate.def.priority === 'urgent')) {
        show(candidate);
        showingCount += 1;
      }
    }
  };

  const coachSuppressed = (all: readonly Entry[]): boolean =>
    busy.get() ||
    all.some(
      (e) =>
        (e.state === 'showing' || e.state === 'dismissing') &&
        (isModal(e) || (e.def.kind === 'toast' && e.def.priority === 'urgent')),
    );

  const arbitrateCoach = (all: readonly Entry[]): void => {
    const coach = all.filter((e) => e.def.kind === 'coach-mark');
    const suppressed = coachSuppressed(all);
    const showing = coach.find((e) => e.state === 'showing');
    if (suppressed) {
      if (showing !== undefined) send(showing, 'suspend');
      return;
    }
    if (showing !== undefined) return;
    const suspended = coach.find((e) => e.state === 'suspended');
    if (suspended !== undefined) {
      if (suspended.def.target === undefined || targets.available(suspended.def.target)) send(suspended, 'resume');
      return;
    }
    const next = coach
      .filter((e) => e.state === 'queued' && e.targetReady.get())
      .sort(byPriorityThenOrder)[0];
    if (next !== undefined) show(next);
  };

  const arbitrate = (): void => {
    if (disposed) return;
    if (arbitrating) {
      rearbitrate = true;
      return;
    }
    arbitrating = true;
    try {
      do {
        rearbitrate = false;
        const all = live();
        arbitrateModals(all);
        arbitrateCapped(all, 'toast', toastCap, true);
        arbitrateCapped(all, 'banner', bannerCap, false);
        for (const candidate of all.filter((e) => e.state === 'queued' && (e.def.kind === 'popover' || e.def.kind === 'inline-alert'))) {
          show(candidate);
        }
        const tooltips = all.filter((e) => e.def.kind === 'tooltip');
        const newestTooltip = tooltips.filter((e) => e.state === 'queued').sort((a, b) => b.order - a.order)[0];
        if (newestTooltip !== undefined) {
          for (const other of tooltips) if (other !== newestTooltip && other.machine.can('dismiss')) dismiss(other, 'replaced', undefined);
          show(newestTooltip);
        }
        arbitrateCoach(live());
      } while (rearbitrate);
    } finally {
      arbitrating = false;
    }
  };

  // ------------------------------------------------------------ coach targets

  interface TargetRecord {
    readonly element: Element;
    readonly visible: Box<boolean>;
    readonly stop: () => void;
  }
  const targetMap = new Map<string, TargetRecord>();
  const targetVersion = box(0);
  const targets: CoachTargets = {
    register(target, element) {
      targetMap.get(target.id)?.stop();
      const visible = box(false);
      const stop = visibility.observe(element, (v) => {
        visible.set(v);
        targetVersion.set(targetVersion.get() + 1);
        refreshTargets();
      });
      const record: TargetRecord = { element, visible, stop };
      targetMap.set(target.id, record);
      targetVersion.set(targetVersion.get() + 1);
      refreshTargets();
      return () => {
        if (targetMap.get(target.id) !== record) return;
        stop();
        targetMap.delete(target.id);
        targetVersion.set(targetVersion.get() + 1);
        refreshTargets();
      };
    },
    element(target) {
      targetVersion.get();
      return targetMap.get(target.id)?.element;
    },
    available(target) {
      targetVersion.get();
      const record = targetMap.get(target.id);
      return record !== undefined && record.visible.get();
    },
  };

  const refreshTargets = (): void => {
    for (const entry of live()) {
      if (entry.def.kind !== 'coach-mark' || entry.def.target === undefined) continue;
      const available = targets.available(entry.def.target);
      if (entry.targetReady.get() !== available) entry.targetReady.set(available);
      // A showing coach mark whose target disappeared waits (suspended) for it to come back.
      if (!available && entry.state === 'showing') send(entry, 'suspend');
    }
    arbitrate();
  };

  // ------------------------------------------------------------ request

  const decideGate = async (entry: Entry, signal: AbortSignal): Promise<GateVerdict> => {
    if (entry.def.gate === undefined) return { effect: 'allow' };
    try {
      return await decide.decide(entry.def.gate, signal);
    } catch (error) {
      return { effect: 'deny', reason: toSfError(error).message };
    }
  };

  const enqueue = (entry: Entry): void => {
    if (!send(entry, 'enqueue')) return;
    if (entry.def.kind === 'coach-mark' && entry.def.target !== undefined) {
      entry.targetReady.set(targets.available(entry.def.target));
      const timeoutMs = entry.def.targetTimeoutMs;
      if (timeoutMs !== undefined) {
        entry.cleanups.push(
          clock.after(timeoutMs, () => {
            if (entry.state === 'queued' && !entry.everShown) {
              reject(entry, 'target-missing', CoachTargetMissingError({ details: { surface: entry.def.id, target: entry.def.target?.id ?? '' } }));
            }
          }),
        );
      }
    }
    publish();
    arbitrate();
  };

  const request = <P, R>(def: SurfaceDef<P, R>, requestOptions: RequestOptions<P>, step?: { index: number; total: number }): Entry<P, R> => {
    const entry = new Entry<P, R>(
      def,
      requestOptions.props as P,
      requestOptions.owner,
      requestOptions.anchor,
      requestOptions.stack === true,
      requestOptions.durationMs,
      step,
      dismiss,
    );
    const owner = requestOptions.owner;
    if (disposed || owner.scope.disposed || (owner.level !== undefined && scopeRank(owner.level) < scopeRank(def.scope))) {
      const error = SurfaceOutlivesScopeError({
        details: { surface: def.id, declaredScope: def.scope, ownerLevel: owner.level ?? 'unknown', ownerDisposed: owner.scope.disposed },
      });
      telemetry.event('messaging.surface.invalid-owner', { subsystem: MESSAGING_SUBSYSTEM, level: 'critical', attrs: { surface: def.id, code: error.code } });
      queueMicrotask(() => reject(entry as Entry, 'scope', error));
      return entry;
    }

    // Banner (or opted-in) dedup: answer with the existing live surface.
    const dedupe = def.dedupe ?? def.kind === 'banner';
    if (dedupe !== false) {
      const key = typeof dedupe === 'function' ? dedupe(entry.props) : def.id;
      const existing = live().find(
        (e) => e.def.id === def.id && LIVE.includes(e.state) && e.state !== 'dismissing' &&
          (typeof dedupe === 'function' ? dedupe(e.props as P) : e.def.id) === key,
      );
      if (existing !== undefined) {
        telemetry.record(messagingMetrics.deduped, 1, { surface: def.id });
        return existing as unknown as Entry<P, R>;
      }
    }

    // Scope-bound lifetime (I-7): the owner's end force-dismisses the surface.
    const onScopeEnd = (): void => dismiss(entry as Entry, 'scope-ended', undefined);
    owner.scope.signal.addEventListener('abort', onScopeEnd, { once: true });
    entry.cleanups.push(() => owner.scope.signal.removeEventListener('abort', onScopeEnd));
    const signal = requestOptions.signal;
    if (signal !== undefined) {
      const onAbort = (): void => dismiss(entry as Entry, 'programmatic', undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      entry.cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }

    entries.set([...entries.get(), entry as Entry]);
    void decideAndEnqueue(entry as Entry);
    return entry;
  };

  const decideAndEnqueue = async (entry: Entry): Promise<void> => {
    const needsGate = entry.def.gate !== undefined;
    const needsSeen = entry.def.kind === 'coach-mark' && entry.def.once !== false;
    if (!needsGate && !needsSeen) {
      enqueue(entry);
      return;
    }
    const verdict = await decideGate(entry, entry.owner.scope.signal);
    if (entry.state !== 'requested') return;
    if (verdict.effect === 'deny') {
      const error = SurfaceGatedError({ details: { surface: entry.def.id, reason: verdict.reason } });
      if (entry.def.upsell !== undefined) {
        entry.redirectHandle = request(entry.def.upsell, { owner: entry.owner } as RequestOptions<void>);
      }
      reject(entry, 'gated', error);
      return;
    }
    if (needsSeen) {
      const wasSeen = await seen.get(seenKey(entry.def), { signal: entry.owner.scope.signal });
      if (entry.state !== 'requested') return;
      if (wasSeen.ok && wasSeen.value === true) {
        reject(entry, 'seen');
        return;
      }
    }
    enqueue(entry);
  };

  // ------------------------------------------------------------ sequences

  const startSequence = (sequence: CoachSequence, sequenceOptions: { readonly owner: SurfaceOwner }): SequenceHandle => {
    let cancelled = false;
    let current: SurfaceHandle | undefined;
    const run = async (): Promise<boolean> => {
      const total = sequence.steps.length;
      for (const [index, step] of sequence.steps.entries()) {
        if (cancelled) return false;
        const handle = request(step, { owner: sequenceOptions.owner } as RequestOptions<void>, { index: index + 1, total });
        current = handle;
        const outcome = await handle.closed;
        if (outcome.state === 'rejected' && outcome.reason === 'seen') continue;
        if (outcome.state === 'dismissed' && (outcome.reason === 'completed' || outcome.reason === 'action')) continue;
        return false;
      }
      void seen.set(`messaging/seen/${sequence.id}`, true);
      return true;
    };
    const done = run();
    return {
      done,
      cancel() {
        cancelled = true;
        current?.dismiss('programmatic');
      },
    };
  };

  const manager: SurfaceManager = {
    request: (def, requestOptions) => request(def, requestOptions),
    get active() {
      return entries.get().filter((e) => LIVE.includes(e.state));
    },
    showing(...kinds) {
      return entries.get().filter((e) => e.state === 'showing' && (kinds.length === 0 || kinds.includes(e.def.kind)));
    },
    get topModal() {
      return entries
        .get()
        .filter((e) => e.state === 'showing' && isModal(e))
        .sort((a, b) => b.order - a.order)[0];
    },
    dismissTop(reason = 'escape') {
      const showing = entries.get().filter((e) => e.state === 'showing' && e.dismissible);
      // Anchored transient surfaces close before modals; then the newest modal; then the rest.
      const rank = (e: Entry): number =>
        e.def.kind === 'tooltip' ? 4 : e.def.kind === 'popover' ? 3 : e.def.kind === 'coach-mark' ? 2 : isModal(e) ? 1 : 0;
      const target = showing.filter((e) => rank(e) > 0).sort((a, b) => rank(b) - rank(a) || b.order - a.order)[0];
      if (target === undefined) return false;
      dismiss(target, reason, undefined);
      return true;
    },
    setUserBusy(value) {
      if (busy.get() === value) return;
      busy.set(value);
      arbitrate();
    },
    get userBusy() {
      return busy.get();
    },
    targets,
    startSequence,
    onTransition(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      for (const entry of [...entries.get()]) dismiss(entry, 'scope-ended', undefined);
      disposed = true;
      for (const record of targetMap.values()) record.stop();
      targetMap.clear();
      listeners.clear();
    },
  };
  return manager;
}
