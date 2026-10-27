/**
 * `<sf-size-field>` — the size field pair (R13.48): `W` and `H` number fields in a unit, a **keep proportions** lock, an
 * **orientation** switch (portrait · landscape: swaps W and H) and a **Units** choice (`px · mm · in · pt`, converted at
 * 96 px per inch), plus a `presets` slot for a presets menu. The value is always in pixels (`width`, `height`); the unit
 * only changes how it is shown and typed. A side outside `min`…`max` px stays in its field with an inline error
 * (SF-KIT-005) and fires nothing; a valid edit fires `sf-change` `{ width, height, unit }`, and `sf-submit` on Enter.
 *
 * A11y: the pair is a `group` named by `label`; each field has its own name (`Width in pixels`); the orientation
 * switch is a radio group; the lock is a toggle button.
 *
 * ```html
 * <sf-size-field label="Size" .width=${1080} .height=${1350} unit="px"><sf-menu slot="presets">…</sf-menu></sf-size-field>
 * ```
 */
import { err, ok, type Result } from '@staticflux/core';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { SizeOutOfRangeError } from './errors.js';
import { emit } from './internal/events.js';
import { baseStyles, focusRing, t } from './internal/styles.js';
import { defineIconElement } from './icon.js';
import { defineIconButton } from './icon-button.js';
import { lockIcon } from './icons/lock.js';
import { lockOpenIcon } from './icons/lock-open.js';
import { defineNumberField, type NumberChangeDetail } from './number-field.js';
import { defineSegmented } from './segmented.js';

/** Pixels per unit (CSS: 96 px per inch). */
export const SIZE_UNITS = Object.freeze({ px: 1, mm: 96 / 25.4, in: 96, pt: 96 / 72 });
export type SizeUnit = keyof typeof SIZE_UNITS;
export const SIZE_UNIT_IDS = Object.keys(SIZE_UNITS) as readonly SizeUnit[];
export const SIZE_UNIT_NAMES: Readonly<Record<SizeUnit, string>> = Object.freeze({ px: 'pixels', mm: 'millimetres', in: 'inches', pt: 'points' });

/** Pixels shown in `unit`: whole pixels, one decimal for mm / in / pt. */
export function sizeInUnit(px: number, unit: SizeUnit): number {
  return unit === 'px' ? Math.round(px) : Math.round((px / SIZE_UNITS[unit]) * 10) / 10;
}

/** A value typed in `unit`, in whole pixels. */
export function sizeFromUnit(value: number, unit: SizeUnit): number {
  return Math.round(value * SIZE_UNITS[unit]);
}

export interface SizeLimits {
  readonly min: number;
  readonly max: number;
}

/** A side in px within the limits (SF-KIT-005 outside them). */
export function validateSide(px: number, limits: SizeLimits): Result<number> {
  if (!Number.isFinite(px) || px < limits.min || px > limits.max) return err(SizeOutOfRangeError({ details: { value: Number.isFinite(px) ? px : null, min: limits.min, max: limits.max } }));
  return ok(Math.round(px));
}

/** The other side when one changes with proportions kept. */
export function keepRatio(previous: { readonly width: number; readonly height: number }, side: 'width' | 'height', value: number): { readonly width: number; readonly height: number } {
  if (previous.width <= 0 || previous.height <= 0) return side === 'width' ? { width: value, height: previous.height } : { width: previous.width, height: value };
  return side === 'width' ? { width: value, height: Math.max(1, Math.round((value * previous.height) / previous.width)) } : { width: Math.max(1, Math.round((value * previous.width) / previous.height)), height: value };
}

/** `16384` → `16 384` (the spec's digit grouping). */
const groupDigits = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export type SizeOrientation = 'portrait' | 'landscape';

/** Portrait when taller than wide (a square reads as portrait). */
export function orientationOf(width: number, height: number): SizeOrientation {
  return width > height ? 'landscape' : 'portrait';
}

export interface SizeChangeDetail {
  readonly width: number;
  readonly height: number;
  readonly unit: SizeUnit;
}

const spec = component({
  tag: 'sf-size-field',
  placeholder: () => nothing,
  description: 'Size field pair: W and H in a unit, keep proportions, orientation and units, with a presets slot.',
});

