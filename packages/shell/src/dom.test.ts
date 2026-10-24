import {
  a11yEnvironmentUnit,
  createFocusManager,
  defaultTimers,
  focusManagerUnit,
  shortcutRegistryUnit,
  ShortcutRegistryToken,
} from '@staticflux/a11y';
import { createInjector, createScope, defineError, err, type Registration, token, unit } from '@staticflux/core';
import { createSurfaceManager, defineSurfaceHost, memorySeenStoreUnit, SurfaceManagerToken } from '@staticflux/messaging';
import { allowAllDecideUnit, component, DecideToken, defineComponent, gateResource, SfElement, visibilityObserverUnit } from '@staticflux/ui';
import { mountTestRoot, type MountedRoot, settle } from '@staticflux/ui/testing';
import { html } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandRegistryToken,
  CommandShortcutBindingsToken,
  commandContribution,
  commandPaletteSurface,
  compactPreset,
  defaultShellMessages,
  defineSkipLinks,
  embeddedPreset,
  ShellMessagesToken,
  shellKeyboardUnits,
  type SfSkipLinksElement,
  SkipLinkEvent,
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

const a11yUnits = (): Registration[] => [
  a11yEnvironmentUnit({ document, matchMedia: undefined, timers: defaultTimers, isMac: false }),
  focusManagerUnit,
  shortcutRegistryUnit,
];

async function mountShell(extra: readonly Registration[] = []): Promise<SfShellElement> {
  defineShell();
  root = mountTestRoot({ units: shellUnitsFor(extra) });
  const shell = document.createElement('sf-shell') as SfShellElement;
  root.container.append(shell);
  await settle(6);
  return shell;
}

