/**
 * Input forwarding (R11.21): main-thread pointer / wheel / keyboard events →
 * timestamped compact input events → (in the render worker or the owner)
 * intents. Timestamps are absolute (`timeOrigin + event.timeStamp`) so latency
 * can be measured on another thread. Pointer moves are coalesced per flush;
 * batches are posted once per microtask so a frame sees all input of a task.
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
  /** Pointer moves merged into this one. */
  readonly n?: number;
}

export interface InputTarget extends EventTarget {
  getBoundingClientRect(): { readonly left: number; readonly top: number };
}

export interface InputForwarderOptions {
  readonly target: InputTarget;
  readonly env: Pick<SurfaceEnvironment, 'now' | 'timeOrigin'>;
  readonly sink: (batch: readonly CompactInputEvent[]) => void;
  /** Coalesce consecutive moves of the same pointer within a flush. Default true. */
  readonly coalesce?: boolean;
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
  readonly forwarded: number;
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

export function createInputForwarder(options: InputForwarderOptions): InputForwarder {
  const { target, env, sink } = options;
  const coalesce = options.coalesce ?? true;
  const schedule = options.schedule ?? ((flush: () => void) => queueMicrotask(flush));
  const keyboardTarget = options.keyboardTarget ?? target;
  let queue: CompactInputEvent[] = [];
  let scheduled = false;
  let forwarded = 0;
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
    forwarded += batch.length;
    sink(batch);
  };
  const push = (event: CompactInputEvent): void => {
    if (coalesce && event.t === InputCode.pointerMove) {
      const last = queue[queue.length - 1];
      if (last !== undefined && last.t === InputCode.pointerMove && last.p === event.p) {
        queue[queue.length - 1] = { ...event, ts: last.ts, n: (last.n ?? 1) + 1 }; // keep the oldest ts (latency)
        return;
      }
    }
    queue.push(event);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
  };

  const onPointer = (raw: Event): void => {
    const event = raw as PointerEvent;
    const code = POINTER_CODES[event.type];
    if (code === undefined) return;
    const rect = target.getBoundingClientRect();
    push({
      t: code,
      ts: timestamp(event),
      x: (event.clientX ?? 0) - rect.left,
      y: (event.clientY ?? 0) - rect.top,
      b: event.buttons ?? 0,
      m: modifiers(event),
      p: event.pointerId ?? 0,
      k: event.pointerType === 'pen' ? PointerKind.pen : event.pointerType === 'touch' ? PointerKind.touch : PointerKind.mouse,
    });
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
