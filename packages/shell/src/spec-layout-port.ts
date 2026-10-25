/**
 * A reactive layout model that is a `SpecMountPort` (R13.28): the runtime drives it, a view renders
 * from it. Each (section, placement) group is an ordered list of entries with a motion **phase**:
 * `entering` → `present` after the step's duration, `moving` → `present`, `exiting` → removed. Exiting
 * entries stay in place while they animate out, so a view can play the exit; `groups()` lists only the
 * slots that are (or are becoming) mounted. Durations come from the runtime's motion steps (0 under
 * reduced motion: the phase settles in the same task). Aborting a step settles it at once.
 *
 * @example
 * const port = createSpecLayoutPort();
 * const runtime = createSpecRuntime({ vocabulary, port });
 * // in a Lit element (MobX-tracked render):
 * port.entries('tool@default').map((e) => html`<sf-button data-phase=${e.phase}>${e.slot.contribution.label}</sf-button>`);
 */
import { batch, box, ok, type Result, sleep } from '@staticflux/core';
import type { SpecContextChange } from './spec-diff.js';
import { groupKey, type ResolvedSlot, type SpecSlotKey } from './spec-model.js';
import type { SpecMotionStep } from './spec-motion.js';
import type { SpecMountPort } from './spec-runtime.js';

export type SpecSlotPhase = 'entering' | 'present' | 'moving' | 'exiting';

export interface SpecLayoutEntry {
  readonly slot: ResolvedSlot;
  readonly phase: SpecSlotPhase;
  readonly step: SpecMotionStep;
}

export interface SpecLayoutPort extends SpecMountPort {
  /** Reactive: the entries of one group in display order, exiting ones included. */
  entries(group: string): readonly SpecLayoutEntry[];
  /** Reactive: every group's mounted slot keys (exiting ones excluded). */
  groups(): Readonly<Record<string, readonly SpecSlotKey[]>>;
  /** Reactive: the mounted context (lens, scope, density). */
  readonly mountedContext: Readonly<Record<string, string>>;
  /** Reactive: the motion of the last context change (a view cross-fades with it). */
  readonly contextStep: SpecMotionStep | undefined;
}

export interface SpecLayoutPortOptions {
  /** Wait for a motion step (default core `sleep`; tests inject a fake clock). */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<Result<void>>;
}

type Groups = ReadonlyMap<string, readonly SpecLayoutEntry[]>;

export function createSpecLayoutPort(options: SpecLayoutPortOptions = {}): SpecLayoutPort {
  const wait = options.wait ?? sleep;
  const state = box<Groups>(new Map());
  const context = box<Readonly<Record<string, string>>>({});
  const contextStep = box<SpecMotionStep | undefined>(undefined);

  const update = (group: string, fn: (list: SpecLayoutEntry[]) => SpecLayoutEntry[]): void => {
    const next = new Map(state.get());
    const list = fn([...(next.get(group) ?? [])]);
    if (list.length === 0) next.delete(group);
    else next.set(group, list);
    state.set(next);
  };
  const insert = (slot: ResolvedSlot, after: SpecSlotKey | undefined, phase: SpecSlotPhase, step: SpecMotionStep): void => {
    update(groupKey(slot), (list) => {
      const at = after === undefined ? 0 : list.findIndex((e) => e.slot.key === after && e.phase !== 'exiting') + 1;
      list.splice(at, 0, { slot, phase, step });
      return list;
    });
  };
  const remove = (key: SpecSlotKey, group: string): void => update(group, (list) => list.filter((e) => e.slot.key !== key));
  const settleTo = async (step: SpecMotionStep, signal: AbortSignal, done: () => void): Promise<Result<void>> => {
    if (step.durationMs > 0 && !signal.aborted) await wait(step.durationMs, signal);
    done();
    return ok();
  };
  const setPhase = (slot: ResolvedSlot, phase: SpecSlotPhase): void =>
    update(groupKey(slot), (list) => list.map((e) => (e.slot.key === slot.key && e.phase !== 'exiting' ? { ...e, phase } : e)));

  return {
    entries: (group) => state.get().get(group) ?? [],
    groups() {
      const out: Record<string, SpecSlotKey[]> = {};
      for (const [group, list] of state.get()) {
        const keys = list.filter((e) => e.phase !== 'exiting').map((e) => e.slot.key);
        if (keys.length > 0) out[group] = keys;
      }
      return out;
    },
    get mountedContext() {
      return context.get();
    },
    get contextStep() {
      return contextStep.get();
    },
    mount(slot, after, step, signal) {
      insert(slot, after, step.durationMs > 0 ? 'entering' : 'present', step);
      return settleTo(step, signal, () => setPhase(slot, 'present'));
    },
    move(move, step, signal) {
      batch(() => {
        const old = groupKey({ section: move.slot.section, placement: move.from.placement });
        update(old, (list) => list.filter((e) => e.slot.key !== move.slot.key || e.phase === 'exiting'));
        insert(move.slot, move.after, step.durationMs > 0 ? 'moving' : 'present', step);
      });
      return settleTo(step, signal, () => setPhase(move.slot, 'present'));
    },
    unmount(slot, step, signal) {
      if (step.durationMs <= 0) {
        remove(slot.key, groupKey(slot));
        return ok();
      }
      update(groupKey(slot), (list) => list.map((e) => (e.slot.key === slot.key ? { ...e, phase: 'exiting', step } : e)));
      return settleTo(step, signal, () => update(groupKey(slot), (list) => list.filter((e) => !(e.slot.key === slot.key && e.phase === 'exiting'))));
    },
    context(_changes: readonly SpecContextChange[], next: Readonly<Record<string, string>>, step: SpecMotionStep) {
      batch(() => {
        context.set(next);
        contextStep.set(step);
      });
      return ok();
    },
  };
}
