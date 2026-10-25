/**
 * `<sf-slider label="Opacity" min="0" max="100" unit="%">` — a labelled native range
 * input (native slider semantics, keyboard and pointer handling for free), themed with
 * the accent. `aria-valuetext` carries the formatted value (`format` or `value + unit`);
 * the visible value is decorative. Fires `sf-input` while dragging and `sf-change` on
 * commit, both with `{ value: number }`.
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { live } from 'lit/directives/live.js';
import { emit } from './internal/events.js';
import { baseStyles, t, srOnly } from './internal/styles.js';

const sliderSpec = component({
  tag: 'sf-slider',
  placeholder: () => nothing,
  description: 'Labelled range slider (native input[type=range]) with formatted value text.',
});

let sliderCounter = 0;

/** Clamp and snap a value to `step` from `min` (pure). */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const clamped = Math.min(Math.max(value, min), max);
  if (!(step > 0)) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number(Math.min(snapped, max).toFixed(decimals));
}

export class SfSliderElement extends SfElement<typeof sliderSpec> {
  static override readonly spec = sliderSpec;
  static override shadowRootOptions: ShadowRootInit = { ...LitElement.shadowRootOptions, delegatesFocus: true };
  static override properties = {
    label: {},
    labelHidden: { type: Boolean, attribute: 'label-hidden' },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    value: { type: Number },
    unit: {},
    format: { attribute: false },
    disabled: { type: Boolean, reflect: true },
    showValue: { type: Boolean, attribute: 'show-value' },
  };
  static override styles = [
    baseStyles,
    srOnly,
    css`
      :host {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        column-gap: ${t.space.sm.css};
        min-inline-size: 120px;
      }
      .label {
        grid-column: 1 / -1;
        font-size: ${t.type.sizeSm.css};
        font-weight: ${t.font.weightMedium.css};
        color: ${t.color.textMuted.css};
      }
      input {
        inline-size: 100%;
        margin: 0;
        min-block-size: ${t.size.controlSm.css};
        accent-color: ${t.color.accent.css};
        background: transparent;
        cursor: pointer;
      }
      input:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
        border-radius: ${t.radius.sm.css};
      }
      input:disabled {
        cursor: not-allowed;
        accent-color: ${t.color.textDisabled.css};
      }
      .value {
        min-inline-size: 4ch;
        text-align: end;
        font-variant-numeric: tabular-nums;
        color: ${t.color.textMuted.css};
      }
    `,
  ];

  declare label: string;
  declare labelHidden: boolean;
  declare min: number;
  declare max: number;
  declare step: number;
  declare value: number;
  declare unit: string;
  /** Formats the value for display and `aria-valuetext`. */
  declare format: ((value: number) => string) | undefined;
  declare disabled: boolean;
  declare showValue: boolean;
  private readonly controlId: string;

  constructor() {
    super();
    sliderCounter += 1;
    this.controlId = `s${sliderCounter}`;
    this.label = '';
    this.labelHidden = false;
    this.min = 0;
    this.max = 100;
    this.step = 1;
    this.value = 0;
    this.unit = '';
    this.format = undefined;
    this.disabled = false;
    this.showValue = true;
  }

  /** The value as text (`format`, else value + unit). */
  get valueText(): string {
    return this.format?.(this.value) ?? `${this.value}${this.unit}`;
  }

  private read(event: Event): number {
    return snapToStep(Number((event.target as HTMLInputElement).value), this.min, this.max, this.step);
  }

  override render(): TemplateResult {
    return html`<label class="label ${this.labelHidden ? 'sr-only' : ''}" for=${this.controlId}>${this.label}</label>
      <input
        id=${this.controlId}
        type="range"
        part="input"
        min=${this.min}
        max=${this.max}
        step=${this.step}
        aria-valuetext=${this.valueText}
        ?disabled=${this.disabled}
        .value=${live(String(this.value))}
        @input=${(e: Event) => {
          this.value = this.read(e);
          emit(this, 'sf-input', { value: this.value });
        }}
        @change=${(e: Event) => {
          this.value = this.read(e);
          emit(this, 'sf-change', { value: this.value });
        }}
      />${this.showValue ? html`<span class="value" aria-hidden="true">${this.valueText}</span>` : nothing}`;
  }
}

export function defineSlider(registry: CustomElementRegistry = customElements): void {
  if (registry.get(sliderSpec.tag) === undefined) defineComponent(SfSliderElement, registry);
}
