import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineTree, dropPositionAt, findNode, flattenTree, isInSubtree, type RenameDetail, type ReorderDetail, type SfTreeElement, type TreeNode, treeDragMachine, visibleRange } from './tree.js';
import { cleanup, events, fixture, settle, shadowAll } from './test-helpers.js';

beforeAll(() => defineTree());
afterEach(cleanup);

const nodes: readonly TreeNode[] = [
  {
    id: 'page-1',
    label: 'Page 1',
    children: [
      { id: 'title', label: 'Title', badge: '✦' },
      { id: 'group', label: 'Group', children: [{ id: 'logo', label: 'Logo' }] },
    ],
  },
  { id: 'page-2', label: 'Page 2', children: [{ id: 'photo', label: 'Photo' }] },
  { id: 'locked', label: 'Locked', draggable: false, disabled: true },
];

function rows(tree: SfTreeElement): HTMLElement[] {
  return shadowAll(tree, '[role="treeitem"]');
}

const ids = (tree: SfTreeElement): string[] => rows(tree).map((r) => r.dataset['id'] ?? '');

describe('tree helpers', () => {
  it('flattens expanded nodes with levels and positions', () => {
    const flat = flattenTree(nodes, new Set(['page-1']));
    expect(flat.map((r) => [r.node.id, r.level, r.posinset, r.setsize, r.expanded])).toEqual([
      ['page-1', 1, 1, 3, true],
      ['title', 2, 1, 2, undefined],
      ['group', 2, 2, 2, false],
      ['page-2', 1, 2, 3, false],
      ['locked', 1, 3, 3, undefined],
    ]);
    expect(flat[2]?.parentId).toBe('page-1');
  });

  it('computes the virtual window, drop positions and subtree checks', () => {
    expect(visibleRange(0, 280, 28, 1000)).toEqual({ start: 0, end: 16 });
    expect(visibleRange(2800, 280, 28, 1000)).toEqual({ start: 94, end: 116 });
    expect(visibleRange(0, 280, 28, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(27_990, 280, 28, 1000).end).toBe(1000);
    expect(dropPositionAt(2, 28, true)).toBe('before');
    expect(dropPositionAt(14, 28, true)).toBe('inside');
    expect(dropPositionAt(26, 28, true)).toBe('after');
    expect(dropPositionAt(10, 28, false)).toBe('before');
    expect(dropPositionAt(20, 28, false)).toBe('after');
    const page = nodes[0] as TreeNode;
    expect(isInSubtree(page, 'logo')).toBe(true);
    expect(isInSubtree(page, 'photo')).toBe(false);
    expect(findNode(nodes, 'logo')?.label).toBe('Logo');
    expect(findNode(nodes, 'nope')).toBeUndefined();
    expect(treeDragMachine.states).toEqual(['idle', 'dragging']);
  });
});

describe('<sf-tree>', () => {
  it('renders an accessible flat tree with activedescendant focus', async () => {
    const { element } = await fixture<SfTreeElement>(html`<sf-tree label="Layers" .nodes=${nodes} .expanded=${new Set(['page-1'])}></sf-tree>`);
    await settle();
    const tree = element.shadowRoot?.querySelector('[role="tree"]') as HTMLElement;
    expect(tree.getAttribute('aria-label')).toBe('Layers');
    expect(ids(element)).toEqual(['page-1', 'title', 'group', 'page-2', 'locked']);
    const [page] = rows(element);
    expect(page?.getAttribute('aria-level')).toBe('1');
    expect(page?.getAttribute('aria-expanded')).toBe('true');
    expect(tree.getAttribute('aria-activedescendant')).toBe(page?.id);
    expect(rows(element)[4]?.getAttribute('aria-disabled')).toBe('true');
    expectNoA11yIssues(element);
  });

  it('navigates with the APG keyboard model; single selection follows focus', async () => {
    const { element } = await fixture<SfTreeElement>(html`<sf-tree label="Layers" .nodes=${nodes}></sf-tree>`);
    await settle();
    const tree = element.shadowRoot?.querySelector('[role="tree"]') as HTMLElement;
    const selections = events<{ ids: string[] }>(element, 'sf-select');
    const toggles = events<{ id: string; expanded: boolean }>(element, 'sf-toggle');
    const activations = events<{ id: string }>(element, 'sf-activate');
    tree.focus();
    press(tree, 'ArrowRight'); // expand page-1
    await element.updateComplete;
    expect(toggles[0]?.detail).toEqual({ id: 'page-1', expanded: true });
    press(tree, 'ArrowRight'); // into first child
    await element.updateComplete;
    expect(element.activeId).toBe('title');
    expect(selections.at(-1)?.detail.ids).toEqual(['title']);
    press(tree, 'ArrowDown');
    press(tree, 'ArrowRight'); // expand group
    press(tree, 'ArrowRight'); // logo
    await element.updateComplete;
    expect(element.activeId).toBe('logo');
    press(tree, 'ArrowLeft'); // to parent group
    press(tree, 'ArrowLeft'); // collapse group
    await element.updateComplete;
    expect(element.expanded.has('group')).toBe(false);
    press(tree, 'End');
    expect(element.activeId).toBe('locked');
    press(tree, 'Home');
    expect(element.activeId).toBe('page-1');
    press(tree, 'p'); // type-ahead → next "P…"
    expect(element.activeId).toBe('page-2');
    press(tree, 'Enter');
    expect(activations[0]?.detail.id).toBe('page-2');
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector('[role="tree"]')?.getAttribute('aria-activedescendant')).toBe(rows(element).find((r) => r.dataset['id'] === 'page-2')?.id);
  });

  it('multi-selects with Space, Ctrl-click and Shift-click', async () => {
    const { element } = await fixture<SfTreeElement>(html`<sf-tree label="Layers" multiselect .nodes=${nodes} .expanded=${new Set(['page-1'])}></sf-tree>`);
    await settle();
    const tree = element.shadowRoot?.querySelector('[role="tree"]') as HTMLElement;
    expect(tree.getAttribute('aria-multiselectable')).toBe('true');
    tree.focus();
    press(tree, 'ArrowDown');
    expect(element.selected.size).toBe(0); // focus does not select in multi mode
    press(tree, ' ');
    expect([...element.selected]).toEqual(['title']);
    const [page, , group] = rows(element);
    group?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ctrlKey: true }));
    expect([...element.selected].sort()).toEqual(['group', 'title']);
    page?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await element.updateComplete;
    rows(element)[3]?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, shiftKey: true }));
    expect([...element.selected]).toEqual(['page-1', 'title', 'group', 'page-2']);
    press(tree, ' ');
    expect(element.selected.has('page-2')).toBe(false);
    rows(element)[4]?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); // disabled
    expect(element.selected.has('locked')).toBe(false);
  });

  it('expands and collapses from the twisty', async () => {
    const { element } = await fixture<SfTreeElement>(html`<sf-tree label="Layers" .nodes=${nodes}></sf-tree>`);
    await settle();
    (rows(element)[0]?.querySelector('.twisty') as HTMLElement).click();
    await element.updateComplete;
    expect(ids(element)).toContain('title');
    expect(element.selected.size).toBe(0);
  });

  it('reorders with Alt+Arrow (keyboard equivalent of dragging), filtered by canDrop and cancelable', async () => {
    const { element } = await fixture<SfTreeElement>(html`<sf-tree label="Layers" .nodes=${nodes} .expanded=${new Set(['page-1'])}></sf-tree>`);
    await settle();
    const tree = element.shadowRoot?.querySelector('[role="tree"]') as HTMLElement;
    const reorders = events<ReorderDetail>(element, 'sf-reorder');
    element.focusRow('group');
    press(tree, 'ArrowUp', { alt: true });
    expect(reorders[0]?.detail).toEqual({ id: 'group', targetId: 'title', position: 'before' });
    element.focusRow('page-1');
    press(tree, 'ArrowDown', { alt: true });
    expect(reorders[1]?.detail).toEqual({ id: 'page-1', targetId: 'page-2', position: 'after' });
    element.canDrop = (_s, target) => target.id !== 'page-2';
    press(tree, 'ArrowDown', { alt: true });
    expect(reorders).toHaveLength(2);
    expect(element.requestReorder('page-1', 'logo', 'inside')).toBe(false); // own subtree
    element.addEventListener('sf-reorder', (e) => e.preventDefault(), { signal: new AbortController().signal });
    element.canDrop = undefined;
    expect(element.requestReorder('title', 'page-2', 'inside')).toBe(false);
  });

  it('B11b: trailing row content never selects; muted and highlighted rows; inline rename commits, refuses empty, cancels', async () => {
    let toggled = 0;
    const decorated: readonly TreeNode[] = [
      { id: 'a', label: 'Sun', muted: true, trailing: html`<span class="eye" aria-hidden="true" @click=${() => (toggled += 1)}>o</span>`, trailingPinned: true },
      { id: 'b', label: 'Moon', trailing: html`<span aria-hidden="true">o</span>` },
    ];
    const { element } = await fixture<SfTreeElement>(html`<sf-tree label="Layers" .nodes=${decorated} .highlighted=${'b'}></sf-tree>`);
    await settle();
    const [a, b] = rows(element);
    expect(a?.classList.contains('muted')).toBe(true);
    expect(b?.classList.contains('hovered')).toBe(true);
    expect(a?.querySelector('.trailing')?.classList.contains('pinned')).toBe(true);
    (a?.querySelector('.eye') as HTMLElement).click();
    expect(toggled).toBe(1);
    expect(element.selected.size).toBe(0);
    expectNoA11yIssues(element);
    const renames = events<RenameDetail>(element, 'sf-rename');
    const cancels = events<{ id: string }>(element, 'sf-rename-cancel');
    element.renaming = 'a';
    await settle();
    const input = element.shadowRoot?.querySelector('input.rename') as HTMLInputElement;
    expect(element.shadowRoot?.activeElement).toBe(input);
    expect(rows(element)[0]?.getAttribute('draggable')).toBe('false');
    input.value = '  Big sun ';
    press(input, 'ArrowDown'); // stays in the field (the tree does not move)
    press(input, 'Enter');
    await settle();
    expect(renames.map((e) => e.detail)).toEqual([{ id: 'a', value: 'Big sun' }]);
    expect(element.renaming).toBeUndefined();
    element.renaming = 'b';
    await settle();
    const second = element.shadowRoot?.querySelector('input.rename') as HTMLInputElement;
    second.value = '   ';
    press(second, 'Enter');
    await settle();
    element.renaming = 'b';
    await settle();
    press(element.shadowRoot?.querySelector('input.rename') as HTMLInputElement, 'Escape');
    expect(renames).toHaveLength(1);
    expect(cancels.map((e) => e.detail.id)).toEqual(['b', 'b']);
  });

  it('exposes drag-and-drop hooks with drop indicators', async () => {
    const { element } = await fixture<SfTreeElement>(html`<sf-tree label="Layers" row-height="28" .nodes=${nodes} .expanded=${new Set(['page-1'])}></sf-tree>`);
    await settle();
    const reorders = events<ReorderDetail>(element, 'sf-reorder');
    const store = new Map<string, string>();
    const dataTransfer = { setData: (t: string, v: string) => store.set(t, v), effectAllowed: '', dropEffect: '' } as unknown as DataTransfer;
    const drag = (type: string, row: HTMLElement, clientY = 0): DragEvent => {
      const event = new Event(type, { bubbles: true, composed: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'clientY', { value: clientY });
      row.dispatchEvent(event);
      return event;
    };
    const [, title, , page2, locked] = rows(element);
    drag('dragstart', title as HTMLElement);
    expect(store.size).toBe(1);
    const over = drag('dragover', page2 as HTMLElement, 14);
    expect(over.defaultPrevented).toBe(true);
    await element.updateComplete;
    expect(rows(element).find((r) => r.dataset['id'] === 'page-2')?.dataset['drop']).toBe('inside');
    drag('drop', rows(element).find((r) => r.dataset['id'] === 'page-2') as HTMLElement, 14);
    expect(reorders[0]?.detail).toEqual({ id: 'title', targetId: 'page-2', position: 'inside' });
    await element.updateComplete;
    expect(rows(element).some((r) => r.dataset['drop'] !== undefined)).toBe(false);
    // non-draggable rows and vetoed drags do not start
    expect(drag('dragstart', locked as HTMLElement).defaultPrevented).toBe(true);
    element.addEventListener('sf-drag-start', (e) => e.preventDefault(), { signal: new AbortController().signal });
    expect(drag('dragstart', rows(element)[0] as HTMLElement).defaultPrevented).toBe(true);
    // dropping into its own subtree is refused
    const page1 = rows(element)[0] as HTMLElement;
    element.dispatchEvent(new Event('dragend'));
    expect(drag('dragover', page1, 14).defaultPrevented).toBe(false);
  });

  it('virtualizes long trees and scrolls the active row into view', async () => {
    const many: TreeNode[] = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, label: `Layer ${i}` }));
    const { element } = await fixture<SfTreeElement>(html`<sf-tree label="Layers" row-height="20" style="block-size:200px" .nodes=${many}></sf-tree>`);
    await settle();
    expect(rows(element).length).toBeLessThan(40);
    expect((element.shadowRoot?.querySelector('.spacer') as HTMLElement).style.blockSize).toBe('100000px');
    element.focusRow('n4000');
    await element.updateComplete;
    expect(ids(element)).toContain('n4000');
    expect(element.scrollTop).toBeGreaterThan(0);
    element.nodes = many.slice(0, 10);
    await element.updateComplete;
    expect(element.activeId).toBeUndefined();
  });
});
