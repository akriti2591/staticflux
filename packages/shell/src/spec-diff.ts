/**
 * Spec diff (R13.27): the minimal change from what is mounted to the next spec, so a new spec (a turn
 * of the agent, a preset, a lens switch) changes only what differs — no full reshuffles (D16).
 *
 * - A slot in both layouts is never unmounted and remounted. If its placement changed, it **moves**.
 * - Within one (section, placement) group, the slots that keep their relative order stay; only the
 *   others move. The kept set is a longest increasing subsequence of old positions, so the number of
 *   moves is the minimum for that reorder.
 * - **Pinned** slots the next spec omits are **retained** at their old place (after the nearest old
 *   predecessor still present). A new spec never removes a pinned slot.
 * - Unmounts are listed in reverse display order, mounts in display order; context changes per key.
 *
 * Pure: `applySpecDiff(current, diff)` is the reference application (it equals `diff.target`).
 */
import { groupKey, type ResolvedSlot, type SpecSlotKey } from './spec-model.js';
import type { ValidatedSpec } from './spec-validate.js';

/** What is mounted: the context and the slots in display order. */
export interface MountedLayout {
  readonly context: Readonly<Record<string, string>>;
  readonly slots: readonly ResolvedSlot[];
}

export const EMPTY_LAYOUT: MountedLayout = Object.freeze({ context: Object.freeze({}), slots: Object.freeze([]) });

export interface SpecMove {
  /** The slot at its new place. */
  readonly slot: ResolvedSlot;
  readonly from: { readonly placement: string; readonly index: number };
  /** Insert after this slot of the target group (undefined: first in the group). See `SpecDiff.after`. */
  readonly after: SpecSlotKey | undefined;
}

export interface SpecContextChange {
  readonly key: string;
  readonly from: string | undefined;
  readonly to: string | undefined;
}

export interface SpecDiff {
  /** Slots to remove, in reverse display order of the current layout. */
  readonly unmount: readonly ResolvedSlot[];
  /** Slots that stay mounted but change placement or position. */
  readonly move: readonly SpecMove[];
  /** Slots to add, in display order of the target layout. */
  readonly mount: readonly ResolvedSlot[];
  /**
   * Insertion anchors for moves and mounts: the nearest preceding slot of the same target group that is
   * already in place when the change is applied in diff order (kept slots, then moves, then mounts, each in
   * display order). A port that inserts each slot right after its anchor (first when undefined) ends up with
   * exactly `target`, without knowing indices of the slots it keeps.
   */
  readonly after: ReadonlyMap<SpecSlotKey, SpecSlotKey | undefined>;
  /** Slots that stay exactly where they are. */
  readonly kept: readonly SpecSlotKey[];
  /** Pinned slots kept although the next spec omits them. */
  readonly retained: readonly SpecSlotKey[];
  readonly context: readonly SpecContextChange[];
  /** The layout after the diff. */
  readonly target: MountedLayout;
  /** True when nothing changes. */
  readonly empty: boolean;
}

export interface DiffSpecsOptions {
  /** Slots the person pinned (the runtime's pin set). */
  readonly pinned?: ReadonlySet<SpecSlotKey>;
}

