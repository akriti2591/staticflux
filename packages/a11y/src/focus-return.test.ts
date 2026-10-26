/** Focus return when an overlay's trigger is gone (OVERLAYS-FEEDBACK §1.3). */
import { afterEach, describe, expect, it } from 'vitest';
import { FOCUS_FALLBACK_SELECTOR, rememberFocusReturn } from './focus.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function deepActive(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement;
  return active;
}

describe('rememberFocusReturn', () => {
  it('returns focus to the trigger while it exists', () => {
    document.body.innerHTML = '<section aria-label="Layers"><button id="row">Row menu</button></section>';
    const trigger = document.getElementById('row') as HTMLButtonElement;
    const ret = rememberFocusReturn(trigger);
    expect(ret.restore()).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it('falls back to the nearest surviving landmark recorded at open time when the trigger is removed', () => {
    document.body.innerHTML = '<div data-sf-focus-fallback id="canvas"><section aria-label="Layers" id="panel"><ul><li><button id="row">Row menu</button></li></ul></section></div>';
    const trigger = document.getElementById('row') as HTMLButtonElement;
    const ret = rememberFocusReturn(trigger);
    trigger.closest('li')?.remove();
    const panel = document.getElementById('panel') as HTMLElement;
    expect(ret.restore()).toBe(panel);
    expect(panel.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel);
    panel.remove();
    expect(rememberFocusReturn(null).restore()).toBeUndefined();
    expect(ret.restore()?.id).toBe('canvas');
  });

  it('prefers an explicit fallback (the canvas for the HUD) and skips inert or hidden ones', () => {
    document.body.innerHTML = '<main id="main"><div id="canvas" tabindex="0"></div><div inert><button id="inert">x</button></div><button id="hud">Fill</button></main>';
    const trigger = document.getElementById('hud') as HTMLButtonElement;
    const ret = rememberFocusReturn(trigger, { fallback: () => document.getElementById('canvas') });
    trigger.remove();
    expect(ret.restore()?.id).toBe('canvas');
    const inert = rememberFocusReturn(document.getElementById('inert'), { fallback: document.getElementById('main') as HTMLElement });
    expect(inert.restore()?.id).toBe('main');
  });

  it('walks out of shadow roots and never lands on body', () => {
    const host = document.createElement('div');
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Inspector');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    root.append(button);
    const ret = rememberFocusReturn(button);
    button.remove();
    expect(ret.restore()).toBe(host);
    expect(deepActive()).toBe(host);
    host.remove();
    expect(ret.restore()).toBeUndefined();
    expect(FOCUS_FALLBACK_SELECTOR).toContain('data-sf-focus-fallback');
  });
});
