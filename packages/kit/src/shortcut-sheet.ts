/**
 * `<sf-shortcut-sheet>` — the keyboard cheat sheet over a shortcut-registry snapshot (R13.47). A search field (focused by
 * `focusSearch()`; typing filters rows by label and keys and marks the matches), a `Mac · Windows` platform switch
 * (defaults to the viewer's), and one card per group in the given order, each a list of `label … kbd` rows. Groups
 * with no rows are absent. Hovering a row fires `sf-row-hover` `{ id }` (`id: undefined` on leave), so the
 * app can point at the control the row belongs to.
 *
 * The rows are data the app builds from `registry.list()` (`shortcutSheetGroups`), so the sheet is never stale.
 *
 * ```html
 * <sf-shortcut-sheet .groups=${groups}></sf-shortcut-sheet>
 * ```
 */
import { comboLabel, type KeyCombo } from '@staticflux/a11y';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { baseStyles, focusRing, srOnly, t } from './internal/styles.js';
import { isApplePlatform } from './internal/shortcuts.js';

export interface ShortcutSheetRow {
  readonly id: string;
  readonly label: string;
  /** Combos as registered (`Mod+Shift+R`); the sheet labels them per platform. */
  readonly keys: readonly (KeyCombo | string)[];
}

export interface ShortcutSheetGroup {
  readonly heading: string;
  readonly rows: readonly ShortcutSheetRow[];
}

export type ShortcutPlatform = 'mac' | 'windows';

/** The registry entries the sheet reads (`ActiveShortcut` has them). */
export interface ShortcutSheetSource {
  readonly id: string;
  readonly description: string;
  readonly keys: readonly (KeyCombo | string)[];
  readonly shadowedBy?: string | undefined;
}

/**
 * Group registry entries: `groupOf` names each entry's group (undefined drops it), `order` orders the groups. Shadowed
 * entries and repeats (one description with the same keys registered in two scopes) are dropped. Pure.
 */
export function shortcutSheetGroups(list: readonly ShortcutSheetSource[], groupOf: (entry: ShortcutSheetSource) => string | undefined, order: readonly string[]): readonly ShortcutSheetGroup[] {
  const groups = new Map<string, ShortcutSheetRow[]>(order.map((g) => [g, []]));
  const seen = new Set<string>();
  for (const entry of list) {
    if (entry.shadowedBy !== undefined) continue;
    const group = groupOf(entry);
    const rows = group === undefined ? undefined : groups.get(group);
    const key = `${entry.description}\u0000${entry.keys.join(' ')}`;
    if (rows === undefined || seen.has(key)) continue;
    seen.add(key);
    rows.push({ id: entry.id, label: entry.description, keys: [...entry.keys] });
  }
  return order.map((heading) => ({ heading, rows: groups.get(heading) ?? [] })).filter((g) => g.rows.length > 0);
}

/** Rows whose label or keys (on `platform`) contain `query` (case-insensitive); empty groups are dropped. Pure. */
export function filterShortcutSheet(groups: readonly ShortcutSheetGroup[], query: string, platform: ShortcutPlatform): readonly ShortcutSheetGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return groups;
  return groups
    .map((g) => ({ heading: g.heading, rows: g.rows.filter((r) => r.label.toLowerCase().includes(q) || r.keys.some((k) => comboLabel(k, platform === 'mac').toLowerCase().includes(q) || k.toLowerCase().includes(q))) }))
    .filter((g) => g.rows.length > 0);
}

const spec = component({
  tag: 'sf-shortcut-sheet',
  placeholder: () => nothing,
  description: 'Keyboard cheat sheet: searchable cards of shortcuts per group over a registry snapshot, with a platform switch.',
});

/**
 * Layout (COMPONENT-ANATOMY §13, #56): one column of single-line 28 px rows (labels ellipsize), two columns only above
 * 1 100 px; nothing inside the sheet scrolls (the dialog body or the page is the one scroller). Key chips are §14's.
 * The search field's ring is for keyboard focus only (#41): a text field matches `:focus-visible` on a pointer press
 * too, so a press marks it `data-focus="pointer"` until it blurs.
 */
