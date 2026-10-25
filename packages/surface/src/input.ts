/**
 * Input forwarding (R11.21, SF-Δ22): main-thread pointer / wheel / keyboard
 * events → timestamped compact input events → (in the editor or render worker)
 * intents. Timestamps are absolute (`timeOrigin + event.timeStamp`) so latency
 * can be measured on another thread.
 *
 * Fidelity (SF-Δ22):
 * - **Lossless points.** A `pointermove` expands into every sample of
 *   `getCoalescedEvents()` (flag `coalesced` on the extra samples), so pens and
 *   fast strokes keep every point the platform measured.
 * - **Pen data.** `pressure`, `tangentialPressure`, `tiltX/Y`, `twist`, contact
 *   `width/height` and `isPrimary` travel when the platform reports them.
 * - **Predicted points** from `getPredictedEvents()` are flagged `predicted` and only
 *   reach sinks that opt in (they are guesses: draw them, never commit them).
 * - **Several sinks, coalescing per sink.** The binary input ring (`input-ring.ts`)
 *   takes every sample; a main-thread overlay can take coalesced moves.
 *
 * Batches are delivered once per microtask (a frame sees all input of a task) with
 * a monotonic batch sequence (`inputSeq`, ARCHITECTURE §4).
 */
import type { SurfaceEnvironment } from './env.js';

export const InputCode = {
  pointerDown: 1,
  pointerMove: 2,
  pointerUp: 3,
  pointerCancel: 4,
  wheel: 5,
  keyDown: 6,
  keyUp: 7,
} as const;
export type InputCode = (typeof InputCode)[keyof typeof InputCode];

/** Modifier bits in `m`. */
export const InputModifier = { shift: 1, ctrl: 2, alt: 4, meta: 8 } as const;

export const PointerKind = { mouse: 0, pen: 1, touch: 2 } as const;

/** Sample flags in `f`. */
export const InputFlag = {
  /** An extra sample from `getCoalescedEvents()` (not the dispatched event itself). */
  coalesced: 1,
  /** A predicted sample from `getPredictedEvents()`: draw, never commit. */
  predicted: 2,
  /** `isPrimary` pointer. */
  primary: 4,
} as const;

/** Compact, structured-clone-cheap input event. Coordinates are CSS px relative to the surface. */
export interface CompactInputEvent {
  readonly t: InputCode;
  /** Absolute timestamp (ms): `timeOrigin + timeStamp`. */
  readonly ts: number;
  readonly x: number;
  readonly y: number;
  /** Pointer buttons bitmask. */
  readonly b: number;
  /** Modifier bits (`InputModifier`). */
  readonly m: number;
  /** Pointer id (pointer events). */
  readonly p?: number;
  /** Pointer kind (`PointerKind`). */
  readonly k?: number;
  /** Wheel deltas (px). */
  readonly dx?: number;
  readonly dy?: number;
  /** KeyboardEvent.key / .code. */
  readonly key?: string;
  readonly code?: string;
  /** Pointer moves merged into this one (coalescing sinks). */
  readonly n?: number;
  /** Sample flags (`InputFlag`), when any. */
  readonly f?: number;
  /** Pen and touch data (present when the platform reports them). */
  readonly pr?: number;
  readonly tp?: number;
  readonly tx?: number;
  readonly ty?: number;
  readonly tw?: number;
  readonly w?: number;
  readonly h?: number;
}

export interface InputTarget extends EventTarget {
  getBoundingClientRect(): { readonly left: number; readonly top: number };
}

/** Per-batch information for sinks. */
export interface InputBatchInfo {
  /** Monotonic batch sequence (`inputSeq`). */
  readonly seq: number;
}

/** One consumer of forwarded input. */
export interface InputSink {
  readonly deliver: (batch: readonly CompactInputEvent[], info: InputBatchInfo) => void;
  /** Merge consecutive moves of one pointer per batch (latest position, oldest ts, `n`). Default false (lossless). */
  readonly coalesce?: boolean;
  /** Receive predicted samples (flagged). Default false. */
  readonly predicted?: boolean;
}