export class SfSizeFieldElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    label: {},
    width: { type: Number },
    height: { type: Number },
    unit: { reflect: true },
    locked: { type: Boolean, reflect: true },
    min: { type: Number },
    max: { type: Number },
    disabled: { type: Boolean, reflect: true },
    problem: { state: true },
  };
  static override styles = [
    baseStyles,
    focusRing,
    css`
      :host {
        display: block;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: ${t.space.sm.css};
      }
      sf-number-field {
        inline-size: 7.5rem;
        font-family: ${t.font.familyMono.css};
      }
      select {
        block-size: ${t.size.control.css};
        padding-inline: ${t.space.sm.css};
        border: 1px solid ${t.color.controlEdge.css};
        border-radius: ${t.radius.control.css};
        background: ${t.color.surface1.css};
        color: ${t.color.text.css};
        font: inherit;
      }
      label.units {
        display: inline-flex;
        flex-direction: column;
        gap: 2px;
        font-size: ${t.type.sizeXs.css};
        color: ${t.color.textMuted.css};
      }
      .error {
        margin: ${t.space.xs.css} 0 0;
        color: ${t.color.dangerText.css};
        font-size: ${t.type.sizeSm.css};
      }
    `,
  ];

  declare label: string;
  declare width: number;
  declare height: number;
  declare unit: SizeUnit;
  declare locked: boolean;
  declare min: number;
  declare max: number;
  declare disabled: boolean;
  declare problem: string | undefined;

  constructor() {
    super();
    this.label = 'Size';
    this.width = 1080;
    this.height = 1080;
    this.unit = 'px';
    this.locked = false;
    this.min = 1;
    this.max = 16_384;
    this.disabled = false;
    this.problem = undefined;
  }

  private get limits(): SizeLimits {
    return { min: this.min, max: this.max };
  }

  private apply(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.problem = undefined;
    emit<SizeChangeDetail>(this, 'sf-change', { width, height, unit: this.unit });
  }

  private onSide(side: 'width' | 'height', e: CustomEvent<NumberChangeDetail>): void {
    e.stopPropagation();
    const typed = e.detail.value;
    if (typed === undefined) return;
    const px = sizeFromUnit(typed, this.unit);
    const valid = validateSide(px, this.limits);
    if (!valid.ok) {
      this.problem = px < this.min ? `At least ${groupDigits(this.min)} px` : `Too large for this device (max ${groupDigits(this.max)} px)`;
      return;
    }
    const next = this.locked ? keepRatio({ width: this.width, height: this.height }, side, valid.value) : { width: side === 'width' ? valid.value : this.width, height: side === 'height' ? valid.value : this.height };
    this.apply(Math.min(this.max, next.width), Math.min(this.max, next.height));
  }

  private onOrientation(e: CustomEvent<{ value: string }>): void {
    e.stopPropagation();
    if (e.detail.value !== orientationOf(this.width, this.height) && this.width !== this.height) this.apply(this.height, this.width);
  }

  private onUnit(e: Event): void {
    const unit = (e.target as HTMLSelectElement).value as SizeUnit;
    if (!(unit in SIZE_UNITS)) return;
    this.unit = unit;
    emit<SizeChangeDetail>(this, 'sf-change', { width: this.width, height: this.height, unit });
  }

  private field(side: 'width' | 'height', short: string): TemplateResult {
    const value = sizeInUnit(side === 'width' ? this.width : this.height, this.unit);
    const units = Object.fromEntries(SIZE_UNIT_IDS.map((u) => [u, SIZE_UNITS[u] / SIZE_UNITS[this.unit]]));
    return html`<sf-number-field
      data-side=${side}
      label=${short}
      unit=${this.unit}
      .units=${units}
      .value=${value}
      precision=${this.unit === 'px' ? 0 : 1}
      ?disabled=${this.disabled}
      @sf-input=${(e: Event) => e.stopPropagation()}
      @sf-change=${(e: CustomEvent<NumberChangeDetail>) => this.onSide(side, e)}
      @keydown=${(e: KeyboardEvent) => (e.key === 'Enter' && this.problem === undefined ? emit(this, 'sf-submit', {}) : undefined)}
    ></sf-number-field>`;
  }

  override render(): TemplateResult {
    const orientation = orientationOf(this.width, this.height);
    return html`<div role="group" aria-label=${this.label}>
      <div class="row">
        ${this.field('width', 'Width')} ${this.field('height', 'Height')}
        <sf-icon-button label="Keep proportions" .pressed=${this.locked} ?disabled=${this.disabled} @click=${() => (this.locked = !this.locked)}
          ><sf-icon .icon=${this.locked ? lockIcon : lockOpenIcon} size="16"></sf-icon
        ></sf-icon-button>
        <sf-segmented
          label="Orientation"
          size="sm"
          .options=${[
            { value: 'portrait', label: 'Portrait' },
            { value: 'landscape', label: 'Landscape' },
          ]}
          .value=${orientation}
          ?disabled=${this.disabled}
          @sf-change=${(e: CustomEvent<{ value: string }>) => this.onOrientation(e)}
        ></sf-segmented>
        <label class="units"
          >Units
          <select .value=${this.unit} ?disabled=${this.disabled} @change=${(e: Event) => this.onUnit(e)}>
            ${SIZE_UNIT_IDS.map((u) => html`<option value=${u} ?selected=${u === this.unit}>${u}</option>`)}
          </select></label
        >
        <slot name="presets"></slot>
      </div>
      ${this.problem === undefined ? nothing : html`<p class="error" role="alert">${this.problem}</p>`}
    </div>`;
  }
}

export function defineSizeField(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  defineIconButton(registry);
  defineNumberField(registry);
  defineSegmented(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(SfSizeFieldElement, registry);
}
