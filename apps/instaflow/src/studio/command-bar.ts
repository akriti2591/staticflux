/**
 * `<if-command-bar>` — the Studio command bar (STUDIO-UX-SPEC §4.4, B11b): a bottom-centre pill `Type a command` with
 * its `Mod+K` key; it opens a filterable menu over what can run **now**: the selection's applicable capabilities (the
 * same list the pill's More menu draws from), the commands that need no selection (undo, redo), the tools and the
 * camera. Recent commands come first. Choosing one fires `if-command` with its value (`cap:<id>`, `tool:<id>`,
 * `camera:<action>`); the Studio frame runs it. Nothing here decides what is allowed: the capability pipeline does.
 */
import { defineButton } from '@staticflux/kit/button';
import { defineIconElement } from '@staticflux/kit/icon';
import { searchIcon } from '@staticflux/kit/icons/search';
import { defineMenu, type SfMenuElement } from '@staticflux/kit/menu';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import type { SelectionSummary } from '../app/scene-summary.js';
import type { HudAction } from './hud.js';
import { MORE_EXCLUDED } from './studio-controls.js';

export const commandBarMessages = Object.freeze({
  bar: 'Command bar',
  placeholder: 'Type a command',
  filter: 'Type a command',
  recent: 'Recent',
  selection: 'Selection',
  edit: 'Edit',
  tools: 'Tools',
  view: 'View',
});

export type CommandGroup = 'recent' | 'selection' | 'edit' | 'tools' | 'view';

/** One runnable row: `value` is `cap:<capability>`, `tool:<tool>` or `camera:<action>`. */
export interface CommandEntry {
  readonly value: string;
  readonly title: string;
  readonly shortcut?: string;
}

export interface CommandSources {
  readonly selection: SelectionSummary | undefined;
  readonly actions: ReadonlyMap<string, HudAction>;
  /** Capabilities that run with nothing selected (undo, redo). */
  readonly globalActions: readonly string[];
  readonly tools: readonly CommandEntry[];
  readonly camera: readonly CommandEntry[];
  /** Values run before, newest first. */
  readonly recent: readonly string[];
}

/** How many recent commands the bar remembers and shows. */
export const RECENT_LIMIT = 5;

const capEntry = (a: HudAction): CommandEntry => ({ value: `cap:${a.id}`, title: a.title, ...(a.shortcut === undefined ? {} : { shortcut: a.shortcut }) });

/**
 * The bar's groups (pure): recent first (only those still runnable), then the selection's applicable capabilities
 * (excluding the ones that need a form or a gesture), the no-selection commands, tools and the camera. A value shows
 * once: a recent row is not repeated in its own group.
 */
export function commandEntries(sources: CommandSources): readonly (readonly [CommandGroup, readonly CommandEntry[]])[] {
  const s = sources.selection;
  const selected = s !== undefined && s.kind !== 'none' && s.nodes.length > 0;
  const selection = selected
    ? s.actions.filter((id) => !MORE_EXCLUDED.has(id)).flatMap((id) => {
        const a = sources.actions.get(id);
        return a === undefined ? [] : [capEntry(a)];
      })
    : [];
  const edit = sources.globalActions.flatMap((id) => {
    const a = sources.actions.get(id);
    return a === undefined ? [] : [capEntry(a)];
  });
  const all = new Map([...selection, ...edit, ...sources.tools, ...sources.camera].map((e) => [e.value, e] as const));
  const recent = sources.recent.flatMap((v) => {
    const e = all.get(v);
    return e === undefined ? [] : [e];
  });
  const seen = new Set(recent.map((e) => e.value));
  const rest = (list: readonly CommandEntry[]): readonly CommandEntry[] => list.filter((e) => !seen.has(e.value));
  const groups: [CommandGroup, readonly CommandEntry[]][] = [
    ['recent', recent],
    ['selection', rest(selection)],
    ['edit', rest(edit)],
    ['tools', rest(sources.tools)],
    ['view', rest(sources.camera)],
  ];
  return groups.filter(([, list]) => list.length > 0);
}

