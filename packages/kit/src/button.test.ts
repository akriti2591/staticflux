import { auditA11y, expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineButton, SfButtonElement } from './button.js';
import { defineIconButton, SfIconButtonElement } from './icon-button.js';
import { pressedConverter } from './internal/button-styles.js';
import { ariaKeyShortcuts, isApplePlatform, shortcutLabel } from './internal/shortcuts.js';
import { cleanup, fixture, settle, shadow } from './test-helpers.js';

beforeAll(() => {
  defineButton();
  defineIconButton();
});
afterEach(cleanup);

describe('<sf-button>', () => {
  it('is an accessible button host that renders its label', async () => {
    const { element } = await fixture<SfButtonElement>(html`<sf-button variant="primary">Save</sf-button>`);
    expect(element.getAttribute('role')).toBe('button');
    expect(element.getAttribute('tabindex')).toBe('0');
    expect(element.getAttribute('variant')).toBe('primary');
    expect(element.getAttribute('sf-state')).toBe('ready');
    expect(shadow(element, '.control slot:not([name])')).toBeTruthy();
    expectNoA11yIssues(element.parentElement as HTMLElement);
  });

  it('activates with Enter on keydown and Space on keyup', async () => {
    const { element } = await fixture<SfButtonElement>(html`<sf-button>Go</sf-button>`);
    let clicks = 0;
    element.addEventListener('click', () => (clicks += 1), { signal: new AbortController().signal });
    press(element, 'Enter');
    expect(clicks).toBe(1);
    const down = press(element, ' ');
    expect(down.defaultPrevented).toBe(true);
    expect(clicks).toBe(1);
    press(element, ' ', { type: 'keyup' });
    expect(clicks).toBe(2);
  });

  it('swallows clicks and leaves the tab order when disabled', async () => {
    const { element } = await fixture<SfButtonElement>(html`<sf-button disabled>Nope</sf-button>`);
    let clicks = 0;
    element.addEventListener('click', () => (clicks += 1), { signal: new AbortController().signal });
    element.click();
    press(element, 'Enter');
    expect(clicks).toBe(0);
    expect(element.getAttribute('aria-disabled')).toBe('true');
    expect(element.getAttribute('tabindex')).toBe('-1');
    element.disabled = false;
    await element.updateComplete;
    expect(element.hasAttribute('aria-disabled')).toBe(false);
    expect(element.getAttribute('tabindex')).toBe('0');
  });

  it('reflects toggle state as aria-pressed', async () => {
    const { element } = await fixture<SfButtonElement>(html`<sf-button pressed>Bold</sf-button>`);
    expect(element.pressed).toBe(true);
    expect(element.getAttribute('aria-pressed')).toBe('true');
    element.pressed = false;
    await element.updateComplete;
    expect(element.getAttribute('aria-pressed')).toBe('false');
    element.pressed = undefined;
    await element.updateComplete;
    expect(element.hasAttribute('aria-pressed')).toBe(false);
    expect(pressedConverter.fromAttribute('false')).toBe(false);
    expect(pressedConverter.fromAttribute(null)).toBeUndefined();
    expect(pressedConverter.toAttribute(true)).toBe('true');
    expect(pressedConverter.toAttribute(undefined)).toBeNull();
  });

  it('submits and resets its form', async () => {
    let submitted = 0;
    let reset = 0;
    const { element } = await fixture<HTMLFormElement>(
      html`<form @submit=${(e: Event) => (e.preventDefault(), (submitted += 1))} @reset=${() => (reset += 1)}>
        <sf-button type="submit">Send</sf-button><sf-button type="reset">Clear</sf-button><sf-button>Plain</sf-button>
      </form>`,
    );
    const [send, clear, plain] = [...element.querySelectorAll('sf-button')] as SfButtonElement[];
    send?.click();
    clear?.click();
    plain?.click();
    expect(submitted).toBe(1);
    expect(reset).toBe(1);
  });

  it('offers agent and agent-soft variants with the same button semantics', async () => {
    const { element } = await fixture<HTMLDivElement>(
      html`<div><sf-button variant="agent">✦ Start making</sf-button><sf-button variant="agent-soft" size="sm">✦ Rewrite</sf-button></div>`,
    );
    const [agent, soft] = [...element.children] as SfButtonElement[];
    expect(agent?.variant).toBe('agent');
    expect(agent?.getAttribute('role')).toBe('button');
    expect(soft?.getAttribute('variant')).toBe('agent-soft');
    expect(soft?.getAttribute('size')).toBe('sm');
    let clicks = 0;
    soft?.addEventListener('click', () => (clicks += 1), { signal: new AbortController().signal });
    press(soft as SfButtonElement, 'Enter');
    expect(clicks).toBe(1);
    expectNoA11yIssues(element);
  });

  it('takes its shape from radius.control and its edge from color.controlEdge', () => {
    const cssText = SfButtonElement.styles.map((s) => String(s)).join('\n');
    expect(cssText).toContain('border-radius: var(--sf-radius-control)');
    expect(cssText).toContain('border: 1px solid var(--sf-color-control-edge)');
    expect(cssText).toMatch(/variant='agent'\]\) \.control \{\s*background: var\(--sf-color-agent\)/);
    expect(cssText).toMatch(/variant='agent-soft'\]\) \.control \{\s*background: var\(--sf-color-agent-soft\)/);
    const iconCss = SfIconButtonElement.styles.map((s) => String(s)).join('\n');
    expect(iconCss).toContain('border-radius: var(--sf-radius-control)');
  });

  it('respects a roving parent that owns the tab stop', async () => {
    const { element } = await fixture<SfButtonElement>(html`<sf-button data-roving tabindex="-1">A</sf-button>`);
    element.variant = 'ghost';
    await element.updateComplete;
    expect(element.getAttribute('tabindex')).toBe('-1');
  });
});

