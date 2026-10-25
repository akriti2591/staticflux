import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineTabs, type SfTabElement, type SfTabPanelElement, type SfTabsElement } from './tabs.js';
import { cleanup, events, fixture, settle } from './test-helpers.js';

beforeAll(() => defineTabs());
afterEach(cleanup);

async function tabs(extra = ''): Promise<{ element: SfTabsElement; tabs: SfTabElement[]; panels: SfTabPanelElement[] }> {
  const { element } = await fixture<SfTabsElement>(
    html`<sf-tabs label="Views" value="a" activation=${extra === 'manual' ? 'manual' : 'auto'}>
      <sf-tab value="a">Content</sf-tab><sf-tab value="b">Comments</sf-tab><sf-tab value="c" disabled>History</sf-tab>
      <sf-tab-panel value="a">A</sf-tab-panel><sf-tab-panel value="b">B</sf-tab-panel>
    </sf-tabs>`,
  );
  await settle();
  return { element, tabs: [...element.querySelectorAll('sf-tab')] as SfTabElement[], panels: [...element.querySelectorAll('sf-tab-panel')] as SfTabPanelElement[] };
}

describe('<sf-tabs>', () => {
  it('wires tablist, tabs and panels in one tree', async () => {
    const { element, tabs: [a, b, c], panels: [pa, pb] } = await tabs();
    const tablist = element.shadowRoot?.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute('aria-label')).toBe('Views');
    expect([a, b, c].map((t) => t?.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(a?.getAttribute('aria-controls')).toBe(pa?.id);
    expect(pa?.getAttribute('aria-labelledby')).toBe(a?.id);
    expect(pb?.hidden).toBe(true);
    expect(c?.hasAttribute('aria-controls')).toBe(false);
    expect(c?.getAttribute('aria-disabled')).toBe('true');
    expect([a, b, c].map((t) => t?.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expectNoA11yIssues(element);
  });

  it('selects on arrow focus (automatic activation) and skips disabled tabs', async () => {
    const { element, tabs: [a, b], panels: [pa, pb] } = await tabs();
    const changes = events<{ value: string }>(element, 'sf-change');
    a?.focus();
    press(a as HTMLElement, 'ArrowRight');
    await settle();
    expect(element.value).toBe('b');
    expect(document.activeElement).toBe(b);
    expect([pa?.hidden, pb?.hidden]).toEqual([true, false]);
    press(b as HTMLElement, 'ArrowRight'); // c disabled → wraps to a
    await settle();
    expect(element.value).toBe('a');
    expect(changes.map((e) => e.detail.value)).toEqual(['b', 'a']);
  });

  it('activates manually with Enter, Space and click', async () => {
    const { element, tabs: [a, b, c] } = await tabs('manual');
    a?.focus();
    press(a as HTMLElement, 'ArrowRight');
    await settle();
    expect(element.value).toBe('a');
    press(b as HTMLElement, 'Enter');
    await settle();
    expect(element.value).toBe('b');
    a?.click();
    await settle();
    expect(element.value).toBe('a');
    press(b as HTMLElement, ' ');
    c?.click();
    await settle();
    expect(element.value).toBe('b');
    element.select('missing');
    expect(element.value).toBe('b');
  });

  it('supports vertical orientation and tabs without panels', async () => {
    const { element } = await fixture<SfTabsElement>(html`<sf-tabs label="Side" orientation="vertical" value="x"><sf-tab value="x">X</sf-tab><sf-tab value="y">Y</sf-tab></sf-tabs>`);
    await settle();
    const [x, y] = [...element.querySelectorAll('sf-tab')] as SfTabElement[];
    expect(element.shadowRoot?.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('vertical');
    x?.focus();
    press(x as HTMLElement, 'ArrowDown');
    await settle();
    expect(element.value).toBe('y');
    expect(document.activeElement).toBe(y);
    expectNoA11yIssues(element);
  });
});
