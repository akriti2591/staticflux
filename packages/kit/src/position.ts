/**
 * `@staticflux/kit/position` — anchored placement for menus, popovers and tooltips.
 *
 * - **CSS anchor positioning** when the browser supports it (`anchor-name`,
 *   `position-area`, `position-try-fallbacks`) and anchor and floating element share a
 *   tree scope (anchor names are tree-scoped): the browser places and flips, no JS per frame.
 * - **JS fallback** everywhere else (the framework is not Chrome-only): `computePosition`
 *   (pure, logical sides, RTL-aware, flips when the preferred side overflows, clamps to the
 *   viewport) re-run on scroll, resize and size changes, batched to one frame.
 */
import { directionOf } from './internal/direction.js';

export type Side = 'block-start' | 'block-end' | 'inline-start' | 'inline-end';
export type Align = 'start' | 'center' | 'end';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PositionInput {
  readonly anchor: Box;
  readonly floating: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly side: Side;
  readonly align?: Align;
  /** Gap between anchor and floating element (px). Default 4. */
  readonly offset?: number;
  /** Minimum distance to the viewport edge (px). Default 8. */
  readonly padding?: number;
  readonly dir?: 'ltr' | 'rtl';
}

export interface PositionResult {
  readonly x: number;
  readonly y: number;
  /** The side actually used (after flipping). */
  readonly side: Side;
}

const OPPOSITE: Readonly<Record<Side, Side>> = { 'block-start': 'block-end', 'block-end': 'block-start', 'inline-start': 'inline-end', 'inline-end': 'inline-start' };

type Physical = 'top' | 'bottom' | 'left' | 'right';

function physical(side: Side, rtl: boolean): Physical {
  if (side === 'block-start') return 'top';
  if (side === 'block-end') return 'bottom';
  if (side === 'inline-start') return rtl ? 'right' : 'left';
  return rtl ? 'left' : 'right';
}

const clamp = (value: number, min: number, max: number): number => (max < min ? min : Math.min(Math.max(value, min), max));

/** Place a floating box next to an anchor box (pure; viewport coordinates). */
export function computePosition(input: PositionInput): PositionResult {
  const { anchor: a, floating: f, viewport: v } = input;
  const offset = input.offset ?? 4;
  const pad = input.padding ?? 8;
  const rtl = input.dir === 'rtl';
  const align = input.align ?? 'start';
  const space: Record<Physical, number> = {
    top: a.y - pad,
    bottom: v.height - (a.y + a.height) - pad,
    left: a.x - pad,
    right: v.width - (a.x + a.width) - pad,
  };
  const need = (p: Physical): number => (p === 'top' || p === 'bottom' ? f.height : f.width) + offset;
  let side = input.side;
  const preferred = physical(side, rtl);
  const flipped = physical(OPPOSITE[side], rtl);
  if (space[preferred] < need(preferred) && space[flipped] > space[preferred]) side = OPPOSITE[side];
  const p = physical(side, rtl);
  let x: number;
  let y: number;
  if (p === 'top' || p === 'bottom') {
    y = p === 'bottom' ? a.y + a.height + offset : a.y - f.height - offset;
    const startX = rtl ? a.x + a.width - f.width : a.x;
    const endX = rtl ? a.x : a.x + a.width - f.width;
    x = align === 'center' ? a.x + (a.width - f.width) / 2 : align === 'start' ? startX : endX;
    x = clamp(x, pad, v.width - f.width - pad);
    y = clamp(y, pad, v.height - f.height - pad);
  } else {
    x = p === 'right' ? a.x + a.width + offset : a.x - f.width - offset;
    y = align === 'center' ? a.y + (a.height - f.height) / 2 : align === 'start' ? a.y : a.y + a.height - f.height;
    y = clamp(y, pad, v.height - f.height - pad);
    x = clamp(x, pad, v.width - f.width - pad);
  }
  return { x: Math.round(x), y: Math.round(y), side };
}

interface CssLike {
  supports(declaration: string): boolean;
}

/** CSS anchor positioning available (`anchor-name` + `position-area`). */
export function supportsAnchorPositioning(css: CssLike | undefined = (globalThis as { CSS?: CssLike }).CSS): boolean {
  if (css === undefined || typeof css.supports !== 'function') return false;
  return css.supports('anchor-name: --sf-probe') && css.supports('position-area: block-end');
}

