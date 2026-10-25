/**
 * `<sf-tag>` — a small, **non-interactive** label pill (status, kind, token). It is not
 * focusable and has no role: its text is read in place. Pressable suggestions are small
 * buttons (`<sf-button size="sm">`), not tags.
 *
 * Tones: `neutral` (default, `neutral3` fill), `agent` (soft agent fill + agent ink), and
 * a custom colour: set `color` (fill) and `ink` (text) to any CSS colour — the caller
 * owns the contrast of a custom pair (apps keep such pairs in a typed palette and test
 * them, e.g. Instaflow's lens tags). `mono` sets the monospace family (tokens, codes).
 * Shape comes from `radius.control`.
 *
 * ```html
 * <sf-tag>Brand · Night Market</sf-tag>
 * <sf-tag tone="agent">✦ Claude</sf-tag>
 * <sf-tag .color=${lens.color} .ink=${lens.onColor}>Layout</sf-tag>
 * <sf-tag mono>@display</sf-tag>
 * ```
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type PropertyValues, type TemplateResult } from 'lit';
import { baseStyles, t } from './internal/styles.js';

export type TagTone = 'neutral' | 'agent';

const tagSpec = component({
  tag: 'sf-tag',
  placeholder: () => html`<slot></slot>`,
  description: 'Non-interactive label pill: neutral, agent or custom colour; optional monospace.',
});

export class SfTagElement extends SfElement<typeof tagSpec> {
  static override readonly spec = tagSpec;
  static override properties = {
    tone: { reflect: true },
    color: {},
    ink: {},
    mono: { type: Boolean, reflect: true },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: ${t.space.xs.css};
        box-sizing: border-box;
        min-block-size: 24px;
        padding-inline: 10px;
        border-radius: ${t.radius.control.css};
        background: var(--kit-tag-color, ${t.color.neutral3.css});
        color: var(--kit-tag-ink, ${t.color.text.css});
        font-size: ${t.type.sizeSm.css};
        font-weight: ${t.font.weightMedium.css};
        white-space: nowrap;
        vertical-align: middle;
      }
      :host([tone='agent']) {
        background: var(--kit-tag-color, ${t.color.agentSoft.css});
        color: var(--kit-tag-ink, ${t.color.agentInk.css});
      }
      :host([mono]) {
        font-family: ${t.font.familyMono.css};
        font-weight: ${t.font.weightRegular.css};
      }
      @media (forced-colors: active) {
        :host {
          border: 1px solid CanvasText;
        }
      }
    `,
  ];

  declare tone: TagTone;
  /** Custom fill (any CSS colour); overrides the tone's fill. */
  declare color: string | undefined;
  /** Custom text colour for `color`; overrides the tone's text colour. */
  declare ink: string | undefined;
  declare mono: boolean;

  constructor() {
    super();
    this.tone = 'neutral';
    this.color = undefined;
    this.ink = undefined;
    this.mono = false;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('color')) setOrRemove(this.style, '--kit-tag-color', this.color);
    if (changed.has('ink')) setOrRemove(this.style, '--kit-tag-ink', this.ink);
  }

  override render(): TemplateResult {
    return html`<slot name="start"></slot><slot></slot>`;
  }
}

function setOrRemove(style: CSSStyleDeclaration, property: string, value: string | undefined): void {
  if (value === undefined || value === '') style.removeProperty(property);
  else style.setProperty(property, value);
}

export function defineTag(registry: CustomElementRegistry = customElements): void {
  if (registry.get(tagSpec.tag) === undefined) defineComponent(SfTagElement, registry);
}
