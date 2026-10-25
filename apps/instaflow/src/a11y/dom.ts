/**
 * The main-thread mount of the canvas projection (IF-25.10, IF-25.11, IF-25.16): reconciles snapshots into
 * `@staticflux/surface`'s accessible layer inside the canvas surface and keeps the **DOM focus on the focus path**:
 * while the canvas (or one of its nodes) has focus, focus moves to the snapshot's focus node (the last selected
 * element); with nothing selected it returns to the canvas surface itself. Keys stay with B3's shortcuts (the layer
 * activates nothing on Enter / Space), so arrow, Tab, Enter and Escape mean the same with and without a screen reader.
 *
 * A node focused by assistive technology or a click (a virtual cursor landing on it) reports `onFocusNode` so the
 * wiring can select it; focus the mount moved itself is not reported back (no loop).
 *
 * The focused node shows the theme's focus ring (2 px `color.focusRing`, 2 px offset); nodes are otherwise transparent.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { NodeId } from '@staticflux/document/v2';
import { type AccessibleLayer, createAccessibleLayer } from '@staticflux/surface';
import { themeTokens as t } from '@staticflux/ui/theme';
import { ProjectorDisposedError } from './errors.js';
import { a11yMessages } from './messages.js';
import type { CanvasSnapshot } from './projection.js';

/** The canvas focus ring: 2 px of the theme's focus colour (Clean Pop: deep tangerine), offset 2 px. */
export const CANVAS_FOCUS_RING = Object.freeze({ outline: `2px solid ${t.color.focusRing.ref}`, offset: '2px' });

export interface CanvasA11yMountOptions {
  /** The canvas surface element (focusable; Studio's `.surface`, `role="application"`). */
  readonly host: HTMLElement;
  readonly document: Document | undefined;
  /** A person focused a node (assistive technology, pointer): usually `view.select([id])` in the editor. */
  readonly onFocusNode?: (id: NodeId) => void;
}

export interface CanvasA11yMount {
  readonly layer: AccessibleLayer;
  /** The node that has DOM focus (undefined: the surface or elsewhere). */
  readonly focused: NodeId | undefined;
  /** Reconcile a snapshot and move focus along the focus path when the canvas has focus. */
  apply(snapshot: CanvasSnapshot): Result<void>;
  dispose(): void;
}

const NODE_ATTR = 'data-sf-a11y-id';

/** Mount the projection into the canvas surface (main thread; `SF-SURF-004` without a document). */
export function mountCanvasA11y(options: CanvasA11yMountOptions): Result<CanvasA11yMount> {
  let moving = false;
  let disposed = false;
  const created = createAccessibleLayer({
    host: options.host,
    document: options.document,
    activateKeys: [],
    focusRing: CANVAS_FOCUS_RING.outline,
    focusRingOffset: CANVAS_FOCUS_RING.offset,
    onAction: (id, action) => {
      if (action === 'focus' && !moving) options.onFocusNode?.(id);
    },
  });
  if (!created.ok) return created;
  const layer = created.value;
  layer.root.setAttribute('aria-description', a11yMessages.instructions);
  const active = (): Element | null => (options.host.getRootNode() as Document | ShadowRoot).activeElement ?? null;
  const canvasHasFocus = (): boolean => {
    const el = active();
    return el !== null && (el === options.host || layer.root.contains(el));
  };
  const focusedId = (): NodeId | undefined => {
    const el = active();
    return el !== null && layer.root.contains(el) ? (el.getAttribute(NODE_ATTR) ?? undefined) : undefined;
  };
  const move = (fn: () => void): void => {
    moving = true;
    try {
      fn();
    } finally {
      moving = false;
    }
  };
  const mount: CanvasA11yMount = {
    layer,
    get focused() {
      return focusedId();
    },
    apply(snapshot) {
      if (disposed) return err(ProjectorDisposedError());
      const hadFocus = canvasHasFocus();
      layer.root.setAttribute('aria-label', snapshot.label);
      move(() => layer.update(snapshot.nodes));
      if (!hadFocus) return ok();
      const target = snapshot.focus;
      if (target !== undefined && focusedId() !== target) move(() => layer.focus(target));
      else if (target === undefined && active() !== options.host) move(() => options.host.focus());
      return ok();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      layer.dispose();
    },
  };
  return ok(mount);
}