describe('<sf-icon-button>', () => {
  it('names the host with its label and exposes the shortcut', async () => {
    const { element } = await fixture<SfIconButtonElement>(html`<sf-icon-button label="Undo" shortcut="Mod+Z"><svg></svg></sf-icon-button>`);
    expect(element.getAttribute('aria-label')).toBe('Undo');
    expect(element.getAttribute('aria-keyshortcuts')).toMatch(/^(Meta|Control)\+Z$/);
    const bubble = shadow(element, '.tooltip');
    expect(bubble.getAttribute('aria-hidden')).toBe('true');
    expect(bubble.textContent).toContain('Undo');
    expect(shadow(element, 'kbd').textContent).toMatch(/Z/);
    expect(auditA11y(element.parentElement as HTMLElement)).toEqual([]);
  });

  it('shows its tooltip on keyboard focus and hides it on Escape and blur', async () => {
    const { element } = await fixture<SfIconButtonElement>(html`<sf-icon-button label="Bold"></sf-icon-button>`);
    element.focus();
    await settle();
    const bubble = shadow(element, '.tooltip');
    expect(bubble.hasAttribute('data-open')).toBe(true);
    expect(bubble.style.top).not.toBe('');
    press(element, 'Escape');
    await settle();
    expect(bubble.hasAttribute('data-open')).toBe(false);
    element.dispatchEvent(new PointerEvent('pointerenter')); // the first tooltip waits 500 ms (OVERLAYS-FEEDBACK §4)
    await new Promise((r) => setTimeout(r, 550));
    await settle();
    expect(bubble.hasAttribute('data-open')).toBe(true);
    element.dispatchEvent(new PointerEvent('pointerleave'));
    await new Promise((r) => setTimeout(r, 120));
    expect(bubble.hasAttribute('data-open')).toBe(false);
  });

  it('closes other tooltips when one opens and can be turned off', async () => {
    const { element } = await fixture<HTMLDivElement>(html`<div><sf-icon-button label="A"></sf-icon-button><sf-icon-button label="B"></sf-icon-button><sf-icon-button label="C" .tooltip=${false}></sf-icon-button></div>`);
    const [a, b, c] = [...element.children] as SfIconButtonElement[];
    a?.focus();
    await settle();
    expect(shadow(a as Element, '.tooltip').hasAttribute('data-open')).toBe(true);
    (b as SfIconButtonElement).dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise((r) => setTimeout(r, 450));
    await settle();
    expect(shadow(a as Element, '.tooltip').hasAttribute('data-open')).toBe(false);
    expect(shadow(b as Element, '.tooltip').hasAttribute('data-open')).toBe(true);
    expect(c?.shadowRoot?.querySelector('.tooltip')).toBeNull();
  });
});

describe('shortcut labels', () => {
  it('formats per platform', () => {
    const apple = { defaultView: { navigator: { platform: 'MacIntel' } } } as unknown as Document;
    const other = { defaultView: { navigator: { platform: 'Win32' } } } as unknown as Document;
    expect(isApplePlatform(apple)).toBe(true);
    expect(isApplePlatform(other)).toBe(false);
    expect(shortcutLabel('Mod+Shift+K', apple)).toBe('⇧⌘K');
    expect(shortcutLabel('Mod+Shift+K', other)).toBe('Ctrl+Shift+K');
    expect(ariaKeyShortcuts('Mod+Shift+K', apple)).toBe('Meta+Shift+K');
    expect(ariaKeyShortcuts('Ctrl+Alt+K', other)).toBe('Control+Alt+K');
  });
});