/** Indices (into `values`) of one longest strictly increasing subsequence. O(n log n). */
export function longestIncreasingSubsequence(values: readonly number[]): readonly number[] {
  const tails: number[] = []; // tails[k] = index into values of the smallest tail of an increasing run of length k + 1
  const previous: number[] = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((values[tails[mid] as number] as number) < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const out: number[] = [];
  let k = tails.length === 0 ? -1 : (tails[tails.length - 1] as number);
  while (k >= 0) {
    out.push(k);
    k = previous[k] as number;
  }
  return out.reverse();
}

const withIndices = (slots: readonly ResolvedSlot[]): ResolvedSlot[] => {
  const counters = new Map<string, number>();
  return slots.map((slot) => {
    const group = groupKey(slot);
    const index = counters.get(group) ?? 0;
    counters.set(group, index + 1);
    return slot.index === index ? slot : Object.freeze({ ...slot, index });
  });
};

/** Insert pinned slots the next spec omits after their nearest old predecessor (same group) that is still there. */
function retainPinned(current: readonly ResolvedSlot[], next: readonly ResolvedSlot[], pinned: ReadonlySet<SpecSlotKey>): { slots: ResolvedSlot[]; retained: SpecSlotKey[] } {
  const slots = [...next];
  const retained: SpecSlotKey[] = [];
  const present = new Set(next.map((s) => s.key));
  current.forEach((slot, position) => {
    if (!pinned.has(slot.key) || present.has(slot.key)) return;
    const group = groupKey(slot);
    let at = -1;
    for (let p = position - 1; p >= 0 && at < 0; p--) {
      const before = current[p] as ResolvedSlot;
      if (groupKey(before) !== group) continue;
      at = slots.findIndex((s) => s.key === before.key && groupKey(s) === group);
      if (at >= 0) at += 1;
    }
    if (at < 0) {
      const first = slots.findIndex((s) => groupKey(s) === group);
      at = first < 0 ? slots.length : first;
    }
    slots.splice(at, 0, slot);
    present.add(slot.key);
    retained.push(slot.key);
  });
  return { slots, retained };
}

/** The minimal diff from `current` to `next` (see the module header). */
export function diffSpecs(current: MountedLayout, next: ValidatedSpec, options: DiffSpecsOptions = {}): SpecDiff {
  const pinned = options.pinned ?? new Set<SpecSlotKey>();
  const { slots: arranged, retained } = retainPinned(current.slots, next.slots, pinned);
  const target = withIndices(arranged);
  const before = new Map(current.slots.map((s) => [s.key, s] as const));
  const inTarget = new Set(target.map((s) => s.key));

  const unmount = current.slots.filter((s) => !inTarget.has(s.key)).reverse();
  const mount = target.filter((s) => !before.has(s.key));

  // Moves: placement changes, then the minimal reorder per group (LIS of old indices).
  const move: SpecMove[] = [];
  const kept: SpecSlotKey[] = [];
  const groups = new Map<string, ResolvedSlot[]>();
  for (const slot of target) {
    const old = before.get(slot.key);
    if (old === undefined) continue;
    if (old.placement !== slot.placement) {
      move.push({ slot, from: { placement: old.placement, index: old.index }, after: undefined });
      continue;
    }
    const list = groups.get(groupKey(slot)) ?? [];
    list.push(slot);
    groups.set(groupKey(slot), list);
  }
  for (const list of groups.values()) {
    const oldIndices = list.map((s) => (before.get(s.key) as ResolvedSlot).index);
    const stay = new Set(longestIncreasingSubsequence(oldIndices));
    list.forEach((slot, i) => {
      const old = before.get(slot.key) as ResolvedSlot;
      if (stay.has(i)) kept.push(slot.key);
      else move.push({ slot, from: { placement: old.placement, index: old.index }, after: undefined });
    });
  }
  const order = new Map(target.map((s, i) => [s.key, i] as const));
  const sortedMoves = move.sort((a, b) => (order.get(a.slot.key) as number) - (order.get(b.slot.key) as number));

  const placed = new Set<SpecSlotKey>(kept);
  const after = new Map<SpecSlotKey, SpecSlotKey | undefined>();
  const anchor = (slot: ResolvedSlot): SpecSlotKey | undefined => {
    let found: SpecSlotKey | undefined;
    for (let i = (order.get(slot.key) as number) - 1; i >= 0 && found === undefined; i--) {
      const candidate = target[i] as ResolvedSlot;
      if (groupKey(candidate) === groupKey(slot) && placed.has(candidate.key)) found = candidate.key;
    }
    placed.add(slot.key);
    return found;
  };
  const moves: SpecMove[] = sortedMoves.map((m) => {
    const at = anchor(m.slot);
    after.set(m.slot.key, at);
    return Object.freeze({ ...m, after: at });
  });
  for (const slot of mount) after.set(slot.key, anchor(slot));

  const context: SpecContextChange[] = [];
  for (const key of new Set([...Object.keys(current.context), ...Object.keys(next.context)])) {
    const from = current.context[key];
    const to = next.context[key];
    if (from !== to) context.push({ key, from, to });
  }

  const layout: MountedLayout = Object.freeze({ context: next.context, slots: Object.freeze(target) });
  return Object.freeze({
    unmount,
    move: moves,
    mount,
    after,
    kept,
    retained,
    context,
    target: layout,
    empty: unmount.length === 0 && moves.length === 0 && mount.length === 0 && context.length === 0,
  });
}

/** The slot keys of each (section, placement) group, in order: the comparable shape of a layout. */
export function layoutGroups(layout: MountedLayout): Readonly<Record<string, readonly SpecSlotKey[]>> {
  const out: Record<string, SpecSlotKey[]> = {};
  const sorted = [...layout.slots].sort((a, b) => a.index - b.index);
  for (const slot of sorted) (out[groupKey(slot)] ??= []).push(slot.key);
  return out;
}

/**
 * Reference application of a diff (pure), the way a mount port sees it: remove `unmount`, take every
 * `move` out of its old group, then insert moves and mounts (in that order) right after their anchor
 * (`diff.after`), or first in their group. The result's `layoutGroups` equal `diff.target`'s.
 */
export function applySpecDiff(current: MountedLayout, diff: SpecDiff): MountedLayout {
  const removed = new Set<SpecSlotKey>([...diff.unmount.map((s) => s.key), ...diff.move.map((m) => m.slot.key)]);
  const groups = new Map<string, ResolvedSlot[]>();
  for (const slot of [...current.slots].sort((a, b) => a.index - b.index)) {
    if (removed.has(slot.key)) continue;
    const list = groups.get(groupKey(slot)) ?? [];
    list.push(slot);
    groups.set(groupKey(slot), list);
  }
  for (const slot of [...diff.move.map((m) => m.slot), ...diff.mount]) {
    const list = groups.get(groupKey(slot)) ?? [];
    const anchor = diff.after.get(slot.key);
    const at = anchor === undefined ? 0 : list.findIndex((s) => s.key === anchor) + 1;
    list.splice(at, 0, slot);
    groups.set(groupKey(slot), list);
  }
  const slots = [...groups.values()].flatMap((list) => list.map((slot, index) => (slot.index === index ? slot : Object.freeze({ ...slot, index }))));
  return { context: diff.target.context, slots };
}
