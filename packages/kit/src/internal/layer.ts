/**
 * Top-layer helpers. Floating elements use `popover="manual"` (the Popover API puts them in
 * the top layer: no z-index wars, not clipped by `overflow`) with the kit's own light
 * dismiss, so behaviour is identical with and without native support. Without the Popover
 * API the element is shown with `data-open` and a `z.*` token layer.
 */

/** Popover API available on this element. */
export function supportsPopover(element: HTMLElement): boolean {
  return typeof (element as { showPopover?: unknown }).showPopover === 'function';
}

export function openLayer(element: HTMLElement): void {
  element.setAttribute('data-open', '');
  if (!supportsPopover(element)) return;
  if (!element.hasAttribute('popover')) element.setAttribute('popover', 'manual');
  if (!element.matches(':popover-open')) element.showPopover();
}

export function closeLayer(element: HTMLElement): void {
  element.removeAttribute('data-open');
  if (supportsPopover(element) && element.hasAttribute('popover') && element.matches(':popover-open')) element.hidePopover();
}

export type DismissCause = 'escape' | 'outside' | 'focus-out';

/**
 * Light dismiss while a layer is open: Escape, a pointer press outside every `inside`
 * element (composed path), or focus leaving them. Stops when `signal` aborts.
 */
export function lightDismiss(inside: () => readonly Element[], onDismiss: (cause: DismissCause, event: Event) => void, doc: Document, signal: AbortSignal, options: { readonly focusOut?: boolean } = {}): void {
  const outside = (event: Event): boolean => {
    const path = event.composedPath();
    return !inside().some((element) => path.includes(element));
  };
  doc.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onDismiss('escape', event);
      }
    },
    { signal, capture: true },
  );
  doc.addEventListener('pointerdown', (event) => outside(event) && onDismiss('outside', event), { signal, capture: true });
  if (options.focusOut === true) doc.addEventListener('focusin', (event) => outside(event) && onDismiss('focus-out', event), { signal, capture: true });
}