/** Put `value` first in the recent list (deduplicated, capped). Pure. */
export function pushRecent(recent: readonly string[], value: string): readonly string[] {
  return [value, ...recent.filter((v) => v !== value)].slice(0, RECENT_LIMIT);
}

const RECENT_KEY = 'instaflow/ui/recent-commands';

/** The recent commands of this browser (a per-viewer convenience: empty when storage is unavailable). */
export function readRecentCommands(): readonly string[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    const list = raw === null || raw === undefined ? [] : (JSON.parse(raw) as unknown);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeRecentCommands(list: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: the bar works without recents.
  }
}

const spec = component({ tag: 'if-command-bar', placeholder: () => nothing, description: 'Instaflow command bar: a filterable menu over what can run now (B11b).' });

export class IfCommandBarElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    sources: { attribute: false },
    shortcut: {},
    recent: { state: true },
  };
  static override styles = [
    css`
      :host {
        display: inline-flex;
      }
      .trigger {
        display: inline-flex;
        align-items: center;
        gap: ${t.space.sm.css};
        min-inline-size: 280px;
        min-block-size: 36px;
        padding-inline: 14px 8px;
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.full.css};
        background: ${t.color.surface2.css};
        color: ${t.color.textMuted.css};
        font: inherit;
        cursor: pointer;
        box-shadow: 0 1px 2px rgba(22, 21, 26, 0.08);
      }
      .trigger:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .trigger span {
        flex: 1;
        text-align: start;
      }
      kbd {
        font-family: ${t.font.familyMono.css};
        font-size: 11px;
        padding: 2px 6px;
        border-radius: ${t.radius.sm.css};
        background: ${t.color.surface1.css};
        color: ${t.color.textMuted.css};
      }
    `,
  ];

  declare sources: CommandSources | undefined;
  /** The visible key label (`⌘K` / `Ctrl K`). */
  declare shortcut: string;
  declare recent: readonly string[];

  constructor() {
    super();
    this.sources = undefined;
    this.shortcut = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘K' : 'Ctrl K';
    this.recent = readRecentCommands();
  }

  /** Open the bar with its filter focused (`Mod+K`). */
  open(): void {
    this.renderRoot.querySelector<SfMenuElement>('sf-menu')?.show('first');
  }

  private pick(value: string): void {
    this.recent = pushRecent(this.recent, value);
    writeRecentCommands(this.recent);
    this.dispatchEvent(new CustomEvent('if-command', { detail: { value }, bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    const sources = this.sources;
    const groups = sources === undefined ? [] : commandEntries({ ...sources, recent: this.recent });
    return html`<sf-menu label=${commandBarMessages.bar} filterable filter-label=${commandBarMessages.filter} @sf-select=${(e: CustomEvent<{ value: string }>) => this.pick(e.detail.value)}>
      <button slot="trigger" class="trigger" type="button" aria-label=${commandBarMessages.bar} aria-keyshortcuts="Control+K Meta+K">
        <sf-icon .icon=${searchIcon} size="16"></sf-icon><span>${commandBarMessages.placeholder}</span><kbd aria-hidden="true">${this.shortcut}</kbd>
      </button>
      ${groups.map(
        ([group, list]) =>
          html`<sf-menu-group label=${commandBarMessages[group]}>
            ${list.map((e) => html`<sf-menu-item value=${e.value} shortcut=${e.shortcut ?? nothing}>${e.title}</sf-menu-item>`)}
          </sf-menu-group>`,
      )}
    </sf-menu>`;
  }
}

/** Define `<if-command-bar>` and the kit components it renders. */
export function defineCommandBar(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconElement(registry);
  defineMenu(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfCommandBarElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-command-bar': IfCommandBarElement;
  }
}
