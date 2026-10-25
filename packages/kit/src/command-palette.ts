/**
 * `@staticflux/kit/command-palette` — the "say what you need" bar (UX §2, `Mod+K`) over
 * the capabilities registry: the same capabilities the UI, agents and WebMCP run, through
 * the same pipeline (authorize → confirm → activate → meter → run).
 *
 * - `<sf-capability-palette>` — combobox + listbox (APG combobox with
 *   `aria-activedescendant`, all in one shadow root): fuzzy search over titles, substring
 *   search over ids and descriptions; ↑/↓, Home/End, Enter runs, Escape closes (the surface layer); shortcut
 *   labels from `CapabilityShortcutsToken` contributions. Lists *runnable* capabilities —
 *   implemented, and whose input schema accepts `{}` (parameterised ones belong to the
 *   HUD, chat or a form). Runs with subject `user` and origin `kit/palette`; fires
 *   `sf-capability-ran` `{ id, result }`.
 * - `capabilityPaletteSurface` — a messaging dialog that renders it; `openCapabilityPalette`,
 *   `bindCapabilityPalette` (a11y shortcut, default `Mod+K`), `bindCapabilityShortcuts`
 *   (each contributed shortcut invokes its capability).
 *
 * Client gating is UX, not security: the palette only hides what cannot run; the
 * capability pipeline and the server decide (R6.16).
 */
import { defineShortcut, type KeyCombo, type ShortcutDef, type ShortcutRegistry } from '@staticflux/a11y';
import {
  type AnyCapability,
  type CapabilityId,
  type CapabilityRegistry,
  CapabilityRegistryToken,
  validate,
} from '@staticflux/capabilities';
import { contribution, type Result, type Scope, token } from '@staticflux/core';
import { I18nToken } from '@staticflux/i18n';
import { defineSurface, type SurfaceHandle, type SurfaceManager, type SurfaceOwner } from '@staticflux/messaging';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { emit } from './internal/events.js';
import { uniqueId } from './internal/ids.js';
import { shortcutLabel } from './internal/shortcuts.js';
import { baseStyles, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

// ------------------------------------------------------------------ search (pure)

export interface FuzzyMatch {
  readonly score: number;
  /** Matched character indices in the text. */
  readonly indices: readonly number[];
}

/**
 * Subsequence match of `query` in `text` (case-insensitive), scored: consecutive
 * characters, word starts and an early first match score higher. Empty query matches all.
 */
export function fuzzyScore(query: string, text: string): FuzzyMatch | undefined {
  const q = query.trim().toLowerCase();
  if (q === '') return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const char of q) {
    if (char === ' ') continue;
    const at = lower.indexOf(char, from);
    if (at < 0) return undefined;
    const previous = indices[indices.length - 1];
    if (previous !== undefined && at === previous + 1) score += 5;
    if (at === 0 || /[\s/_.-]/.test(lower[at - 1] ?? '')) score += 8;
    score += 1;
    indices.push(at);
    from = at + 1;
  }
  score -= (indices[0] ?? 0) * 0.1;
  score -= text.length * 0.01;
  return { score, indices };
}

/** A capability the palette can run without parameters. */
export function isPaletteRunnable(capability: AnyCapability, isImplemented: (id: string) => boolean): boolean {
  return isImplemented(capability.id) && validate(capability.input, {}).ok;
}

export interface PaletteEntry {
  readonly capability: AnyCapability;
  readonly score: number;
  /** Matched indices in the title (for highlighting). */
  readonly indices: readonly number[];
  readonly shortcut: KeyCombo | undefined;
}

