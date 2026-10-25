/**
 * `<sf-tooltip text="Align left" shortcut="Mod+Shift+L">` wraps one anchor element and
 * describes it (WAI-ARIA APG Tooltip): shows on hover after a delay and on keyboard
 * focus, hides on leave / blur / Escape; one tooltip at a time. The tooltip text lives in
 * a light-DOM `role="tooltip"` element next to the anchor, so the anchor's
 * `aria-describedby` resolves in the same tree; the bubble is in the top layer.
 *
 * For icon-only buttons prefer `<sf-icon-button label>` (its tooltip repeats the name).
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import type { Side } from './position.js';
import { uniqueId } from './internal/ids.js';
import { shortcutLabel } from './internal/shortcuts.js';
import { floatingStyles } from './internal/floating-styles.js';
import { baseStyles } from './internal/styles.js';
import { TooltipController } from './internal/tooltip-core.js';
import { tooltipStyles } from './internal/tooltip-styles.js';

const tooltipSpec = component({
  tag: 'sf-tooltip',
  placeholder: () => html`<slot></slot>`,
  description: 'Tooltip that describes its anchor (aria-describedby in the same tree); hover delay, focus, Escape.',
});

export class SfTooltipElement extends SfElement<typeof tooltipSpec> {
  static override readonly spec = tooltipSpec;
  static override properties = {
    text: {},
    shortcut: {},
    side: {},
  };
  static override styles = [
    baseStyles,
    floatingStyles,
    tooltipStyles,
    css`
      :host {
        display: inline-flex;
      }
    `,
  ];

  declare text: string;
  declare shortcut: string | undefined;
  declare side: Side;
  private readonly tipId = uniqueId('sf-tooltip');
  private readonly tip: TooltipController;

  constructor() {
    super();
    this.text = '';
    this.shortcut = undefined;
    this.side = 'block-start';
    this.tip = new TooltipController(this, {
      anchor: () => this.anchorElement ?? this,
      bubble: () => this.renderRoot.querySelector<HTMLElement>('.tooltip'),
      side: () => this.side,
      enabled: () => this.text !== '',
    });
  }

  /** The described element: the first child that is not the tooltip text. */
  get anchorElement(): Element | undefined {
    return [...this.children].find((child) => child.getAttribute('slot') !== 'tip');
  }

  /** The light-DOM `role="tooltip"` element (created on demand). */
  get tipElement(): HTMLElement {
    let tip = this.querySelector<HTMLElement>(':scope > [slot="tip"]');
    if (tip === null) {
      tip = this.ownerDocument.createElement('span');
      tip.slot = 'tip';
      tip.id = this.tipId;
      tip.setAttribute('role', 'tooltip');
      this.append(tip);
    }
    return tip;
  }

  protected override updated(): void {
    const tip = this.tipElement;
    const hint = this.shortcut === undefined || this.shortcut === '' ? '' : shortcutLabel(this.shortcut, this.ownerDocument);
    tip.replaceChildren(this.text);
    if (hint !== '') {
      const kbd = this.ownerDocument.createElement('kbd');
      kbd.textContent = hint;
      tip.append(' ', kbd);
    }
    const anchor = this.anchorElement;
    if (anchor !== undefined) {
      const ids = new Set((anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id !== ''));
      ids.add(tip.id);
      anchor.setAttribute('aria-describedby', [...ids].join(' '));
    }
  }

  override render(): TemplateResult {
    return html`<slot></slot><div class="floating tooltip" part="tooltip" ?data-open=${this.tip.open}><slot name="tip"></slot></div>`;
  }
}

export function defineTooltip(registry: CustomElementRegistry = customElements): void {
  if (registry.get(tooltipSpec.tag) === undefined) defineComponent(SfTooltipElement, registry);
}