describe('<sf-shell> accessibility (R15.2)', () => {
  it('renders skip links first and correct landmark roles', async () => {
    const shell = await mountShell();
    const shadow = shell.shadowRoot as ShadowRoot;
    expect(shadow.firstElementChild?.localName).toBe('sf-skip-links');
    expect(shadow.querySelector('[data-slot="header"]')?.getAttribute('role')).toBe('banner');
    expect(shadow.querySelector('[data-slot="main"]')?.localName).toBe('main');
    const nav = shadow.querySelector('[data-slot="sidebar"]') as HTMLElement;
    expect(nav.localName).toBe('nav');
    expect(nav.getAttribute('aria-label')).toBe('Navigation');
    const panel = shadow.querySelector('[data-slot="panel"]') as HTMLElement;
    expect(panel.localName).toBe('aside');
    expect(panel.getAttribute('role')).toBe('complementary');
    expect(panel.getAttribute('aria-label')).toBe('Side panel');
    const skip = shadow.querySelector('sf-skip-links') as SfSkipLinksElement;
    await skip.updateComplete;
    const links = [...(skip.shadowRoot?.querySelectorAll('a') ?? [])];
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Skip to main content', 'Skip to navigation', 'Skip to side panel']);
    expect(skip.shadowRoot?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Skip links');
  });

  it('a skip link moves focus to its target region (via the a11y focus manager when bound)', async () => {
    const shell = await mountShell(a11yUnits());
    const shadow = shell.shadowRoot as ShadowRoot;
    const skip = shadow.querySelector('sf-skip-links') as SfSkipLinksElement;
    await settle(3);
    expect(skip.focusManager).toBeDefined();
    const events: SkipLinkEvent[] = [];
    shell.addEventListener(SkipLinkEvent.type, (e) => events.push(e as SkipLinkEvent));
    (skip.shadowRoot?.querySelector('a[data-skip="main"]') as HTMLAnchorElement).click();
    const main = shadow.querySelector('main') as HTMLElement;
    expect(shadow.activeElement).toBe(main);
    expect(events[0]?.slot).toBe('main');
    expect(events[0]?.result.ok).toBe(true);
    (skip.shadowRoot?.querySelector('a[data-skip="sidebar"]') as HTMLAnchorElement).click();
    expect(shadow.activeElement).toBe(shadow.querySelector('nav'));
  });

  it('uses localized messages from ShellMessagesToken and the preset skip targets', async () => {
    const messages = unit({
      id: 'test/messages',
      provides: ShellMessagesToken,
      scope: 'app',
      create: () => ({ skipLinksLabel: 'Sprunglinks', skipTo: { main: 'Zum Hauptinhalt' }, regions: { sidebar: 'Navigation (de)', panel: 'Seitenleiste' } }),
    });
    const shell = await mountShell([messages]);
    await settle(3);
    const shadow = shell.shadowRoot as ShadowRoot;
    const skip = shadow.querySelector('sf-skip-links') as SfSkipLinksElement;
    await skip.updateComplete;
    expect([...(skip.shadowRoot?.querySelectorAll('a') ?? [])].map((a) => a.textContent?.trim())).toEqual(['Zum Hauptinhalt']);
    expect(skip.label).toBe('Sprunglinks');
    expect(shadow.querySelector('aside')?.getAttribute('aria-label')).toBe('Seitenleiste');
  });

  it('embedded preset offers only the main skip link', async () => {
    const shell = await mountShell([shellPresetUnit(embeddedPreset)]);
    const skip = shell.shadowRoot?.querySelector('sf-skip-links') as SfSkipLinksElement;
    expect(skip.links.map((l) => l.slot)).toEqual(['main']);
  });
});

describe('<sf-skip-links> standalone', () => {
  it('focuses document targets through the focus manager and is visually hidden until focused', async () => {
    defineSkipLinks();
    const target = document.createElement('div');
    target.setAttribute('data-slot', 'main');
    const skip = document.createElement('sf-skip-links') as SfSkipLinksElement;
    const focusManager = createFocusManager({ document });
    const spy = vi.spyOn(focusManager, 'focusRouteTarget');
    skip.focusManager = focusManager;
    document.body.append(skip, target);
    await skip.updateComplete;
    (skip.shadowRoot?.querySelector('a') as HTMLAnchorElement).click();
    expect(spy).toHaveBeenCalledWith({ target, preventScroll: false });
    expect(document.activeElement).toBe(target);
    expect(target.getAttribute('tabindex')).toBe('-1');
    const css = (skip.constructor as typeof SfSkipLinksElement).styles;
    expect(String(css)).toContain('a:not(:focus)');
    // Missing target → SF-A11Y-001, no focus move.
    target.remove();
    const missing = skip.skipTo('main');
    expect(!missing.ok && missing.error.code).toBe('SF-A11Y-001');
    await focusManager.dispose();
  });

  it('defaults to the main link with an English label', async () => {
    defineSkipLinks();
    const skip = document.createElement('sf-skip-links') as SfSkipLinksElement;
    document.body.append(skip);
    await skip.updateComplete;
    expect(skip.shadowRoot?.querySelector('a')?.textContent?.trim()).toBe(defaultShellMessages.skipTo.main);
  });
});

describe('keyboard glue (a11y shortcut registry)', () => {
  it('binds Mod+K to the palette and command shortcuts; palette shows shortcut labels; conflicts are reported', async () => {
    defineSurfaceHost();
    const manager = createSurfaceManager();
    const managerUnit = unit({ id: 'test/manager', provides: SurfaceManagerToken, scope: 'app', create: () => manager });
    let exported = 0;
    const units: Registration[] = [
      allowAllDecideUnit,
      ...shellUnits,
      ...a11yUnits(),
      ...shellKeyboardUnits,
      managerUnit,
      memorySeenStoreUnit,
      commandContribution(defineCommand({ id: 'studio/export-pdf', title: 'Export as PDF', shortcut: 'Mod+Shift+E', run: () => void (exported += 1) })),
      commandContribution(defineCommand({ id: 'studio/link', title: 'Insert link', shortcut: 'Mod+K', run: () => undefined })),
    ];
    root = mountTestRoot({ units });
    const host = document.createElement('sf-surface-host');
    root.container.append(host);
    const bindings = await root.injector.get(CommandShortcutBindingsToken);
    if (!bindings.ok) throw bindings.error;
    expect(bindings.value.bound).toEqual(['shell/command-palette', 'studio/export-pdf']);
    expect(bindings.value.errors.map((e) => e.code)).toEqual(['SF-A11Y-002']);
    const registry = await root.injector.get(ShortcutRegistryToken);
    expect(registry.ok && registry.value.list().map((s) => s.id)).toEqual(['shell/command-palette', 'studio/export-pdf']);

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await settle(2);
    expect(exported).toBe(1);

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle(4);
    expect(manager.showing('dialog').map((h) => h.def.id)).toEqual([commandPaletteSurface.id]);
    // A second Mod+K while open does not stack another palette.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle(2);
    expect(manager.showing('dialog')).toHaveLength(1);
    const palette = host.shadowRoot?.querySelector('sf-command-palette') as HTMLElement;
    const option = palette.shadowRoot?.querySelector('[data-command="studio/export-pdf"]') as HTMLElement;
    expect(option.querySelector('kbd')?.textContent).toBe('Ctrl+Shift+E');
  });
});