/** Ranked palette entries for `query` (pure over its inputs). Fuzzy title matches outrank id/description substring matches. */
export function paletteEntries(
  capabilities: readonly AnyCapability[],
  isImplemented: (id: string) => boolean,
  query: string,
  shortcuts: ReadonlyMap<string, KeyCombo> = new Map(),
  limit = 50,
): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const capability of capabilities) {
    if (!isPaletteRunnable(capability, isImplemented)) continue;
    // Titles match fuzzily; ids and descriptions only by substring (fuzzy there is too loose).
    const title = fuzzyScore(query, capability.title);
    const needle = query.trim().toLowerCase();
    const other = title === undefined && (capability.id.toLowerCase().includes(needle) || capability.description.toLowerCase().includes(needle));
    if (title === undefined && !other) continue;
    out.push({
      capability,
      score: title === undefined ? 0 : title.score + 100,
      indices: title?.indices ?? [],
      shortcut: shortcuts.get(capability.id),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.capability.title.localeCompare(b.capability.title)).slice(0, limit);
}

// ------------------------------------------------------------------ shortcuts (DI)

export interface CapabilityShortcut {
  readonly capability: CapabilityId;
  readonly keys: KeyCombo;
}

/** Multi: keyboard shortcuts of capabilities (shown in the palette, bound by `bindCapabilityShortcuts`). */
export const CapabilityShortcutsToken = /* @__PURE__ */ token('kit/capability-shortcuts').multi<CapabilityShortcut>();

/** Contribute a shortcut for a capability. */
/* @__NO_SIDE_EFFECTS__ */
export function capabilityShortcut(capability: AnyCapability, keys: KeyCombo) {
  return contribution({
    id: `kit/capability-shortcut:${capability.id}`,
    provides: CapabilityShortcutsToken,
    scope: 'app',
    create: (): CapabilityShortcut => ({ capability: capability.id, keys }),
  });
}

// ------------------------------------------------------------------ element

const paletteSpec = component({
  tag: 'sf-capability-palette',
  deps: { render: { registry: CapabilityRegistryToken }, lazy: { i18n: I18nToken, shortcuts: CapabilityShortcutsToken } },
  placeholder: () => html`<div style="min-block-size:240px"></div>`,
  size: { block: '240px' },
  description: 'Command palette over runnable capabilities (APG combobox + listbox).',
});

export interface CapabilityRanDetail {
  readonly id: CapabilityId;
  readonly result: Result<unknown>;
}

export class SfCapabilityPaletteElement extends SfElement<typeof paletteSpec> {
  static override readonly spec = paletteSpec;
  static override properties = { query: { state: true }, active: { state: true }, running: { state: true }, placeholder: {} };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        inline-size: 100%;
        min-inline-size: min(480px, calc(100vw - 32px));
      }
      .search {
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        padding: ${t.space.md.css};
        border-block-end: 1px solid ${t.color.border.css};
      }
      .search::before {
        content: '✦';
        color: ${t.color.accentText.css};
      }
      input {
        all: unset;
        flex: 1;
        font-size: ${t.type.sizeLg.css};
        color: ${t.color.text.css};
      }
      input::placeholder {
        color: ${t.color.textSubtle.css};
      }
      [role='listbox'] {
        max-block-size: min(400px, 60vh);
        overflow: auto;
        padding: ${t.space.xs.css};
        margin: 0;
      }
      [role='option'] {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        column-gap: ${t.space.md.css};
        padding-block: ${t.space.sm.css};
        padding-inline: ${t.space.md.css};
        border-radius: ${t.radius.md.css};
        cursor: pointer;
      }
      [role='option'][aria-selected='true'] {
        background: ${t.color.surfaceSelected.css};
      }
      .title mark {
        background: none;
        color: inherit;
        font-weight: ${t.font.weightSemibold.css};
        text-decoration: underline;
        text-decoration-color: ${t.color.accent.css};
      }
      .description {
        grid-column: 1;
        font-size: ${t.type.sizeSm.css};
        color: ${t.color.textMuted.css};
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      kbd {
        grid-row: 1 / span 2;
        grid-column: 2;
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
        color: ${t.color.textMuted.css};
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.sm.css};
        padding-inline: ${t.space.xs.css};
      }
      .empty {
        padding: ${t.space.lg.css};
        color: ${t.color.textMuted.css};
        text-align: center;
      }
      @media (forced-colors: active) {
        [role='option'][aria-selected='true'] {
          background: Highlight;
          color: HighlightText;
        }
      }
    `,
  ];

  declare query: string;
  declare active: number;
  declare running: boolean;
  declare placeholder: string;
  private readonly listId = uniqueId('sf-palette');
  private focusedInput = false;

  constructor() {
    super();
    this.query = '';
    this.active = 0;
    this.running = false;
    this.placeholder = '';
  }

  /** Current entries (reactive over the registry and the shortcut contributions). */
  get entries(): PaletteEntry[] {
    const registry: CapabilityRegistry = this.deps.registry;
    const shortcuts = new Map((this.deps.shortcuts.value ?? []).map((s) => [s.capability as string, s.keys] as const));
    return paletteEntries(registry.list(), (id) => registry.isImplemented(id), this.query, shortcuts);
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('query')) this.active = 0;
  }

  protected override updated(): void {
    if (!this.ready) return;
    const input = this.renderRoot.querySelector('input');
    if (input !== null && !this.focusedInput) {
      this.focusedInput = true;
      input.focus();
    }
    this.renderRoot.querySelector(`#${this.listId}-${this.active}`)?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Run an entry through the capability pipeline. */
  async run(entry: PaletteEntry): Promise<void> {
    if (this.running) return;
    this.running = true;
    const result = await this.deps.registry.invoke(entry.capability.id, {}, { subject: 'user', origin: { channel: 'kit/palette' } });
    this.running = false;
    emit<CapabilityRanDetail>(this, 'sf-capability-ran', { id: entry.capability.id, result });
  }

  private onKeydown(event: KeyboardEvent, entries: readonly PaletteEntry[]): void {
    const last = entries.length - 1;
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = this.active >= last ? 0 : this.active + 1;
    else if (event.key === 'ArrowUp') next = this.active <= 0 ? last : this.active - 1;
    else if (event.key === 'Home' && event.ctrlKey) next = 0;
    else if (event.key === 'End' && event.ctrlKey) next = last;
    else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = entries[this.active];
      if (entry !== undefined) void this.run(entry);
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    this.active = Math.max(0, next);
  }

  override render(): TemplateResult {
    const entries = this.entries;
    const i18n = this.deps.i18n;
    const activeId = entries[this.active] === undefined ? nothing : `${this.listId}-${this.active}`;
    return html`<div class="search">
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls=${this.listId}
          aria-activedescendant=${activeId}
          aria-autocomplete="list"
          aria-label=${kitText(i18n, kitMessages.paletteSearch)}
          aria-busy=${this.running ? 'true' : nothing}
          placeholder=${this.placeholder || kitText(i18n, kitMessages.paletteSearch)}
          autocomplete="off"
          spellcheck="false"
          .value=${this.query}
          @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => this.onKeydown(e, entries)}
        />
      </div>
      <div id=${this.listId} role="listbox" aria-label=${kitText(i18n, kitMessages.paletteLabel)}>
        ${entries.map(
          (entry, i) => html`<div
            id=${`${this.listId}-${i}`}
            role="option"
            aria-selected=${i === this.active ? 'true' : 'false'}
            data-capability=${entry.capability.id}
            @pointermove=${() => (this.active = i)}
            @click=${() => void this.run(entry)}
          >
            <span class="title">${highlight(entry.capability.title, entry.indices)}</span>
            ${entry.shortcut === undefined ? nothing : html`<kbd aria-label=${entry.shortcut}>${shortcutLabel(entry.shortcut, this.ownerDocument)}</kbd>`}
            <span class="description">${entry.capability.description}</span>
          </div>`,
        )}
      </div>
      ${entries.length === 0 ? html`<div class="empty" role="status">${kitText(i18n, kitMessages.paletteEmpty)}</div>` : nothing}`;
  }
}

