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
 * **Slots outside the link** (R13.49, FOUNDATIONS §4.14): `actions` sits top-right over the card (a `⋯` menu button, a
 * star), revealed on hover and focus within, always shown with `actions-shown`; `leading` sits top-left (a selection
 * checkbox). Both are siblings of the link, so Tab reaches the link first, then each action; they never nest inside it.
 * States: `selected` (the soft tangerine edge), `drop-target` (the tangerine outline while something is dragged over),
 * `dragging` (90 % scale, 80 % opacity).
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
    selected: { type: Boolean, reflect: true },
    dropTarget: { type: Boolean, reflect: true, attribute: 'drop-target' },
    dragging: { type: Boolean, reflect: true },
    actionsShown: { type: Boolean, reflect: true, attribute: 'actions-shown' },
  };
  static override styles = [
    baseStyles,
    focusRing,
    css`
      :host {
        position: relative;
        display: block;
        min-inline-size: 0;
      }
      .actions,
      .leading {
        position: absolute;
        inset-block-start: ${t.space.sm.css};
        display: flex;
        gap: ${t.space.xs.css};
        opacity: 0;
        transition: opacity ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
      }
      .actions {
        inset-inline-end: ${t.space.sm.css};
      }
      .leading {
        inset-inline-start: ${t.space.sm.css};
      }
      :host(:hover) .actions,
      :host(:focus-within) .actions,
      :host([actions-shown]) .actions,
      :host(:hover) .leading,
      :host(:focus-within) .leading,
      :host([actions-shown]) .leading,
      :host([selected]) .leading {
        opacity: 1;
      }
      :host([selected]) .card {
        border-color: ${t.color.accent.css};
        box-shadow: 0 0 0 1px ${t.color.accent.css};
        background: ${t.color.accentSubtle.css};
      }
      :host([drop-target]) .card {
        outline: 2px solid ${t.color.accent.css};
        outline-offset: 2px;
      }
      :host([dragging]) {
        opacity: 0.8;
        transform: scale(0.9);
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
        .actions,
        .leading {
          transition: none;
        }
      }
      @media (forced-colors: active) {
        .card {
          border-color: CanvasText;
        }
        a.card {
          color: LinkText;
        }
        :host([selected]) .card,
        :host([drop-target]) .card {
          outline: 2px solid Highlight;
        }
      }
    `,
  ];

  /** Make the whole card a link to this URL. */
  declare href: string | undefined;
  /** Accessible name of the link (default: the card's text). */
  declare label: string | undefined;
  /** Part of a selection (the soft tangerine edge). */
  declare selected: boolean;
  /** Something droppable is over it. */
  declare dropTarget: boolean;
  /** It is being dragged. */
  declare dragging: boolean;
  /** Keep the `actions` and `leading` slots visible (a menu from them is open; Pro). */
  declare actionsShown: boolean;

  constructor() {
    super();
    this.href = undefined;
    this.label = undefined;
    this.selected = false;
    this.dropTarget = false;
    this.dragging = false;
    this.actionsShown = false;
  }

  override render(): TemplateResult {
    const slots = html`<div class="leading"><slot name="leading"></slot></div>
      <div class="actions"><slot name="actions"></slot></div>`;
    if (this.href === undefined || this.href === '') return html`<div class="card" part="card"><slot></slot></div>${slots}`;
    return html`<a class="card focus-target" part="card" href=${this.href} aria-label=${this.label === undefined || this.label === '' ? nothing : this.label}><slot></slot></a>${slots}`;
  }
}

export function defineCard(registry: CustomElementRegistry = customElements): void {
  if (registry.get(cardSpec.tag) === undefined) defineComponent(SfCardElement, registry);
}
