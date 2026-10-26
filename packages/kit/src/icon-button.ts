/**
 * `<sf-icon-button label="Undo" shortcut="Mod+Z">` — a square button whose only content
 * is an icon (default slot). `label` is required: it is the accessible name and is shown
 * as a tooltip on hover and keyboard focus (UX: every action has a visible label or
 * tooltip with its shortcut). `shortcut` adds `aria-keyshortcuts` and a `<kbd>` hint.
 * Same behaviour as `<sf-button>` (APG button, `pressed` toggles, disabled); default
 * variant `ghost`.
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import type { Side } from './position.js';
import { buttonStyles, type ControlSize, pressedConverter } from './internal/button-styles.js';
import { PressController } from './internal/press.js';
import { ariaKeyShortcuts, shortcutLabel } from './internal/shortcuts.js';
import { floatingStyles } from './internal/floating-styles.js';
import { baseStyles, controlStyles, focusRing } from './internal/styles.js';
import { composeTooltip, TooltipController } from './internal/tooltip-core.js';
import { tooltipStyles } from './internal/tooltip-styles.js';
import type { ButtonVariant } from './button.js';

const iconButtonSpec = component({
  tag: 'sf-icon-button',
  placeholder: () => html`<slot></slot>`,
  description: 'Icon-only button with a required label (accessible name + tooltip) and optional shortcut.',
});

export class SfIconButtonElement extends SfElement<typeof iconButtonSpec> {
  static override readonly spec = iconButtonSpec;
  static readonly formAssociated = true;
  static override properties = {
    label: {},
    shortcut: {},
    variant: { reflect: true },
    size: { reflect: true },
    disabled: { type: Boolean, reflect: true },
    pressed: { converter: pressedConverter },
    type: {},
    tooltip: { type: Boolean },
    tooltipSide: { attribute: 'tooltip-side' },
    reason: {},
    description: {},
  };
  static override styles = [
    baseStyles,
    focusRing,
    controlStyles,
    buttonStyles,
    floatingStyles,
    tooltipStyles,
    css`
      .control {
        inline-size: var(--kit-height);
        padding-inline: 0;
      }
    `,
  ];

  declare label: string;
  declare shortcut: string | undefined;
  declare variant: ButtonVariant;
  declare size: ControlSize;
  declare disabled: boolean;
  declare pressed: boolean | undefined;
  declare type: 'button' | 'submit' | 'reset';
  /** Show the label as a tooltip (default true; turn off when a visible label is next to it). */
  declare tooltip: boolean;
  /** Below by default; the bottom bars and the HUD put it above (OVERLAYS-FEEDBACK §4). */
  declare tooltipSide: Side;
  /** Disabled reason shown after a `·` in the tooltip. */
  declare reason: string | undefined;
  /** Muted second tooltip line (Pro density). */
  declare description: string | undefined;
  private readonly tip: TooltipController;

  constructor() {
    super();
    this.label = '';
    this.shortcut = undefined;
    this.variant = 'ghost';
    this.size = 'md';
    this.disabled = false;
    this.pressed = undefined;
    this.type = 'button';
    this.tooltip = true;
    this.tooltipSide = 'block-end';
    this.reason = undefined;
    this.description = undefined;
    new PressController(this);
    this.tip = new TooltipController(this, {
      anchor: () => this,
      bubble: () => this.renderRoot.querySelector<HTMLElement>('.tooltip'),
      side: () => this.tooltipSide,
      enabled: () => this.tooltip && this.label !== '',
    });
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('label')) this.setAttribute('aria-label', this.label);
    if (changed.has('shortcut')) {
      if (this.shortcut == null || this.shortcut === '') this.removeAttribute('aria-keyshortcuts');
      else this.setAttribute('aria-keyshortcuts', ariaKeyShortcuts(this.shortcut, this.ownerDocument));
    }
  }

  override render(): TemplateResult {
    const hint = this.shortcut == null || this.shortcut === '' ? nothing : html`<kbd>${shortcutLabel(this.shortcut, this.ownerDocument)}</kbd>`;
    // The bubble repeats the accessible name, so it is hidden from assistive technology.
    return html`<span class="control" part="control"><slot></slot></span>${this.tooltip && this.label !== ''
        ? html`<div class="floating tooltip" part="tooltip" aria-hidden="true" ?data-open=${this.tip.open}>${composeTooltip(this.label, this.reason)}${hint}${this.description === undefined || this.description === ''
              ? nothing
              : html`<span class="description">${this.description}</span>`}</div>`
        : nothing}`;
  }
}

export function defineIconButton(registry: CustomElementRegistry = customElements): void {
  if (registry.get(iconButtonSpec.tag) === undefined) defineComponent(SfIconButtonElement, registry);
}
