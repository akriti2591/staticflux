import { createScope, unit } from '@staticflux/core';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { mountTestRoot, type MountedRoot, settle } from '@staticflux/ui/testing';
import { html } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  coachTarget,
  createSurfaceManager,
  defineCoachTarget,
  defineSurface,
  defineSurfaceHost,
  defineSurfaceOutlet,
  type SurfaceManager,
  SurfaceManagerToken,
} from './index.js';

let root: MountedRoot | undefined;
afterEach(async () => {
  await root?.dispose();
  root = undefined;
  document.body.innerHTML = '';
});

function mount(): { manager: SurfaceManager; root: MountedRoot; host: HTMLElement; owner: { scope: ReturnType<typeof createScope> } } {
  defineSurfaceHost();
  defineSurfaceOutlet();
  const manager = createSurfaceManager();
  const managerUnit = unit({ id: 'test/manager', provides: SurfaceManagerToken, scope: 'app', create: () => manager });
  root = mountTestRoot({ units: [managerUnit] });
  const host = document.createElement('sf-surface-host');
  root.container.append(host);
  return { manager, root, host, owner: { scope: createScope('feature') } };
}

const shareDialog = defineSurface({
  id: 'studio/share',
  kind: 'dialog',
  scope: 'feature',
  render: ({ titleId, dismiss }) =>
    html`<h2 id=${titleId}>Share</h2>
      <input class="email" />
      <button class="ok" @click=${() => dismiss('action')}>OK</button>`,
});

describe('<sf-surface-host>', () => {
  it('renders a modal with dialog semantics, moves focus in, inerts the background, restores on Escape', async () => {
    const { manager, root, host, owner } = mount();
    const trigger = document.createElement('button');
    trigger.textContent = 'open';
    root.container.append(trigger);
    trigger.focus();
    await settle();
    const handle = manager.request(shareDialog, { owner });
    await settle();
    const modal = host.shadowRoot?.querySelector('[role="dialog"]') as HTMLElement;
    expect(modal).not.toBeNull();
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('aria-labelledby')).toBe(handle.titleId);
    expect(host.shadowRoot?.activeElement?.className).toBe('email');
    expect(trigger.hasAttribute('inert')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect((await handle.closed).reason).toBe('escape');
    await settle();
    expect(host.shadowRoot?.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab inside the top modal', async () => {
    const { manager, host, owner } = mount();
    manager.request(shareDialog, { owner });
    await settle();
    const ok = host.shadowRoot?.querySelector('.ok') as HTMLButtonElement;
    ok.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(host.shadowRoot?.activeElement?.className).toBe('email');
  });

  it('renders toasts in a live region (urgent → role=alert) and banners', async () => {
    const { manager, host } = mount();
    const owner = { scope: createScope('app') };
    manager.request(defineSurface({ id: 'billing/credits', kind: 'toast', scope: 'app', render: () => 'credits used' }), { owner });
    manager.request(defineSurface({ id: 'app/error', kind: 'toast', scope: 'app', priority: 'urgent', render: () => 'failed' }), { owner });
    manager.request(defineSurface({ id: 'billing/low', kind: 'banner', scope: 'app', render: () => 'low balance' }), { owner });
    await settle();
    const toasts = host.shadowRoot?.querySelector('.toasts') as HTMLElement;
    expect(toasts.getAttribute('aria-live')).toBe('polite');
    expect(toasts.textContent).toContain('credits used');
    expect(toasts.querySelector('[role="alert"]')?.textContent).toContain('failed');
    expect(host.shadowRoot?.querySelector('.banners')?.textContent).toContain('low balance');
  });

  it('coachTarget() registers targets with the manager; coach marks render anchored', async () => {
    const { manager, root, host, owner } = mount();
    const AiButton = defineCoachTarget('studio/ai-button');
    const spec = component({ tag: 'test-ai-toolbar' });
    class AiToolbar extends SfElement<typeof spec> {
      static override readonly spec = spec;
      override render(): unknown {
        return html`<button ${coachTarget(AiButton)}>AI</button>`;
      }
    }
    defineComponent(AiToolbar);
    const toolbar = document.createElement('test-ai-toolbar');
    root.container.append(toolbar);
    await settle(5);
    expect(manager.targets.element(AiButton)?.textContent).toBe('AI');
    const coach = manager.request(
      defineSurface({ id: 'studio/ai-coach', kind: 'coach-mark', scope: 'feature', target: AiButton, render: () => 'Try the AI' }),
      { owner },
    );
    await settle(5);
    expect(coach.state).toBe('showing');
    expect(host.shadowRoot?.querySelector('.anchored.coach-mark')?.textContent).toContain('Try the AI');
    toolbar.remove();
    await settle();
    expect(manager.targets.element(AiButton)).toBeUndefined();
    expect(coach.state).toBe('suspended');
  });

  it('<sf-surface-outlet> renders inline alerts for its outlet', async () => {
    const { manager, root, owner } = mount();
    const outlet = document.createElement('sf-surface-outlet') as HTMLElement & { outlet: string };
    outlet.outlet = 'studio/editor-alerts';
    root.container.append(outlet);
    manager.request(
      defineSurface({ id: 'studio/save-failed', kind: 'inline-alert', scope: 'feature', priority: 'high', outlet: 'studio/editor-alerts', render: () => 'Save failed' }),
      { owner },
    );
    await settle();
    expect(outlet.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain('Save failed');
  });
});
