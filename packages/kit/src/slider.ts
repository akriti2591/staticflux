/**
 * `<sf-slider label="Opacity" min="0" max="100" unit="%">` — a labelled native range
 * input (native slider semantics, keyboard and pointer handling for free): a thin
 * `neutral7` track, the filled part and the thumb ring in the accent, a `surface3` thumb,
 * and the value in a mono pill next to the label (`value` slot to replace it; inline with
 * the track when `label-hidden`). `aria-valuetext` carries the formatted value (`format`
 * or `value + unit`); the visible value is decorative. Fires `sf-input` while dragging and
 * `sf-change` on commit, both with `{ value: number }`. Forced colors use the native look.
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

/** Filled share of the track in percent (0–100, rounded to 0.1) for `value` in `min…max` (pure). */
export function sliderFill(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  const share = (Math.min(Math.max(value, min), max) - min) / (max - min);
  return Math.round(share * 1000) / 10;
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
        gap: ${t.space.xs.css} ${t.space.sm.css};
        min-inline-size: 120px;
      }
      .label {
        font-size: ${t.type.sizeSm.css};
        font-weight: ${t.font.weightMedium.css};
        color: ${t.color.textMuted.css};
      }
      .value {
        grid-area: 1 / 2;
        min-inline-size: 4ch;
        padding: 2px ${t.space.sm.css};
        border-radius: ${t.radius.full.css};
        background: ${t.color.neutral3.css};
        color: ${t.color.text.css};
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeSm.css};
        font-variant-numeric: tabular-nums;
        text-align: center;
      }
      input {
        grid-column: 1 / -1;
        -webkit-appearance: none;
        appearance: none;
        inline-size: 100%;
        margin: 0;
        min-block-size: ${t.size.controlSm.css};
        background: transparent;
        cursor: pointer;
      }
      input.inline {
        grid-area: 1 / 1;
      }
      input::-webkit-slider-runnable-track {
        block-size: 4px;
        border-radius: 2px;
        background:
          linear-gradient(var(--kit-fill-color), var(--kit-fill-color)) 0 0 / var(--kit-fill) 100% no-repeat,
          ${t.color.neutral7.css};
      }
      input:dir(rtl)::-webkit-slider-runnable-track {
        background-position: 100% 0;
      }
      input::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        box-sizing: border-box;
        inline-size: 18px;
        block-size: 18px;
        margin-block-start: -7px;
        border-radius: 50%;
        background: ${t.color.surface3.css};
        border: 2px solid var(--kit-fill-color);
        box-shadow: ${t.shadow.level1.css};
      }
      input::-moz-range-track {
        block-size: 4px;
        border-radius: 2px;
        background: ${t.color.neutral7.css};
      }
      input::-moz-range-progress {
        block-size: 4px;
        border-radius: 2px;
        background: var(--kit-fill-color);
      }
      input::-moz-range-thumb {
        box-sizing: border-box;
        inline-size: 18px;
        block-size: 18px;
        border-radius: 50%;
        background: ${t.color.surface3.css};
        border: 2px solid var(--kit-fill-color);
      }
      input {
        --kit-fill-color: ${t.color.accent.css};
      }
      input:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
        border-radius: ${t.radius.sm.css};
      }
      input:disabled {
        cursor: not-allowed;
        --kit-fill-color: ${t.color.textDisabled.css};
      }
      @media (forced-colors: active) {
        input {
          -webkit-appearance: auto;
          appearance: auto;
        }
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

  /** How much of the track is filled, 0–100 (pure view of `value` in `min…max`). */
  get fillPercent(): number {
    return sliderFill(this.value, this.min, this.max);
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
        class=${this.labelHidden ? 'inline' : ''}
        style=${`--kit-fill:${this.fillPercent}%`}
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
      />${this.showValue ? html`<span class="value" part="value" aria-hidden="true"><slot name="value">${this.valueText}</slot></span>` : nothing}`;
  }
}

export function defineSlider(registry: CustomElementRegistry = customElements): void {
  if (registry.get(sliderSpec.tag) === undefined) defineComponent(SfSliderElement, registry);
}
