/** Writing direction and composed-tree parents (RTL-aware keyboard and placement). */

/** Parent across shadow boundaries (assigned slot → parent → shadow host). */
export function composedParentOf(node: Element): Element | null {
  if (node.assignedSlot) return node.assignedSlot;
  if (node.parentElement !== null) return node.parentElement;
  const root = node.parentNode;
  return root instanceof ShadowRoot ? root.host : null;
}

/** Writing direction from the nearest `dir` attribute in the composed tree (default `ltr`). */
export function directionOf(element: Element): 'ltr' | 'rtl' {
  for (let node: Element | null = element; node !== null; node = composedParentOf(node)) {
    const dir = node.getAttribute('dir');
    if (dir === 'rtl' || dir === 'ltr') return dir;
  }
  return element.ownerDocument.documentElement.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr';
}
