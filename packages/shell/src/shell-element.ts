/**
 * `<sf-shell>` — the app frame (R13.1–R13.3): regions laid out by the injected
 * `ShellPreset`, each filled with the slot contributions arranged by the active
 * workspace, each contribution wrapped in its own error boundary. Gated contributions
 * stay hidden until the gate allows them. The theme controller (if bound) is applied
 * to the shell element. Workspace switches run inside a View Transition.
 *
 * Accessibility (R15.2): `<sf-skip-links>` is rendered first; regions are landmarks
 * (`header` → banner, `sidebar` → navigation, `main`, `panel` → complementary, other
 * slots → named regions) named from `ShellMessages`. Skip links focus through the a11y
 * focus manager when bound. The shell also resolves the keyboard glue
 * (`CommandShortcutBindingsToken`) when idle, if the app registered it.
 */
import { FocusManagerToken, type FocusManager } from '@staticflux/a11y';
import { box, type Result, type Scope } from '@staticflux/core';
import { component, type ComponentHooksOf, DecideToken, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { defineBoundary } from './boundary.js';
import { ShellPresetToken } from './presets.js';
import {
  DEFAULT_SKIP_TARGETS,
  defaultShellMessages,
  defineSkipLinks,
  landmarkOf,
  type ShellMessages,
  ShellMessagesToken,
  skipLinksFor,
} from './skip-links.js';
import { type SlotContribution, SlotContributionsToken, type SlotId } from './slots.js';
import { ThemeControllerToken } from './theme.js';
import { withViewTransition } from './transitions.js';
import { CommandShortcutBindingsToken } from './tokens.js';
import { arrangeSlots, WorkspaceManagerToken, type WorkspaceId } from './workspace.js';
import type { WorkspaceDef } from './workspace.js';

const shellSpec = component({
  tag: 'sf-shell',
  deps: {
    render: {
      contributions: SlotContributionsToken,
      workspaces: WorkspaceManagerToken,
      preset: ShellPresetToken,
    },
    lazy: {
      theme: ThemeControllerToken,
      decide: DecideToken,
      focus: FocusManagerToken,
      messages: ShellMessagesToken,
      keyboard: { token: CommandShortcutBindingsToken, init: 'idle' },
    },
  },
  placeholder: () => html`<sf-skeleton lines="3"></sf-skeleton>`,
  size: { block: '100vh' },
  description: 'App frame: preset regions, workspace-arranged slot contributions, per-region error boundaries.',
});

export class SfShellElement extends SfElement<typeof shellSpec> {
  static override readonly spec = shellSpec;
  static override styles = css`
    :host {
      display: block;
      block-size: 100%;
      background: var(--sf-color-bg, transparent);
      color: var(--sf-color-fg, inherit);
      font-family: var(--sf-font-body, inherit);
    }
    .frame {
      display: grid;
      block-size: 100%;
      min-block-size: 100vh;
    }
    .region {
      min-inline-size: 0;
      min-block-size: 0;
      contain: layout style;
    }
    .region[data-slot='main'] {
      overflow: auto;
    }
    .region:focus {
      outline: none;
    }
    .region:focus-visible {
      outline: 2px solid var(--sf-color-focus, var(--sf-color-accent, #4f46e5));
      outline-offset: -2px;
    }
  `;

  /** Reactive allow-list of gated contributions (absent = not yet decided = hidden). */
  private readonly decisions = box<ReadonlyMap<string, boolean>>(new Map());
  private readonly messages = box<ShellMessages>(defaultShellMessages);
  private readonly focusManager = box<FocusManager | undefined>(undefined);

  protected override wireDeps(on: ComponentHooksOf<typeof shellSpec>): void {
    on.onReady('contributions', async (contributions: readonly SlotContribution[], scope: Scope) => {
      const decide = await this.deps.decide.whenReady(scope.signal);
      if (!decide.ok) return;
      const next = new Map<string, boolean>();
      await Promise.all(
        contributions
          .filter((c) => c.gate !== undefined)
          .map(async (c) => {
            const verdict = await decide.value.decide(c.gate as NonNullable<SlotContribution['gate']>, scope.signal);
            next.set(c.id, verdict.effect === 'allow');
          }),
      );
      if (!scope.disposed) this.decisions.set(next);
    });
    on.onReady('theme', (theme, scope) => theme.apply(this, scope));
    on.onReady('messages', (messages, scope) => {
      this.messages.set(messages);
      scope.defer(() => this.messages.set(defaultShellMessages));
    });
    on.onReady('focus', (manager, scope) => {
      this.focusManager.set(manager);
      scope.defer(() => this.focusManager.set(undefined));
    });
  }

  /** Switch workspace inside a View Transition (falls back to an instant switch). */
  async switchWorkspace(id: WorkspaceId): Promise<Result<WorkspaceDef>> {
    let result: Result<WorkspaceDef> | undefined;
    const transition = await withViewTransition(async () => {
      result = await this.deps.workspaces.switchTo(id);
      this.requestUpdate();
      await this.updateComplete;
    });
    if (!transition.ok) return transition;
    return result as Result<WorkspaceDef>;
  }

  override render(): TemplateResult {
    const { contributions, workspaces, preset } = this.deps;
    const decisions = this.decisions.get();
    const layout = arrangeSlots(contributions, workspaces.current, (c) => c.gate === undefined || decisions.get(c.id) === true);
    const messages = this.messages.get();
    const rendered = preset.regions.filter((slot) => slot === 'main' || (layout.get(slot) ?? []).length > 0);
    const links = skipLinksFor(rendered, preset.skipTargets ?? DEFAULT_SKIP_TARGETS, messages);
    const style = `grid-template-areas: ${preset.areas.map((row) => `"${row}"`).join(' ')}; grid-template-columns: ${preset.columns}; grid-template-rows: ${preset.rows};`;
    return html`<sf-skip-links .links=${links} .label=${messages.skipLinksLabel} .focusManager=${this.focusManager.get()}></sf-skip-links>
      <div class="frame" style=${style} data-preset=${preset.id} data-workspace=${workspaces.current.id}>
        ${preset.regions.map((slot) => this.renderRegion(slot, layout.get(slot) ?? [], messages))}
      </div>`;
  }

  private renderRegion(slot: SlotId, items: readonly SlotContribution[], messages: ShellMessages): unknown {
    if (items.length === 0 && slot !== 'main') return nothing;
    const content = repeat(
      items,
      (c) => c.id,
      (c) => html`<sf-boundary region=${slot} label=${c.label ?? ''} data-contribution=${c.id}>${c.render()}</sf-boundary>`,
    );
    const area = `grid-area: ${slot};`;
    const name = messages.regions[slot] ?? slot;
    // Explicit roles: inside a shadow root the implicit header/aside roles depend on the flat tree.
    switch (landmarkOf(slot)) {
      case 'banner':
        return html`<header class="region" data-slot=${slot} style=${area} role="banner" tabindex="-1">${content}</header>`;
      case 'main':
        return html`<main class="region" data-slot=${slot} style=${area} tabindex="-1">${content}</main>`;
      case 'navigation':
        return html`<nav class="region" data-slot=${slot} style=${area} aria-label=${name} tabindex="-1">${content}</nav>`;
      case 'complementary':
        return html`<aside class="region" data-slot=${slot} style=${area} role="complementary" aria-label=${name} tabindex="-1">${content}</aside>`;
      case 'region':
        return html`<section class="region" data-slot=${slot} style=${area} role="region" aria-label=${name} tabindex="-1">${content}</section>`;
    }
  }
}

export function defineShell(registry: CustomElementRegistry = customElements): void {
  defineBoundary(registry);
  defineSkipLinks(registry);
  if (registry.get(shellSpec.tag) === undefined) defineComponent(SfShellElement, registry);
}
