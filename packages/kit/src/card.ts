/**
 * `<sf-card>` — a content card: a raised surface with a hairline edge and the large radius
 * (`radius.lg`). Content goes in the default slot; the card lays it out as a column.
 *
 * With `href` the **whole card is one link** (a native `<a>` inside the shadow root, so Enter,
 * middle click and "open in new tab" work as for any link) with the focus ring on the card. Its
 * accessible name is its text unless `label` is set. Without `href` it is a plain container with
 * no role (put headings and controls inside). Never nest interactive controls inside a linked card.
 *
 * `--kit-card-padding` and `--kit-card-gap` let a layout tighten or widen the card (tiles, lists).
 *
 * ```html
 * <sf-card href="/s/as_1"><span>Night Market Flyer</span><span>Edited 2 min ago</span></sf-card>
 * <sf-card><h2>Quick actions</h2>…</sf-card>
 * ```
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { baseStyles, focusRing, t } from './internal/styles.js';

const cardSpec = component({
  tag: 'sf-card',
  placeholder: () => html`<slot></slot>`,
  description: 'Content card on a raised surface; with href the whole card is one link.',
});

export class SfCardElement extends SfElement<typeof cardSpec> {
  static override readonly spec = cardSpec;
  static override properties = {
    href: { reflect: true },
    label: {},
  };
  static override styles = [
    baseStyles,
    focusRing,
    css`
      :host {
        display: block;
        min-inline-size: 0;
      }
      .card {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: var(--kit-card-gap, ${t.space.sm.css});
        box-sizing: border-box;
        block-size: 100%;
        padding: var(--kit-card-padding, ${t.space.lg.css});
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.lg.css};
        background: ${t.color.surface2.css};
        color: ${t.color.text.css};
        text-decoration: none;
        transition:
          border-color ${t.motion.durationFast.css} ${t.motion.easeStandard.css},
          transform ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
      }
      a.card:hover {
        border-color: ${t.color.controlEdge.css};
        transform: translateY(-1px);
      }
      a.card:active {
        transform: none;
      }
      @media (prefers-reduced-motion: reduce) {
        a.card:hover {
          transform: none;
        }
      }
      @media (forced-colors: active) {
        .card {
          border-color: CanvasText;
        }
        a.card {
          color: LinkText;
        }
      }
    `,
  ];

  /** Make the whole card a link to this URL. */
  declare href: string | undefined;
  /** Accessible name of the link (default: the card's text). */
  declare label: string | undefined;

  constructor() {
    super();
    this.href = undefined;
    this.label = undefined;
  }

  override render(): TemplateResult {
    if (this.href === undefined || this.href === '') return html`<div class="card" part="card"><slot></slot></div>`;
    return html`<a class="card focus-target" part="card" href=${this.href} aria-label=${this.label === undefined || this.label === '' ? nothing : this.label}><slot></slot></a>`;
  }
}

export function defineCard(registry: CustomElementRegistry = customElements): void {
  if (registry.get(cardSpec.tag) === undefined) defineComponent(SfCardElement, registry);
}
