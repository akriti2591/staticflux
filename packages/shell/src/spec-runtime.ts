/**
 * The spec runtime (R13.25–R13.29): owns what one editor surface has mounted. `apply(spec)` validates
 * and gates the spec, diffs it against the mounted layout (pins kept), and drives a **mount port** with
 * the minimal changes in a fixed order — unmounts (reverse display order), moves, the context change,
 * mounts (display order). All port calls start in the same task, so the structural change lands in one
 * frame; each call gets its 120–200 ms motion step (0 under reduced motion) and the runtime waits for
 * every step before `apply` resolves. Applies are serialized: a second `apply` runs after the first.
 *
 * Lifecycle `shell/spec-runtime` (docs/LIFECYCLES.md §20): empty → applying → mounted ⇄ applying;
 * applying → empty (the spec mounted nothing); any → disposed.
 *
 * @example
 * const runtime = createSpecRuntime({ vocabulary, port: domPort, decide: gateDecide, reducedMotion: () => prefs.reducedMotion });
 * const applied = await runtime.apply(studioShellSpec, { signal });
 * runtime.pin('panel:instaflow/layers'); // the next spec cannot remove it
 */
import {
  AbortedError,
  anySignal,
  batch,
  box,
  createMachine,
  createNoopTelemetry,
  defineMachine,
  err,
  ok,
  type Result,
  type SfError,
  type Telemetry,
  toSfError,
} from '@staticflux/core';
import { allowAllDecide, type DecidePort } from '@staticflux/ui';
import { SpecMountError, SpecRuntimeDisposedError, SpecSlotError } from './spec-errors.js';
import { diffSpecs, EMPTY_LAYOUT, type MountedLayout, type SpecContextChange, type SpecDiff, type SpecMove } from './spec-diff.js';
import { groupKey, type ResolvedSlot, type ShellSpec, type SpecSlotKey, type SpecVocabulary } from './spec-model.js';
import { clampSpecMotion, type SpecMotion, type SpecMotionStep, specMotionStep } from './spec-motion.js';
import { validateSpec, type ValidatedSpec } from './spec-validate.js';
import { SHELL_SUBSYSTEM } from './telemetry.js';

