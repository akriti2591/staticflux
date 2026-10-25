/**
 * The Assets panel: kit components only under Clean Pop, keyboard paths for every action, an
 * accessibility audit, and the B0 panel contribution.
 */
import { unit } from '@staticflux/core';
import type { SfButtonElement } from '@staticflux/kit/button';
import type { SfSegmentedElement } from '@staticflux/kit/segmented';
import type { SfTreeElement } from '@staticflux/kit/tree';
import { auditA11y, press } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { lensOf } from '../theme/lenses.js';
import type { LibraryEntry } from './library-doc.js';
import { defineLibraryPanel, type IfLibraryPanelElement, libraryNodes } from './library-panel.js';
import { LibraryPanelModelToken } from './tokens.js';
import { fakeImageBytes, fileOf, panelModelFixture, signal, unwrap } from './test-helpers.js';

let dispose: (() => Promise<void>) | undefined;

beforeAll(() => defineLibraryPanel());
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

async function mount() {
  const fixture = await panelModelFixture([fileOf('picked.png', 'image/png', fakeImageBytes(6, 6, [1, 2, 3, 255], 9))]);
  unwrap(await fixture.model.importFiles([fileOf('hero.png', 'image/png', fakeImageBytes(640, 480)), fileOf('jingle.mp3', 'audio/mpeg', Uint8Array.of(1, 2))]));
  unwrap(await fixture.renditions.idle(signal));
  const style = document.createElement('style');
  style.textContent = compileTheme(cleanPopTheme);
  document.head.append(style);
  const root = mountTestRoot({ units: [unit({ id: 'test/library-panel-model', provides: LibraryPanelModelToken, scope: 'app', create: () => fixture.model })] });
  dispose = () => root.dispose();
  render(html`<if-library-panel></if-library-panel>`, root.container);
  await settle();
  const panel = root.container.querySelector('if-library-panel') as IfLibraryPanelElement;
  await panel.updateComplete;
  const shadow = panel.shadowRoot as ShadowRoot;
  const q = <T extends Element>(selector: string): T => shadow.querySelector(selector) as T;
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      await settle();
      await panel.updateComplete;
    }
  };
  const tree = async (): Promise<{ host: SfTreeElement; node: HTMLElement }> => {
    const host = q<SfTreeElement>('sf-tree');
    await host.updateComplete;
    return { host, node: host.shadowRoot?.querySelector('[role="tree"]') as HTMLElement };
  };
  const announced = (): string => q<HTMLElement>('[role="status"]').textContent ?? '';
  return { ...fixture, panel, shadow, q, flush, tree, announced };
}

describe('libraryNodes', () => {
  it('maps entries to flat rows with the kind’s lens mark, size and favourite badge', () => {
    const entry: LibraryEntry = { asset: 'as_1', kind: 'image', title: 'Hero', createdAt: '', folder: '', favorite: true, tags: [], renditions: {}, media: { width: 4, height: 3 } };
    const [row] = libraryNodes([entry, { ...entry, favorite: false, media: {} }], 'Favorite');
    expect(row).toMatchObject({ id: 'as_1', label: 'Hero', badge: '4×3 · Favorite', draggable: false });
    const markup = (row?.icon as { values: unknown[] }).values.join('');
    expect(markup).toContain(lensOf('pixel').color);
    expect(libraryNodes([{ ...entry, favorite: false, media: {} }], 'F')[0]?.badge).toBeUndefined();
  });
});

