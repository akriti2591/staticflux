/**
 * `@staticflux/kit/overlay` — the overlay model as data (OVERLAYS-FEEDBACK §1): six layers, the nesting table and the
 * gaps. Kit overlays enforce it: an open overlay marks its host `data-sf-overlay="<kind>"`, and a new overlay looks up
 * its parent through the flat tree (slots and shadow hosts included) and refuses to open where the table says no
 * (SF-KIT-003, an `sf-overlay-refused` event). The modal and toast rules live in messaging's `SurfaceManager`.
 *
 * | # | Layer | Kinds |
 * |---|---|---|
 * | 1 | Canvas HUD | `hud` |
 * | 2 | Floating bars | `bar` |
 * | 3 | Popovers and menus | `menu`, `submenu`, `popover`, `hint` |
 * | 4 | Sheets and dialogs | `dialog`, `sheet`, `takeover` |
 * | 5 | Toasts and banners | `toast` |
 * | 6 | Tooltips | `tooltip` |
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { OverlayNestingError } from './errors.js';

export type OverlayKind = 'hud' | 'bar' | 'menu' | 'submenu' | 'popover' | 'hint' | 'dialog' | 'sheet' | 'takeover' | 'toast' | 'tooltip';
export type OverlayLayer = 1 | 2 | 3 | 4 | 5 | 6;

export const OVERLAY_LAYERS: Readonly<Record<OverlayKind, OverlayLayer>> = Object.freeze({
  hud: 1,
  bar: 2,
  menu: 3,
  submenu: 3,
  popover: 3,
  hint: 3,
  dialog: 4,
  sheet: 4,
  takeover: 4,
  toast: 5,
  tooltip: 6,
});

/**
 * What may open inside what (§1.2). Tooltips and toasts are allowed everywhere. Not listed = refused: a popover never
 * spawns a popover, a menu never opens a popover, a submenu never opens a submenu, a dialog never opens a dialog
 * (messaging refuses it), a takeover only holds its own chrome's menus and popovers.
 */
export const OVERLAY_NESTING: Readonly<Record<OverlayKind, readonly OverlayKind[]>> = Object.freeze({
  hud: ['popover', 'menu'],
  bar: ['popover', 'menu'],
  menu: ['submenu', 'dialog'],
  submenu: ['dialog'],
  popover: ['menu'],
  hint: [],
  dialog: ['popover', 'menu'],
  sheet: ['popover', 'menu', 'dialog'],
  takeover: ['popover', 'menu'],
  toast: [],
  tooltip: [],
});

/** Gap between anchor and surface, px (§1.5). */
export const OVERLAY_GAP: Readonly<Record<'menu' | 'tooltip' | 'popover' | 'hud', number>> = Object.freeze({ menu: 6, tooltip: 6, popover: 8, hud: 12 });

/** May `child` open inside `parent` (undefined = the page)? Refusals carry SF-KIT-003. */
export function canNest(parent: OverlayKind | undefined, child: OverlayKind): Result<void, SfError> {
  if (parent === undefined || child === 'tooltip' || child === 'toast') return ok(undefined);
  if (OVERLAY_NESTING[parent].includes(child)) return ok(undefined);
  return err(OverlayNestingError({ details: { parent, child } }));
}

/** Attribute an open overlay's host carries (`data-sf-overlay="menu"`); HUDs and dialogs set it on their root. */
export const OVERLAY_ATTR = 'data-sf-overlay';

/** The flat-tree parent: the assigned slot, else the parent element, else the shadow host. */
export function flatParent(node: Element): Element | null {
  const slot = node.assignedSlot;
  if (slot !== null && slot !== undefined) return slot;
  if (node.parentElement !== null) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** `ancestor` contains `node` in the flat tree (slotted content counts as inside its slot). */
export function flatContains(ancestor: Element, node: Element): boolean {
  for (let current: Element | null = node; current !== null; current = flatParent(current)) if (current === ancestor) return true;
  return false;
}

/** The nearest open overlay around `node` in the flat tree (not counting `node` itself). */
export function parentOverlay(node: Element): { readonly kind: OverlayKind; readonly element: Element } | undefined {
  for (let current = flatParent(node); current !== null; current = flatParent(current)) {
    const kind = current.getAttribute(OVERLAY_ATTR);
    if (kind !== null && kind in OVERLAY_LAYERS) return { kind: kind as OverlayKind, element: current };
  }
  return undefined;
}
