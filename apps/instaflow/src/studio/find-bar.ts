/**
 * `<if-find-bar>` — find and replace (B11c slice 3; STUDIO-UX-SPEC §9.1): a floating card under the top bar at the
 * canvas's top-right, non-modal (the canvas stays live). `Kind ▾` (Text · Font · Colour), the search field (focused),
 * the count (`3 of 12`, a polite live region), `↑ ↓` (Enter / Shift+Enter, `Mod+G` / `Mod+Shift+G` while the bar has
 * focus), `Aa` (text: match case), `Replace ▾` (a second row: the replacement — text, a font from the document's
 * fonts, or a colour — with `Replace` and `Replace all`), `Scope ▾` (All pages · This page · Selection) and `×`.
 * Escape closes it (the selection stays). Kind and Scope are remembered per device (`instaflow/ui/find`).
 *
 * The bar decides nothing about the document: it asks `port.find` (the `instaflow/find` capability), steps through
 * the matches with `port.reveal` (select it, show its page, zoom when it is off-screen) and replaces with
 * `port.replace` (`instaflow/replace`: one undo step, toasted by the host).
 */
import { defineButton } from '@staticflux/kit/button';
import { defineIconElement } from '@staticflux/kit/icon';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { chevronDownIcon } from '@staticflux/kit/icons/chevron-down';
import { chevronUpIcon } from '@staticflux/kit/icons/chevron-up';
import { xIcon } from '@staticflux/kit/icons/x';
import { defineMenu } from '@staticflux/kit/menu';
import { defineTextField, type SfTextFieldElement } from '@staticflux/kit/text-field';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import type { FindKind, FindMatch, FindQuery, FindResult, FindScope, ReplaceResult } from '../app/find-replace.js';
import type { FontChoice } from '../text/typography.js';

export const FIND_BAR_TAG = 'if-find-bar';
export const FIND_MEMORY_KEY = 'instaflow/ui/find';
/** How long the bar waits after typing before it searches. */
export const FIND_DEBOUNCE_MS = 150;

export const findBarMessages = Object.freeze({
  find: 'Find',
  kind: 'Find kind',
  kinds: { text: 'Text', font: 'Font', colour: 'Colour' } as Readonly<Record<FindKind, string>>,
  placeholder: { text: 'Find text', font: 'Font family', colour: '#ff5c39' } as Readonly<Record<FindKind, string>>,
  scope: 'Scope',
  scopes: { all: 'All pages', page: 'This page', selection: 'Selection' } as Readonly<Record<FindScope, string>>,
  count: (at: number, of: number) => (of === 0 ? '0' : `${at} of ${of}`),
  previous: 'Previous match',
  next: 'Next match',
  matchCase: 'Match case',
  replaceToggle: 'Replace',
  replaceWith: 'Replace with',
  pickFont: 'Choose a font',
  replace: 'Replace',
  replaceAll: 'Replace all',
  close: 'Close find',
  empty: (q: string, pages: number) => `No matches for '${q}' in ${pages === 1 ? '1 page' : `${pages} pages`}`,
  announce: (at: number, of: number, m: FindMatch) => `Match ${at} of ${of}: ${m.label} on ${m.pageName}`,
  skipped: (n: number) => `${n} locked, skipped`,
});
const m = findBarMessages;

/** What the bar runs (the chrome port implements it over the capabilities). */
export interface FindBarPort {
  find(query: FindQuery): Promise<FindResult | undefined>;
  replace(query: FindQuery, replacement: string, options: { readonly font?: FontChoice['value']; readonly only?: readonly string[] }): Promise<ReplaceResult | undefined>;
  reveal(match: FindMatch): void;
}

interface FindMemory {
  readonly kind: FindKind;
  readonly scope: FindScope;
}

const KINDS: readonly FindKind[] = ['text', 'font', 'colour'];
const SCOPES: readonly FindScope[] = ['all', 'page', 'selection'];

/** This device's Kind and Scope (tolerant). */
export function readFindMemory(storage: Pick<Storage, 'getItem'> | undefined): FindMemory {
  try {
    const raw = JSON.parse(storage?.getItem(FIND_MEMORY_KEY) ?? '{}') as Partial<Record<keyof FindMemory, unknown>>;
    return { kind: KINDS.includes(raw.kind as FindKind) ? (raw.kind as FindKind) : 'text', scope: SCOPES.includes(raw.scope as FindScope) ? (raw.scope as FindScope) : 'all' };
  } catch {
    return { kind: 'text', scope: 'all' };
  }
}

