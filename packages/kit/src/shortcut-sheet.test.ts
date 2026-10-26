import { expectNoA11yIssues } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineShortcutSheet, filterShortcutSheet, type SfShortcutSheetElement, type ShortcutSheetGroup, shortcutSheetGroups } from './shortcut-sheet.js';
import { cleanup, events, fixture, shadowAll } from './test-helpers.js';

beforeAll(() => defineShortcutSheet());
afterEach(cleanup);

const list = [
  { id: 'a/undo', description: 'Undo', keys: ['Mod+Z'] },
  { id: 'a/undo-chrome', description: 'Undo', keys: ['Mod+Z'] },
  { id: 'a/rename', description: 'Rename', keys: ['Mod+Shift+R', 'F2'] },
  { id: 'a/zoom', description: 'Zoom in', keys: ['Mod+='] },
  { id: 'a/shadowed', description: 'Shadowed', keys: ['Escape'], shadowedBy: 'a/other' },
  { id: 'a/dropped', description: 'Not grouped', keys: ['X'] },
];
const groupOf = (e: { id: string }): string | undefined => ({ 'a/undo': 'Edit', 'a/undo-chrome': 'Edit', 'a/rename': 'Studio', 'a/zoom': 'View', 'a/shadowed': 'View' })[e.id];

describe('shortcutSheetGroups', () => {
  it('groups in order, drops repeats, shadowed and ungrouped entries and empty groups', () => {
    const groups = shortcutSheetGroups(list, groupOf, ['Tools', 'Edit', 'View', 'Studio']);
    expect(groups.map((g) => g.heading)).toEqual(['Edit', 'View', 'Studio']);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['a/undo']);
    expect(groups[1]?.rows.map((r) => r.id)).toEqual(['a/zoom']);
    expect(groups[2]?.rows[0]?.keys).toEqual(['Mod+Shift+R', 'F2']);
  });

  it('filters by label and by the platform key label', () => {
    const groups = shortcutSheetGroups(list, groupOf, ['Edit', 'View', 'Studio']);
    expect(filterShortcutSheet(groups, 'ren', 'mac').map((g) => g.heading)).toEqual(['Studio']);
    expect(filterShortcutSheet(groups, 'ctrl+z', 'windows')[0]?.rows[0]?.id).toBe('a/undo');
    expect(filterShortcutSheet(groups, 'ctrl+z', 'mac')).toEqual([]);
    expect(filterShortcutSheet(groups, '  ', 'mac')).toBe(groups);
  });
});

describe('<sf-shortcut-sheet>', () => {
  const groups: readonly ShortcutSheetGroup[] = shortcutSheetGroups(list, groupOf, ['Edit', 'View', 'Studio']);

  it('renders one card per group with kbd pills per platform, accessible', async () => {
    const { element } = await fixture<SfShortcutSheetElement>(html`<sf-shortcut-sheet platform="windows" .groups=${groups}></sf-shortcut-sheet>`);
    expect(shadowAll(element, 'section h3').map((h) => h.textContent)).toEqual(['Edit', 'View', 'Studio']);
    expect(shadowAll(element, 'kbd').map((k) => k.textContent)).toContain('Ctrl+Z');
    expectNoA11yIssues(element);
    shadowAll<HTMLButtonElement>(element, '.platform button')[0]?.click();
    await element.updateComplete;
    expect(element.platform).toBe('mac');
    expect(shadowAll(element, '.platform button')[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(shadowAll(element, 'kbd').map((k) => k.textContent)).not.toContain('Ctrl+Z');
  });

  it('focuses the search, filters and marks matches, shows an empty state', async () => {
    const { element } = await fixture<SfShortcutSheetElement>(html`<sf-shortcut-sheet .groups=${groups}></sf-shortcut-sheet>`);
    await element.focusSearch();
    const input = element.shadowRoot?.querySelector('input') as HTMLInputElement;
    expect(element.shadowRoot?.activeElement).toBe(input);
    input.value = 'zoom';
    input.dispatchEvent(new Event('input'));
    await element.updateComplete;
    expect(shadowAll(element, 'li').length).toBe(1);
    expect(shadowAll(element, 'mark')[0]?.textContent).toBe('Zoom');
    input.value = 'nothing like this';
    input.dispatchEvent(new Event('input'));
    await element.updateComplete;
    expect(shadowAll(element, '.empty')[0]?.textContent).toBe('No shortcuts match');
    expectNoA11yIssues(element);
  });

  it('reports the hovered row', async () => {
    const { element } = await fixture<SfShortcutSheetElement>(html`<sf-shortcut-sheet .groups=${groups}></sf-shortcut-sheet>`);
    const seen = events<{ id: string | undefined }>(element, 'sf-row-hover');
    const row = shadowAll(element, 'li')[0] as HTMLElement;
    row.dispatchEvent(new Event('pointerenter'));
    row.dispatchEvent(new Event('pointerleave'));
    expect(seen.map((e) => e.detail.id)).toEqual(['a/undo', undefined]);
  });
});
