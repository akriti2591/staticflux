/**
 * `<sf-tooltip text="Align left" shortcut="Mod+Shift+L">` wraps one anchor element and describes it (WAI-ARIA APG
 * Tooltip, OVERLAYS-FEEDBACK §4): 500 ms on the first hover, then a 300 ms warm period in which neighbours show at
 * once; on keyboard focus; hidden on leave, blur, press, any key and scroll; a long-press on touch; one at a time.
 * The text is the name, the shortcut as `kbd` (every density), the disabled reason after a `·` (`reason`, dialogs and
 * forms only: the control stays focusable with `aria-disabled`) and an optional muted second line (`description`,
 * the Pro density). It lives in a light-DOM `role="tooltip"` element next to the anchor, so the anchor's
 * `aria-describedby` resolves in the same tree; the bubble is in the top layer, below the anchor by default.
 *
 * Never essential: whatever a tooltip says exists elsewhere as text. For icon-only buttons prefer
 * `<sf-icon-button label>` (its tooltip repeats the name).
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import type { Side } from './position.js';
import { uniqueId } from './internal/ids.js';
import { shortcutLabel } from './internal/shortcuts.js';
import { floatingStyles } from './internal/floating-styles.js';
import { baseStyles } from './internal/styles.js';
import { composeTooltip, TOOLTIP_TIMING, TooltipController } from './internal/tooltip-core.js';
import { tooltipStyles } from './internal/tooltip-styles.js';

export { composeTooltip, TOOLTIP_TIMING };

const tooltipSpec = component({
  tag: 'sf-tooltip',
  placeholder: () => html`<slot></slot>`,
  description: 'Tooltip that describes its anchor (aria-describedby in the same tree); delay + warm period, focus, long-press, disabled reason.',
});

export class SfTooltipElement extends SfElement<typeof tooltipSpec> {
  static override readonly spec = tooltipSpec;
  static override properties = {
    text: {},
    shortcut: {},
    side: {},
    reason: {},
    description: {},
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
  /** Why the control is disabled (`Export · Choose at least one page`). */
  declare reason: string | undefined;
  /** Muted second line (Pro density: the capability's one-line description). */
  declare description: string | undefined;
  private readonly tipId = uniqueId('sf-tooltip');
  private readonly tip: TooltipController;

  constructor() {
    super();
    this.text = '';
    this.shortcut = undefined;
    this.side = 'block-end';
    this.reason = undefined;
    this.description = undefined;
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

  /** Show now (tests, coach flows); hover and focus use the delays. */
  show(): void {
    this.tip.show();
  }

  hide(): void {
    this.tip.hide();
  }

  get isOpen(): boolean {
    return this.tip.open;
  }

  protected override updated(): void {
    const tip = this.tipElement;
    const doc = this.ownerDocument;
    const hint = this.shortcut === undefined || this.shortcut === '' ? '' : shortcutLabel(this.shortcut, doc);
    tip.replaceChildren(composeTooltip(this.text, this.reason));
    if (hint !== '') {
      const kbd = doc.createElement('kbd');
      kbd.textContent = hint;
      tip.append(' ', kbd);
    }
    if (this.description !== undefined && this.description !== '') {
      const line = doc.createElement('span');
      line.className = 'description';
      // Light DOM: the bubble's shadow styles cannot reach it, so the second line styles itself.
      line.style.cssText = 'display:block;opacity:0.75;font-weight:400;white-space:normal';
      line.textContent = this.description;
      tip.append(' ', line);
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