function writeFindMemory(storage: Pick<Storage, 'setItem'> | undefined, memory: FindMemory): void {
  try {
    storage?.setItem(FIND_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // A convenience only.
  }
}

const spec = component({ tag: FIND_BAR_TAG, placeholder: () => nothing, description: 'Studio find and replace: text, fonts and colours across pages (B11c, STUDIO §9.1).' });

export class IfFindBarElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    port: { attribute: false },
    fonts: { attribute: false },
    selection: { attribute: false },
    storage: { attribute: false },
    kind: { state: true },
    scope: { state: true },
    query: { state: true },
    matchCase: { state: true },
    replacing: { type: Boolean, reflect: true },
    replacement: { state: true },
    font: { state: true },
    result: { state: true },
    current: { state: true },
    note: { state: true },
  };
  static override styles = css`
    :host {
      display: block;
      inline-size: 420px;
      max-inline-size: calc(100% - 32px);
      padding: ${t.space.sm.css};
      background: ${t.color.surface2.css};
      border: 1px solid ${t.color.border.css};
      border-radius: ${t.radius.lg.css};
      box-shadow: ${t.shadow.level2.css};
      color: ${t.color.text.css};
      font-family: ${t.font.family.css};
      font-size: ${t.type.sizeSm.css};
    }
    .row {
      display: flex;
      align-items: center;
      gap: ${t.space.xs.css};
    }
    .row + .row {
      margin-block-start: ${t.space.xs.css};
    }
    .grow {
      flex: 1;
      min-inline-size: 0;
    }
    .count {
      font-family: ${t.font.familyMono.css};
      font-size: 12px;
      color: ${t.color.textMuted.css};
      min-inline-size: 52px;
      text-align: end;
      white-space: nowrap;
    }
    .note {
      margin: ${t.space.xs.css} 0 0;
      color: ${t.color.textMuted.css};
    }
    .note:empty {
      display: none;
    }
    .aa {
      font-weight: ${t.font.weightSemibold.css};
      font-size: 12px;
    }
    .swatch {
      inline-size: 16px;
      block-size: 16px;
      border-radius: 4px;
      border: 1px solid ${t.color.border.css};
      flex: none;
    }
  `;

  declare port: FindBarPort | undefined;
  declare fonts: readonly FontChoice[];
  /** The canvas selection (scope `Selection`). */
  declare selection: readonly string[];
  declare storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  declare kind: FindKind;
  declare scope: FindScope;
  declare query: string;
  declare matchCase: boolean;
  declare replacing: boolean;
  declare replacement: string;
  declare font: FontChoice | undefined;
  declare result: FindResult | undefined;
  /** Index of the current match (−1: none yet). */
  declare current: number;
  declare note: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private searches = 0;

  constructor() {
    super();
    this.port = undefined;
    this.fonts = [];
    this.selection = [];
    this.storage = (globalThis as { localStorage?: Storage }).localStorage;
    const memory = readFindMemory(this.storage);
    this.kind = memory.kind;
    this.scope = memory.scope;
    this.query = '';
    this.matchCase = false;
    this.replacing = false;
    this.replacement = '';
    this.font = undefined;
    this.result = undefined;
    this.current = -1;
    this.note = '';
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }

  /** Focus the search field (and select its text): `Mod+F` again. */
  async focusField(): Promise<void> {
    await this.updateComplete;
    const field = this.renderRoot.querySelector<SfTextFieldElement>('sf-text-field.query');
    field?.focus();
    field?.select();
  }

  /** The query the bar would run now. */
  queryNow(): FindQuery {
    return { kind: this.kind, query: this.query, scope: this.scope, ...(this.kind === 'text' && this.matchCase ? { matchCase: true } : {}), ...(this.scope === 'selection' ? { nodes: [...this.selection] } : {}) };
  }

  /** Search now (tests; typing searches after `FIND_DEBOUNCE_MS`). */
  async search(): Promise<void> {
    clearTimeout(this.timer);
    const q = this.queryNow();
    if (q.query.trim() === '' || this.port === undefined) {
      this.result = undefined;
      this.current = -1;
      return;
    }
    const ticket = (this.searches += 1);
    const found = await this.port.find(q);
    if (ticket !== this.searches) return; // a newer search started
    this.result = found;
    this.current = -1;
    this.note = found !== undefined && found.matches.length === 0 ? m.empty(q.query, found.pages) : '';
  }

  /** Go to the next (`+1`) or previous (`−1`) match: it is selected and shown. */
  step(delta: 1 | -1): void {
    const list = this.result?.matches ?? [];
    if (list.length === 0) return;
    this.current = this.current < 0 ? (delta > 0 ? 0 : list.length - 1) : (this.current + delta + list.length) % list.length;
    const match = list[this.current] as FindMatch;
    this.note = '';
    this.port?.reveal(match);
    this.announce(m.announce(this.current + 1, list.length, match));
  }

  /** Replace the current match (`only`) or all of them, then search again. */
  async replace(all: boolean): Promise<void> {
    const list = this.result?.matches ?? [];
    const target = list[this.current] ?? list[0];
    if (this.port === undefined || target === undefined) return;
    const replacement = this.kind === 'font' ? (this.font?.label ?? '') : this.replacement;
    const done = await this.port.replace(this.queryNow(), replacement, { ...(this.kind === 'font' && this.font !== undefined ? { font: this.font.value } : {}), ...(all ? {} : { only: [target.id] }) });
    const at = this.current;
    await this.search();
    if (!all && (this.result?.matches.length ?? 0) > 0) {
      this.current = Math.max(-1, Math.min(at, (this.result?.matches.length ?? 0)) - 1);
      this.step(1);
    }
    if (done !== undefined && done.skipped > 0) this.note = m.skipped(done.skipped);
    // Nothing left to replace disables the buttons: keep the focus in the bar (Escape, typing) instead of losing it.
    if ((this.result?.matches.length ?? 0) === 0) await this.focusField();
  }

  private announce(text: string): void {
    this.dispatchEvent(new CustomEvent('if-announce', { detail: { message: text }, bubbles: true, composed: true }));
  }

  private remember(): void {
    writeFindMemory(this.storage, { kind: this.kind, scope: this.scope });
  }

  private later(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.search(), FIND_DEBOUNCE_MS);
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('if-find-close', { bubbles: true, composed: true }));
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if ((e.key === 'Enter' && !mod && e.composedPath()[0] instanceof HTMLInputElement && (e.composedPath() as Element[]).some((t) => t instanceof HTMLElement && t.classList.contains('query'))) || (mod && e.key.toLowerCase() === 'g')) {
      e.preventDefault();
      e.stopPropagation();
      this.step(e.shiftKey ? -1 : 1);
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') {
      // `Mod+F` with the bar open: back to the field (the browser's find stays closed).
      e.preventDefault();
      e.stopPropagation();
      void this.focusField();
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('kind') || changed.has('scope') || changed.has('matchCase')) {
      if (changed.get('kind') !== undefined || changed.get('scope') !== undefined || changed.get('matchCase') !== undefined) void this.search();
    }
  }

  override render(): TemplateResult {
    const list = this.result?.matches ?? [];
    const count = this.query.trim() === '' ? '' : m.count(this.current + 1, list.length);
    const swatch = this.kind === 'colour' && /^#?[0-9a-f]{3,8}$/i.test(this.query.trim()) ? (this.query.trim().startsWith('#') ? this.query.trim() : `#${this.query.trim()}`) : undefined;
    return html`<div role="search" aria-label=${m.find} @keydown=${(e: KeyboardEvent) => this.onKey(e)}>
      <div class="row">
        <sf-menu
          class="kind"
          label=${m.kind}
          @sf-select=${(e: CustomEvent<{ value: FindKind }>) => {
            this.kind = e.detail.value;
            this.remember();
          }}
        >
          <sf-button slot="trigger" size="sm" variant="ghost">${m.kinds[this.kind]} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
          ${KINDS.map((k) => html`<sf-menu-item type="radio" value=${k} ?checked=${k === this.kind}>${m.kinds[k]}</sf-menu-item>`)}
        </sf-menu>
        ${swatch === undefined ? nothing : html`<span class="swatch" aria-hidden="true" style=${`background:${swatch}`}></span>`}
        <sf-text-field
          class="query grow"
          size="sm"
          label=${m.find}
          label-hidden
          placeholder=${m.placeholder[this.kind]}
          .value=${this.query}
          @input=${(e: Event) => {
            this.query = (e.composedPath()[0] as HTMLInputElement).value ?? '';
            this.later();
          }}
        ></sf-text-field>
        <span class="count" role="status" aria-live="polite">${count}</span>
        <sf-icon-button size="sm" variant="ghost" class="previous" label=${m.previous} shortcut="Shift+Enter" ?disabled=${list.length === 0} @click=${() => this.step(-1)}
          ><sf-icon .icon=${chevronUpIcon} size="16"></sf-icon
        ></sf-icon-button>
        <sf-icon-button size="sm" variant="ghost" class="next" label=${m.next} shortcut="Enter" ?disabled=${list.length === 0} @click=${() => this.step(1)}
          ><sf-icon .icon=${chevronDownIcon} size="16"></sf-icon
        ></sf-icon-button>
        <sf-icon-button size="sm" variant="ghost" class="close" label=${m.close} shortcut="Escape" @click=${() => this.close()}><sf-icon .icon=${xIcon} size="16"></sf-icon></sf-icon-button>
      </div>
      <div class="row">
        ${this.kind === 'text'
          ? html`<sf-icon-button class="match-case" size="sm" variant="ghost" label=${m.matchCase} .pressed=${this.matchCase} @click=${() => (this.matchCase = !this.matchCase)}
              ><span class="aa" aria-hidden="true">Aa</span></sf-icon-button
            >`
          : nothing}
        <sf-button class="replace-toggle" size="sm" variant="ghost" aria-expanded=${String(this.replacing)} @click=${() => (this.replacing = !this.replacing)}
          >${m.replaceToggle} <sf-icon .icon=${this.replacing ? chevronUpIcon : chevronDownIcon} size="14"></sf-icon
        ></sf-button>
        <span class="grow"></span>
        <sf-menu
          class="scope"
          label=${m.scope}
          @sf-select=${(e: CustomEvent<{ value: FindScope }>) => {
            this.scope = e.detail.value;
            this.remember();
          }}
        >
          <sf-button slot="trigger" size="sm" variant="ghost">${m.scopes[this.scope]} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
          ${SCOPES.map((sc) => html`<sf-menu-item type="radio" value=${sc} ?checked=${sc === this.scope}>${m.scopes[sc]}</sf-menu-item>`)}
        </sf-menu>
      </div>
      ${this.replacing ? this.renderReplace(list.length > 0) : nothing}
      <p class="note" role="status">${this.note}</p>
    </div>`;
  }

  private renderReplace(any: boolean): TemplateResult {
    const field =
      this.kind === 'font'
        ? html`<sf-menu class="font-menu grow" label=${m.pickFont} @sf-select=${(e: CustomEvent<{ value: string }>) => (this.font = this.fonts[Number(e.detail.value)])}>
            <sf-button slot="trigger" size="sm">${this.font?.label ?? m.pickFont} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
            ${this.fonts.map((f, i) => html`<sf-menu-item type="radio" value=${String(i)} ?checked=${f === this.font}>${f.label}</sf-menu-item>`)}
          </sf-menu>`
        : html`<sf-text-field
            class="replacement grow"
            size="sm"
            label=${m.replaceWith}
            label-hidden
            placeholder=${m.replaceWith}
            .value=${this.replacement}
            @input=${(e: Event) => (this.replacement = (e.composedPath()[0] as HTMLInputElement).value ?? '')}
          ></sf-text-field>`;
    const ready = any && (this.kind !== 'font' || this.font !== undefined);
    return html`<div class="row">
      ${field}
      <sf-button class="replace-one" size="sm" ?disabled=${!ready} @click=${() => void this.replace(false)}>${m.replace}</sf-button>
      <sf-button class="replace-all" size="sm" variant="primary" ?disabled=${!ready} @click=${() => void this.replace(true)}>${m.replaceAll}</sf-button>
    </div>`;
  }
}

export function defineFindBar(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconElement(registry);
  defineIconButton(registry);
  defineMenu(registry);
  defineTextField(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfFindBarElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-find-bar': IfFindBarElement;
  }
}