export class SfShortcutSheetElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    groups: { attribute: false },
    platform: { reflect: true },
    searchLabel: { attribute: 'search-label' },
    emptyLabel: { attribute: 'empty-label' },
    platformLabel: { attribute: 'platform-label' },
    query: { state: true },
  };
  static override styles = [
    baseStyles,
    focusRing,
    srOnly,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: ${t.space.md.css};
        min-inline-size: 0;
        container-type: inline-size;
      }
      .bar {
        display: flex;
        gap: ${t.space.sm.css};
        align-items: center;
      }
      input {
        flex: 1;
        min-inline-size: 0;
        block-size: ${t.size.control.css};
        padding-inline: ${t.space.sm.css};
        border: 1px solid ${t.color.controlEdge.css};
        border-radius: ${t.radius.md.css};
        background: ${t.color.surface1.css};
        color: ${t.color.text.css};
        font: inherit;
      }
      input[data-focus='pointer']:focus-visible {
        outline: none;
      }
      .platform {
        display: inline-flex;
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.sm.css};
        overflow: hidden;
      }
      .platform button {
        border: 0;
        background: transparent;
        color: ${t.color.textMuted.css};
        font: inherit;
        font-size: ${t.type.sizeSm.css};
        padding-inline: ${t.space.sm.css};
        block-size: ${t.size.control.css};
        cursor: pointer;
      }
      .platform button[aria-pressed='true'] {
        background: ${t.color.surface3.css};
        color: ${t.color.text.css};
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: ${t.space.md.css};
        align-items: start;
      }
      @container (min-width: 1100px) {
        .grid {
          grid-template-columns: repeat(2, minmax(320px, 1fr));
        }
      }
      section {
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.lg.css};
        padding: ${t.space.sm.css} ${t.space.md.css};
        background: ${t.color.surface2.css};
      }
      h3 {
        margin: 0 0 ${t.space.xs.css};
        font-size: ${t.type.sizeXs.css};
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: ${t.color.textMuted.css};
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: ${t.space.md.css};
        block-size: 28px;
        font-size: ${t.type.sizeMd.css};
      }
      .label {
        flex: 1;
        min-inline-size: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      li:hover {
        color: ${t.color.text.css};
      }
      .keys {
        display: inline-flex;
        gap: ${t.space.xs.css};
        flex-shrink: 0;
      }
      kbd {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        block-size: 20px;
        min-inline-size: 20px;
        padding: 0 6px;
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
        line-height: 1;
        white-space: nowrap;
        color: ${t.color.text.css};
        border: 1px solid ${t.color.border.css};
        border-radius: 6px;
        background: ${t.color.surface1.css};
      }
      mark {
        background: ${t.color.accentSubtle.css};
        color: inherit;
      }
      .empty {
        color: ${t.color.textMuted.css};
        text-align: center;
        padding: ${t.space.lg.css};
      }
      @media (forced-colors: active) {
        section,
        kbd {
          border-color: CanvasText;
        }
        mark {
          background: Highlight;
          color: HighlightText;
        }
      }
    `,
  ];

  declare groups: readonly ShortcutSheetGroup[];
  declare platform: ShortcutPlatform;
  declare searchLabel: string;
  declare emptyLabel: string;
  declare platformLabel: string;
  declare query: string;

  constructor() {
    super();
    this.groups = [];
    this.platform = typeof document === 'undefined' ? 'windows' : isApplePlatform(document) ? 'mac' : 'windows';
    this.searchLabel = 'Search shortcuts';
    this.emptyLabel = 'No shortcuts match';
    this.platformLabel = 'Platform';
    this.query = '';
  }

  /**
   * Focus the search field (the dialog calls it on open). The ring follows the input that caused the move (#41): pass
   * `focusVisible`, or the sheet reads it from the element focus comes from (a pointer press leaves it without
   * `:focus-visible`, a key gives it one); a text field would otherwise match `:focus-visible` on any focus.
   */
  async focusSearch(options: { readonly focusVisible?: boolean } = {}): Promise<void> {
    await this.updateComplete;
    const input = this.renderRoot.querySelector<HTMLInputElement>('input');
    if (input === null) return;
    const visible = options.focusVisible ?? keyboardFocused(input.ownerDocument);
    if (visible) delete input.dataset['focus'];
    else input.dataset['focus'] = 'pointer';
    const focusOptions: FocusOptions & { readonly focusVisible?: boolean } = { focusVisible: visible };
    input.focus(focusOptions);
  }

  private hover(id: string | undefined): void {
    this.dispatchEvent(new CustomEvent('sf-row-hover', { detail: { id }, bubbles: true, composed: true }));
  }

  private mark(text: string): TemplateResult | string {
    const q = this.query.trim();
    const at = q === '' ? -1 : text.toLowerCase().indexOf(q.toLowerCase());
    if (at < 0) return text;
    return html`${text.slice(0, at)}<mark>${text.slice(at, at + q.length)}</mark>${text.slice(at + q.length)}`;
  }

  override render(): TemplateResult {
    const mac = this.platform === 'mac';
    const shown = filterShortcutSheet(this.groups, this.query, this.platform);
    const platform = (value: ShortcutPlatform, label: string): TemplateResult =>
      html`<button type="button" class="focus-target" aria-pressed=${this.platform === value ? 'true' : 'false'} @click=${() => (this.platform = value)}>${label}</button>`;
    return html`<div class="bar">
        <label class="sr-only" for="q">${this.searchLabel}</label>
        <input
          id="q"
          type="search"
          class="focus-target"
          placeholder=${this.searchLabel}
          .value=${this.query}
          @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
          @pointerdown=${(e: Event) => ((e.currentTarget as HTMLInputElement).dataset['focus'] = 'pointer')}
          @blur=${(e: Event) => delete (e.currentTarget as HTMLInputElement).dataset['focus']}
        />
        <div class="platform" role="group" aria-label=${this.platformLabel}>${platform('mac', 'Mac')}${platform('windows', 'Windows')}</div>
      </div>
      ${shown.length === 0
        ? html`<p class="empty" role="status">${this.emptyLabel}</p>`
        : html`<div class="grid">
            ${shown.map(
              (g) => html`<section aria-label=${g.heading}>
                <h3>${g.heading}</h3>
                <ul>
                  ${g.rows.map(
                    (r) => html`<li data-id=${r.id} @pointerenter=${() => this.hover(r.id)} @pointerleave=${() => this.hover(undefined)}>
                      <span class="label" title=${r.label}>${this.mark(r.label)}</span>
                      <span class="keys">${r.keys.map((k) => html`<kbd>${this.mark(comboLabel(k, mac))}</kbd>`)}</span>
                    </li>`,
                  )}
                </ul>
              </section>`,
            )}
          </div>`}`;
  }
}

/** Whether the element that has focus now (through shadow roots) shows the keyboard focus ring. */
function keyboardFocused(doc: Document): boolean {
  let active: Element | null = doc.activeElement;
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement;
  if (active === null || active === doc.body) return false;
  try {
    return active.matches(':focus-visible');
  } catch {
    return false;
  }
}

export function defineShortcutSheet(registry: CustomElementRegistry = customElements): void {
  if (registry.get(spec.tag) === undefined) defineComponent(SfShortcutSheetElement, registry);
}
