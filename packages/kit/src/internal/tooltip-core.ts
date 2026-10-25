/**
 * Tooltip behaviour (WAI-ARIA APG Tooltip, OVERLAYS-FEEDBACK §4): shows on hover after 500 ms and on keyboard focus;
 * then a **warm period** — moving to another control while a tooltip shows, or within 300 ms after one hid, shows its
 * tooltip at once (toolbars and pills feel instant). Hidden on leave, blur, pointerdown, any key (Escape is not
 * consumed for anything else) and scroll; one tooltip at a time per document (`sf-tooltip-open` closes the others,
 * `sf-tooltip-close` starts the warm period — no global state). **Touch:** a 500 ms long-press shows the tooltip
 * without activating the control; lifting the finger hides it and swallows that press's click. The bubble lives in
 * the top layer, 6 px from its anchor, placed with `anchorFloating`.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { type AnchorHandle, anchorFloating, type Side } from '../position.js';
import { closeLayer, openLayer } from './layer.js';

export const TOOLTIP_OPEN_EVENT = 'sf-tooltip-open';
export const TOOLTIP_CLOSE_EVENT = 'sf-tooltip-close';

/** First tooltip delay, warm period and long-press time (ms, §4). */
export const TOOLTIP_TIMING = Object.freeze({ showDelay: 500, warmMs: 300, longPressMs: 500, hideDelay: 80 });
/** `OVERLAY_GAP.tooltip` (kept local: every icon button loads this module). */
const TOOLTIP_GAP = 6;
/** A finger that moves this far is scrolling, not long-pressing. */
const LONG_PRESS_SLOP_PX = 10;

export interface TooltipCoreOptions {
  /** The element the tooltip describes and is anchored to. */
  readonly anchor: () => Element | null;
  /** The floating bubble (rendered by the host). */
  readonly bubble: () => HTMLElement | null;
  readonly side?: () => Side;
  /** Hover delay before the first tooltip shows (ms). Default 500. */
  readonly showDelay?: number;
  /** Whether there is anything to show. */
  readonly enabled?: () => boolean;
}

/**
 * Tooltip text (§4): the name, then the disabled reason after a `·` (`Export · Choose at least one page`). The
 * shortcut is shown separately as `kbd`; a toggle passes the label of the state the press will produce.
 */
export function composeTooltip(label: string, reason?: string): string {
  return reason === undefined || reason === '' ? label : `${label} · ${reason}`;
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true; // DOM without :focus-visible support: treat focus as keyboard focus
  }
}

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

export class TooltipController implements ReactiveController {
  open = false;
  private connection: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  private anchored: AnchorHandle | undefined;
  /** Another tooltip of this document is showing, or hid at this time (warm period). */
  private otherOpen = false;
  private lastClosed = Number.NEGATIVE_INFINITY;
  private longPressed = false;

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly options: TooltipCoreOptions,
  ) {
    host.addController(this);
  }

  /** Inside the warm period: the next tooltip shows without the delay. */
  get warm(): boolean {
    return this.otherOpen || now() - this.lastClosed < TOOLTIP_TIMING.warmMs;
  }

  hostConnected(): void {
    this.connection = new AbortController();
    const { signal } = this.connection;
    const host = this.host;
    const doc = host.ownerDocument;
    host.addEventListener(
      'pointerenter',
      (event) => event.pointerType !== 'touch' && this.schedule(true, this.warm ? 0 : (this.options.showDelay ?? TOOLTIP_TIMING.showDelay)),
      { signal },
    );
    host.addEventListener('pointerleave', (event) => event.pointerType !== 'touch' && this.schedule(false, TOOLTIP_TIMING.hideDelay), { signal });
    host.addEventListener('pointerdown', (event) => this.onPointerDown(event), { signal });
    host.addEventListener(
      'click',
      (event) => {
        if (!this.longPressed) return;
        // The long-press showed the tooltip: this press does not activate the control.
        this.longPressed = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { signal, capture: true },
    );
    host.addEventListener(
      'focusin',
      (event) => {
        const target = event.composedPath()[0];
        if (target instanceof Element && focusVisible(target)) this.schedule(true, 0);
      },
      { signal },
    );
    host.addEventListener('focusout', () => this.schedule(false, 0), { signal });
    // Any key hides it; Escape is not consumed, so it still closes whatever is open around the control.
    doc.addEventListener('keydown', () => this.open && this.hide(), { signal, capture: true });
    doc.addEventListener('scroll', () => this.open && this.hide(), { signal, capture: true, passive: true });
    // composedPath()[0], not target: the event is retargeted when the host sits in a shadow root.
    doc.addEventListener(
      TOOLTIP_OPEN_EVENT,
      (event) => {
        if (event.composedPath()[0] === host) return;
        this.otherOpen = true;
        this.hide();
      },
      { signal },
    );
    doc.addEventListener(
      TOOLTIP_CLOSE_EVENT,
      (event) => {
        if (event.composedPath()[0] === host) return;
        this.otherOpen = false;
        this.lastClosed = now();
      },
      { signal },
    );
  }

  hostDisconnected(): void {
    this.connection?.abort();
    clearTimeout(this.timer);
    clearTimeout(this.pressTimer);
    this.hide();
  }

  private onPointerDown(event: PointerEvent): void {
    clearTimeout(this.timer);
    if (event.pointerType !== 'touch') {
      this.hide();
      return;
    }
    this.longPressed = false;
    const { clientX: x, clientY: y } = event;
    const done = new AbortController();
    const view = this.host.ownerDocument.defaultView ?? globalThis;
    const end = (): void => {
      done.abort();
      clearTimeout(this.pressTimer);
    };
    this.pressTimer = setTimeout(() => {
      if (this.options.enabled?.() === false) return;
      this.longPressed = true;
      this.show();
    }, TOOLTIP_TIMING.longPressMs);
    view.addEventListener('pointermove', (move) => Math.hypot(move.clientX - x, move.clientY - y) > LONG_PRESS_SLOP_PX && end(), { signal: done.signal });
    view.addEventListener(
      'pointerup',
      () => {
        end();
        if (this.longPressed) this.hide();
      },
      { signal: done.signal },
    );
    view.addEventListener('pointercancel', () => {
      end();
      this.longPressed = false;
      this.hide();
    }, { signal: done.signal });
  }

  private schedule(show: boolean, delay: number): void {
    clearTimeout(this.timer);
    if (show && this.options.enabled?.() === false) return;
    if (delay === 0) {
      if (show) this.show();
      else this.hide();
      return;
    }
    this.timer = setTimeout(() => (show ? this.show() : this.hide()), delay);
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.host.requestUpdate();
    this.host.dispatchEvent(new Event(TOOLTIP_OPEN_EVENT, { bubbles: true, composed: true }));
    void this.host.updateComplete.then(() => {
      const bubble = this.options.bubble();
      const anchor = this.options.anchor();
      if (!this.open || bubble === null || anchor === null) return;
      openLayer(bubble);
      this.anchored?.stop();
      this.anchored = anchorFloating(anchor, bubble, { side: this.options.side?.() ?? 'block-end', align: 'center', offset: TOOLTIP_GAP }, this.connection?.signal);
    });
  }

  hide(): void {
    clearTimeout(this.timer);
    if (!this.open) return;
    this.open = false;
    this.anchored?.stop();
    this.anchored = undefined;
    const bubble = this.options.bubble();
    if (bubble !== null) closeLayer(bubble);
    this.host.requestUpdate();
    if (this.host.isConnected) this.host.dispatchEvent(new Event(TOOLTIP_CLOSE_EVENT, { bubbles: true, composed: true }));
  }
}
