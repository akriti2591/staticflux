/**
 * `<sf-popover label="Text options">` — an anchored, non-modal dialog (WAI-ARIA APG
 * disclosure + dialog): the `trigger` slot toggles it (`aria-expanded`,
 * `aria-haspopup="dialog"` on the trigger), focus moves into the panel on open, Escape or
 * an outside press closes it and focus returns to the trigger. The panel is in the top
 * layer (Popover API) and placed with CSS anchor positioning or the JS fallback.
 *
 * Element-local overlay: it lives and dies with its element (scope-bound by construction).
 * Feature-level transient surfaces requested through `@staticflux/messaging` are rendered
 * by `<sf-surface-layer>` instead.
 *
 * ```html
 * <sf-popover label="Text options" @sf-toggle=${…}>
 *   <sf-button slot="trigger">Aa</sf-button>
 *   <sf-slider label="Size"></sf-slider>
 * </sf-popover>
 * ```
 */
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { type AnchorHandle, anchorFloating, type Align, type Side } from './position.js';
import { emit } from './internal/events.js';
import { ConnectedListeners } from './internal/listeners.js';
import { closeLayer, lightDismiss, openLayer } from './internal/layer.js';
import { floatingStyles } from './internal/floating-styles.js';
import { baseStyles, t } from './internal/styles.js';

export interface ToggleDetail {
  readonly open: boolean;
}

const popoverSpec = component({
  tag: 'sf-popover',
  placeholder: () => html`<slot name="trigger"></slot>`,
  description: 'Anchored non-modal dialog toggled by its trigger; top layer, light dismiss, focus return.',
});

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** First focusable element among `roots` (light DOM, including kit hosts with tabindex). */
export function firstFocusable(roots: readonly Element[]): HTMLElement | undefined {
  for (const root of roots) {
    if (root instanceof HTMLElement && root.matches(FOCUSABLE) && !root.hasAttribute('disabled')) return root;
    const inner = root.querySelector<HTMLElement>(FOCUSABLE);
    if (inner !== null) return inner;
  }
  return undefined;
}

export class SfPopoverElement extends SfElement<typeof popoverSpec> {
  static override readonly spec = popoverSpec;
  static override properties = {
    open: { type: Boolean, reflect: true },
    label: {},
    side: {},
    align: {},
    anchor: { attribute: false },
  };
  static override styles = [
    baseStyles,
    floatingStyles,
    css`
      :host {
        display: inline-block;
      }
      .anchor {
        display: inline-flex;
      }
      .panel {
        min-inline-size: 160px;
        max-inline-size: min(360px, calc(100vw - 16px));
        max-block-size: min(480px, calc(100vh - 16px));
        overflow: auto;
        padding: ${t.space.md.css};
        border-radius: ${t.radius.lg.css};
        box-shadow: ${t.shadow.level2.css};
      }
    `,
  ];

  declare open: boolean;
  declare label: string;
  declare side: Side;
  declare align: Align;
  /** Anchor element when there is no `trigger` slot (e.g. a selection on a canvas). */
  declare anchor: Element | undefined;
  private anchored: AnchorHandle | undefined;
  private dismiss: AbortController | undefined;
  private returnFocus = true;
  private readonly listeners: ConnectedListeners;

  constructor() {
    super();
    this.open = false;
    this.label = '';
    this.side = 'block-end';
    this.align = 'start';
    this.anchor = undefined;
    this.listeners = new ConnectedListeners(this, (signal) => {
      this.addEventListener(
        'click',
        (event) => {
          const trigger = this.trigger;
          if (trigger !== undefined && event.composedPath().includes(trigger)) this.toggle();
        },
        { signal },
      );
    });
  }

  /** The element in the `trigger` slot. */
  get trigger(): HTMLElement | undefined {
    return this.querySelector<HTMLElement>(':scope > [slot="trigger"]') ?? undefined;
  }

  get panel(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.panel');
  }

  show(): void {
    this.open = true;
  }

  hide(): void {
    this.open = false;
  }

  toggle(): void {
    this.open = !this.open;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardown();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const trigger = this.trigger;
    if (trigger !== undefined) {
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    }
    if (changed.has('open') && changed.get('open') !== undefined) emit<ToggleDetail>(this, 'sf-toggle', { open: this.open });
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has('open')) return;
    if (this.open) this.setup();
    else if (changed.get('open') === true) {
      this.teardown();
      if (this.returnFocus) this.trigger?.focus();
      this.returnFocus = true;
    }
  }

  private setup(): void {
    const panel = this.panel;
    if (panel === null) return;
    openLayer(panel);
    const anchor = this.anchor ?? this.renderRoot.querySelector('.anchor') ?? this;
    this.anchored = anchorFloating(anchor, panel, { side: this.side, align: this.align, offset: 6 }, this.listeners.signal);
    this.dismiss = new AbortController();
    lightDismiss(
      () => [panel, this, ...(this.anchor === undefined ? [] : [this.anchor])],
      (cause) => {
        // A press elsewhere moves focus there; only Escape returns focus to the trigger.
        this.returnFocus = cause === 'escape';
        this.open = false;
      },
      this.ownerDocument,
      this.dismiss.signal,
    );
    (firstFocusable([...this.children].filter((c) => c.getAttribute('slot') !== 'trigger')) ?? panel).focus();
  }

  private teardown(): void {
    this.dismiss?.abort();
    this.dismiss = undefined;
    this.anchored?.stop();
    this.anchored = undefined;
    const panel = this.panel;
    if (panel !== null) closeLayer(panel);
  }

  override render(): TemplateResult {
    return html`<span class="anchor"><slot name="trigger"></slot></span>
      <div class="floating panel" part="panel" role="dialog" aria-label=${this.label || nothing} tabindex="-1"><slot></slot></div>`;
  }
}

export function definePopover(registry: CustomElementRegistry = customElements): void {
  if (registry.get(popoverSpec.tag) === undefined) defineComponent(SfPopoverElement, registry);
}
