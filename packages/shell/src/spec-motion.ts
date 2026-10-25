/**
 * Motion for spec diffs (R13.28): every mount, move and unmount gets a 120–200 ms step (UX: "Motion is
 * 120–200 ms, respects reduced motion"). Under reduced motion every step is 0 ms, so a mount port that
 * animates with the step's duration simply swaps instantly.
 */

/** Motion for one change, handed to the mount port. */
export interface SpecMotionStep {
  readonly durationMs: number;
  /** CSS easing (`cubic-bezier(…)`); ignored at 0 ms. */
  readonly easing: string;
  readonly reduced: boolean;
}

export type SpecChangeKind = 'mount' | 'move' | 'unmount' | 'context';

export interface SpecMotion {
  readonly enterMs: number;
  readonly moveMs: number;
  readonly exitMs: number;
  readonly contextMs: number;
  readonly easing: string;
}

export const SPEC_MOTION_MIN_MS = 120;
export const SPEC_MOTION_MAX_MS = 200;

/** Enter 160 ms, move 200 ms, exit 120 ms, context (lens, density) 160 ms; standard easing. */
export const DEFAULT_SPEC_MOTION: SpecMotion = Object.freeze({
  enterMs: 160,
  moveMs: 200,
  exitMs: 120,
  contextMs: 160,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
});

const clamp = (ms: number): number => Math.min(SPEC_MOTION_MAX_MS, Math.max(SPEC_MOTION_MIN_MS, Number.isFinite(ms) ? ms : SPEC_MOTION_MIN_MS));

/** Keep every duration inside 120–200 ms. */
export function clampSpecMotion(motion: Partial<SpecMotion>): SpecMotion {
  const merged = { ...DEFAULT_SPEC_MOTION, ...motion };
  return Object.freeze({
    enterMs: clamp(merged.enterMs),
    moveMs: clamp(merged.moveMs),
    exitMs: clamp(merged.exitMs),
    contextMs: clamp(merged.contextMs),
    easing: merged.easing,
  });
}

const DURATION: Readonly<Record<SpecChangeKind, keyof Omit<SpecMotion, 'easing'>>> = {
  mount: 'enterMs',
  move: 'moveMs',
  unmount: 'exitMs',
  context: 'contextMs',
};

/** The step for one change; 0 ms when `reduced`. */
export function specMotionStep(motion: SpecMotion, kind: SpecChangeKind, reduced: boolean): SpecMotionStep {
  return { durationMs: reduced ? 0 : motion[DURATION[kind]], easing: motion.easing, reduced };
}
