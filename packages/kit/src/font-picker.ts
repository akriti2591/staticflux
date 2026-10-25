/**
 * `<sf-font-picker>` — the font picker (STUDIO-UX-SPEC §4.2.6): the content of a 264 × 360 popover. A filter field on
 * top (`Search fonts`, an APG combobox that keeps focus while arrows move through the list), then a **virtualised**
 * list of 36 px rows, each family drawn **in its own face** with its name, grouped `Recent · In this design · All`, a
 * mono `@display` tag on brand fonts, a muted download icon on fonts not cached yet.
 *
 * Hovering a row for 150 ms previews it (`sf-preview` `{ family }`), moving on previews the next, leaving the list
 * previews the opening family again; a click or Enter commits (`sf-change` `{ family }`, one undo step `Font`);
 * Escape on the surrounding popover restores (`sf-preview` of the opening family, then `sf-restore`). Weight is never
 * part of this list (a separate `Weight ▾` menu).
 */
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { defineIconElement } from './icon.js';
import { downloadIcon } from './icons/download.js';
import { emit } from './internal/events.js';
import { uniqueId } from './internal/ids.js';
import { ConnectedListeners } from './internal/listeners.js';
import { baseStyles, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

export interface FontEntry {
  readonly family: string;
  /** Brand token naming this font (`display`), shown as `@display`. */
  readonly token?: string;
  /** Available offline / already downloaded. */
  readonly cached: boolean;
}

export type FontRow =
  | { readonly kind: 'heading'; readonly label: 'recent' | 'design' | 'all' }
  | { readonly kind: 'font'; readonly font: FontEntry; readonly group: 'recent' | 'design' | 'all' };

export const FONT_ROW_HEIGHT = 36;
export const FONT_PREVIEW_MS = 150;
const OVERSCAN = 4;

/** Rows of the list: the three groups (empty ones dropped), filtered by every typed word. Pure. */
export function fontRows(fonts: readonly FontEntry[], recent: readonly string[], inDesign: readonly string[], query: string): FontRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  const match = (f: FontEntry): boolean => words.every((w) => f.family.toLowerCase().includes(w) || (f.token ?? '').toLowerCase().includes(w));
  const byName = new Map(fonts.map((f) => [f.family, f]));
  const pick = (names: readonly string[]): FontEntry[] => names.map((n) => byName.get(n)).filter((f): f is FontEntry => f !== undefined && match(f));
  const groups: [FontRow & { kind: 'heading' }, FontEntry[]][] = [
    [{ kind: 'heading', label: 'recent' }, pick(recent)],
    [{ kind: 'heading', label: 'design' }, pick(inDesign)],
    [{ kind: 'heading', label: 'all' }, fonts.filter(match)],
  ];
  return groups.flatMap(([heading, list]) => (list.length === 0 ? [] : [heading, ...list.map((font): FontRow => ({ kind: 'font', font, group: heading.label }))]));
}

/** The window of rows to render for a scroll position (with overscan). Pure. */
export function fontWindow(count: number, scrollTop: number, viewport: number, rowHeight = FONT_ROW_HEIGHT): { readonly start: number; readonly end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  return { start, end };
}

/** A family name as a safe quoted CSS font-family with a fallback. Pure. */
export function fontFaceCss(family: string): string {
  return `"${family.replace(/["\\]/g, '')}", system-ui, sans-serif`;
}

const fontPickerSpec = component({
  tag: 'sf-font-picker',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html``,
  description: 'Font picker: search combobox over a virtualised in-face list grouped Recent / In this design / All; hover preview.',
});