describe('<if-library-panel>', () => {
  it('renders kit components only, one primary action, labelled controls and no a11y issues', async () => {
    const { panel, shadow } = await mount();
    expect(shadow.querySelector('section')?.getAttribute('aria-labelledby')).toBe('library-title');
    const variants = [...shadow.querySelectorAll('sf-button')].map((b) => (b as SfButtonElement).variant);
    expect(variants.filter((v) => v === 'primary')).toHaveLength(1);
    expect(variants.every((v) => ['primary', 'secondary', 'ghost'].includes(v))).toBe(true);
    const custom = [...shadow.querySelectorAll('*')].map((e) => e.localName).filter((n) => n.includes('-'));
    expect(new Set(custom)).toEqual(new Set(['sf-button', 'sf-text-field', 'sf-segmented', 'sf-tree', 'sf-toolbar']));
    expect(auditA11y(panel.parentElement as HTMLElement)).toEqual([]);
  });

  it('keyboard: the list selects, shows a preview, Enter places, F2 renames, Delete trashes', async () => {
    const { q, flush, tree, announced, placed, shadow } = await mount();
    const { node } = await tree();
    node.focus();
    press(node, 'ArrowDown');
    await flush();
    expect(q<HTMLImageElement>('img.preview')?.getAttribute('alt') ?? q<HTMLElement>('.caption')?.textContent).toBeTruthy();
    press(node, 'h'); // type-ahead
    await flush();
    const img = q<HTMLImageElement>('img.preview');
    expect(img?.getAttribute('src')).toMatch(/^blob:/);
    expect(img?.getAttribute('alt')).toBe('Preview of hero');
    press(node, 'Enter');
    await flush();
    expect(placed.map((e) => e.title)).toEqual(['hero']);
    expect(announced()).toBe('Placed “hero”');

    press(node, 'F2');
    await flush();
    const field = q<HTMLElement>('sf-text-field.rename-field');
    await (field as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const input = field.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = 'Lamps';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    press(input, 'Enter');
    await flush();
    expect(announced()).toBe('Renamed to “Lamps”');
    expect(shadow.querySelector('sf-text-field.rename-field')).toBeNull();

    const again = (await tree()).node;
    again.focus();
    press(again, 'l');
    await flush();
    press(again, 'Delete');
    await flush();
    expect(announced()).toBe('Moved “Lamps” to the trash');
  });

  it('filter switcher, search, favorite toggle, restore from trash, and Escape cancels a rename', async () => {
    const { q, flush, tree, announced, model } = await mount();
    const filter = q<SfSegmentedElement>('sf-segmented');
    filter.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'audio' } }));
    await flush();
    expect(model.rows().map((r) => r.title)).toEqual(['jingle']);
    filter.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'all' } }));
    const search = q<HTMLElement>('sf-text-field.search');
    await (search as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const input = search.shadowRoot?.querySelector('input') as HTMLInputElement;
    input.value = 'her';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await flush();
    expect(model.rows().map((r) => r.title)).toEqual(['hero']);
    const { node } = await tree();
    node.focus();
    press(node, 'h');
    await flush();
    q<SfButtonElement>('sf-button.favorite').click();
    await flush();
    expect(announced()).toBe('Added “hero” to favorites');
    expect(q<SfButtonElement>('sf-button.favorite').pressed).toBe(true);
    q<SfButtonElement>('sf-button.rename').click();
    await flush();
    const rename = q<HTMLElement>('sf-text-field.rename-field');
    await (rename as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    press(rename.shadowRoot?.querySelector('input') as HTMLInputElement, 'Escape');
    await flush();
    expect(q('sf-text-field.rename-field')).toBeNull();
    q<SfButtonElement>('sf-button.trash').click();
    await flush();
    filter.dispatchEvent(new CustomEvent('sf-change', { detail: { value: 'trash' } }));
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await flush();
    const trashed = (await tree()).node;
    trashed.focus();
    press(trashed, 'Home');
    await flush();
    expect(q<SfButtonElement>('sf-button.trash').textContent).toBe('Restore');
    expect(q<SfButtonElement>('sf-button.place').disabled).toBe(true);
    press(trashed, 'Delete');
    await flush();
    expect(announced()).toBe('Restored “hero”');
    expect(q<HTMLElement>('.empty').textContent).toBe('The trash is empty.');
  });

  it('Import opens the picker (the keyboard path for dropping files); dropped files import too', async () => {
    const { q, flush, announced, panel, model } = await mount();
    q<SfButtonElement>('sf-button.import').click();
    await flush();
    expect(announced()).toBe('Imported 1 asset(s)');
    const file = new File([fakeImageBytes(640, 480) as Uint8Array<ArrayBuffer>], 'hero copy.png', { type: 'image/png' });
    await panel.importFiles([file]);
    await flush();
    expect(announced()).toBe('hero copy.png is already in the library'.replace('hero copy.png', 'hero'));
    await panel.importFiles([new File([Uint8Array.of(1)], 'x.txt', { type: 'text/plain' })]);
    await flush();
    expect(announced()).toContain('x.txt could not be imported');
    const drop = new Event('drop', { bubbles: true, composed: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File([fakeImageBytes(2, 2, [5, 5, 5, 255]) as Uint8Array<ArrayBuffer>], 'dropped.png', { type: 'image/png' })] } });
    q('section').dispatchEvent(drop);
    await flush();
    expect(model.rows().map((r) => r.title)).toContain('dropped');
  });
});
