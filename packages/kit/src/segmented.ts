/**
 * `<sf-segmented>` — a segmented control: WAI-ARIA APG radio group (`role="radiogroup"`
 * on the host, `role="radio"` segments). One segment is in the tab order; arrow keys move
 * and select (RTL-aware); `sf-change` fires with `{ value }`.
 *
 * ```ts
 * html`<sf-segmented label="Density" .options=${[{ value: 'focus', label: 'Focus' }, …]} .value=${density}
 *        @sf-change=${(e) => appearance.set({ density: e.detail.value })}></sf-segmented>`
 * ```
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import type { ControlSize } from './internal/button-styles.js';
import { emit } from './internal/events.js';
import { baseStyles, controlStyles, focusRing, t } from './internal/styles.js';
import { RovingFocusController } from './roving.js';

export interface SegmentOption<V extends string = string> {
  readonly value: V;
  readonly label: string;
  /** Optional icon template rendered before (or instead of, with `iconOnly`) the label. */
  readonly icon?: unknown;
  readonly disabled?: boolean;
}

export interface ChangeDetail<V = string> {
  readonly value: V;
}

const segmentedSpec = component({
  tag: 'sf-segmented',
  placeholder: () => nothing,
  description: 'Segmented control (APG radio group): roving focus, selection follows focus.',
});

export class SfSegmentedElement extends SfElement<typeof segmentedSpec> {
  static override readonly spec = segmentedSpec;
  static override properties = {
    options: { attribute: false },
    value: {},
    label: {},
    size: { reflect: true },
    disabled: { type: Boolean, reflect: true },
    iconOnly: { type: Boolean, attribute: 'icon-only' },
  };
  static override styles = [
    baseStyles,
    focusRing,
    controlStyles,
    css`
      :host {
        display: inline-flex;
      }
      .track {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: ${t.radius.control.css};
        background: ${t.color.neutral3.css};
        border: 1px solid ${t.color.controlEdge.css};
      }
      [role='radio'] {
        all: unset;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: ${t.space.xs.css};
        min-block-size: calc(var(--kit-height) - 6px);
        padding-inline: var(--kit-pad-inline);
        border-radius: max(0px, calc(${t.radius.control.css} - 3px));
        color: ${t.color.textMuted.css};
        font-weight: ${t.font.weightMedium.css};
        cursor: pointer;
        transition:
          background-color ${t.motion.durationFast.css} ${t.motion.easeStandard.css},
          color ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
      }
      [role='radio']:hover {
        color: ${t.color.text.css};
      }
      [role='radio'][aria-checked='true'] {
        background: ${t.color.surface3.css};
        color: ${t.color.text.css};
        box-shadow:
          ${t.shadow.level1.css},
          inset 0 0 0 1px ${t.color.border.css};
      }
      [role='radio']:focus-visible {
        outline: 2px solid ${t.color.focusRing.css};
        outline-offset: 2px;
      }
      [role='radio'][aria-disabled='true'] {
        color: ${t.color.textDisabled.css};
        cursor: not-allowed;
      }
      @media (forced-colors: active) {
        [role='radio'][aria-checked='true'] {
          background: Highlight;
          color: HighlightText;
        }
      }
    `,
  ];

  declare options: readonly SegmentOption[];
  declare value: string;
  declare label: string;
  declare size: ControlSize;
  declare disabled: boolean;
  declare iconOnly: boolean;
  private readonly roving: RovingFocusController;

  constructor() {
    super();
    this.options = [];
    this.value = '';
    this.label = '';
    this.size = 'md';
    this.disabled = false;
    this.iconOnly = false;
    this.roving = new RovingFocusController(this, {
      items: () => [...(this.shadowRoot?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])],
      orientation: 'horizontal',
      initial: () => this.options.findIndex((o) => o.value === this.value),
      onMove: (_item, index) => this.select(index),
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'radiogroup');
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('label')) this.setAttribute('aria-label', this.label);
    if (changed.has('value') || changed.has('options')) this.roving.reset(); // tab stop = the checked segment
    if (changed.has('disabled')) {
      if (this.disabled) this.setAttribute('aria-disabled', 'true');
      else this.removeAttribute('aria-disabled');
    }
  }

  /** Select the option at `index` (no-op when disabled); fires `sf-change`. */
  select(index: number): void {
    const option = this.options[index];
    if (option === undefined || option.disabled === true || this.disabled || option.value === this.value) return;
    this.value = option.value;
    emit<ChangeDetail>(this, 'sf-change', { value: option.value });
  }

  override render(): TemplateResult {
    return html`<div class="track" part="track">
      ${this.options.map((option, index) => {
        const checked = option.value === this.value;
        const disabled = this.disabled || option.disabled === true;
        return html`<button
          type="button"
          role="radio"
          part="segment"
          aria-checked=${checked ? 'true' : 'false'}
          aria-disabled=${disabled ? 'true' : nothing}
          aria-label=${this.iconOnly ? option.label : nothing}
          title=${this.iconOnly ? option.label : nothing}
          data-value=${option.value}
          @click=${() => this.select(index)}
        >
          ${option.icon ?? nothing}${this.iconOnly ? nothing : option.label}
        </button>`;
      })}
    </div>`;
  }
}

export function defineSegmented(registry: CustomElementRegistry = customElements): void {
  if (registry.get(segmentedSpec.tag) === undefined) defineComponent(SfSegmentedElement, registry);
}
