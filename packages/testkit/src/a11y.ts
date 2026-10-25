/**
 * `@staticflux/testkit/a11y` — accessibility checks for component tests (R15.4).
 *
 * A deterministic, dependency-free subset of axe-style rules that understands the
 * composed tree (light DOM + open shadow roots + slots), so it catches what web
 * components typically get wrong:
 *
 * - `name`               — interactive roles, dialogs and regions have an accessible name;
 * - `aria-ref`           — `aria-labelledby|describedby|controls|activedescendant|owns` ids resolve
 *                          *in the same tree* (references never cross a shadow boundary);
 * - `required-attr`      — e.g. `tab`/`option` need `aria-selected`, `slider` needs `aria-valuenow`;
 * - `required-parent`    — `tab` in `tablist`, `option` in `listbox`, `menuitem` in `menu`, `treeitem` in `tree`;
 * - `valid-role`, `positive-tabindex`, `hidden-focusable` (focusable inside `aria-hidden`),
 *   `nested-interactive` (a focusable control inside another control).
 *
 * Layout-dependent rules (color contrast of rendered pixels, target size) are covered
 * by the theme contract (`runThemeContract`) and real-browser e2e checks instead.
 *
 * @example
 * expectNoA11yIssues(element);              // throws listing every issue
 * expect(accessibleName(button)).toBe('Save');
 * press(element, 'ArrowDown');
 */

export type A11yRule =
  | 'name'
  | 'aria-ref'
  | 'required-attr'
  | 'required-parent'
  | 'valid-role'
  | 'positive-tabindex'
  | 'hidden-focusable'
  | 'nested-interactive';

export interface A11yIssue {
  readonly rule: A11yRule;
  readonly element: Element;
  readonly message: string;
}

export interface AuditOptions {
  readonly rules?: readonly A11yRule[];
}

const ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader', 'combobox',
  'complementary', 'contentinfo', 'definition', 'dialog', 'directory', 'document', 'feed', 'figure', 'form', 'grid',
  'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math',
  'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
  'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

const NAME_REQUIRED = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'treeitem', 'dialog', 'alertdialog', 'listbox', 'tree',
  'tablist', 'radiogroup', 'toolbar', 'menu', 'progressbar', 'meter', 'region',
]);

const REQUIRED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  tab: ['aria-selected'],
  option: ['aria-selected'],
  checkbox: ['aria-checked'],
  radio: ['aria-checked'],
  switch: ['aria-checked'],
  menuitemcheckbox: ['aria-checked'],
  menuitemradio: ['aria-checked'],
  slider: ['aria-valuenow'],
  combobox: ['aria-expanded'],
  treeitem: ['aria-selected'],
};

const REQUIRED_PARENT: Readonly<Record<string, readonly string[]>> = {
  tab: ['tablist'],
  option: ['listbox', 'group'],
  menuitem: ['menu', 'menubar', 'group'],
  menuitemcheckbox: ['menu', 'menubar', 'group'],
  menuitemradio: ['menu', 'menubar', 'group'],
  treeitem: ['tree', 'group'],
};

const INTERACTIVE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'treeitem']);
const REF_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-activedescendant', 'aria-owns', 'aria-errormessage'] as const;

/** The element's role: explicit `role`, else the implicit role of common native elements. */
export function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit !== undefined && explicit !== '') return explicit;
  const tag = element.localName;
  if (tag === 'button') return 'button';
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : undefined;
  if (tag === 'select') return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'dialog') return 'dialog';
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'hidden') return undefined;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
    if (type === 'search') return 'searchbox';
    if (type === 'color' || type === 'file' || type === 'date' || type === 'time') return 'button';
    return 'textbox';
  }
  return undefined;
}

function isNative(element: Element): boolean {
  return ['input', 'select', 'textarea', 'button'].includes(element.localName);
}

/** The parent in the composed (flattened) tree: assigned slot, parent element, or shadow host. */
export function composedParent(element: Element): Element | null {
  const slot = element.assignedSlot ?? slotFor(element);
  if (slot !== null) return slot;
  if (element.parentElement !== null) return element.parentElement;
  const root = element.parentNode;
  return root instanceof ShadowRoot ? root.host : null;
}

/** The slot an element is assigned to, found by name (DOM implementations without `assignedSlot`). */
function slotFor(element: Element): HTMLSlotElement | null {
  const shadow = element.parentElement?.shadowRoot;
  if (shadow === null || shadow === undefined) return null;
  const name = element.getAttribute('slot');
  return shadow.querySelector<HTMLSlotElement>(name === null || name === '' ? 'slot:not([name]), slot[name=""]' : `slot[name="${CSS.escape(name)}"]`);
}

