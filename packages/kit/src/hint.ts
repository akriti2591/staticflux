/**
 * `<sf-hint text="Drag on the canvas to draw a frame.">` — the first-use hint card (OVERLAYS-FEEDBACK §5, FOUNDATIONS
 * §4.22): one sentence in a small white card with a `×`, anchored to a tool or a region. It never blocks: no focus
 * trap, no dimming, not in the tab order, Escape does not dismiss it (it belongs to nothing the person opened). It
 * leaves when `×` is pressed (`sf-dismiss`), when its 6 s timer ends (`sf-expire`), or when the app sees the target
 * used. Rendered as a messaging `coach-mark` through `defineHintSurface` (`./surface-defs`): the layer gives it the
 * `dialog` role named by the sentence, and the sentence is announced politely once.
 */
import { I18nToken } from '@staticflux/i18n';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { defineIconElement } from './icon.js';
import { xIcon } from './icons/x.js';
import { emit } from './internal/events.js';
import { baseStyles, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';

/** A hint shows for this long unless dismissed first (ms). */
export const HINT_MS = 6000;

const hintSpec = component({
  tag: 'sf-hint',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html``,
  description: 'First-use hint card: one sentence and ×, never blocking, gone after 6 s.',
});

export class SfHintElement extends SfElement<typeof hintSpec> {
  static override readonly spec = hintSpec;
  static override properties = { text: {}, durationMs: { type: Number, attribute: 'duration-ms' } };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        align-items: flex-start;
        gap: ${t.space.sm.css};
        max-inline-size: 280px;
        padding: ${t.space.sm.css} ${t.space.sm.css} ${t.space.sm.css} ${t.space.md.css};
        border-radius: 12px;
        background: ${t.color.surface2.css};
        box-shadow: ${t.shadow.level2.css};
        font-size: 13px;
        line-height: ${t.type.lineNormal.css};
      }
      .text {
        flex: 1;
        padding-block: 4px;
      }
      /* Not in the tab order (§5): the hint leaves with its timer or the target's use. */
      button {
        all: unset;
        display: inline-grid;
        place-items: center;
        inline-size: 24px;
        block-size: 24px;
        border-radius: ${t.radius.full.css};
        color: ${t.color.textMuted.css};
      }
      button:hover {
        background: ${t.color.surfaceHover.css};
      }
      @media (forced-colors: active) {
        :host {
          border: 1px solid CanvasText;
        }
      }
    `,
  ];

  declare text: string;
  declare durationMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.text = '';
    this.durationMs = HINT_MS;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => emit(this, 'sf-expire', {}), this.durationMs);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }

  override render(): TemplateResult {
    return html`<span class="text" role="status">${this.text}</span>
      <button type="button" tabindex="-1" aria-label=${kitText(this.deps.i18n, kitMessages.dismiss)} @click=${() => emit(this, 'sf-dismiss', {})}><sf-icon .icon=${xIcon}></sf-icon></button>`;
  }
}

export function defineHint(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  if (registry.get(hintSpec.tag) === undefined) defineComponent(SfHintElement, registry);
}
