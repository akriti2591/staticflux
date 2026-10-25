/**
 * `<sf-disclosure heading="Shadow" summary="Multiply 50 %" key="inspector/effects">` — the disclosure blocks of
 * DENSITY-DISCLOSURE §2 (APG disclosure):
 *
 * - `variant="section"` (default) — **Section ▸**: a heading button with a chevron (`aria-expanded`); collapsed it
 *   shows a one-line mono **summary** of the non-default state, so hidden never means unknown;
 * - `variant="more"` — the **`More ▾` row** at the end of a section: a ghost row that expands the rest of the section
 *   in place (never a popover), with a mist count tag when hidden fields are non-default (`More ▾ · 2`);
 * - `pinned` — always open with no toggle (the Pro density shows everything; the app sets it per mode).
 *
 * Fires `sf-toggle` `{ open, key }`; the app persists the state per device under `key` and passes it back as `open`
 * (DENSITY-DISCLOSURE §7.1). Disclosure folds; it never removes (gating does that).
 */
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { defineIconElement } from './icon.js';
import { chevronDownIcon } from './icons/chevron-down.js';
import { chevronRightIcon } from './icons/chevron-right.js';
import { emit } from './internal/events.js';
import { uniqueId } from './internal/ids.js';
import { baseStyles, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

export interface DisclosureToggleDetail {
  readonly open: boolean;
  readonly key: string;
}

const disclosureSpec = component({
  tag: 'sf-disclosure',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html`<slot></slot>`,
  description: 'Disclosure: a collapsible section with a summary line, or a More row with a count; pinned open in Pro.',
});

export class SfDisclosureElement extends SfElement<typeof disclosureSpec> {
  static override readonly spec = disclosureSpec;
  static override properties = {
    heading: {},
    summary: {},
    open: { type: Boolean, reflect: true },
    pinned: { type: Boolean, reflect: true },
    variant: { reflect: true },
    count: { type: Number },
    key: {},
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }
      button {
        all: unset;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: ${t.space.xs.css};
        inline-size: 100%;
        min-block-size: ${t.size.row.css};
        padding-inline: ${t.space.xs.css};
        border-radius: ${t.radius.sm.css};
        cursor: default;
      }
      button:hover {
        background: ${t.color.surfaceHover.css};
      }
      button:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .heading {
        font-size: ${t.type.sizeXs.css};
        font-weight: ${t.font.weightSemibold.css};
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      :host([variant='more']) .heading {
        font-size: ${t.type.sizeSm.css};
        font-weight: ${t.font.weightMedium.css};
        text-transform: none;
        letter-spacing: 0;
        color: ${t.color.textMuted.css};
      }
      .summary {
        flex: 1;
        min-inline-size: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
        color: ${t.color.textMuted.css};
        text-align: end;
      }
      .count {
        padding-inline: 6px;
        border-radius: ${t.radius.full.css};
        background: ${t.color.neutral3.css};
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
      }
      .pinned-heading {
        display: block;
        min-block-size: ${t.size.row.css};
        line-height: ${t.size.row.css};
        padding-inline: ${t.space.xs.css};
      }
      .body[hidden] {
        display: none;
      }
    `,
  ];

  declare heading: string;
  /** One line in mono describing the non-default state while collapsed (`Multiply 50 %`). */
  declare summary: string;
  declare open: boolean;
  declare pinned: boolean;
  declare variant: 'section' | 'more';
  /** `More` rows: hidden fields with non-default values. */
  declare count: number;
  /** Persistence key the app stores the state under. */
  declare key: string;
  private readonly bodyId = uniqueId('sf-disclosure');

  constructor() {
    super();
    this.heading = '';
    this.summary = '';
    this.open = false;
    this.pinned = false;
    this.variant = 'section';
    this.count = 0;
    this.key = '';
  }

  toggle(): void {
    if (this.pinned) return;
    this.open = !this.open;
    emit<DisclosureToggleDetail>(this, 'sf-toggle', { open: this.open, key: this.key });
  }

  get expanded(): boolean {
    return this.pinned || this.open;
  }

  override render(): TemplateResult {
    const heading = this.heading === '' && this.variant === 'more' ? kitText(this.deps.i18n, kitMessages.more) : this.heading;
    if (this.pinned) {
      // Pro: everything open. A `More` row has nothing to say then; a section keeps its heading.
      return html`${this.variant === 'more' ? nothing : html`<span class="pinned-heading heading" role="heading" aria-level="3">${heading}</span>`}
        <div class="body" id=${this.bodyId}><slot></slot></div>`;
    }
    const chevron = this.variant === 'more' ? chevronDownIcon : this.open ? chevronDownIcon : chevronRightIcon;
    const trailing =
      this.variant === 'more'
        ? this.count > 0 && !this.open
          ? html`<span class="count">${this.count}</span>`
          : nothing
        : !this.open && this.summary !== ''
          ? html`<span class="summary">${this.summary}</span>`
          : nothing;
    return html`<button type="button" aria-expanded=${this.open ? 'true' : 'false'} aria-controls=${this.bodyId} @click=${() => this.toggle()}>
        ${this.variant === 'more' ? nothing : html`<sf-icon .icon=${chevron}></sf-icon>`}<span class="heading">${heading}</span>${this.variant === 'more'
          ? html`<sf-icon .icon=${chevron}></sf-icon>`
          : nothing}${trailing}
      </button>
      <div class="body" id=${this.bodyId} ?hidden=${!this.open}><slot></slot></div>`;
  }
}

export function defineDisclosure(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  if (registry.get(disclosureSpec.tag) === undefined) defineComponent(SfDisclosureElement, registry);
}