function isHiddenFromAt(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = composedParent(node)) {
    if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden') || node.hasAttribute('inert')) return true;
  }
  return false;
}

/** Text of a node in the flattened tree (shadow content and slotted nodes), skipping hidden parts. */
export function flatText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return '';
  if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden')) return '';
  if (node.localName === 'style' || node.localName === 'script') return '';
  const label = node.getAttribute('aria-label');
  if (label !== null && label.trim() !== '') return label;
  if (node.localName === 'slot') {
    const assigned = (node as HTMLSlotElement).assignedNodes({ flatten: true });
    const nodes = assigned.length > 0 ? assigned : [...node.childNodes];
    return nodes.map(flatText).join('');
  }
  const children = node.shadowRoot !== null ? [...node.shadowRoot.childNodes] : [...node.childNodes];
  return children.map(flatText).join('');
}

function byIdIn(element: Element, id: string): Element | null {
  const root = element.getRootNode() as Document | ShadowRoot;
  return root.getElementById?.(id) ?? (root as ParentNode).querySelector(`#${CSS.escape(id)}`);
}

/** Accessible name (simplified accname: labelledby, aria-label, native label, content, title). */
export function accessibleName(element: Element): string {
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const labelledby = element.getAttribute('aria-labelledby');
  if (labelledby !== null && labelledby.trim() !== '') {
    const text = labelledby
      .split(/\s+/)
      .map((id) => byIdIn(element, id))
      .filter((el): el is Element => el !== null)
      .map((el) => flatText(el))
      .join(' ');
    if (clean(text) !== '') return clean(text);
  }
  const label = element.getAttribute('aria-label');
  if (label !== null && clean(label) !== '') return clean(label);
  if (isNative(element) || element.localName === 'meter' || element.localName === 'output') {
    const id = element.getAttribute('id');
    const root = element.getRootNode() as ParentNode;
    const explicit = id === null ? null : root.querySelector(`label[for="${CSS.escape(id)}"]`);
    const wrapping = element.closest('label');
    const text = [explicit, wrapping].filter((l): l is HTMLLabelElement => l !== null).map((l) => flatText(l)).join(' ');
    if (clean(text) !== '') return clean(text);
    if (element.localName === 'input' && ['button', 'submit', 'reset'].includes((element as HTMLInputElement).type)) {
      return clean((element as HTMLInputElement).value);
    }
  }
  const role = roleOf(element);
  const nameFromContent = role !== undefined && !['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'tree', 'tablist', 'radiogroup', 'toolbar', 'menu', 'dialog', 'alertdialog', 'region'].includes(role);
  if (nameFromContent || role === undefined) {
    const text = clean(flatText(element));
    if (text !== '') return text;
  }
  const title = element.getAttribute('title');
  return title === null ? '' : clean(title);
}

/** Every element of `root`, including inside open shadow roots (document order per tree). */
export function allElements(root: Element | Document | ShadowRoot): Element[] {
  const out: Element[] = [];
  const visit = (scope: ParentNode): void => {
    for (const element of scope.querySelectorAll('*')) {
      out.push(element);
      if (element.shadowRoot !== null) visit(element.shadowRoot);
    }
  };
  if (root instanceof Element) {
    out.push(root);
    if (root.shadowRoot !== null) visit(root.shadowRoot);
  }
  visit(root);
  return out;
}

function isFocusable(element: Element): boolean {
  if (element.hasAttribute('disabled')) return false;
  const tabindex = element.getAttribute('tabindex');
  if (tabindex !== null) return Number(tabindex) >= 0;
  if (['button', 'select', 'textarea'].includes(element.localName)) return true;
  if (element.localName === 'input') return (element as HTMLInputElement).type !== 'hidden';
  if (element.localName === 'a') return element.hasAttribute('href');
  return false;
}

/** Run the audit. Hidden subtrees (`hidden`, `aria-hidden`, `inert`) are skipped except for `hidden-focusable`. */
export function auditA11y(root: Element | Document | ShadowRoot, options: AuditOptions = {}): A11yIssue[] {
  const rules = new Set<A11yRule>(options.rules ?? ['name', 'aria-ref', 'required-attr', 'required-parent', 'valid-role', 'positive-tabindex', 'hidden-focusable', 'nested-interactive']);
  const issues: A11yIssue[] = [];
  const report = (rule: A11yRule, element: Element, message: string): void => {
    if (rules.has(rule)) issues.push({ rule, element, message: `${describe(element)}: ${message}` });
  };
  for (const element of allElements(root)) {
    if (isHiddenFromAt(element)) {
      // aria-hidden hides from AT but not from the keyboard; `hidden` / `inert` remove both.
      if (composedAriaHidden(element) && isFocusable(element) && !insideInert(element)) {
        report('hidden-focusable', element, 'focusable element inside aria-hidden="true"');
      }
      continue;
    }
    const explicitRole = element.getAttribute('role');
    const role = roleOf(element);
    if (explicitRole !== null && explicitRole.trim() !== '' && !ROLES.has(explicitRole.trim().split(/\s+/)[0] as string)) {
      report('valid-role', element, `unknown role "${explicitRole}"`);
    }
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) > 0) report('positive-tabindex', element, `tabindex="${tabindex}" breaks the tab order`);
    for (const attr of REF_ATTRS) {
      const value = element.getAttribute(attr);
      if (value === null || value.trim() === '') continue;
      for (const id of value.trim().split(/\s+/)) {
        if (byIdIn(element, id) === null) report('aria-ref', element, `${attr}="${id}" does not resolve in the same tree (ids never cross a shadow boundary)`);
      }
    }
    if (role === undefined) continue;
    if (NAME_REQUIRED.has(role) && accessibleName(element) === '') {
      if (!(role === 'region' && explicitRole === null)) report('name', element, `role "${role}" has no accessible name`);
    }
    if (explicitRole !== null) {
      for (const attr of REQUIRED_ATTRS[role] ?? []) {
        if (!element.hasAttribute(attr)) report('required-attr', element, `role "${role}" needs ${attr}`);
      }
      const parents = REQUIRED_PARENT[role];
      if (parents !== undefined && !hasOwnerRole(element, parents)) report('required-parent', element, `role "${role}" must be owned by ${parents.join(' | ')}`);
    }
    if (INTERACTIVE.has(role) && isFocusable(element)) {
      for (let node = composedParent(element); node !== null; node = composedParent(node)) {
        const parentRole = roleOf(node);
        if (parentRole !== undefined && INTERACTIVE.has(parentRole) && parentRole !== 'treeitem' && parentRole !== 'option') {
          report('nested-interactive', element, `focusable "${role}" nested inside "${parentRole}" (${describe(node)})`);
          break;
        }
      }
    }
  }
  return issues;
}

