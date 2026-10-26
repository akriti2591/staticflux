/**
 * `<if-layers-panel>` (B11b, STUDIO-UX-SPEC §3.1): the page as a group with its elements top-most first; selection both
 * ways; rename inline; reorder by drag or Alt+↑/↓ mapped to document order; the eye and lock toggles; row keys; the
 * filter (names and kind prefixes); the empty state's tool links; hover both ways; the full audit under Clean Pop.
 */
import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import type { SfTreeElement } from '@staticflux/kit/tree';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LayerRow } from '../app/scene-summary.js';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { defineLayersPanel, dropTarget, EMPTY_LAYERS, filterLayers, type IfLayersPanelElement, type LayersModel, type LayersPort } from './layers-panel.js';

let dispose: (() => Promise<void>) | undefined;
beforeAll(() => defineLayersPanel());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

const row = (id: string, name: string, kind: LayerRow['kind'], extra: Partial<LayerRow> = {}): LayerRow => ({ id, name, kind, hidden: false, locked: false, children: [], ...extra });
const LAYERS: readonly LayerRow[] = [
  row('t', 'Night market', 'text'),
  row('g', 'Group', 'group', { children: [row('s', 'Sun', 'ellipse'), row('r', 'Card', 'rectangle')] }),
  row('h', 'Ghost', 'rectangle', { hidden: true, locked: true }),
  row('rep', 'Star', 'repeat', { meta: 'Radial · 8' }),
];
const MODEL: LayersModel = { ...EMPTY_LAYERS, page: { id: 'p1', name: 'Page 1', width: 1080, height: 1350 }, layers: LAYERS, selection: [] };

async function mount(model: LayersModel): Promise<{ el: IfLayersPanelElement; tree: SfTreeElement; calls: string[] }> {
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const root = mountTestRoot({ units: [] });
  dispose = () => root.dispose();
  const calls: string[] = [];
  const log =
    (name: string) =>
    (...args: unknown[]): void =>
      void calls.push(`${name} ${JSON.stringify(args)}`);
  const port: LayersPort = { select: log('select'), selectPage: log('selectPage'), rename: log('rename'), move: log('move'), hide: log('hide'), lock: log('lock'), remove: log('remove'), hover: log('hover'), pickTool: log('pickTool') };
  render(html`<if-layers-panel .model=${model} .port=${port}></if-layers-panel>`, root.container);
  await settle(8);
  const el = root.container.querySelector('if-layers-panel') as IfLayersPanelElement;
  const tree = el.shadowRoot?.querySelector('sf-tree') as SfTreeElement;
  await settle(4);
  return { el, tree, calls };
}

const rowIds = (tree: SfTreeElement): string[] => [...(tree.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? [])].map((r) => (r as HTMLElement).dataset['id'] ?? '');
const rowEl = (tree: SfTreeElement, id: string): HTMLElement => tree.shadowRoot?.querySelector(`[role="treeitem"][data-id="${id}"]`) as HTMLElement;