export class SfFontPickerElement extends SfElement<typeof fontPickerSpec> {
  static override readonly spec = fontPickerSpec;
  static override properties = {
    fonts: { attribute: false },
    recent: { attribute: false },
    inDesign: { attribute: false },
    value: {},
    query: { state: true },
    active: { state: true },
    scrollTop: { state: true },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        gap: ${t.space.sm.css};
        inline-size: 236px;
        block-size: 332px;
      }
      .filter {
        display: flex;
        align-items: center;
        min-block-size: ${t.size.control.css};
        padding-inline: ${t.space.sm.css};
        border-radius: ${t.radius.md.css};
        border: 1px solid ${t.color.controlEdge.css};
        background: ${t.color.surfaceSunken.css};
      }
      .filter:focus-within {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      input {
        all: unset;
        flex: 1;
        min-inline-size: 0;
      }
      .scroller {
        position: relative;
        overflow: auto;
      }
      .rows {
        position: relative;
      }
      .row {
        position: absolute;
        inset-inline: 0;
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        block-size: ${FONT_ROW_HEIGHT}px;
        padding-inline: ${t.space.sm.css};
        border-radius: ${t.radius.sm.css};
        box-sizing: border-box;
      }
      .heading {
        font-size: ${t.type.sizeXs.css};
        font-weight: ${t.font.weightSemibold.css};
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: ${t.color.textMuted.css};
      }
      [role='option'] {
        cursor: default;
        font-size: 15px;
      }
      [role='option'][data-active],
      [role='option']:hover {
        background: ${t.color.surfaceHover.css};
      }
      [role='option'][aria-selected='true'] {
        background: ${t.color.accentSubtle.css};
      }
      .name {
        flex: 1;
        min-inline-size: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tag {
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
        color: ${t.color.textMuted.css};
      }
      .muted {
        color: ${t.color.textSubtle.css};
      }
      .empty {
        padding: ${t.space.sm.css};
        color: ${t.color.textMuted.css};
      }
      @media (forced-colors: active) {
        [role='option'][data-active] {
          outline: 2px solid Highlight;
        }
      }
    `,
  ];

  declare fonts: readonly FontEntry[];
  declare recent: readonly string[];
  declare inDesign: readonly string[];
  /** The current family. */
  declare value: string;
  declare query: string;
  /** Index (in rows) of the active option. */
  declare active: number;
  declare scrollTop: number;
  private opening = '';
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listId = uniqueId('sf-fonts');

  constructor() {
    super();
    this.fonts = [];
    this.recent = [];
    this.inDesign = [];
    this.value = '';
    this.query = '';
    this.active = -1;
    this.scrollTop = 0;
    new ConnectedListeners(this, (signal) => {
      this.closest('sf-popover')?.addEventListener(
        'sf-toggle',
        (event) => {
          const detail = (event as CustomEvent<{ open: boolean; cause?: string }>).detail;
          if (detail.open) this.opening = this.value;
          else if (detail.cause === 'escape') this.restore();
        },
        { signal },
      );
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.opening = this.value;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.hoverTimer);
  }

  get rows(): FontRow[] {
    return fontRows(this.fonts, this.recent, this.inDesign, this.query);
  }

  /** Back to the opening family (Escape). */
  restore(): void {
    clearTimeout(this.hoverTimer);
    emit(this, 'sf-preview', { family: this.opening });
    emit(this, 'sf-restore', {});
  }

  commitFont(family: string): void {
    clearTimeout(this.hoverTimer);
    this.value = family;
    this.opening = family;
    emit(this, 'sf-change', { family });
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('query')) this.active = this.rows.findIndex((r) => r.kind === 'font');
  }

  private optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  private move(delta: number): void {
    const rows = this.rows;
    let next = this.active;
    do next += delta;
    while (next >= 0 && next < rows.length && rows[next]?.kind !== 'font');
    if (next < 0 || next >= rows.length) return;
    this.active = next;
    const scroller = this.renderRoot.querySelector<HTMLElement>('.scroller');
    if (scroller === null) return;
    const top = next * FONT_ROW_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + FONT_ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + FONT_ROW_HEIGHT - scroller.clientHeight;
    this.scrollTop = scroller.scrollTop;
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(event.key === 'ArrowDown' ? 1 : -1);
      const row = this.rows[this.active];
      if (row?.kind === 'font') emit(this, 'sf-preview', { family: row.font.family });
    } else if (event.key === 'Enter') {
      const row = this.rows[this.active];
      if (row?.kind === 'font') {
        event.preventDefault();
        this.commitFont(row.font.family);
      }
    }
  }

  private hover(family: string): void {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => emit(this, 'sf-preview', { family }), FONT_PREVIEW_MS);
  }

  override render(): TemplateResult {
    const i18n = this.deps.i18n;
    const rows = this.rows;
    const fontCount = rows.filter((r) => r.kind === 'font').length;
    const viewport = 296;
    const { start, end } = fontWindow(rows.length, this.scrollTop, viewport);
    const headingText = { recent: kitText(i18n, kitMessages.fontsRecent), design: kitText(i18n, kitMessages.fontsInDesign), all: kitText(i18n, kitMessages.fontsAll) };
    let position = rows.slice(0, start).filter((r) => r.kind === 'font').length;
    const visible = rows.slice(start, end).map((row, offset) => {
      const index = start + offset;
      const top = `top:${index * FONT_ROW_HEIGHT}px`;
      if (row.kind === 'heading') return html`<div class="row heading" style=${top} aria-hidden="true">${headingText[row.label]}</div>`;
      position += 1;
      const { font } = row;
      const label = `${font.family}${font.token === undefined ? '' : `, @${font.token}`}${font.cached ? '' : `, ${kitText(i18n, kitMessages.notDownloaded)}`}`;
      return html`<div
        role="option"
        class="row"
        id=${this.optionId(index)}
        style=${top}
        aria-label=${label}
        aria-selected=${font.family === this.value ? 'true' : 'false'}
        aria-setsize=${fontCount}
        aria-posinset=${position}
        ?data-active=${index === this.active}
        @pointerenter=${() => this.hover(font.family)}
        @click=${() => this.commitFont(font.family)}
      >
        <span class="name" style=${`font-family:${fontFaceCss(font.family)}`} aria-hidden="true">${font.family}</span>
        ${font.token === undefined ? nothing : html`<span class="tag" aria-hidden="true">@${font.token}</span>`}
        ${font.cached ? nothing : html`<sf-icon class="muted" .icon=${downloadIcon}></sf-icon>`}
      </div>`;
    });
    return html`<div class="filter">
        <input
          role="combobox"
          aria-label=${kitText(i18n, kitMessages.searchFonts)}
          placeholder=${kitText(i18n, kitMessages.searchFonts)}
          aria-expanded="true"
          aria-controls=${this.listId}
          aria-autocomplete="list"
          aria-activedescendant=${this.active >= start && this.active < end && rows[this.active]?.kind === 'font' ? this.optionId(this.active) : nothing}
          .value=${this.query}
          @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => this.onKey(e)}
        />
      </div>
      <div class="scroller" @scroll=${(e: Event) => (this.scrollTop = (e.target as HTMLElement).scrollTop)} @pointerleave=${() => this.hover(this.opening)}>
        <div class="rows" id=${this.listId} role="listbox" aria-label=${kitText(i18n, kitMessages.searchFonts)} style=${`block-size:${rows.length * FONT_ROW_HEIGHT}px`}>${visible}</div>
        ${fontCount === 0 ? html`<div class="empty" role="status">${kitText(i18n, kitMessages.noFonts)}</div>` : nothing}
      </div>`;
  }
}

export function defineFontPicker(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  if (registry.get(fontPickerSpec.tag) === undefined) defineComponent(SfFontPickerElement, registry);
}
