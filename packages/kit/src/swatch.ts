/**
 * `<sf-swatch color="#FF5C39">` — the round colour swatch of FOUNDATIONS §4.6 and STUDIO-UX-SPEC
 * §5.4: a 16 px circle filled with the **resolved** colour on a checkerboard (so transparency
 * shows), with a hairline ring so white reads on white. `unresolved` (a token the brand kit does
 * not define, or no colour) shows a hatched pattern instead, never a guessed colour.
 *
 * Non-interactive and decorative like `<sf-tag>`: it has no role and is hidden from assistive
 * technology; the control around it (a field row, a pill button, the colour popover's trigger) says
 * the value in words. `size`: `16` (default), `24`. `opacity` (0–1) shows a translucent fill.
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { baseStyles, t } from './internal/styles.js';

const swatchSpec = component({
  tag: 'sf-swatch',
  placeholder: () => nothing,
  description: 'Decorative round colour swatch: resolved colour on a checkerboard, hatched when unresolved.',
});

/** Clamp an opacity to 0–1 (non-finite → 1). Pure. */
export function swatchOpacity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** A CSS colour safe to put in a custom property (hex, rgb()/hsl()/oklch() and names); anything else → ''. Pure. */
export function swatchColor(value: string): string {
  const v = value.trim();
  return /^(?:#[0-9a-f]{3,8}|[a-z]+(?:\([0-9a-z.,%\s/+-]*\))?)$/i.test(v) ? v : '';
}

export class SfSwatchElement extends SfElement<typeof swatchSpec> {
  static override readonly spec = swatchSpec;
  static override properties = {
    color: {},
    opacity: { type: Number },
    unresolved: { type: Boolean, reflect: true },
    size: { reflect: true, type: Number },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        --_size: 16px;
        display: inline-block;
        flex: none;
        inline-size: var(--_size);
        block-size: var(--_size);
        vertical-align: middle;
      }
      :host([size='24']) {
        --_size: 24px;
      }
      .chip {
        box-sizing: border-box;
        display: block;
        inline-size: 100%;
        block-size: 100%;
        border-radius: ${t.radius.full.css};
        box-shadow: inset 0 0 0 1px ${t.color.borderStrong.css};
        background-image:
          linear-gradient(var(--_fill), var(--_fill)),
          conic-gradient(${t.color.neutral4.css} 25%, ${t.color.surface2.css} 0 50%, ${t.color.neutral4.css} 0 75%, ${t.color.surface2.css} 0);
        background-size:
          100% 100%,
          8px 8px;
      }
      :host([unresolved]) .chip {
        background-image: repeating-linear-gradient(-45deg, ${t.color.textMuted.css} 0 1.5px, ${t.color.surface2.css} 1.5px 4px);
        background-size: auto;
      }
      @media (forced-colors: active) {
        .chip {
          forced-color-adjust: none;
          border: 1px solid CanvasText;
        }
      }
    `,
  ];

  /** The resolved CSS colour (hex from the token → kit → hex chain). */
  declare color: string;
  declare opacity: number | undefined;
  declare unresolved: boolean;
  declare size: 16 | 24;

  constructor() {
    super();
    this.color = '';
    this.opacity = undefined;
    this.unresolved = false;
    this.size = 16;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('aria-hidden', 'true');
  }

  override render(): TemplateResult {
    const alpha = swatchOpacity(this.opacity);
    const color = swatchColor(this.color);
    const fill = color === '' ? 'transparent' : `color-mix(in srgb, ${color} ${Math.round(alpha * 1000) / 10}%, transparent)`;
    return html`<span class="chip" part="swatch" style=${`--_fill:${fill}`}></span>`;
  }
}

export function defineSwatch(registry: CustomElementRegistry = customElements): void {
  if (registry.get(swatchSpec.tag) === undefined) defineComponent(SfSwatchElement, registry);
}