describe('<if-layers-panel>', () => {
  it('lists the page and its elements top-most first; hidden rows are muted, locked rows keep the lock; repeats carry their tag', async () => {
    const { el, tree } = await mount(MODEL);
    expect(rowIds(tree)).toEqual(['p1', 't', 'g', 'h', 'rep']);
    expect(rowEl(tree, 'h').classList.contains('muted')).toBe(true);
    expect(rowEl(tree, 'h').querySelector('.trailing')?.classList.contains('pinned')).toBe(true);
    expect(rowEl(tree, 'rep').textContent).toContain('Radial · 8');
    expect(rowEl(tree, 'h').querySelector('sf-icon')?.getAttribute('aria-label')).toBe('Rectangle, hidden, locked');
    expectNoA11yIssues(el);
  });

  it('a canvas selection expands its containers and highlights its row; a canvas hover outlines one', async () => {
    const { tree } = await mount({ ...MODEL, selection: ['s'], hover: 't' });
    expect(rowIds(tree)).toEqual(['p1', 't', 'g', 's', 'r', 'h', 'rep']);
    expect(rowEl(tree, 's').getAttribute('aria-selected')).toBe('true');
    expect(rowEl(tree, 't').classList.contains('hovered')).toBe(true);
  });

  it('selecting rows selects on the canvas; the page row selects the page', async () => {
    const { tree, calls } = await mount(MODEL);
    rowEl(tree, 't').click();
    rowEl(tree, 'h').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ctrlKey: true }));
    rowEl(tree, 'p1').click();
    expect(calls).toEqual(['select [["t"]]', 'select [["t","h"]]', 'selectPage []']);
  });

  it('the eye and lock toggle without selecting; row keys hide, lock, delete and rename', async () => {
    const { tree, calls } = await mount({ ...MODEL, selection: ['t'] });
    const acts = rowEl(tree, 'h').querySelectorAll<HTMLElement>('.act');
    acts[0]?.click();
    acts[1]?.click();
    const viewport = tree.shadowRoot?.querySelector('[role="tree"]') as HTMLElement;
    press(viewport, 'H', { ctrl: true, shift: true });
    press(viewport, 'L', { ctrl: true, shift: true });
    press(viewport, 'Delete');
    press(viewport, 'F2');
    await settle(4);
    const input = tree.shadowRoot?.querySelector('input.rename') as HTMLInputElement;
    input.value = 'Headline';
    press(input, 'Enter');
    expect(calls).toEqual(['hide [["h"],false]', 'lock [["h"],false]', 'hide [["t"],true]', 'lock [["t"],true]', 'remove [["t"]]', 'rename ["t","Headline"]']);
  });

  it('Alt+↑ / ↓ and drops map to document order: above a row = after it in paint order', async () => {
    const { tree, calls } = await mount({ ...MODEL, selection: ['h'] });
    tree.focusRow('h', { select: false });
    const viewport = tree.shadowRoot?.querySelector('[role="tree"]') as HTMLElement;
    press(viewport, 'ArrowUp', { alt: true });
    press(viewport, 'ArrowDown', { alt: true });
    expect(dropTarget(LAYERS, 'p1', { id: 'h', targetId: 'g', position: 'before' })).toEqual({ parent: 'p1', before: 't' });
    expect(dropTarget(LAYERS, 'p1', { id: 'h', targetId: 't', position: 'before' })).toEqual({ parent: 'p1', before: null });
    expect(dropTarget(LAYERS, 'p1', { id: 'h', targetId: 'rep', position: 'after' })).toEqual({ parent: 'p1', before: 'rep' });
    expect(dropTarget(LAYERS, 'p1', { id: 't', targetId: 'g', position: 'inside' })).toEqual({ parent: 'g', before: null });
    expect(dropTarget(LAYERS, 'p1', { id: 't', targetId: 's', position: 'after' })).toEqual({ parent: 'g', before: 's' });
    expect(dropTarget(LAYERS, 'p1', { id: 't', targetId: 'p1', position: 'inside' })).toEqual({ parent: 'p1', before: null });
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe('move [["h"],"p1","t"]');
    expect(calls[1]).toBe('move [["h"],"p1","rep"]');
  });

  it('filters by name and by kind prefix (ancestors stay); Escape clears; no match says so', async () => {
    expect(filterLayers(LAYERS, 'sun').map((r) => [r.id, r.children.map((c) => c.id)])).toEqual([['g', ['s']]]);
    expect(filterLayers(LAYERS, 'text:').map((r) => r.id)).toEqual(['t']);
    expect(filterLayers(LAYERS, 'shape: card').map((r) => [r.id, r.children.map((c) => c.id)])).toEqual([['g', ['r']]]);
    expect(filterLayers(LAYERS, '')).toBe(LAYERS);
    const { el, tree } = await mount(MODEL);
    const field = el.shadowRoot?.querySelector('sf-text-field') as HTMLElement;
    const input = field.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await settle(4);
    expect(el.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe('No layers match.');
    expect(rowIds(tree)).toEqual(['p1']);
    press(input, 'Escape');
    await settle(4);
    expect(rowIds(tree)).toEqual(['p1', 't', 'g', 'h', 'rep']);
  });

  it('empty page: one line whose tool names pick the tools; hovering rows outlines on the canvas', async () => {
    const { el, calls } = await mount({ ...MODEL, layers: [] });
    const links = [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('button.link') ?? [])];
    expect(el.shadowRoot?.querySelector('p')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Nothing here yet. Draw a shape (R) or add text (T).');
    links[0]?.click();
    links[1]?.click();
    expect(calls).toEqual(['pickTool ["shape"]', 'pickTool ["text"]']);
    expectNoA11yIssues(el);
    const full = await mount(MODEL);
    rowEl(full.tree, 't').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true }));
    full.tree.dispatchEvent(new PointerEvent('pointerleave'));
    expect(full.calls).toEqual(['hover ["t"]', 'hover [null]']);
  });
});
