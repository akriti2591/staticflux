/**
 * Layout slots and slot contributions (R13.1, R3.1).
 *
 * Slots are an open set: the built-ins are `header`, `sidebar`, `main`, `panel`;
 * packages add more via declaration merging:
 *
 *   declare module '@staticflux/core' { interface Registry { slots: { 'status-bar': true } } }
 *
 * Features fill slots by contributing to the `SlotContributionsToken` multi token
 * (`slotContribution({...})` wraps core `contribution()`), never by touching the DOM.
 */
import { contribution, type Registry, token } from '@staticflux/core';
import type { GateResource } from '@staticflux/ui';

export const BUILT_IN_SLOTS = ['header', 'sidebar', 'main', 'panel'] as const;
export type BuiltInSlot = (typeof BUILT_IN_SLOTS)[number];
type RegisteredSlots = Registry extends { readonly slots: infer S } ? Extract<keyof S, string> : never;
export type SlotId = BuiltInSlot | RegisteredSlots;

export type ContributionId = `${string}/${string}`;

export interface SlotContribution {
  readonly id: ContributionId;
  readonly slot: SlotId;
  /** Ascending order within the slot (default 0). */
  readonly order?: number;
  /** The region content (typically a feature's root component). */
  readonly render: () => unknown;
  /** Accessible name of the contribution's region. */
  readonly label?: string;
  /**
   * `true` (default): shown in every workspace unless one removes it.
   * `false`: opt-in — shown only when the active workspace adds or swaps it in.
   */
  readonly byDefault?: boolean;
  /** Gate resource: hidden until allowed (never shown before the decision). */
  readonly gate?: GateResource;
}

/** Multi token: every slot contribution of the app. */
export const SlotContributionsToken = token('shell/slot-contributions').multi<SlotContribution>();

/** Declare a slot contribution as a DI unit (one item of `SlotContributionsToken`). */
export function slotContribution(item: SlotContribution) {
  return contribution({
    id: `${item.id}-slot`,
    provides: SlotContributionsToken,
    scope: 'app',
    ...(item.order === undefined ? {} : { order: item.order }),
    create: () => item,
    description: `Fills shell slot "${item.slot}" with ${item.id}.`,
  });
}
