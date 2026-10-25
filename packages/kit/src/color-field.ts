/**
 * `<sf-color-field label="Fill" value="#3a5bd9">` — a hex text input plus the native
 * color picker (`input[type=color]`) as a swatch button. Typing accepts `#rgb`, `#rrggbb`
 * (with or without `#`, any case); the value is normalized to `#rrggbb` on commit, an
 * invalid entry shows an error (`aria-invalid`, message announced) and keeps the last valid
 * value. Fires `sf-input` (picker drag) and `sf-change` with `{ value: '#rrggbb' }`.
 */
import type { DepHandle } from '@staticflux/core';
import { I18nToken, type I18n } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { normalizeHex } from '@staticflux/ui/theme';
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { kitMessages, kitText } from './messages.js';
import { emit } from './internal/events.js';
import { fieldStyles } from './internal/field-styles.js';
import { baseStyles, controlStyles, t, srOnly } from './internal/styles.js';

const colorFieldSpec = component({
  tag: 'sf-color-field',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => nothing,
  description: 'Hex color input with a native color picker swatch; validates and normalizes to #rrggbb.',
});

let colorCounter = 0;

/** Six-digit hex for the native picker (it cannot show alpha). */
export function pickerValue(hex: string): string {
  return /^#[0-9a-f]{6}/i.test(hex) ? hex.slice(0, 7).toLowerCase() : '#000000';
}

export class SfColorFieldElement extends SfElement<typeof colorFieldSpec> {
  static override readonly spec = colorFieldSpec;
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true };
  static override properties = {
    label: {},
    labelHidden: { type: Boolean, attribute: 'label-hidden' },
    value: {},
    disabled: { type: Boolean, reflect: true },
    draft: { state: true },
    invalid: { type: Boolean, reflect: true },
  };
  static override styles = [
    baseStyles,
    srOnly,
    controlStyles,
    fieldStyles,
    css`
      .swatch {
        position: relative;
        flex: none;
        inline-size: calc(var(--kit-height) - 10px);
        block-size: calc(var(--kit-height) - 10px);
        border-radius: ${t.radius.sm.css};
        border: 1px solid ${t.color.borderStrong.css};
        overflow: hidden;
      }
      .swatch input {
        position: absolute;
        inset: -4px;
        inline-size: calc(100% + 8px);
        block-size: calc(100% + 8px);
        padding: 0;
        border: 0;
        cursor: pointer;
        opacity: 0;
      }
      .swatch:focus-within {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      .hex {
        font-family: ${t.font.familyMono.css};
        text-transform: lowercase;
      }
    `,
  ];

  declare label: string;
  declare labelHidden: boolean;
  /** Committed value, `#rrggbb`. */
  declare value: string;
  declare disabled: boolean;
  declare draft: string | undefined;
  declare invalid: boolean;
  private readonly ids: { readonly text: string; readonly error: string };

  constructor() {
    super();
    colorCounter += 1;
    this.ids = { text: `c${colorCounter}`, error: `ce${colorCounter}` };
    this.label = '';
    this.labelHidden = false;
    this.value = '#000000';
    this.disabled = false;
    this.draft = undefined;
    this.invalid = false;
  }

  private get i18n(): DepHandle<I18n> | undefined {
    return this.ready ? this.deps.i18n : undefined;
  }

  /** Commit typed text: normalize or flag invalid. */
  commitText(text: string): void {
    const normalized = normalizeHex(text);
    if (!normalized.ok) {
      this.invalid = true;
      return;
    }
    this.invalid = false;
    this.draft = undefined;
    if (normalized.value === this.value) return;
    this.value = normalized.value;
    emit(this, 'sf-change', { value: this.value });
  }

  override render(): TemplateResult {
    const label = this.label;
    const i18n = this.i18n;
    return html`<label class="label ${this.labelHidden ? 'sr-only' : ''}" for=${this.ids.text}>${label}</label>
      <div class="field control" part="field">
        <span class="swatch" style=${`background:${pickerValue(this.value)}`}>
          <input
            type="color"
            aria-label=${kitText(i18n, kitMessages.pickColor, { label })}
            ?disabled=${this.disabled}
            .value=${live(pickerValue(this.value))}
            @input=${(e: Event) => {
              this.value = (e.target as HTMLInputElement).value;
              this.invalid = false;
              this.draft = undefined;
              emit(this, 'sf-input', { value: this.value });
            }}
            @change=${() => emit(this, 'sf-change', { value: this.value })}
          />
        </span>
        <input
          id=${this.ids.text}
          class="hex"
          spellcheck="false"
          autocomplete="off"
          aria-describedby=${this.invalid ? this.ids.error : nothing}
          aria-invalid=${this.invalid ? 'true' : nothing}
          ?disabled=${this.disabled}
          .value=${live(this.draft ?? this.value)}
          @input=${(e: Event) => (this.draft = (e.target as HTMLInputElement).value)}
          @change=${(e: Event) => this.commitText((e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.commitText((e.target as HTMLInputElement).value)}
        />
      </div>
      ${this.invalid ? html`<div class="error" id=${this.ids.error} role="alert">${kitText(i18n, kitMessages.invalidColor)}</div>` : nothing}`;
  }
}

export function defineColorField(registry: CustomElementRegistry = customElements): void {
  if (registry.get(colorFieldSpec.tag) === undefined) defineComponent(SfColorFieldElement, registry);
}
