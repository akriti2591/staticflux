import { auditA11y } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineTag, SfTagElement } from './tag.js';
import { cleanup, fixture } from './test-helpers.js';

beforeAll(() => defineTag());
afterEach(cleanup);

describe('<sf-tag>', () => {
  it('is a non-interactive label: no role, not focusable, text read in place', async () => {
    const { element } = await fixture<SfTagElement>(html`<sf-tag>Brand · Night Market</sf-tag>`);
    expect(element.tone).toBe('neutral');
    expect(element.getAttribute('tone')).toBe('neutral');
    expect(element.hasAttribute('role')).toBe(false);
    expect(element.hasAttribute('tabindex')).toBe(false);
    expect(element.tabIndex).toBe(-1);
    expect(element.textContent).toBe('Brand · Night Market');
    expect(element.shadowRoot?.querySelector('slot:not([name])')).toBeTruthy();
    expect(auditA11y(element.parentElement as HTMLElement)).toEqual([]);
  });

  it('reflects the agent tone and mono', async () => {
    const { element } = await fixture<HTMLDivElement>(html`<div><sf-tag tone="agent">✦ Claude</sf-tag><sf-tag mono>@display</sf-tag></div>`);
    const [agent, mono] = [...element.children] as SfTagElement[];
    expect(agent?.getAttribute('tone')).toBe('agent');
    expect(mono?.mono).toBe(true);
    expect(mono?.hasAttribute('mono')).toBe(true);
  });

  it('takes a custom colour and ink, and clears them', async () => {
    const { element } = await fixture<SfTagElement>(html`<sf-tag .color=${'#3D5AFE'} .ink=${'#FFFFFF'}>Video</sf-tag>`);
    expect(element.style.getPropertyValue('--kit-tag-color')).toBe('#3D5AFE');
    expect(element.style.getPropertyValue('--kit-tag-ink')).toBe('#FFFFFF');
    element.color = undefined;
    element.ink = '';
    await element.updateComplete;
    expect(element.style.getPropertyValue('--kit-tag-color')).toBe('');
    expect(element.style.getPropertyValue('--kit-tag-ink')).toBe('');
  });

  it('is themed through contract tokens (pill from radius.control)', () => {
    const cssText = SfTagElement.styles.map((s) => String(s)).join('\n');
    expect(cssText).toContain('border-radius: var(--sf-radius-control)');
    expect(cssText).toContain('var(--kit-tag-color, var(--sf-color-neutral-3))');
    expect(cssText).toContain('var(--kit-tag-color, var(--sf-color-agent-soft))');
    expect(cssText).toContain('var(--kit-tag-ink, var(--sf-color-agent-ink))');
    expect(cssText).toContain('forced-colors');
  });
});
