import { createInjector, createScope, defineError, err, type Registration, token, unit } from '@staticflux/core';
import { createSurfaceManager, defineSurfaceHost, memorySeenStoreUnit, SurfaceManagerToken } from '@staticflux/messaging';
import { allowAllDecideUnit, component, DecideToken, defineComponent, gateResource, SfElement, visibilityObserverUnit } from '@staticflux/ui';
import { mountTestRoot, type MountedRoot, settle } from '@staticflux/ui/testing';
import { html } from 'lit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandRegistryToken,
  compactPreset,
  createCommandRegistry,
  defineCommand,
  defineShell,
  defineWorkspace,
  openCommandPalette,
  type SfBoundaryElement,
  type SfShellElement,
  shellPresetUnit,
  shellUnits,
  slotContribution,
  ThemeControllerToken,
  WorkspaceManagerToken,
  workspaceContribution,
} from './index.js';

let root: MountedRoot | undefined;
afterEach(async () => {
  await root?.dispose();
  root = undefined;
  document.body.innerHTML = '';
});

const BrokenToken = token('test/broken').type<string>();
const brokenUnit = unit({
  id: 'test/broken-unit',
  provides: BrokenToken,
  scope: 'app',
  create: () => 'x',
  init: () => err(defineError('SF-TEST-SH-2', 'unavailable', 'broken', 'fix')()),
});
const brokenSpec = component({ tag: 'test-broken-panel', deps: { render: { value: BrokenToken } } });
class BrokenPanel extends SfElement<typeof brokenSpec> {
  static override readonly spec = brokenSpec;
  override render(): unknown {
    return html`${this.deps.value}`;
  }
}
defineComponent(BrokenPanel);

const expert = defineWorkspace({ id: 'studio/expert', add: ['studio/inspector'] });

function shellUnitsFor(extra: readonly Registration[] = []): Registration[] {
  return [
    allowAllDecideUnit,
    visibilityObserverUnit,
    ...shellUnits,
    workspaceContribution(expert),
    slotContribution({ id: 'app/header', slot: 'header', render: () => html`<h1>Studio</h1>` }),
    slotContribution({ id: 'studio/editor', slot: 'main', label: 'Editor', render: () => html`<p class="editor">editor</p>` }),
    slotContribution({ id: 'studio/inspector', slot: 'panel', byDefault: false, render: () => html`<p class="inspector">inspector</p>` }),
    slotContribution({ id: 'agent/chat', slot: 'panel', label: 'Chat', render: () => html`<test-broken-panel></test-broken-panel>` }),
    slotContribution({
      id: 'billing/premium-panel',
      slot: 'sidebar',
      gate: gateResource('slot', 'slot:billing/premium-panel'),
      render: () => html`<p class="premium">premium</p>`,
    }),
    brokenUnit,
    ...extra,
  ];
}