export const SpecRuntimeLifecycle = defineMachine({
  id: 'shell/spec-runtime',
  initial: 'empty',
  states: ['empty', 'applying', 'mounted', 'disposed'],
  transitions: {
    empty: { apply: 'applying', dispose: 'disposed' },
    applying: { settle: 'mounted', clear: 'empty', dispose: 'disposed' },
    mounted: { apply: 'applying', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});
export type SpecRuntimeState = (typeof SpecRuntimeLifecycle.states)[number];

export type SpecPortResult = Result<void> | Promise<Result<void>>;

/**
 * Where slots become UI. Calls arrive in the documented order and are not awaited one by one: a port
 * makes its structural change synchronously and returns a promise for the end of its motion.
 */
export interface SpecMountPort {
  /** Insert `slot` right after `after` in its group (first when undefined): see `SpecDiff.after`. */
  mount(slot: ResolvedSlot, after: SpecSlotKey | undefined, step: SpecMotionStep, signal: AbortSignal): SpecPortResult;
  /** Take the slot out of its old place and insert it after `move.after` in its (possibly new) group. */
  move(move: SpecMove, step: SpecMotionStep, signal: AbortSignal): SpecPortResult;
  unmount(slot: ResolvedSlot, step: SpecMotionStep, signal: AbortSignal): SpecPortResult;
  /** Context values changed (lens, scope, density); called after moves, before mounts. */
  context?(changes: readonly SpecContextChange[], context: Readonly<Record<string, string>>, step: SpecMotionStep, signal: AbortSignal): SpecPortResult;
}

export interface SpecRuntimeOptions {
  readonly vocabulary: SpecVocabulary;
  readonly port: SpecMountPort;
  /** Default gating port; `apply` may pass another (an agent's subject). Default: allow all. */
  readonly decide?: DecidePort;
  readonly motion?: Partial<SpecMotion>;
  /** Read at each apply (bind `PreferenceFacts.reducedMotion`). */
  readonly reducedMotion?: () => boolean;
  readonly telemetry?: Telemetry;
}

export interface SpecApplyOptions {
  readonly signal?: AbortSignal;
  readonly decide?: DecidePort;
}

export interface SpecApplied {
  readonly spec: ValidatedSpec;
  readonly diff: SpecDiff;
  /** Port failures (SF-SHELL-014, `details.slot`); the layout reflects what really mounted. */
  readonly failures: readonly SfError[];
  /** Pins dropped because their slot is now gated out (gating wins over pinning). */
  readonly droppedPins: readonly SpecSlotKey[];
}

export interface SpecPreview {
  readonly spec: ValidatedSpec;
  readonly diff: SpecDiff;
}

export interface SpecRuntime {
  readonly state: SpecRuntimeState;
  /** Reactive: the mounted layout. */
  readonly layout: MountedLayout;
  /** Reactive: the last applied spec. */
  readonly spec: ValidatedSpec | undefined;
  /** Reactive: pinned slot keys. */
  readonly pinned: ReadonlySet<SpecSlotKey>;
  validate(spec: ShellSpec, options?: SpecApplyOptions): Promise<Result<ValidatedSpec>>;
  /** Validate and diff without mounting (a proposal's preview). */
  preview(spec: ShellSpec, options?: SpecApplyOptions): Promise<Result<SpecPreview>>;
  apply(spec: ShellSpec, options?: SpecApplyOptions): Promise<Result<SpecApplied>>;
  /** Re-apply the current spec (after gate decisions changed): denied slots unmount, pinned ones too. */
  revalidate(options?: SpecApplyOptions): Promise<Result<SpecApplied | undefined>>;
  /** Pin a mounted slot of a pinnable section (a person's action; specs only add pins). */
  pin(key: SpecSlotKey): Result<void>;
  unpin(key: SpecSlotKey): Result<void>;
  onApplied(listener: (applied: SpecApplied) => void): () => void;
  /** Unmount everything (no motion) and stop. */
  dispose(): Promise<void>;
}

const settle = async (result: SpecPortResult): Promise<Result<void>> => {
  try {
    return await result;
  } catch (error) {
    return err(toSfError(error));
  }
};

const reindex = (slots: readonly ResolvedSlot[]): ResolvedSlot[] => {
  const counters = new Map<string, number>();
  return slots.map((slot) => {
    const group = groupKey(slot);
    const index = counters.get(group) ?? 0;
    counters.set(group, index + 1);
    return slot.index === index ? slot : Object.freeze({ ...slot, index });
  });
};

export function createSpecRuntime(options: SpecRuntimeOptions): SpecRuntime {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const motion = clampSpecMotion(options.motion ?? {});
  const machine = createMachine(SpecRuntimeLifecycle);
  const layout = box<MountedLayout>(EMPTY_LAYOUT);
  const current = box<ValidatedSpec | undefined>(undefined);
  const pinned = box<ReadonlySet<SpecSlotKey>>(new Set());
  const listeners = new Set<(applied: SpecApplied) => void>();
  const lifetime = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();

  const decideOf = (o: SpecApplyOptions | undefined): DecidePort => o?.decide ?? options.decide ?? allowAllDecide;
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const validate = (spec: ShellSpec, o?: SpecApplyOptions): Promise<Result<ValidatedSpec>> =>
    validateSpec(spec, options.vocabulary, { decide: decideOf(o), ...(o?.signal === undefined ? {} : { signal: o.signal }) });

  /** Pinned slots the next spec omits keep their place only while the gate still allows them. */
  const checkRetainedPins = async (next: ValidatedSpec, o?: SpecApplyOptions): Promise<{ keep: Set<SpecSlotKey>; dropped: SpecSlotKey[] }> => {
    const keep = new Set(pinned.get());
    const dropped: SpecSlotKey[] = [];
    const named = new Set(next.slots.map((s) => s.key));
    const decide = decideOf(o);
    for (const slot of layout.get().slots) {
      if (!keep.has(slot.key) || named.has(slot.key) || slot.contribution.gate === undefined) continue;
      const verdict = await decide.decide(slot.contribution.gate, o?.signal);
      if (verdict.effect === 'allow') continue;
      keep.delete(slot.key);
      dropped.push(slot.key);
    }
    return { keep, dropped };
  };

  const drive = async (diff: SpecDiff, reduced: boolean, signal: AbortSignal): Promise<{ failures: SfError[]; failedMounts: Set<SpecSlotKey>; failedUnmounts: ResolvedSlot[] }> => {
    const calls: Promise<void>[] = [];
    const failures: SfError[] = [];
    const failedMounts = new Set<SpecSlotKey>();
    const failedUnmounts: ResolvedSlot[] = [];
    const track = (result: SpecPortResult, slot: SpecSlotKey | undefined, phase: string, onFail?: () => void): void => {
      calls.push(
        settle(result).then((outcome) => {
          if (outcome.ok) return;
          failures.push(SpecMountError({ details: { slot, phase }, cause: outcome.error }));
          onFail?.();
        }),
      );
    };
    for (const slot of diff.unmount) track(options.port.unmount(slot, specMotionStep(motion, 'unmount', reduced), signal), slot.key, 'unmount', () => failedUnmounts.push(slot));
    for (const m of diff.move) track(options.port.move(m, specMotionStep(motion, 'move', reduced), signal), m.slot.key, 'move');
    if (diff.context.length > 0 && options.port.context !== undefined) {
      track(options.port.context(diff.context, diff.target.context, specMotionStep(motion, 'context', reduced), signal), undefined, 'context');
    }
    for (const slot of diff.mount) track(options.port.mount(slot, diff.after.get(slot.key), specMotionStep(motion, 'mount', reduced), signal), slot.key, 'mount', () => failedMounts.add(slot.key));
    await Promise.all(calls);
    return { failures, failedMounts, failedUnmounts };
  };

  const applyNow = async (spec: ShellSpec, o?: SpecApplyOptions): Promise<Result<SpecApplied>> => {
    if (machine.is('disposed')) return err(SpecRuntimeDisposedError());
    const validated = await validate(spec, o);
    if (!validated.ok) return validated;
    const { keep, dropped } = await checkRetainedPins(validated.value, o);
    const signal = o?.signal;
    if (signal?.aborted === true) return err(AbortedError({ cause: signal.reason }));
    if (machine.is('disposed')) return err(SpecRuntimeDisposedError());
    const diff = diffSpecs(layout.get(), validated.value, { pinned: keep });
    const reduced = options.reducedMotion?.() ?? false;
    machine.send('apply');
    const portSignal = anySignal(signal, lifetime.signal);
    const { failures, failedMounts, failedUnmounts } = await drive(diff, reduced, portSignal);
    const slots = reindex([...diff.target.slots.filter((s) => !failedMounts.has(s.key)), ...failedUnmounts]);
    const mounted: MountedLayout = Object.freeze({ context: diff.target.context, slots: Object.freeze(slots) });
    const nextPins = new Set([...keep, ...validated.value.pinned].filter((key) => slots.some((s) => s.key === key)));
    batch(() => {
      layout.set(mounted);
      current.set(validated.value);
      pinned.set(nextPins);
    });
    if (!machine.is('disposed')) machine.send(slots.length === 0 ? 'clear' : 'settle');
    telemetry.event('shell.spec.applied', {
      subsystem: SHELL_SUBSYSTEM,
      level: 'standard',
      attrs: { spec: spec.id, mounted: diff.mount.length, moved: diff.move.length, unmounted: diff.unmount.length, retained: diff.retained.length, failures: failures.length, reduced },
    });
    const applied: SpecApplied = Object.freeze({ spec: validated.value, diff, failures, droppedPins: dropped });
    for (const listener of [...listeners]) listener(applied);
    return ok(applied);
  };

  const pinnable = (key: SpecSlotKey): ResolvedSlot | undefined => {
    const slot = layout.get().slots.find((s) => s.key === key);
    return slot !== undefined && options.vocabulary.section(slot.section)?.pinnable === true ? slot : undefined;
  };

  return {
    get state() {
      return machine.state;
    },
    get layout() {
      return layout.get();
    },
    get spec() {
      return current.get();
    },
    get pinned() {
      return pinned.get();
    },
    validate,
    async preview(spec, o) {
      const validated = await validate(spec, o);
      if (!validated.ok) return validated;
      const { keep } = await checkRetainedPins(validated.value, o);
      return ok({ spec: validated.value, diff: diffSpecs(layout.get(), validated.value, { pinned: keep }) });
    },
    apply: (spec, o) => serialized(() => applyNow(spec, o)),
    revalidate: (o) =>
      serialized(async () => {
        const spec = current.get()?.spec;
        if (spec === undefined) return ok(undefined);
        // Drop slots that are now denied instead of rejecting the whole spec (a denied one-slot section,
        // the lens, still rejects it: the layout then stays as it is).
        const decide = decideOf(o);
        const slots: ShellSpec['slots'][number][] = [];
        for (const request of spec.slots) {
          const gate = options.vocabulary.contribution(request.section, request.id)?.gate;
          const verdict = gate === undefined ? ({ effect: 'allow' } as const) : await decide.decide(gate, o?.signal);
          if (verdict.effect === 'allow') slots.push(request);
        }
        const pins = (spec.pinned ?? []).filter((key) => slots.some((s) => `${s.section}:${s.id}` === key));
        return applyNow({ ...spec, slots, pinned: pins }, o);
      }),
    pin(key) {
      if (pinnable(key) === undefined) return err(SpecSlotError({ message: `Cannot pin "${key}": it is not a mounted slot of a pinnable section.`, details: { slot: key } }));
      pinned.set(new Set([...pinned.get(), key]));
      return ok();
    },
    unpin(key) {
      if (!pinned.get().has(key)) return err(SpecSlotError({ message: `"${key}" is not pinned.`, details: { slot: key } }));
      const next = new Set(pinned.get());
      next.delete(key);
      pinned.set(next);
      return ok();
    },
    onApplied(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (machine.is('disposed')) return;
      await queue;
      const step = specMotionStep(motion, 'unmount', true);
      const slots = [...layout.get().slots].reverse();
      machine.send('dispose');
      lifetime.abort(SpecRuntimeDisposedError());
      const teardown = new AbortController().signal;
      await Promise.all(slots.map((slot) => settle(options.port.unmount(slot, step, teardown))));
      batch(() => {
        layout.set(EMPTY_LAYOUT);
        pinned.set(new Set());
      });
      listeners.clear();
    },
  };
}