function highlight(text: string, indices: readonly number[]): unknown {
  if (indices.length === 0) return text;
  const set = new Set(indices);
  return [...text].map((char, i) => (set.has(i) ? html`<mark>${char}</mark>` : char));
}

export function defineCapabilityPalette(registry: CustomElementRegistry = customElements): void {
  if (registry.get(paletteSpec.tag) === undefined) defineComponent(SfCapabilityPaletteElement, registry);
}

// ------------------------------------------------------------------ surface + bindings

/** The palette as a messaging dialog (app scope, high priority; closes after a run). */
export const capabilityPaletteSurface = /* @__PURE__ */ defineSurface<void, CapabilityRanDetail>({
  id: 'kit/capability-palette',
  kind: 'dialog',
  scope: 'app',
  priority: 'high',
  label: kitMessages.paletteLabel.source,
  render: ({ dismiss }) =>
    html`<sf-capability-palette data-sf-frame @sf-capability-ran=${(e: CustomEvent<CapabilityRanDetail>) => dismiss('action', e.detail)}></sf-capability-palette>`,
});

export const CapabilityPaletteShortcut = /* @__PURE__ */ defineShortcut({
  id: 'kit/capability-palette',
  keys: ['Mod+K'],
  description: 'Open the action palette',
  allowInInputs: true,
});

export function openCapabilityPalette(options: { readonly manager: SurfaceManager; readonly owner: SurfaceOwner }): SurfaceHandle<void, CapabilityRanDetail> {
  defineCapabilityPalette();
  return options.manager.request(capabilityPaletteSurface, { owner: options.owner });
}

/** Bind the palette to an a11y shortcut (default `Mod+K`); a conflict is `SF-A11Y-002`. Re-pressing while open does nothing. */
export function bindCapabilityPalette(options: {
  readonly shortcuts: ShortcutRegistry;
  readonly manager: SurfaceManager;
  readonly owner: SurfaceOwner;
  readonly scope: Scope;
  readonly shortcut?: ShortcutDef;
}): Result<() => void> {
  return options.shortcuts.register(
    options.shortcut ?? CapabilityPaletteShortcut,
    () => {
      if (options.manager.showing('dialog').some((h) => h.def.id === capabilityPaletteSurface.id)) return;
      openCapabilityPalette(options);
    },
    { scope: options.scope },
  );
}

/**
 * Bind every contributed capability shortcut: pressing it invokes the capability (subject
 * `user`, origin `kit/shortcut`) when it is palette-runnable. Returns one result per binding.
 */
export function bindCapabilityShortcuts(options: {
  readonly shortcuts: ShortcutRegistry;
  readonly registry: CapabilityRegistry;
  readonly entries: readonly CapabilityShortcut[];
  readonly scope: Scope;
}): readonly Result<() => void>[] {
  return options.entries.map((entry) =>
    options.shortcuts.register(
      defineShortcut({ id: `kit/capability-shortcut:${entry.capability}` as `${string}/${string}`, keys: [entry.keys], description: entry.capability }),
      () => {
        const capability = options.registry.get(entry.capability);
        if (capability === undefined || !isPaletteRunnable(capability, (id) => options.registry.isImplemented(id))) return false;
        void options.registry.invoke(capability.id, {}, { subject: 'user', origin: { channel: 'kit/shortcut' } });
        return true;
      },
      { scope: options.scope },
    ),
  );
}
