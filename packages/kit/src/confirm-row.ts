/**
 * `<sf-confirm-row message="Delete 'Client v1'?" confirm-label="Delete" cancel-label="Cancel" tone="danger">` — the
 * **inline confirm row** (OVERLAYS-FEEDBACK §2.3–§2.4, FOUNDATIONS §5.5): a confirmation that replaces a row's or a
 * dialog footer's actions instead of opening a second dialog. Focus moves to the safe action (`Cancel`, `Keep
 * editing`) when it appears; Escape cancels and stays inside the row (it never closes the dialog around it).
 * Fires `sf-confirm` or `sf-cancel`. The message is announced politely once.
 *
 * ```html
 * ${removing ? html`<sf-confirm-row message="Remove?" confirm-label="Remove" @sf-confirm=${remove} @sf-cancel=${keep}></sf-confirm-row>` : row}
 * ```
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { defineButton } from './button.js';
import { emit } from './internal/events.js';
import { ConnectedListeners } from './internal/listeners.js';
import { baseStyles, t } from './internal/styles.js';

const confirmRowSpec = component({
  tag: 'sf-confirm-row',
  placeholder: () => html``,
  description: 'Inline confirm row: message, confirm and cancel; focus on the safe action; Escape cancels.',
});

export class SfConfirmRowElement extends SfElement<typeof confirmRowSpec> {
  static override readonly spec = confirmRowSpec;
  static override properties = {
    message: {},
    confirmLabel: { attribute: 'confirm-label' },
    cancelLabel: { attribute: 'cancel-label' },
    tone: { reflect: true },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: ${t.space.sm.css};
        min-block-size: ${t.size.row.css};
      }
      .message {
        flex: 1;
        min-inline-size: 0;
        font-weight: ${t.font.weightMedium.css};
      }
    `,
  ];

  declare message: string;
  declare confirmLabel: string;
  declare cancelLabel: string;
  /** `danger` for an irreversible confirm (the confirm button is the danger variant). */
  declare tone: 'neutral' | 'danger';

  constructor() {
    super();
    this.message = '';
    this.confirmLabel = 'Confirm';
    this.cancelLabel = 'Cancel';
    this.tone = 'danger';
    new ConnectedListeners(this, (signal) => {
      // Target phase, before the surface layer's Escape: cancel the row, not the dialog around it.
      this.addEventListener(
        'keydown',
        (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          this.cancel();
        },
        { signal },
      );
    });
  }

  protected override firstUpdated(): void {
    // The safe action gets focus (OVERLAYS-FEEDBACK §2.4: focus on Keep editing / Cancel).
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('.cancel')?.focus());
  }

  confirm(): void {
    emit(this, 'sf-confirm', {});
  }

  cancel(): void {
    emit(this, 'sf-cancel', {});
  }

  override render(): TemplateResult {
    return html`<span class="message" role="status">${this.message}</span>
      <sf-button class="confirm" size="sm" variant=${this.tone === 'danger' ? 'danger' : 'primary'} @click=${() => this.confirm()}>${this.confirmLabel}</sf-button>
      <sf-button class="cancel" size="sm" variant="secondary" @click=${() => this.cancel()}>${this.cancelLabel}</sf-button>`;
  }
}

export function defineConfirmRow(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  if (registry.get(confirmRowSpec.tag) === undefined) defineComponent(SfConfirmRowElement, registry);
}