/** `position-area` value for a side + alignment (e.g. `block-end span-inline-end`). */
export function positionArea(side: Side, align: Align): string {
  if (align === 'center') return side;
  const crossStart = side.startsWith('block') ? 'inline-start' : 'block-start';
  const crossEnd = side.startsWith('block') ? 'inline-end' : 'block-end';
  return `${side} span-${align === 'start' ? crossEnd : crossStart}`;
}

export interface AnchorOptions {
  readonly side?: Side;
  readonly align?: Align;
  readonly offset?: number;
  /** Force the JS fallback (tests, embedders that cannot rely on anchor names). */
  readonly forceFallback?: boolean;
}

export interface AnchorHandle {
  readonly mode: 'css' | 'js';
  /** Re-measure now (JS mode); no-op in CSS mode. */
  update(): void;
  stop(): void;
}

let anchorCounter = 0;

const MARGIN_FOR_SIDE: Readonly<Record<Side, string>> = {
  'block-end': 'margin-block-start',
  'block-start': 'margin-block-end',
  'inline-end': 'margin-inline-start',
  'inline-start': 'margin-inline-end',
};

/**
 * Keep `floating` (a `position: fixed` element, typically a popover in the top layer) next
 * to `anchor` until `stop()` or `signal` aborts. Writes `data-side` on the floating element.
 */
export function anchorFloating(anchor: Element, floating: HTMLElement, options: AnchorOptions = {}, signal?: AbortSignal): AnchorHandle {
  const side = options.side ?? 'block-end';
  const align = options.align ?? 'start';
  const offset = options.offset ?? 4;
  floating.dataset['side'] = side;
  const sameTree = anchor.getRootNode() === floating.getRootNode();
  if (options.forceFallback !== true && sameTree && supportsAnchorPositioning() && anchor instanceof HTMLElement) {
    anchorCounter += 1;
    const name = `--sf-anchor-${anchorCounter}`;
    anchor.style.setProperty('anchor-name', name);
    floating.style.setProperty('position-anchor', name);
    floating.style.setProperty('position-area', positionArea(side, align));
    floating.style.setProperty('position-try-fallbacks', side.startsWith('block') ? 'flip-block' : 'flip-inline');
    floating.style.setProperty(MARGIN_FOR_SIDE[side], `${offset}px`);
    const detach = new AbortController();
    const stop = (): void => {
      detach.abort();
      anchor.style.removeProperty('anchor-name');
      for (const property of ['position-anchor', 'position-area', 'position-try-fallbacks', MARGIN_FOR_SIDE[side]]) floating.style.removeProperty(property);
    };
    signal?.addEventListener('abort', stop, { once: true, signal: detach.signal });
    return { mode: 'css', update: () => undefined, stop };
  }

  const view = floating.ownerDocument.defaultView ?? globalThis;
  const listeners = new AbortController();
  let frame: number | undefined;
  const update = (): void => {
    const rect = anchor.getBoundingClientRect();
    const own = floating.getBoundingClientRect();
    const result = computePosition({
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      floating: { width: own.width, height: own.height },
      viewport: { width: view.innerWidth, height: view.innerHeight },
      side,
      align,
      offset,
      dir: directionOf(anchor),
    });
    floating.style.left = `${result.x}px`;
    floating.style.top = `${result.y}px`;
    floating.dataset['side'] = result.side;
  };
  const schedule = (): void => {
    if (frame !== undefined) return;
    const raf = view.requestAnimationFrame?.bind(view) ?? ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number);
    frame = raf(() => {
      frame = undefined;
      if (!listeners.signal.aborted) update();
    });
  };
  view.addEventListener('scroll', schedule, { capture: true, passive: true, signal: listeners.signal });
  view.addEventListener('resize', schedule, { passive: true, signal: listeners.signal });
  const Observer = (view as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const observer = Observer === undefined ? undefined : new Observer(schedule);
  observer?.observe(anchor);
  observer?.observe(floating);
  const stop = (): void => {
    listeners.abort();
    observer?.disconnect();
  };
  signal?.addEventListener('abort', stop, { once: true, signal: listeners.signal });
  update();
  return { mode: 'js', update, stop };
}
