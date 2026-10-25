import { auditA11y } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineStatus, SfStatusElement } from './status.js';
import { cleanup, fixture } from './test-helpers.js';

beforeAll(() => defineStatus());
afterEach(cleanup);

describe('<sf-status>', () => {
  it('is a polite live region with a decorative dot and the label in words', async () => {
    const { element } = await fixture<SfStatusElement>(html`<sf-status tone="success">Saved</sf-status>`);
    expect(element.getAttribute('role')).toBe('status');
    expect(element.tone).toBe('success');
    expect(element.getAttribute('tone')).toBe('success');
    expect(element.tabIndex).toBe(-1);
    expect(element.textContent).toBe('Saved');
    expect(element.shadowRoot?.querySelector('.dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(auditA11y(element.parentElement as HTMLElement)).toEqual([]);
  });

  it('defaults to neutral, reflects busy, and keeps an explicit role', async () => {
    const { element } = await fixture<HTMLDivElement>(html`<div><sf-status busy>Saving…</sf-status><sf-status role="alert" tone="danger">Disk full</sf-status></div>`);
    const [busy, alert] = [...element.children] as SfStatusElement[];
    expect(busy?.tone).toBe('neutral');
    expect(busy?.hasAttribute('busy')).toBe(true);
    expect(alert?.getAttribute('role')).toBe('alert');
  });

  it('is themed through contract tokens, with reduced-motion and forced-colors rules', () => {
    const cssText = SfStatusElement.styles.map((s) => String(s)).join('\n');
    expect(cssText).toContain('var(--sf-color-success)');
    expect(cssText).toContain('var(--sf-color-warning)');
    expect(cssText).toContain('var(--sf-color-danger)');
    expect(cssText).toContain('var(--sf-color-text-muted)');
    expect(cssText).toContain('prefers-reduced-motion');
    expect(cssText).toContain('forced-colors');
    expect(cssText).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('defineStatus is idempotent', () => {
    defineStatus();
    expect(customElements.get('sf-status')).toBe(SfStatusElement);
  });
});
