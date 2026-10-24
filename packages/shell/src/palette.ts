/**
 * Command palette (R13.3): a dialog surface (via the surface manager — one focus/a11y
 * model) rendering `<sf-command-palette>`: a combobox input with a listbox of fuzzy
 * matched, available commands with their platform-aware shortcut labels (from the
 * a11y shortcut registry). ↑/↓ move, Enter runs, Escape closes (surface host).
 */
import type { ShortcutDef, ShortcutRegistry } from '@staticflux/a11y';
import type { Result, Scope } from '@staticflux/core';
import { defineSurface, type SurfaceHandle, type SurfaceManager, type SurfaceOwner } from '@staticflux/messaging';
import { css, html, LitElement, type PropertyValues } from 'lit';
import type { CommandRegistry, CommandSearchResult } from './commands.js';
import { CommandPaletteShortcut, commandShortcutLabels } from './shortcuts.js';

export class CommandRanEvent extends Event {
  static readonly type = 'sf-command-ran' as const;
  constructor(
    readonly commandId: string,
    readonly result: Result<unknown>,
  ) {
    super(CommandRanEvent.type, { bubbles: true, composed: true });
  }
}

let paletteCounter = 0;

export class SfCommandPaletteElement extends LitElement {
  static override properties = {
    registry: { attribute: false },
    shortcuts: { attribute: false },
    query: { state: true },
    active: { state: true },
  };
  static override styles = css`
    :host {
      display: block;
      min-inline-size: min(560px, 90vw);
    }
    input {
      inline-size: 100%;
      box-sizing: border-box;
      padding: var(--sf-space-2, 8px);
      font: inherit;
    }
    ul {
      list-style: none;
      margin: var(--sf-space-2, 8px) 0 0;
      padding: 0;
      max-block-size: 50vh;
      overflow: auto;
    }
    li {
      padding: var(--sf-space-2, 8px);
      border-radius: var(--sf-radius-small, 4px);
      cursor: pointer;
    }
    li[aria-selected='true'] {
      background: var(--sf-color-accent, #4f46e5);
      color: var(--sf-color-accent-fg, #fff);
    }
    mark {
      background: none;
      color: inherit;
      font-weight: 700;
    }
    .meta {
      float: inline-end;
      display: inline-flex;
      gap: var(--sf-space-2, 8px);
      opacity: 0.7;
      font-size: 0.85em;
    }
    kbd {
      font: inherit;
    }
  `;

  declare registry: CommandRegistry | undefined;
  /** a11y shortcut registry; when set, each command shows its shortcut label. */
  declare shortcuts: ShortcutRegistry | undefined;
  declare query: string;
  declare active: number;
  private readonly listId: string;

  constructor() {
    super();
    paletteCounter += 1;
    this.listId = `sf-palette-list-${paletteCounter}`;
    this.registry = undefined;
    this.shortcuts = undefined;
    this.query = '';
    this.active = 0;
  }

  get results(): readonly CommandSearchResult[] {
    return this.registry?.search(this.query, { limit: 30 }) ?? [];
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('query')) this.active = 0;
  }

  protected override firstUpdated(): void {
    this.renderRoot.querySelector('input')?.focus();
  }

  override render(): unknown {
    const results = this.results;
    const activeId = results[this.active] === undefined ? '' : `${this.listId}-${this.active}`;
    return html`<input
        role="combobox"
        aria-expanded="true"
        aria-controls=${this.listId}
        aria-activedescendant=${activeId}
        aria-autocomplete="list"
        aria-label="Search commands"
        .value=${this.query}
        @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => this.onKey(e, results)}
      />
      <ul id=${this.listId} role="listbox" aria-label="Commands">
        ${results.map(
          (r, i) => html`<li
            id=${`${this.listId}-${i}`}
            role="option"
            aria-selected=${i === this.active ? 'true' : 'false'}
            data-command=${r.command.id}
            @click=${() => void this.run(r)}
          >
            ${highlight(r.command.title, r.indices)}${this.renderMeta(r)}
          </li>`,
        )}
      </ul>`;
  }

  private renderMeta(result: CommandSearchResult): unknown {
    const labels = this.shortcuts === undefined ? [] : commandShortcutLabels(this.shortcuts, result.command);
    if (labels.length === 0 && result.command.group === undefined) return null;
    return html`<span class="meta"
      >${result.command.group === undefined ? null : html`<span class="group">${result.command.group}</span>`}${labels.map(
        (label) => html`<kbd class="shortcut">${label}</kbd>`,
      )}</span
    >`;
  }

  private onKey(event: KeyboardEvent, results: readonly CommandSearchResult[]): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.active = results.length === 0 ? 0 : (this.active + 1) % results.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.active = results.length === 0 ? 0 : (this.active - 1 + results.length) % results.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = results[this.active];
      if (selected !== undefined) void this.run(selected);
    }
  }

  private async run(result: CommandSearchResult): Promise<void> {
    const registry = this.registry;
    if (registry === undefined) return;
    const outcome = await registry.run(result.command.id, { source: 'palette' });
    this.dispatchEvent(new CommandRanEvent(result.command.id, outcome));
  }
}

function highlight(text: string, indices: readonly number[]): unknown {
  if (indices.length === 0) return text;
  const set = new Set(indices);
  return [...text].map((char, i) => (set.has(i) ? html`<mark>${char}</mark>` : char));
}

export const COMMAND_PALETTE_TAG = 'sf-command-palette';

export function defineCommandPalette(registry: CustomElementRegistry = customElements): void {
  if (registry.get(COMMAND_PALETTE_TAG) === undefined) registry.define(COMMAND_PALETTE_TAG, SfCommandPaletteElement);
}

export interface CommandPaletteProps {
  readonly registry: CommandRegistry;
  readonly shortcuts?: ShortcutRegistry;
}

export const commandPaletteSurface = defineSurface<CommandPaletteProps>({
  id: 'shell/command-palette',
  kind: 'dialog',
  scope: 'app',
  priority: 'high',
  label: 'Command palette',
  render: ({ props, dismiss }) =>
    html`<sf-command-palette .registry=${props.registry} .shortcuts=${props.shortcuts} @sf-command-ran=${() => dismiss('action')}></sf-command-palette>`,
});

export function openCommandPalette(options: {
  readonly manager: SurfaceManager;
  readonly registry: CommandRegistry;
  readonly owner: SurfaceOwner;
  /** Shows shortcut labels next to commands. */
  readonly shortcuts?: ShortcutRegistry;
}): SurfaceHandle {
  defineCommandPalette();
  const props: CommandPaletteProps =
    options.shortcuts === undefined ? { registry: options.registry } : { registry: options.registry, shortcuts: options.shortcuts };
  return options.manager.request(commandPaletteSurface, { owner: options.owner, props });
}

/**
 * Bind the palette to an a11y shortcut (default `CommandPaletteShortcut`, `Mod+K`).
 * A conflict with another shortcut in the same a11y scope is an `SF-A11Y-002` error.
 */
export function bindCommandPalette(options: {
  readonly shortcuts: ShortcutRegistry;
  readonly manager: SurfaceManager;
  readonly registry: CommandRegistry;
  readonly owner: SurfaceOwner;
  readonly scope: Scope;
  readonly shortcut?: ShortcutDef;
}): Result<() => void> {
  return options.shortcuts.register(
    options.shortcut ?? CommandPaletteShortcut,
    () => {
      if (options.manager.showing('dialog').some((h) => h.def.id === commandPaletteSurface.id)) return;
      openCommandPalette(options);
    },
    { scope: options.scope },
  );
}
