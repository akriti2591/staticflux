/**
 * Accessible DOM layer for pure-canvas content (R11.23). The projection (e.g.
 * the document's ECS view) produces `AccessibleNode`s; the layer reconciles them
 * by id into real, positioned DOM elements over the canvas (roles, names,
 * states, focus order), so screen readers, keyboard focus and find-in-page work
 * although pixels come from a canvas. Not needed when the HTML-in-Canvas
 * adapter is used (its content is DOM already).
 */
import { err, ok, type Result } from '@staticflux/core';
import { MainThreadOnlyError } from './errors.js';

export interface AccessibleBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AccessibleNode {
  /** Stable id (e.g. entity id). */
  readonly id: string;
  /** ARIA role (`button`, `img`, `textbox`, `group`, `listitem`…). */
  readonly role: string;
  /** Accessible name. */
  readonly label: string;
  readonly description?: string;
  /** CSS px relative to the surface. */
  readonly bounds?: AccessibleBounds;
  readonly focusable?: boolean;
  readonly selected?: boolean;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Text content (also searchable). */
  readonly text?: string;
  readonly children?: readonly AccessibleNode[];
}

export type AccessibleAction = 'activate' | 'focus';

export interface AccessibleLayer {
  readonly root: HTMLElement;
  /** Reconcile the tree (keyed by id; element identity is kept for unchanged ids so focus survives). */
  update(nodes: readonly AccessibleNode[]): void;
  /** Move keyboard focus to a node. */
  focus(id: string): boolean;
  /** Element of a node (tests / devtools). */
  element(id: string): HTMLElement | undefined;
  readonly size: number;
  dispose(): void;
}

export interface AccessibleLayerOptions {
  readonly host: HTMLElement;
  readonly document: Document | undefined;
  /** User activated (Enter/Space/click) or focused a node → map to an intent. */
  readonly onAction?: (id: string, action: AccessibleAction) => void;
  /** Label of the layer root (e.g. "Canvas: page 1"). */
  readonly label?: string;
}

const NODE_ATTR = 'data-sf-a11y-id';

export function createAccessibleLayer(options: AccessibleLayerOptions): Result<AccessibleLayer> {
  const doc = options.document;
  if (doc === undefined) return err(MainThreadOnlyError({ details: { api: 'accessible-layer' } }));
  const root = doc.createElement('div');
  root.setAttribute('data-sf-a11y-layer', '');
  root.setAttribute('role', 'group');
  if (options.label !== undefined) root.setAttribute('aria-label', options.label);
  // Positioned over the canvas, invisible but present in the accessibility tree.
  Object.assign(root.style, { position: 'absolute', left: '0px', top: '0px', right: '0px', bottom: '0px', overflow: 'hidden', pointerEvents: 'none' });
  options.host.appendChild(root);
  const elements = new Map<string, HTMLElement>();

  const onClick = (event: Event): void => {
    const id = (event.target as Element | null)?.closest?.(`[${NODE_ATTR}]`)?.getAttribute(NODE_ATTR);
    if (id !== null && id !== undefined) options.onAction?.(id, 'activate');
  };
  const onKeydown = (event: Event): void => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
    const id = (event.target as Element | null)?.getAttribute?.(NODE_ATTR);
    if (id === null || id === undefined) return;
    event.preventDefault();
    options.onAction?.(id, 'activate');
  };
  const onFocusin = (event: Event): void => {
    const id = (event.target as Element | null)?.getAttribute?.(NODE_ATTR);
    if (id !== null && id !== undefined) options.onAction?.(id, 'focus');
  };
  // Aborted in dispose() to remove the layer's listeners.
  const listeners = new AbortController();
  root.addEventListener('click', onClick, { signal: listeners.signal });
  root.addEventListener('keydown', onKeydown, { signal: listeners.signal });
  root.addEventListener('focusin', onFocusin, { signal: listeners.signal });

  const setAttr = (el: HTMLElement, name: string, value: string | undefined): void => {
    if (value === undefined) el.removeAttribute(name);
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };
  const bool = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : String(value));

  const render = (node: AccessibleNode, parent: HTMLElement, seen: Set<string>, origin: { x: number; y: number }): void => {
    seen.add(node.id);
    let el = elements.get(node.id);
    if (el === undefined) {
      el = doc.createElement('div');
      el.setAttribute(NODE_ATTR, node.id);
      elements.set(node.id, el);
    }
    setAttr(el, 'role', node.role);
    setAttr(el, 'aria-label', node.label);
    setAttr(el, 'aria-description', node.description);
    setAttr(el, 'aria-selected', bool(node.selected));
    setAttr(el, 'aria-checked', bool(node.checked));
    setAttr(el, 'aria-disabled', bool(node.disabled));
    setAttr(el, 'tabindex', node.focusable === true ? '0' : undefined);
    const ownText = node.text ?? '';
    const textNode = el.firstChild !== null && el.firstChild.nodeType === 3 ? el.firstChild : undefined;
    if (ownText !== '' && textNode === undefined) el.insertBefore(doc.createTextNode(ownText), el.firstChild);
    else if (textNode !== undefined && textNode.textContent !== ownText) {
      if (ownText === '') textNode.remove();
      else textNode.textContent = ownText;
    }
    const b = node.bounds;
    const style = el.style;
    style.position = 'absolute';
    style.pointerEvents = node.focusable === true ? 'auto' : 'none';
    style.opacity = '0';
    if (b !== undefined) {
      style.left = `${b.x - origin.x}px`;
      style.top = `${b.y - origin.y}px`;
      style.width = `${b.width}px`;
      style.height = `${b.height}px`;
    }
    // Keep DOM order = projection order (reading order).
    const childOrigin = b === undefined ? origin : { x: b.x, y: b.y };
    let cursor: ChildNode | null = textNode ?? (ownText === '' ? null : el.firstChild);
    for (const child of node.children ?? []) {
      render(child, el, seen, childOrigin);
      const childEl = elements.get(child.id) as HTMLElement;
      const expectedNext = cursor === null ? el.firstChild : cursor.nextSibling;
      if (childEl.parentElement !== el || expectedNext !== childEl) {
        if (cursor === null) el.insertBefore(childEl, el.firstChild);
        else cursor.after(childEl);
      }
      cursor = childEl;
    }
    if (el.parentElement !== parent) parent.appendChild(el);
  };

  const layer: AccessibleLayer = {
    root,
    update(nodes) {
      const seen = new Set<string>();
      let previous: HTMLElement | undefined;
      for (const node of nodes) {
        render(node, root, seen, { x: 0, y: 0 });
        const el = elements.get(node.id) as HTMLElement;
        const expected = previous === undefined ? root.firstChild : previous.nextSibling;
        if (expected !== el) {
          if (previous === undefined) root.insertBefore(el, root.firstChild);
          else previous.after(el);
        }
        previous = el;
      }
      for (const [id, el] of elements) {
        if (!seen.has(id)) {
          el.remove();
          elements.delete(id);
        }
      }
    },
    focus(id) {
      const el = elements.get(id);
      if (el === undefined || el.getAttribute('tabindex') === null) return false;
      el.focus();
      return true;
    },
    element: (id) => elements.get(id),
    get size() {
      return elements.size;
    },
    dispose() {
      listeners.abort();
      root.remove();
      elements.clear();
    },
  };
  return ok(layer);
}
