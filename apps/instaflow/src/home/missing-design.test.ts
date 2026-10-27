/** B11c: the page a Studio link shows when its design is not on this device or is in the trash (NAVIGATION §4). */
import { auditA11y } from '@staticflux/testkit/a11y';
import { compileTheme } from '@staticflux/ui/theme';
import { mountTestRoot, settle } from '@staticflux/ui/testing';
import { html, render } from 'lit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPopTheme } from '../theme/clean-pop.js';
import { defineMissingDesign, type IfMissingDesignElement } from './missing-design.js';

describe('<if-missing-design>', () => {
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(() => defineMissingDesign());
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    document.head.innerHTML = '';
  });

  async function mount(trashed: boolean) {
    const style = document.createElement('style');
    style.textContent = compileTheme(cleanPopTheme);
    document.head.append(style);
    const root = mountTestRoot({ units: [] });
    dispose = () => root.dispose();
    const events: string[] = [];
    render(
      html`<if-missing-design
        asset="as_gone"
        ?trashed=${trashed}
        design-title="Night Market"
        home-href="/"
        @if-restore=${(e: CustomEvent<{ asset: string }>) => events.push(`restore ${e.detail.asset}`)}
        @if-navigate=${(e: CustomEvent<{ href: string }>) => {
          e.preventDefault();
          events.push(`navigate ${e.detail.href}`);
        }}
      ></if-missing-design>`,
      root.container,
    );
    await settle(4);
    const el = root.container.querySelector('if-missing-design') as IfMissingDesignElement;
    await el.updateComplete;
    return { el, shadow: el.shadowRoot as ShadowRoot, events, root };
  }

  it('not on this device: says so with the sentence, Go to Home is the primary action', async () => {
    const { shadow, events, root, el } = await mount(false);
    expect(shadow.querySelector('h1')?.textContent).toBe('This design isn’t on this device');
    expect(shadow.querySelector('p')?.textContent).toBe('Designs live in this browser profile or in the folder you chose.');
    expect(shadow.querySelector('sf-button.restore')).toBeNull();
    expect(shadow.querySelector('sf-button.go-home')?.getAttribute('variant')).toBe('primary');
    expect(auditA11y(root.container)).toEqual([]);
    await el.focusPrimary();
    (shadow.querySelector('sf-button.go-home') as HTMLElement).click();
    expect(events).toEqual(['navigate /']);
  });

  it('in the trash: Restore (once, busy until the host is done) and Go to Home', async () => {
    const { shadow, events, root, el } = await mount(true);
    expect(shadow.querySelector('h1')?.textContent).toBe('This design is in the trash');
    expect(shadow.querySelector('p')?.textContent).toBe('Restore “Night Market” to keep working on it.');
    expect(auditA11y(root.container)).toEqual([]);
    const restore = shadow.querySelector('sf-button.restore') as HTMLElement;
    restore.click();
    restore.click();
    await el.updateComplete;
    expect(events).toEqual(['restore as_gone']);
    expect(shadow.querySelector('sf-button.restore')?.textContent?.trim()).toBe('Restoring…');
    el.restoreFailed();
    await el.updateComplete;
    expect(shadow.querySelector('sf-button.restore')?.textContent?.trim()).toBe('Restore');
  });
});
