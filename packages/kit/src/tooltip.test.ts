/** Tooltips (OVERLAYS-FEEDBACK §4): 500 ms then a 300 ms warm period, hide on press / key / scroll, long-press, reason. */
import { expectNoA11yIssues, press } from '@staticflux/testkit/a11y';
import { html, render } from 'lit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineButton } from './button.js';
import { defineIconButton, type SfIconButtonElement } from './icon-button.js';
import { composeTooltip, defineTooltip, type SfTooltipElement, TOOLTIP_TIMING } from './tooltip.js';
import { cleanup, fixture, shadow } from './test-helpers.js';

beforeAll(() => {
  defineButton();
  defineTooltip();
  defineIconButton();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function mount(): Promise<{ a: SfTooltipElement; b: SfTooltipElement; c: SfIconButtonElement }> {
  const host = document.createElement('div');
  document.body.append(host);
  render(
    html`<sf-tooltip text="Align left" shortcut="Mod+Shift+L"><sf-button>L</sf-button></sf-tooltip>
      <sf-tooltip text="Export" reason="Choose at least one page" description="Save the pages as files"><sf-button aria-disabled="true">Export</sf-button></sf-tooltip>
      <sf-icon-button label="Lock" shortcut="Mod+Shift+L" reason="Nothing selected"><span aria-hidden="true">L</span></sf-icon-button>`,
    host,
  );
  await vi.advanceTimersByTimeAsync(0);
  const [a, b] = [...host.querySelectorAll('sf-tooltip')] as SfTooltipElement[];
  await a?.updateComplete;
  await b?.updateComplete;
  return { a: a as SfTooltipElement, b: b as SfTooltipElement, c: host.querySelector('sf-icon-button') as SfIconButtonElement };
}

const enter = (el: Element): boolean => el.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
const leave = (el: Element): boolean => el.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));

describe('tooltips', () => {
  it('compose the name, the disabled reason and the second line', async () => {
    expect(composeTooltip('Export', 'Choose at least one page')).toBe('Export · Choose at least one page');
    expect(composeTooltip('Lock')).toBe('Lock');
    vi.useRealTimers();
    const { element } = await fixture<HTMLDivElement>(
      html`<div>
        <sf-tooltip text="Export" reason="Choose at least one page" description="Save the pages as files"><sf-button aria-disabled="true">Export</sf-button></sf-tooltip>
        <sf-icon-button label="Lock" shortcut="Mod+Shift+L" reason="Nothing selected" description="Stops edits"><span aria-hidden="true">L</span></sf-icon-button>
      </div>`,
    );
    const b = element.querySelector('sf-tooltip') as SfTooltipElement;
    const c = element.querySelector('sf-icon-button') as SfIconButtonElement;
    expect(b.tipElement.textContent).toContain('Export · Choose at least one page');
    expect(b.tipElement.querySelector('.description')?.textContent).toBe('Save the pages as files');
    expect(shadow(c, '.tooltip').textContent).toContain('Lock · Nothing selected');
    expect(shadow(c, '.description').textContent).toBe('Stops edits');
    expect(c.tooltipSide).toBe('block-end');
    await cleanup();
    expect(TOOLTIP_TIMING).toMatchObject({ showDelay: 500, warmMs: 300, longPressMs: 500 });
    expectNoA11yIssues(document.body);
  });

  it('wait 500 ms for the first one, then show neighbours at once during the warm period', async () => {
    const { a, b } = await mount();
    enter(a);
    await vi.advanceTimersByTimeAsync(450);
    expect(a.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(a.isOpen).toBe(true);
    leave(a);
    enter(b);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.isOpen).toBe(true);
    expect(a.isOpen).toBe(false); // one at a time
    leave(b);
    await vi.advanceTimersByTimeAsync(TOOLTIP_TIMING.hideDelay + 200); // hidden 200 ms ago: still warm
    enter(a);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.isOpen).toBe(true);
    leave(a);
    await vi.advanceTimersByTimeAsync(TOOLTIP_TIMING.hideDelay + 400); // cold again
    enter(b);
    await vi.advanceTimersByTimeAsync(100);
    expect(b.isOpen).toBe(false);
  });

  it('hide on a press, on any key without consuming it, and on scroll', async () => {
    const { a } = await mount();
    a.show();
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    expect(a.isOpen).toBe(false);
    a.show();
    const escape = press(document.body, 'Escape');
    expect(a.isOpen).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
    a.show();
    document.dispatchEvent(new Event('scroll'));
    expect(a.isOpen).toBe(false);
  });

  it('show on a 500 ms long-press without activating the control', async () => {
    const { a } = await mount();
    const button = a.querySelector('sf-button') as HTMLElement;
    const clicks: Event[] = [];
    button.addEventListener('click', (event) => clicks.push(event));
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 5, clientY: 5 }));
    await vi.advanceTimersByTimeAsync(TOOLTIP_TIMING.longPressMs);
    expect(a.isOpen).toBe(true);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    expect(a.isOpen).toBe(false);
    button.click();
    expect(clicks).toHaveLength(0);
    button.click();
    expect(clicks).toHaveLength(1);
    // A short tap is a tap: no tooltip.
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 5, clientY: 5 }));
    await vi.advanceTimersByTimeAsync(100);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }));
    await vi.advanceTimersByTimeAsync(600);
    expect(a.isOpen).toBe(false);
  });
});
