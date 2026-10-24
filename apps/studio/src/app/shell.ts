/**
 * The app frame (R13.1–R13.3): slot contributions (header, main, panel, sidebar),
 * workspaces (`default`, `expert` adds the inspector), the outlets features mount
 * into, the assistant panel controller, and the UI root.
 */
import { box, contribution, ok, type Result, unit, watch } from '@staticflux/core';
import { RouterToken } from '@staticflux/router';
import { FeatureHostToken, defineSubsystem, SubsystemsToken } from '@staticflux/runtime';
import { defaultWorkspace, defineShell, defineWorkspace, slotContribution, workspaceContribution, WorkspaceManagerToken } from '@staticflux/shell';
import { gateResource, UiEnvironmentToken } from '@staticflux/ui';
import type { Injector } from '@staticflux/core';
import { html, render } from 'lit';
import { defineAppViews } from '../ui/app-views.js';
import { Features, type PanelController, PanelControllerToken, type StudioOutlets, OutletsToken } from './contracts.js';
import { GateIds } from './policies.js';

export const ExpertWorkspace = defineWorkspace({
  id: 'studio/expert',
  label: 'Expert',
  gate: gateResource('workspace', GateIds.expertWorkspace),
  add: ['studio/inspector'],
});

export const shellContributionUnits = [
  slotContribution({ id: 'studio/header', slot: 'header', label: 'Studio', render: () => html`<studio-header></studio-header>` }),
  slotContribution({ id: 'studio/main', slot: 'main', label: 'Main', render: () => html`<studio-main></studio-main>` }),
  slotContribution({ id: 'studio/assistant-panel', slot: 'panel', label: 'Assistant', render: () => html`<studio-panel></studio-panel>` }),
  slotContribution({
    id: 'studio/ai-suggestions',
    slot: 'sidebar',
    label: 'AI suggestions',
    gate: gateResource('ui-slot', GateIds.aiPanelSlot),
    render: () => html`<aside><h2>AI suggestions</h2><p>Ask the assistant to draft a paragraph or an illustration.</p></aside>`,
  }),
  slotContribution({ id: 'studio/inspector', slot: 'sidebar', label: 'Inspector', byDefault: false, render: () => html`<studio-inspector></studio-inspector>` }),
  workspaceContribution(defaultWorkspace),
  workspaceContribution(ExpertWorkspace),
] as const;

export function outletsUnit(doc: Document | undefined) {
  return unit({
    id: 'studio/outlets-unit',
    provides: OutletsToken,
    scope: 'app',
    create: (): StudioOutlets => {
      const make = (name: string): HTMLElement => {
        const element = (doc ?? document).createElement('div');
        element.className = `outlet outlet-${name}`;
        element.dataset['outlet'] = name;
        return element;
      };
      return { main: make('main'), panel: make('panel'), inspector: make('inspector') };
    },
  });
}

export const panelControllerUnit = unit({
  id: 'studio/panel-controller-unit',
  provides: PanelControllerToken,
  scope: 'app',
  deps: { required: { host: FeatureHostToken, outlets: OutletsToken } },
  create: ({ host, outlets }): PanelController => {
    const open = box<string | undefined>(undefined);
    return {
      get open() {
        return open.get();
      },
      async show(feature): Promise<Result<void>> {
        const mounted = await host.mount(feature, { target: outlets.panel });
        if (mounted.ok) open.set(feature);
        return mounted;
      },
      async hide(): Promise<Result<void>> {
        const current = open.get();
        open.set(undefined);
        if (current === undefined) return ok();
        return host.unmount(Features.agentChat.id);
      },
    };
  },
  description: 'Mounts the assistant (agent-chat) into the panel outlet.',
});

/** Workspace switches swap feature UIs declared as data (R13.2): expert mounts the inspector content. */
export const workspaceSwitchSubsystemUnit = contribution({
  id: 'studio/workspace-switch-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { workspaces: WorkspaceManagerToken } },
  create: ({ workspaces }) =>
    defineSubsystem({
      id: 'shell/workspaces',
      start: async (ctx) => {
        await workspaces.restore(ctx.signal);
        watch(
          () => workspaces.current.id,
          (id) => ctx.telemetry.event('shell.workspace', { subsystem: 'shell/layout', attrs: { workspace: id } }),
          { scope: ctx.scope },
        );
      },
      description: 'Restores the workspace preference.',
    }),
});

/** Render the UI root into `container` (browser entry and DOM tests). */
export async function mountStudioUi(container: HTMLElement, injector: Injector): Promise<Result<() => void>> {
  defineShell();
  defineAppViews(); // <sf-surface-host> is defined by the deferred surfaces chunk
  const environment = await injector.get(UiEnvironmentToken);
  if (!environment.ok) return environment;
  const router = await injector.get(RouterToken);
  if (!router.ok) return router;
  const onNavigate = (event: Event): void => {
    const href = (event as CustomEvent<string>).detail;
    void router.value.navigate({ href });
  };
  container.addEventListener('studio-navigate', onNavigate);
  render(html`<sf-scope name="studio" .injector=${injector} .environment=${environment.value}><sf-shell></sf-shell><sf-surface-host></sf-surface-host></sf-scope>`, container);
  return ok(() => {
    container.removeEventListener('studio-navigate', onNavigate);
    render(html``, container);
  });
}
