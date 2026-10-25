/**
 * `<sf-toolbar label="Formatting">` — WAI-ARIA APG toolbar: `role="toolbar"` on the host,
 * one tab stop, arrow keys move between controls (RTL-aware; ArrowUp/Down when
 * `orientation="vertical"`), Home/End. Controls are the slotted kit controls and native
 * buttons/inputs — directly or one wrapper deep (`<sf-tooltip>`, `<sf-menu>` triggers).
 * Text fields keep their arrow keys; composite children (segmented controls) handle their
 * own. `role="separator"` children render as hairlines. In narrow containers (container
 * query) children marked `data-toolbar-priority="low"` hide. The toolbar is a size container:
 * it takes the inline size its parent gives it (block layout, a grid track, or `flex: 1`), not
 * the size of its content.
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { baseStyles, t } from './internal/styles.js';
import { RovingFocusController } from './roving.js';

/** Elements a toolbar treats as its controls. */
export const TOOLBAR_CONTROLS = 'sf-button, sf-icon-button, sf-segmented, sf-text-field, sf-color-field, sf-slider, button, input, select, [data-toolbar-item]';

/** The toolbar items among `children` (each child, or its first control descendant). */
export function toolbarItems(children: readonly Element[]): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of children) {
    if (child.getAttribute('role') === 'separator') continue;
    const control = child.matches(TOOLBAR_CONTROLS) ? child : child.querySelector(TOOLBAR_CONTROLS);
    if (control instanceof HTMLElement) items.push(control);
  }
  return items;
}

const toolbarSpec = component({
  tag: 'sf-toolbar',
  placeholder: () => html`<slot></slot>`,
  description: 'Toolbar (APG): one tab stop, roving arrow-key focus, separators, container-query overflow.',
});

export class SfToolbarElement extends SfElement<typeof toolbarSpec> {
  static override readonly spec = toolbarSpec;
  static override properties = { label: {}, orientation: { reflect: true } };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        container-type: inline-size;
      }
      .bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: ${t.space.xs.css};
        min-block-size: ${t.size.toolbar.css};
        padding-inline: ${t.space.sm.css};
      }
      :host([orientation='vertical']) .bar {
        flex-direction: column;
        padding-block: ${t.space.sm.css};
        padding-inline: 0;
        min-inline-size: ${t.size.toolbar.css};
      }
      ::slotted([role='separator']) {
        align-self: stretch;
        inline-size: 1px;
        margin-block: ${t.space.sm.css};
        margin-inline: ${t.space.xs.css};
        background: ${t.color.border.css};
      }
      :host([orientation='vertical']) ::slotted([role='separator']) {
        inline-size: auto;
        block-size: 1px;
        margin-block: ${t.space.xs.css};
        margin-inline: ${t.space.sm.css};
      }
      ::slotted([data-toolbar-spacer]) {
        flex: 1;
      }
      @container (max-width: 480px) {
        ::slotted([data-toolbar-priority='low']) {
          display: none;
        }
      }
    `,
  ];

  declare label: string;
  declare orientation: 'horizontal' | 'vertical';
  private readonly roving: RovingFocusController;

  constructor() {
    super();
    this.label = '';
    this.orientation = 'horizontal';
    this.roving = new RovingFocusController(this, { items: () => this.items, orientation: () => this.orientation });
  }

  /** The toolbar's controls, in order. */
  get items(): HTMLElement[] {
    return toolbarItems([...this.children]);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('role', 'toolbar');
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('label')) this.setAttribute('aria-label', this.label);
    if (this.orientation === 'vertical') this.setAttribute('aria-orientation', 'vertical');
    else this.removeAttribute('aria-orientation');
  }

  override render(): TemplateResult {
    return html`<div class="bar" part="bar"><slot @slotchange=${() => this.roving.sync()}></slot></div>${nothing}`;
  }
}

export function defineToolbar(registry: CustomElementRegistry = customElements): void {
  if (registry.get(toolbarSpec.tag) === undefined) defineComponent(SfToolbarElement, registry);
}
