/**
 * Epoch port. The runtime bumps the app epoch on refresh (R4.3); the data layer
 * tags every request with the epoch it started in and discards responses whose
 * epoch is older when they arrive (I-10, `SF-DATA-001`).
 */
import { box } from '@staticflux/core';

export interface EpochSource {
  /** Current epoch. Reactive (reads are tracked). */
  readonly current: number;
}

export interface MutableEpochSource extends EpochSource {
  /** Advance the epoch (normally driven by the runtime's `refresh`). */
  bump(): number;
}

/** A standalone epoch source (tests, apps without the runtime). */
export function createEpochSource(initial = 0): MutableEpochSource {
  const value = box(initial);
  return {
    get current() {
      return value.get();
    },
    bump() {
      value.set(value.get() + 1);
      return value.get();
    },
  };
}

/** An epoch source that never changes. */
export const FIXED_EPOCH: EpochSource = Object.freeze({ current: 0 });
