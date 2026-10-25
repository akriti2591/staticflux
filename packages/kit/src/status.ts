/**
 * `<sf-status tone="success">Saved</sf-status>` — a small, non-interactive status indicator: a
 * coloured dot and a short muted label (save state, sync, connection). The host is a polite live
 * region (`role="status"`), so a change of the label is announced without moving focus; the label
 * always states the status in words, so the dot's colour is never the only signal.
 *
 * Tones: `neutral` (default), `success`, `warning`, `danger`. `busy` pulses the dot (no motion under
 * reduced motion: the motion tokens are 0 there).
 *
 * ```html
 * <sf-status tone="success">Saved</sf-status>
 * <sf-status busy>Saving…</sf-status>
 * <sf-status tone="warning">Not saved yet: storage is full</sf-status>
 * ```
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { baseStyles, t } from './internal/styles.js';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';

const statusSpec = component({
  tag: 'sf-status',
  placeholder: () => html`<slot></slot>`,
  description: 'Status indicator: tone dot + label in a polite live region (role=status).',
});

export class SfStatusElement extends SfElement<typeof statusSpec> {
  static override readonly spec = statusSpec;
  static override properties = {
    tone: { reflect: true },
    busy: { type: Boolean, reflect: true },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: ${t.space.xs.css};
        color: ${t.color.textMuted.css};
        font-size: ${t.type.sizeSm.css};
        white-space: nowrap;
      }
      .dot {
        flex: none;
        inline-size: 7px;
        block-size: 7px;
        border-radius: 50%;
        background: ${t.color.textSubtle.css};
      }
      :host([tone='success']) .dot {
        background: ${t.color.success.css};
      }
      :host([tone='warning']) .dot {
        background: ${t.color.warning.css};
      }
      :host([tone='danger']) .dot {
        background: ${t.color.danger.css};
      }
      :host([busy]) .dot {
        animation: sf-status-pulse calc(${t.motion.durationSlow.css} * 4) ${t.motion.easeStandard.css} infinite alternate;
      }
      @keyframes sf-status-pulse {
        from {
          opacity: 1;
        }
        to {
          opacity: 0.35;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        :host([busy]) .dot {
          animation: none;
        }
      }
      @media (forced-colors: active) {
        .dot {
          background: CanvasText;
        }
      }
    `,
  ];

  declare tone: StatusTone;
  declare busy: boolean;

  constructor() {
    super();
    this.tone = 'neutral';
    this.busy = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
  }

  override render(): TemplateResult {
    return html`<span class="dot" part="dot" aria-hidden="true"></span><slot></slot>`;
  }
}

export function defineStatus(registry: CustomElementRegistry = customElements): void {
  if (registry.get(statusSpec.tag) === undefined) defineComponent(SfStatusElement, registry);
}
