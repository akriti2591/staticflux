/**
 * `<sf-button>` — WAI-ARIA APG button on the host (`role="button"`): text in the default
 * slot, optional `start` / `end` slots (icons, kbd), variants `secondary` (default),
 * `primary`, `ghost`, `danger`, sizes `sm | md | lg` (density-aware heights), `pressed`
 * for toggle buttons, `type="submit|reset"` inside forms.
 *
 * ```html
 * <sf-button variant="primary" @click=${save}>Save</sf-button>
 * <sf-button .pressed=${bold} @click=${toggleBold}>Bold</sf-button>
 * ```
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { html, type TemplateResult } from 'lit';
import { buttonStyles, type ControlSize, pressedConverter } from './internal/button-styles.js';
import { PressController } from './internal/press.js';
import { baseStyles, controlStyles, focusRing } from './internal/styles.js';

export type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'danger';
export type { ControlSize };

const buttonSpec = component({
  tag: 'sf-button',
  placeholder: () => html`<slot></slot>`,
  description: 'Button (APG): role=button host, Enter/Space, disabled, toggle (aria-pressed), form submit.',
});

export class SfButtonElement extends SfElement<typeof buttonSpec> {
  static override readonly spec = buttonSpec;
  static readonly formAssociated = true;
  static override properties = {
    variant: { reflect: true },
    size: { reflect: true },
    disabled: { type: Boolean, reflect: true },
    pressed: { converter: pressedConverter },
    type: {},
  };
  static override styles = [baseStyles, focusRing, controlStyles, buttonStyles];

  declare variant: ButtonVariant;
  declare size: ControlSize;
  declare disabled: boolean;
  declare pressed: boolean | undefined;
  declare type: 'button' | 'submit' | 'reset';

  constructor() {
    super();
    this.variant = 'secondary';
    this.size = 'md';
    this.disabled = false;
    this.pressed = undefined;
    this.type = 'button';
    new PressController(this);
  }

  override render(): TemplateResult {
    return html`<span class="control" part="control"><slot name="start"></slot><slot></slot><slot name="end"></slot></span>`;
  }
}

export function defineButton(registry: CustomElementRegistry = customElements): void {
  if (registry.get(buttonSpec.tag) === undefined) defineComponent(SfButtonElement, registry);
}
