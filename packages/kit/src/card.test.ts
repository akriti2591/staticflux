import { auditA11y } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineCard, SfCardElement } from './card.js';
import { cleanup, fixture, shadow } from './test-helpers.js';

beforeAll(() => defineCard());
afterEach(cleanup);

describe('<sf-card>', () => {
  it('is a plain container without href: no role, not focusable, content slotted', async () => {
    const { element } = await fixture<SfCardElement>(html`<sf-card><h2>Quick actions</h2></sf-card>`);
    expect(element.shadowRoot?.querySelector('a')).toBeNull();
    const card = shadow(element, '.card');
    expect(card.localName).toBe('div');
    expect(card.querySelector('slot')).toBeTruthy();
    expect(element.hasAttribute('role')).toBe(false);
    expect(element.tabIndex).toBe(-1);
    expect(auditA11y(element.parentElement as HTMLElement)).toEqual([]);
  });

  it('with href, the whole card is one native link named by its text', async () => {
    const { element } = await fixture<SfCardElement>(html`<sf-card href="/s/as_1"><span>Night Market Flyer</span><span>Edited now</span></sf-card>`);
    const link = shadow<HTMLAnchorElement>(element, 'a.card');
    expect(link.getAttribute('href')).toBe('/s/as_1');
    expect(link.classList.contains('focus-target')).toBe(true);
    expect(link.hasAttribute('aria-label')).toBe(false);
    expect(link.querySelector('slot')).toBeTruthy();
    expect(element.getAttribute('href')).toBe('/s/as_1');
    expect(auditA11y(element.parentElement as HTMLElement)).toEqual([]);
  });

  it('takes an explicit accessible name and drops the link when href is cleared', async () => {
    const { element } = await fixture<SfCardElement>(html`<sf-card href="/new" label="New Instagram post"><span aria-hidden="true">＋</span></sf-card>`);
    expect(shadow(element, 'a').getAttribute('aria-label')).toBe('New Instagram post');
    element.label = '';
    await element.updateComplete;
    expect(shadow(element, 'a').hasAttribute('aria-label')).toBe(false);
    element.href = undefined;
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector('a')).toBeNull();
    element.href = '';
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector('a')).toBeNull();
  });

  it('is themed through contract tokens (large radius, hairline, focus ring, forced colors)', () => {
    const cssText = SfCardElement.styles.map((s) => String(s)).join('\n');
    expect(cssText).toContain('border-radius: var(--sf-radius-lg)');
    expect(cssText).toContain('1px solid var(--sf-color-border)');
    expect(cssText).toContain('var(--kit-card-padding, var(--sf-space-lg))');
    expect(cssText).toContain('.focus-target:focus-visible');
    expect(cssText).toContain('forced-colors');
    expect(cssText).toContain('prefers-reduced-motion');
  });
});