export interface InputForwarderOptions {
  readonly target: InputTarget;
  readonly env: Pick<SurfaceEnvironment, 'now' | 'timeOrigin'>;
  /** Single consumer (coalesced by default; see `coalesce`). */
  readonly sink?: (batch: readonly CompactInputEvent[]) => void;
  /** `sink` only: coalesce consecutive moves of the same pointer within a flush. Default true. */
  readonly coalesce?: boolean;
  /** Further consumers, each with its own coalescing and prediction choice. */
  readonly sinks?: readonly InputSink[];
  /** Expand `getCoalescedEvents()` into individual samples. Default true. */
  readonly coalescedEvents?: boolean;
  /** Keyboard events come from here (focusable canvas or the document). Default `target`. */
  readonly keyboardTarget?: EventTarget;
  /** Call preventDefault on wheel (surface owns scrolling). Default false. */
  readonly captureWheel?: boolean;
  /** Schedules the flush. Default `queueMicrotask`. */
  readonly schedule?: (flush: () => void) => void;
}

export interface InputForwarder {
  /** Post queued events now. */
  flush(): void;
  /** Samples produced (before per-sink coalescing). */
  readonly forwarded: number;
  /** Batches delivered (the last `inputSeq`). */
  readonly batches: number;
  dispose(): void;
}

function modifiers(event: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): number {
  return (
    (event.shiftKey === true ? InputModifier.shift : 0) |
    (event.ctrlKey === true ? InputModifier.ctrl : 0) |
    (event.altKey === true ? InputModifier.alt : 0) |
    (event.metaKey === true ? InputModifier.meta : 0)
  );
}

const POINTER_CODES: Readonly<Record<string, InputCode>> = {
  pointerdown: InputCode.pointerDown,
  pointermove: InputCode.pointerMove,
  pointerup: InputCode.pointerUp,
  pointercancel: InputCode.pointerCancel,
};

/** Pen/touch fields in the compact event, keyed by PointerEvent property. */
const FIDELITY = [
  ['pressure', 'pr'],
  ['tangentialPressure', 'tp'],
  ['tiltX', 'tx'],
  ['tiltY', 'ty'],
  ['twist', 'tw'],
  ['width', 'w'],
  ['height', 'h'],
] as const;

type PointerLike = PointerEvent & {
  getCoalescedEvents?: () => PointerEvent[];
  getPredictedEvents?: () => PointerEvent[];
};

/**
 * Merge consecutive moves of the same pointer (keeps the latest sample, the oldest
 * timestamp for latency, and the merged count in `n`). Predicted samples are dropped
 * unless `predicted` is true, and never merged.
 */
export function coalesceInput(events: readonly CompactInputEvent[], options: { readonly predicted?: boolean } = {}): CompactInputEvent[] {
  const out: CompactInputEvent[] = [];
  for (const event of events) {
    const predicted = ((event.f ?? 0) & InputFlag.predicted) !== 0;
    if (predicted && options.predicted !== true) continue;
    const last = out[out.length - 1];
    const lastPredicted = ((last?.f ?? 0) & InputFlag.predicted) !== 0;
    if (!predicted && !lastPredicted && last !== undefined && event.t === InputCode.pointerMove && last.t === InputCode.pointerMove && last.p === event.p) {
      out[out.length - 1] = { ...event, ts: last.ts, n: (last.n ?? 1) + (event.n ?? 1) };
      continue;
    }
    out.push(event);
  }
  return out;
}

