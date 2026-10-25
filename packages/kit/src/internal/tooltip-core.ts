/**
 * Tooltip behaviour (WAI-ARIA APG Tooltip): shows on hover after a delay and on keyboard
 * focus, hides on leave / blur / Escape, one tooltip at a time per document (a
 * `sf-tooltip-open` event closes the others — no global state). The bubble lives in the
 * top layer and is anchored with `anchorFloating` (CSS anchor positioning or JS fallback).
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { type AnchorHandle, anchorFloating, type Side } from '../position.js';
import { closeLayer, openLayer } from './layer.js';

export const TOOLTIP_OPEN_EVENT = 'sf-tooltip-open';

export interface TooltipCoreOptions {
  /** The element the tooltip describes and is anchored to. */
  readonly anchor: () => Element | null;
  /** The floating bubble (rendered by the host). */
  readonly bubble: () => HTMLElement | null;
  readonly side?: () => Side;
  /** Hover delay before showing (ms). Default 400. */
  readonly showDelay?: number;
  /** Whether there is anything to show. */
  readonly enabled?: () => boolean;
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true; // DOM without :focus-visible support: treat focus as keyboard focus
  }
}

export class TooltipController implements ReactiveController {
  open = false;
  private connection: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private anchored: AnchorHandle | undefined;

  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly options: TooltipCoreOptions,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    this.connection = new AbortController();
    const { signal } = this.connection;
    const host = this.host;
    host.addEventListener('pointerenter', () => this.schedule(true, this.options.showDelay ?? 400), { signal });
    host.addEventListener('pointerleave', () => this.schedule(false, 80), { signal });
    host.addEventListener(
      'focusin',
      (event) => {
        const target = event.composedPath()[0];
        if (target instanceof Element && focusVisible(target)) this.schedule(true, 0);
      },
      { signal },
    );
    host.addEventListener('focusout', () => this.schedule(false, 0), { signal });
    host.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.open) {
          event.stopPropagation(); // dismiss the tooltip only, not the dialog around it
          this.hide();
        }
      },
      { signal },
    );
    // composedPath()[0], not target: the event is retargeted when the host sits in a shadow root.
    host.ownerDocument.addEventListener(TOOLTIP_OPEN_EVENT, (event) => event.composedPath()[0] !== host && this.hide(), { signal });
  }

  hostDisconnected(): void {
    this.connection?.abort();
    clearTimeout(this.timer);
    this.hide();
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
      this.anchored = anchorFloating(anchor, bubble, { side: this.options.side?.() ?? 'block-start', align: 'center', offset: 6 }, this.connection?.signal);
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
  }
}