describe('<sf-shell>', () => {
  it('renders preset regions with workspace-arranged contributions and isolates failures per region', async () => {
    defineShell();
    root = mountTestRoot({ units: shellUnitsFor() });
    const shell = document.createElement('sf-shell') as SfShellElement;
    root.container.append(shell);
    await settle(6);
    const shadow = shell.shadowRoot as ShadowRoot;
    expect(shadow.querySelector('header h1')?.textContent).toBe('Studio');
    expect(shadow.querySelector('main .editor')?.textContent).toBe('editor');
    expect(shadow.querySelector('.inspector')).toBeNull();
    expect(shadow.querySelector('.premium')?.textContent).toBe('premium'); // allow-all gate
    const frame = shadow.querySelector('.frame') as HTMLElement;
    expect(frame.dataset['preset']).toBe('shell/expanded');
    // The broken chat panel is caught by its own boundary; the editor still renders.
    const chatBoundary = shadow.querySelector('sf-boundary[data-contribution="agent/chat"]') as SfBoundaryElement;
    expect(chatBoundary.failure?.code).toBe('SF-UI-003');
    expect(chatBoundary.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain('Chat failed to load.');
    // Workspace switch adds the inspector.
    const switched = await shell.switchWorkspace('studio/expert');
    expect(switched.ok).toBe(true);
    await settle(3);
    expect(shadow.querySelector('.inspector')?.textContent).toBe('inspector');
    expect(frame.dataset['workspace']).toBe('studio/expert');
    // Theme applied to the shell element.
    expect(shell.dataset['theme']).toMatch(/^shell\//);
  });

  it('boundary retry re-resolves the failing component', async () => {
    defineShell();
    root = mountTestRoot({ units: shellUnitsFor() });
    const shell = document.createElement('sf-shell') as SfShellElement;
    root.container.append(shell);
    await settle(6);
    const boundary = shell.shadowRoot?.querySelector('sf-boundary[data-contribution="agent/chat"]') as SfBoundaryElement;
    const button = boundary.shadowRoot?.querySelector('button') as HTMLButtonElement;
    button.click();
    await settle(4);
    // Still broken (init fails deterministically) → caught again.
    expect(boundary.failure?.code).toBe('SF-UI-003');
  });

  it('hides gated contributions when denied and uses the bound preset', async () => {
    defineShell();
    const denyAll = unit({ id: 'test/deny', provides: DecideToken, scope: 'app', create: () => ({ decide: () => ({ effect: 'deny' as const, reason: 'no' }) }) });
    const injector = createInjector({ units: [...shellUnitsFor(), denyAll, shellPresetUnit(compactPreset)].filter((u) => u !== allowAllDecideUnit) });
    root = mountTestRoot({ injector });
    const shell = document.createElement('sf-shell') as SfShellElement;
    root.container.append(shell);
    await settle(6);
    expect(shell.shadowRoot?.querySelector('.premium')).toBeNull();
    expect((shell.shadowRoot?.querySelector('.frame') as HTMLElement).dataset['preset']).toBe('shell/compact');
  });

  it('shell units resolve', async () => {
    const injector = createInjector({ units: shellUnitsFor([]) });
    expect((await injector.get(WorkspaceManagerToken)).ok).toBe(true);
    expect((await injector.get(CommandRegistryToken)).ok).toBe(true);
    expect((await injector.get(ThemeControllerToken)).ok).toBe(true);
    await injector.dispose();
  });
});

describe('command palette', () => {
  it('opens as a dialog surface, filters, navigates with arrows and runs on Enter', async () => {
    defineSurfaceHost();
    let ran = '';
    const created = createCommandRegistry({
      commands: [
        defineCommand({ id: 'studio/export-pdf', title: 'Export as PDF', run: () => void (ran = 'pdf') }),
        defineCommand({ id: 'studio/export-png', title: 'Export as PNG', run: () => void (ran = 'png') }),
      ],
    });
    if (!created.ok) throw created.error;
    const manager = createSurfaceManager();
    const managerUnit = unit({ id: 'test/manager', provides: SurfaceManagerToken, scope: 'app', create: () => manager });
    root = mountTestRoot({ units: [managerUnit, memorySeenStoreUnit] });
    const host = document.createElement('sf-surface-host');
    root.container.append(host);
    const handle = openCommandPalette({ manager, registry: created.value, owner: { scope: createScope('app') } });
    await settle(4);
    const palette = host.shadowRoot?.querySelector('sf-command-palette') as HTMLElement;
    expect(palette).not.toBeNull();
    const input = palette.shadowRoot?.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('role')).toBe('combobox');
    input.value = 'png';
    input.dispatchEvent(new Event('input'));
    await settle(2);
    expect(palette.shadowRoot?.querySelectorAll('[role="option"]')).toHaveLength(1);
    input.value = 'export';
    input.dispatchEvent(new Event('input'));
    await settle(2);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await settle(2);
    const selected = palette.shadowRoot?.querySelector('[aria-selected="true"]') as HTMLElement;
    expect(input.getAttribute('aria-activedescendant')).toBe(selected.id);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    const outcome = await handle.closed;
    expect(outcome.reason).toBe('action');
    expect(ran).toBe(selected.dataset['command'] === 'studio/export-png' ? 'png' : 'pdf');
  });
});