export function createInputForwarder(options: InputForwarderOptions): InputForwarder {
  const { target, env } = options;
  const schedule = options.schedule ?? ((flush: () => void) => queueMicrotask(flush));
  const keyboardTarget = options.keyboardTarget ?? target;
  const expandCoalesced = options.coalescedEvents ?? true;
  const sinks: InputSink[] = [...(options.sinks ?? [])];
  if (options.sink !== undefined) sinks.unshift({ deliver: options.sink, coalesce: options.coalesce ?? true });
  const wantsPredicted = sinks.some((sink) => sink.predicted === true);
  let queue: CompactInputEvent[] = [];
  let scheduled = false;
  let forwarded = 0;
  let batches = 0;
  let disposed = false;

  const timestamp = (event: Event): number => {
    const stamp = typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : env.now();
    return env.timeOrigin + stamp;
  };
  const flush = (): void => {
    scheduled = false;
    if (queue.length === 0 || disposed) return;
    const batch = queue;
    queue = [];
    batches += 1;
    const info: InputBatchInfo = { seq: batches };
    for (const sink of sinks) {
      const view = sink.coalesce === true ? coalesceInput(batch, sink) : sink.predicted === true ? batch : batch.filter((e) => ((e.f ?? 0) & InputFlag.predicted) === 0);
      if (view.length > 0) sink.deliver(view, info);
    }
  };
  const push = (event: CompactInputEvent): void => {
    forwarded += 1;
    queue.push(event);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  };

  const sample = (code: InputCode, event: PointerEvent, flags: number): CompactInputEvent => {
    const rect = target.getBoundingClientRect();
    const out: Record<string, number> = {
      t: code,
      ts: timestamp(event),
      x: (event.clientX ?? 0) - rect.left,
      y: (event.clientY ?? 0) - rect.top,
      b: event.buttons ?? 0,
      m: modifiers(event),
      p: event.pointerId ?? 0,
      k: event.pointerType === 'pen' ? PointerKind.pen : event.pointerType === 'touch' ? PointerKind.touch : PointerKind.mouse,
    };
    for (const [property, key] of FIDELITY) {
      const value = (event as unknown as Record<string, unknown>)[property];
      if (typeof value === 'number') out[key] = value;
    }
    const f = flags | (event.isPrimary === true ? InputFlag.primary : 0);
    if (f !== 0) out['f'] = f;
    return out as unknown as CompactInputEvent;
  };

  const onPointer = (raw: Event): void => {
    const event = raw as PointerLike;
    const code = POINTER_CODES[event.type];
    if (code === undefined) return;
    if (code === InputCode.pointerMove && expandCoalesced && typeof event.getCoalescedEvents === 'function') {
      const coalesced = event.getCoalescedEvents();
      // Every measured sample; the dispatched event is the last one.
      for (let i = 0; i < coalesced.length - 1; i++) push(sample(code, coalesced[i] as PointerEvent, InputFlag.coalesced));
    }
    push(sample(code, event, 0));
    if (code === InputCode.pointerMove && wantsPredicted && typeof event.getPredictedEvents === 'function') {
      for (const predicted of event.getPredictedEvents()) push(sample(code, predicted, InputFlag.predicted));
    }
  };
  const onWheel = (raw: Event): void => {
    const event = raw as WheelEvent;
    if (options.captureWheel === true) event.preventDefault();
    const rect = target.getBoundingClientRect();
    // deltaMode 1 = lines, 2 = pages → px (approximation used by browsers).
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
    push({
      t: InputCode.wheel,
      ts: timestamp(event),
      x: (event.clientX ?? 0) - rect.left,
      y: (event.clientY ?? 0) - rect.top,
      b: event.buttons ?? 0,
      m: modifiers(event),
      dx: (event.deltaX ?? 0) * scale,
      dy: (event.deltaY ?? 0) * scale,
    });
  };
  const onKey = (raw: Event): void => {
    const event = raw as KeyboardEvent;
    push({
      t: event.type === 'keydown' ? InputCode.keyDown : InputCode.keyUp,
      ts: timestamp(event),
      x: 0,
      y: 0,
      b: 0,
      m: modifiers(event),
      key: event.key,
      code: event.code,
    });
  };

  const pointerTypes = Object.keys(POINTER_CODES);
  // Aborted in dispose() to remove every input listener.
  const listeners = new AbortController();
  for (const type of pointerTypes) target.addEventListener(type, onPointer, { signal: listeners.signal });
  target.addEventListener('wheel', onWheel, { passive: options.captureWheel !== true, signal: listeners.signal });
  keyboardTarget.addEventListener('keydown', onKey, { signal: listeners.signal });
  keyboardTarget.addEventListener('keyup', onKey, { signal: listeners.signal });

  return {
    flush,
    get forwarded() {
      return forwarded;
    },
    get batches() {
      return batches;
    },
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      listeners.abort();
      queue = [];
    },
  };
}

// ---------------------------------------------------------------- intents

export interface InputIntentContext {
  readonly surfaceId: string;
  readonly size: { readonly width: number; readonly height: number; readonly dpr: number };
}

/** Maps one compact input event to zero or more intents (e.g. `replica.intent('select', …)` payloads). */
export type InputIntentMapper<Intent> = (event: CompactInputEvent, context: InputIntentContext) => Intent | readonly Intent[] | undefined;

export function mapInputToIntents<Intent>(
  events: readonly CompactInputEvent[],
  mapper: InputIntentMapper<Intent>,
  context: InputIntentContext,
): Intent[] {
  const intents: Intent[] = [];
  for (const event of events) {
    const mapped = mapper(event, context);
    if (mapped === undefined) continue;
    if (Array.isArray(mapped)) intents.push(...(mapped as readonly Intent[]));
    else intents.push(mapped as Intent);
  }
  return intents;
}

/** Oldest timestamp in a batch (for input-to-frame latency). */
export function oldestTimestamp(events: readonly CompactInputEvent[]): number | undefined {
  let oldest: number | undefined;
  for (const event of events) oldest = oldest === undefined ? event.ts : Math.min(oldest, event.ts);
  return oldest;
}
