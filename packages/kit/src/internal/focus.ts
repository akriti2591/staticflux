/** Focus helpers over the composed tree (dialogs, popovers). */

const FOCUSABLE_TAGS = /* @__PURE__ */ new Set(['button', 'input', 'select', 'textarea']);

function focusableSelf(element: Element): boolean {
  if (element.hasAttribute('disabled') || element.hasAttribute('inert') || element.hasAttribute('hidden')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  const tabindex = element.getAttribute('tabindex');
  if (tabindex !== null) return Number(tabindex) >= 0;
  if (element.localName === 'a') return element.hasAttribute('href');
  if (element.localName === 'input') return (element as HTMLInputElement).type !== 'hidden';
  return FOCUSABLE_TAGS.has(element.localName);
}

/**
 * First focusable element in the composed tree of `container` (light DOM, open shadow
 * roots, slotted content), preferring `[autofocus]`. Hidden subtrees are skipped.
 */
export function firstFocusableComposed(container: Element): HTMLElement | undefined {
  let first: HTMLElement | undefined;
  const visit = (node: Element): HTMLElement | undefined => {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return undefined;
    if (node !== container && focusableSelf(node) && node instanceof HTMLElement) {
      if (node.hasAttribute('autofocus')) return node;
      first ??= node;
    }
    const children: Element[] =
      node.localName === 'slot'
        ? (node as HTMLSlotElement).assignedElements({ flatten: true })
        : node.shadowRoot !== null
          ? [...node.shadowRoot.children]
          : [...node.children];
    for (const child of children) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(container) ?? first;
}
