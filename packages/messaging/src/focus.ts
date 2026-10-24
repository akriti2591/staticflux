/**
 * Focus helpers for the one surface focus model (R13.5, R15.2): focus trap,
 * restore, inert background. Shadow-DOM aware.
 */

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** The deepest active element, through open shadow roots. */
export function deepActiveElement(root: Document | ShadowRoot = document): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement;
  return active;
}

/** Focusable descendants of `container` (light DOM of the container, in order). */
export function focusableWithin(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('inert'));
}

/** Move focus into `container`: first focusable, else the container itself (needs tabindex=-1). */
export function focusFirst(container: HTMLElement): void {
  const first = focusableWithin(container)[0];
  (first ?? container).focus();
}

/** Keep Tab / Shift+Tab inside `container`. Returns true when the event was handled. */
export function trapTab(event: KeyboardEvent, container: HTMLElement, active: Element | null): boolean {
  if (event.key !== 'Tab') return false;
  const items = focusableWithin(container);
  if (items.length === 0) {
    event.preventDefault();
    container.focus();
    return true;
  }
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const inside = active !== null && (container === active || container.contains(active));
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/** Make every sibling of `keep` (and of its ancestors up to `body`) inert. Returns restore. */
export function inertSiblings(keep: Element): () => void {
  const changed: Element[] = [];
  let node: Element | null = keep;
  while (node !== null && node.parentElement !== null && node !== document.body) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || sibling.hasAttribute('inert') || sibling.localName === 'script' || sibling.localName === 'style') continue;
      sibling.setAttribute('inert', '');
      changed.push(sibling);
    }
    node = node.parentElement;
  }
  return () => {
    for (const el of changed) el.removeAttribute('inert');
  };
}
