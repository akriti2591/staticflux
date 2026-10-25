/**
 * Resize handles (WAI-ARIA window splitter: `role="separator"`, focusable, with
 * `aria-valuenow/min/max`): pointer drag with pointer capture and keyboard steps
 * (arrows ±16 px, Shift ±64 px, Home/End = min/max, Enter toggles collapse). Every drag
 * runs the `kit/resize` machine (idle → resizing → idle) and ends with one `onCommit`.
 */
import { createMachine, defineMachine } from '@staticflux/core';
import { directionOf } from './direction.js';

export const resizeMachine = defineMachine({
  id: 'kit/resize',
  initial: 'idle',
  states: ['idle', 'resizing'],
  transitions: {
    idle: { start: 'resizing' },
    resizing: { move: 'resizing', end: 'idle', cancel: 'idle' },
  },
});

export const clampSize = (size: number, min: number, max: number): number => Math.round(Math.min(Math.max(size, min), Math.max(min, max)));

/**
 * The new size for a handle on the `edge` of a box: dragging toward the outside grows it.
 * `edge` is logical (`inline-start` | `inline-end` | `block-end`); RTL flips inline edges.
 */
export function sizeFromDrag(start: number, delta: { readonly x: number; readonly y: number }, edge: 'inline-start' | 'inline-end' | 'block-end', dir: 'ltr' | 'rtl'): number {
  if (edge === 'block-end') return start + delta.y;
  const towardEnd = dir === 'rtl' ? -delta.x : delta.x;
  return edge === 'inline-end' ? start + towardEnd : start - towardEnd;
}

/** Keyboard resize step for `key` (undefined: not a resize key). */
export function sizeFromKey(size: number, key: string, shift: boolean, edge: 'inline-start' | 'inline-end' | 'block-end', dir: 'ltr' | 'rtl', bounds: { readonly min: number; readonly max: number }): number | undefined {
  const step = shift ? 64 : 16;
  if (key === 'Home') return bounds.min;
  if (key === 'End') return bounds.max;
  if (edge === 'block-end') {
    if (key === 'ArrowDown') return size + step;
    if (key === 'ArrowUp') return size - step;
    return undefined;
  }
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined;
  const towardEnd = (key === 'ArrowRight') !== (dir === 'rtl');
  return edge === 'inline-end' ? size + (towardEnd ? step : -step) : size + (towardEnd ? -step : step);
}

export interface ResizeHandleOptions {
  readonly edge: () => 'inline-start' | 'inline-end' | 'block-end';
  readonly size: () => number;
  readonly bounds: () => { readonly min: number; readonly max: number };
  /** Live size while dragging. */
  readonly onResize: (size: number) => void;
  /** Final size (drag end or keyboard step). */
  readonly onCommit: (size: number) => void;
  readonly onToggle?: () => void;
}

/** Wire pointer and keyboard resizing on `handle` until `signal` aborts. */
export function attachResizeHandle(handle: HTMLElement, options: ResizeHandleOptions, signal: AbortSignal): void {
  const machine = createMachine(resizeMachine);
  let origin = { x: 0, y: 0, size: 0 };
  let last = 0;
  const resolve = (size: number): number => {
    const { min, max } = options.bounds();
    return clampSize(size, min, max);
  };
  handle.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      machine.send('start');
      origin = { x: event.clientX, y: event.clientY, size: options.size() };
      last = origin.size;
      handle.setPointerCapture?.(event.pointerId);
      handle.toggleAttribute('data-resizing', true);
    },
    { signal },
  );
  handle.addEventListener(
    'pointermove',
    (event) => {
      if (!machine.is('resizing')) return;
      machine.send('move');
      last = resolve(sizeFromDrag(origin.size, { x: event.clientX - origin.x, y: event.clientY - origin.y }, options.edge(), directionOf(handle)));
      options.onResize(last);
    },
    { signal },
  );
  const finish = (commit: boolean): void => {
    if (!machine.is('resizing')) return;
    machine.send(commit ? 'end' : 'cancel');
    handle.toggleAttribute('data-resizing', false);
    if (commit) options.onCommit(last);
    else options.onResize(origin.size);
  };
  handle.addEventListener('pointerup', () => finish(true), { signal });
  handle.addEventListener('pointercancel', () => finish(false), { signal });
  handle.addEventListener('lostpointercapture', () => finish(true), { signal });
  handle.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && options.onToggle !== undefined) {
        event.preventDefault();
        options.onToggle();
        return;
      }
      const next = sizeFromKey(options.size(), event.key, event.shiftKey, options.edge(), directionOf(handle), options.bounds());
      if (next === undefined) return;
      event.preventDefault();
      options.onCommit(resolve(next));
    },
    { signal },
  );
}
