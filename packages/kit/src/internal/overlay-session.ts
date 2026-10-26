/**
 * One open layer-3 overlay (menu, submenu, popover): the rules of OVERLAYS-FEEDBACK §1.2–§1.4 and §1.7 without global
 * state. Every open overlay announces itself on its document (`sf-overlay-open` / `sf-overlay-close`) and each open
 * session reacts on its own:
 *
 * - **nesting:** `check()` looks up the parent overlay in the flat tree and refuses what the table forbids (SF-KIT-003);
 * - **one at a time:** a layer-3 overlay opening elsewhere closes this one (`replaced`); a modal (layer 4) closes every
 *   layer-3 overlay opened before it; an overlay opened *inside* this one (submenu, a popover's menu) is a child;
 * - **Escape:** innermost first — a session with open children leaves Escape to them; the newest one consumes it;
 * - **light dismiss:** an outside pointerdown closes it and is *consumed* (menus, chrome popovers: the press never
 *   reaches the canvas, and the click that follows is swallowed) or *passes through* (HUD and inspector popovers);
 *   wheel or scroll outside closes menus and pass-through popovers (chrome popovers follow their anchor); window blur
 *   and resize close all; a parent closing closes its children.
 */
import type { Result, SfError } from '@staticflux/core';
import { canNest, flatContains, OVERLAY_ATTR, OVERLAY_LAYERS, type OverlayKind, parentOverlay } from '../overlay.js';

export const OVERLAY_OPEN_EVENT = 'sf-overlay-open';
export const OVERLAY_CLOSE_EVENT = 'sf-overlay-close';

export interface OverlayEventDetail {
  readonly host: Element;
  readonly kind: OverlayKind;
}

export type OverlayDismissCause = 'escape' | 'outside' | 'scroll' | 'blur' | 'resize' | 'replaced' | 'parent' | 'focus-out';

export interface OverlaySessionOptions {
  readonly kind: () => OverlayKind;
  /** The floating panel (gets `data-sf-overlay` while open). */
  readonly panel: () => HTMLElement | null;
  /** Elements whose composed subtree counts as inside (the host, the panel, an external anchor). */
  readonly inside: () => readonly Element[];
  readonly outside: () => 'consume' | 'pass';
  /** Wheel or scroll outside: `close` (menus, HUD popovers) or `follow` (chrome popovers keep their anchor). */
  readonly scroll: () => 'close' | 'follow';
  readonly onDismiss: (cause: OverlayDismissCause) => void;
}

/** Announce an overlay opening or closing on a document (also used by the surface layer for modals). */
export function announceOverlay(doc: Document, type: typeof OVERLAY_OPEN_EVENT | typeof OVERLAY_CLOSE_EVENT, detail: OverlayEventDetail): void {
  doc.dispatchEvent(new CustomEvent<OverlayEventDetail>(type, { detail }));
}

/** Swallow the click that follows a consumed pointerdown (one gesture), then stop listening. */
function swallowNextClick(doc: Document): void {
  const done = new AbortController();
  const view = doc.defaultView ?? globalThis;
  doc.addEventListener(
    'click',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      done.abort();
    },
    { capture: true, signal: done.signal },
  );
  doc.addEventListener('pointerup', () => view.setTimeout(() => done.abort(), 0), { capture: true, once: true, signal: done.signal });
  // A keyboard click is a new gesture, never the tail of the consumed press.
  doc.addEventListener('keydown', () => done.abort(), { capture: true, once: true, signal: done.signal });
  view.setTimeout(() => done.abort(), 1000);
}

export class OverlaySession {
  private session: AbortController | undefined;
  private readonly children = new Set<Element>();

  constructor(
    private readonly host: HTMLElement,
    private readonly options: OverlaySessionOptions,
  ) {}

  get isOpen(): boolean {
    return this.session !== undefined;
  }

  /** Overlays currently open inside this one. */
  get childCount(): number {
    return this.children.size;
  }

  /** May this overlay open where it is (§1.2)? */
  check(): Result<void, SfError> {
    return canNest(parentOverlay(this.host)?.kind, this.options.kind());
  }

  open(): void {
    if (this.session !== undefined) return;
    const session = new AbortController();
    this.session = session;
    const { signal } = session;
    const doc = this.host.ownerDocument;
    const view = doc.defaultView ?? globalThis;
    const kind = this.options.kind();
    // On the host: its light children (a popover's menu, a menu's submenu) are inside it in the flat tree.
    this.host.setAttribute(OVERLAY_ATTR, kind);
    const outsideOf = (event: Event): boolean => {
      const path = event.composedPath();
      return !this.options.inside().some((element) => path.includes(element));
    };
    const dismiss = (cause: OverlayDismissCause): void => {
      if (this.session === session) this.options.onDismiss(cause);
    };

    doc.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || this.children.size > 0) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss('escape');
      },
      { signal, capture: true },
    );
    doc.addEventListener(
      'pointerdown',
      (event) => {
        if (!outsideOf(event)) return;
        if (this.options.outside() === 'consume') {
          event.preventDefault();
          event.stopPropagation();
          swallowNextClick(doc);
        }
        dismiss('outside');
      },
      { signal, capture: true },
    );
    const onScroll = (event: Event): void => {
      if (this.options.scroll() === 'close' && outsideOf(event)) dismiss('scroll');
    };
    doc.addEventListener('wheel', onScroll, { signal, capture: true, passive: true });
    doc.addEventListener('scroll', onScroll, { signal, capture: true, passive: true });
    view.addEventListener('blur', () => dismiss('blur'), { signal });
    view.addEventListener('resize', () => dismiss('resize'), { signal });
    doc.addEventListener(
      OVERLAY_OPEN_EVENT,
      (event) => {
        const detail = (event as CustomEvent<OverlayEventDetail>).detail;
        if (detail.host === this.host) return;
        const panel = this.options.panel();
        if (flatContains(this.host, detail.host) || (panel !== null && flatContains(panel, detail.host))) {
          this.children.add(detail.host);
          return;
        }
        const layer = OVERLAY_LAYERS[detail.kind];
        if (layer >= 4 || (layer === 3 && detail.kind !== 'hint' && !flatContains(detail.host, this.host))) dismiss('replaced');
      },
      { signal },
    );
    doc.addEventListener(
      OVERLAY_CLOSE_EVENT,
      (event) => {
        const detail = (event as CustomEvent<OverlayEventDetail>).detail;
        this.children.delete(detail.host);
        if (detail.host !== this.host && flatContains(detail.host, this.host)) dismiss('parent');
      },
      { signal },
    );
    announceOverlay(doc, OVERLAY_OPEN_EVENT, { host: this.host, kind });
  }

  close(): void {
    const session = this.session;
    if (session === undefined) return;
    this.session = undefined;
    session.abort();
    this.children.clear();
    this.host.removeAttribute(OVERLAY_ATTR);
    announceOverlay(this.host.ownerDocument, OVERLAY_CLOSE_EVENT, { host: this.host, kind: this.options.kind() });
  }
}
