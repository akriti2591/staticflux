import { press } from '@staticflux/testkit/a11y';
import { html, LitElement, type TemplateResult } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import { isRovingDisabled, isTextEditing, RovingFocusController, rovingNextIndex } from './roving.js';

describe('rovingNextIndex', () => {
  const h = { orientation: 'horizontal' } as const;
  it('moves with arrows, wraps, and jumps with Home/End', () => {
    expect(rovingNextIndex(0, 3, 'ArrowRight', h)).toBe(1);
    expect(rovingNextIndex(2, 3, 'ArrowRight', h)).toBe(0);
    expect(rovingNextIndex(0, 3, 'ArrowLeft', h)).toBe(2);
    expect(rovingNextIndex(1, 3, 'Home', h)).toBe(0);
    expect(rovingNextIndex(1, 3, 'End', h)).toBe(2);
    expect(rovingNextIndex(1, 3, 'ArrowDown', h)).toBeUndefined();
    expect(rovingNextIndex(1, 3, 'a', h)).toBeUndefined();
    expect(rovingNextIndex(0, 0, 'ArrowRight', h)).toBeUndefined();
  });

  it('respects orientation, RTL, wrap=false and disabled items', () => {
    expect(rovingNextIndex(0, 3, 'ArrowDown', { orientation: 'vertical' })).toBe(1);
    expect(rovingNextIndex(0, 3, 'ArrowRight', { orientation: 'vertical' })).toBeUndefined();
    expect(rovingNextIndex(0, 3, 'ArrowDown', { orientation: 'both' })).toBe(1);
    expect(rovingNextIndex(0, 3, 'ArrowRight', { orientation: 'horizontal', dir: 'rtl' })).toBe(2);
    expect(rovingNextIndex(0, 3, 'ArrowLeft', { orientation: 'horizontal', dir: 'rtl' })).toBe(1);
    expect(rovingNextIndex(2, 3, 'ArrowRight', { orientation: 'horizontal', wrap: false })).toBe(2);
    const disabled = (i: number): boolean => i === 1;
    expect(rovingNextIndex(0, 3, 'ArrowRight', { orientation: 'horizontal', isDisabled: disabled })).toBe(2);
    expect(rovingNextIndex(1, 3, 'Home', { orientation: 'horizontal', isDisabled: (i) => i === 0 })).toBe(1);
    expect(rovingNextIndex(1, 3, 'End', { orientation: 'horizontal', isDisabled: () => true })).toBeUndefined();
    expect(rovingNextIndex(0, 2, 'ArrowRight', { orientation: 'horizontal', isDisabled: (i) => i === 1 })).toBe(0);
  });

  it('knows disabled items and text-editing targets', () => {
    const a = document.createElement('button');
    expect(isRovingDisabled(a)).toBe(false);
    a.setAttribute('aria-disabled', 'true');
    expect(isRovingDisabled(a)).toBe(true);
    const text = document.createElement('input');
    const range = document.createElement('input');
    range.type = 'range';
    expect(isTextEditing(text)).toBe(true);
    expect(isTextEditing(range)).toBe(false);
    expect(isTextEditing(document.createElement('textarea'))).toBe(true);
    expect(isTextEditing(a)).toBe(false);
    expect(isTextEditing(undefined)).toBe(false);
  });
});

class RovingHost extends LitElement {
  readonly roving = new RovingFocusController(this, {
    items: () => [...this.querySelectorAll<HTMLElement>('button')],
    orientation: 'horizontal',
    initial: () => 1,
    onMove: (_item, index) => this.moves.push(index),
  });
  readonly moves: number[] = [];
  protected override createRenderRoot(): HTMLElement {
    return this;
  }
  protected override render(): TemplateResult {
    return html``;
  }
}
customElements.define('x-roving-host', RovingHost);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('RovingFocusController', () => {
  it('keeps one tab stop and moves focus with arrows', async () => {
    const host = document.createElement('x-roving-host') as RovingHost;
    host.innerHTML = '<button>a</button><button disabled>b</button><button>c</button><input>';
    document.body.append(host);
    await host.updateComplete;
    const [a, b, c] = [...host.querySelectorAll('button')];
    // initial() = 1 is disabled → first enabled
    expect([a, b, c].map((x) => x?.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(a?.hasAttribute('data-roving')).toBe(true);
    a?.focus();
    const event = press(a as HTMLElement, 'ArrowRight');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(c);
    expect(host.roving.activeIndex).toBe(2);
    expect(host.moves).toEqual([2]);
    expect(c?.getAttribute('tabindex')).toBe('0');
    // focus moved by pointer updates the stop
    a?.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    expect(a?.getAttribute('tabindex')).toBe('0');
    // modifiers and text fields are left alone
    expect(press(a as HTMLElement, 'ArrowRight', { ctrl: true }).defaultPrevented).toBe(false);
    const input = host.querySelector('input') as HTMLInputElement;
    expect(press(input, 'ArrowRight').defaultPrevented).toBe(false);
    host.roving.reset();
    host.roving.sync();
    expect(a?.getAttribute('tabindex')).toBe('0');
  });
});