function composedAriaHidden(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = composedParent(node)) if (node.getAttribute('aria-hidden') === 'true') return true;
  return false;
}

function insideInert(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = composedParent(node)) if (node.hasAttribute('inert') || node.hasAttribute('hidden')) return true;
  return false;
}

function hasOwnerRole(element: Element, roles: readonly string[]): boolean {
  for (let node = composedParent(element); node !== null; node = composedParent(node)) {
    const role = roleOf(node);
    if (role === undefined || role === 'none' || role === 'presentation') continue;
    if (node.localName === 'slot') continue;
    return roles.includes(role);
  }
  return false;
}

function describe(element: Element): string {
  const id = element.id === '' ? '' : `#${element.id}`;
  const role = element.getAttribute('role');
  return `<${element.localName}${id}${role === null ? '' : ` role=${role}`}>`;
}

/** Throw an Error listing every issue (use in tests). */
export function expectNoA11yIssues(root: Element | Document | ShadowRoot, options: AuditOptions = {}): void {
  const issues = auditA11y(root, options);
  if (issues.length > 0) throw new Error(`Accessibility issues (${issues.length}):\n  ${issues.map((i) => `[${i.rule}] ${i.message}`).join('\n  ')}`);
}

/** The deepest focused element, through open shadow roots. */
export function deepFocused(doc: Document = document): Element | null {
  let active = doc.activeElement;
  for (;;) {
    let inner: Element | null = null;
    try {
      inner = active?.shadowRoot?.activeElement ?? null;
    } catch {
      // Some DOM implementations throw for focus inside nested shadow roots; fall back to a search.
      inner = active?.shadowRoot === null || active?.shadowRoot === undefined ? null : findFocused(active.shadowRoot);
    }
    if (inner === null) return active;
    active = inner;
  }
}

function findFocused(root: ShadowRoot): Element | null {
  for (const element of root.querySelectorAll('*')) {
    if (element.matches(':focus') || element.shadowRoot !== null && findFocused(element.shadowRoot) !== null) return element;
  }
  return null;
}

export interface PressOptions {
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly type?: 'keydown' | 'keyup';
}

/** Dispatch a bubbling, composed, cancelable keyboard event; returns the event (check `defaultPrevented`). */
export function press(target: EventTarget, key: string, options: PressOptions = {}): KeyboardEvent {
  const event = new KeyboardEvent(options.type ?? 'keydown', {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
    shiftKey: options.shift ?? false,
    ctrlKey: options.ctrl ?? false,
    altKey: options.alt ?? false,
    metaKey: options.meta ?? false,
  });
  target.dispatchEvent(event);
  return event;
}
