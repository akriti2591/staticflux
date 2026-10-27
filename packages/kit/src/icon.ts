/**
 * `<sf-icon .icon=${trash2Icon}>` — one outline icon rendered as inline SVG (FOUNDATIONS §5.9,
 * STUDIO-UX-SPEC §10.2). One set everywhere: **Lucide** (ISC) on a 24-unit grid with a 2 px
 * round stroke, plus custom icons for the gaps drawn on the same grid
 * (`packages/kit/src/icons/custom/*.svg`).
 *
 * - **Typed values, not names** (rule 1): every icon is an `IconDef` exported by its own module
 *   (`@staticflux/kit/icons/trash-2` → `trash2Icon`, or the `@staticflux/kit/icons` barrel), so only
 *   the icons a surface imports ship (no sprite sheet, no icon font, no runtime fetch). The
 *   `name` attribute is reflected from the icon for styling and tests; it is never looked up.
 * - Paints with `currentColor`, `fill: none`; stroke 2 on the 24 grid, 1.75 at 16 px (the size
 *   menus, rows, the inspector and tags use). Sizes: `16` (default), `18` (icon buttons, tool
 *   picker), `24` (cards, empty states). `--sf-icon-stroke` overrides the stroke; `--sf-icon-fill` fills the shape
 *   (a favourite's star; default none).
 * - Decorative by default (`aria-hidden="true"`): the control around it carries the name. With
 *   `label` it is an image (`role="img"`, `aria-label`) for the rare icon that stands alone.
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type PropertyValues, type TemplateResult } from 'lit';
import { baseStyles } from './internal/styles.js';

import { iconElement, type IconDef, type IconSize } from './icon-def.js';

export * from './icon-def.js';

const iconSpec = component({
  tag: 'sf-icon',
  placeholder: () => html``,
  description: 'One outline icon (Lucide + custom set) as inline SVG in currentColor; decorative unless labelled.',
});

const sizeConverter = {
  fromAttribute: (value: string | null): IconSize => {
    const n = Number(value);
    return n === 18 || n === 24 ? n : 16;
  },
  toAttribute: (value: IconSize): string => String(value),
};

export class SfIconElement extends SfElement<typeof iconSpec> {
  static override readonly spec = iconSpec;
  static override properties = {
    icon: { attribute: false },
    size: { reflect: true, converter: sizeConverter },
    label: {},
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        --_size: 16px;
        --_stroke: var(--sf-icon-stroke, 1.75);
        display: inline-flex;
        flex: none;
        inline-size: var(--_size);
        block-size: var(--_size);
        color: inherit;
        line-height: 0;
        vertical-align: middle;
      }
      :host([size='18']) {
        --_size: 18px;
        --_stroke: var(--sf-icon-stroke, 2);
      }
      :host([size='24']) {
        --_size: 24px;
        --_stroke: var(--sf-icon-stroke, 2);
      }
      svg {
        inline-size: 100%;
        block-size: 100%;
        stroke-width: var(--_stroke);
        fill: var(--sf-icon-fill, none);
        overflow: visible;
      }
      @media (forced-colors: active) {
        svg {
          stroke: CanvasText;
        }
      }
    `,
  ];

  declare icon: IconDef | undefined;
  declare size: IconSize;
  /** Accessible name when the icon stands alone (`role="img"`); empty = decorative. */
  declare label: string;

  constructor() {
    super();
    this.icon = undefined;
    this.size = 16;
    this.label = '';
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('icon')) {
      if (this.icon === undefined) this.removeAttribute('name');
      else this.setAttribute('name', this.icon.name);
    }
    if (changed.has('label')) {
      if (this.label === '') {
        this.removeAttribute('role');
        this.removeAttribute('aria-label');
        this.setAttribute('aria-hidden', 'true');
      } else {
        this.setAttribute('role', 'img');
        this.setAttribute('aria-label', this.label);
        this.removeAttribute('aria-hidden');
      }
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has('icon')) return;
    const box = this.renderRoot.querySelector('.box');
    box?.replaceChildren(...(this.icon === undefined ? [] : [iconElement(this.icon, this.ownerDocument)]));
  }

  override render(): TemplateResult {
    return html`<span class="box" part="svg" style="display:contents"></span>`;
  }
}

export function defineIconElement(registry: CustomElementRegistry = customElements): void {
  if (registry.get(iconSpec.tag) === undefined) defineComponent(SfIconElement, registry);
}
