/**
 * `<sf-popover label="Text options">` — an anchored, non-modal dialog (WAI-ARIA APG disclosure + dialog), layer 3 of
 * OVERLAYS-FEEDBACK §1: the `trigger` slot toggles it (`aria-expanded`, `aria-haspopup="dialog"`); focus moves in when
 * it holds a focusable control and otherwise stays on the trigger; Escape closes it and focus returns to the trigger
 * (or, when the trigger is gone, to `returnFallback` or the trigger's nearest landmark). The panel is in the top layer
 * (Popover API), 8 px from its anchor, placed with CSS anchor positioning or the JS fallback.
 *
 * Light dismiss (§1.4): `outside="consume"` (default; chrome popovers) closes on an outside press and swallows it, and
 * the popover follows its anchor on scroll; `outside="pass"` (HUD and inspector popovers) closes and lets the press
 * through, so one click selects the next element (Canva), and wheel or scroll outside closes it. Opening another
 * popover or menu elsewhere, or any dialog, closes it. A popover never opens inside a popover or a menu (SF-KIT-003,
 * `sf-overlay-refused`): grow or swap the content in place instead. `suspended` hides the panel while it stays open
 * (the colour popover's eyedropper).
 *
 * Element-local overlay: it lives and dies with its element (scope-bound by construction). Feature-level transient
 * surfaces requested through `@staticflux/messaging` are rendered by `<sf-surface-layer>` instead.
 *
 * ```html
 * <sf-popover label="Fill colour" outside="pass" @sf-toggle=${…}>
 *   <sf-button slot="trigger">Aa</sf-button>
 *   <sf-color-popover …></sf-color-popover>
 * </sf-popover>
 * ```
 */
import { rememberFocusReturn, type FocusReturn } from '@staticflux/a11y';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { type AnchorHandle, anchorFloating, type Align, type Side } from './position.js';
import { OVERLAY_GAP } from './overlay.js';
import { emit } from './internal/events.js';
import { firstFocusableComposed } from './internal/focus.js';
import { ConnectedListeners } from './internal/listeners.js';
import { closeLayer, openLayer } from './internal/layer.js';
import { type OverlayDismissCause, OverlaySession } from './internal/overlay-session.js';
import { floatingStyles } from './internal/floating-styles.js';
import { baseStyles, t } from './internal/styles.js';

export interface ToggleDetail {
  readonly open: boolean;
  /** Why it closed (absent when opening or closed by the app). */
  readonly cause?: OverlayDismissCause | 'trigger';
}

const popoverSpec = component({
  tag: 'sf-popover',
  placeholder: () => html`<slot name="trigger"></slot>`,
  description: 'Anchored non-modal dialog toggled by its trigger; top layer, consumed or pass-through light dismiss, focus return.',
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

/** Does focus come back to the trigger after this close? (A pass-through press moved it; a newer overlay took it.) */
export function popoverReturnsFocus(cause: OverlayDismissCause | 'trigger' | undefined, outside: 'consume' | 'pass'): boolean {
  if (cause === 'replaced' || cause === 'parent') return false;
  return !(cause === 'outside' && outside === 'pass');
}

export class SfPopoverElement extends SfElement<typeof popoverSpec> {
  static override readonly spec = popoverSpec;
  static override properties = {
    open: { type: Boolean, reflect: true },
    label: {},
    side: {},
    align: {},
    anchor: { attribute: false },
    outside: { reflect: true },
    suspended: { type: Boolean, reflect: true },
    returnFallback: { attribute: false },
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
        padding: 14px;
        border-radius: ${t.radius.lg.css};
        box-shadow: ${t.shadow.level2.css};
      }
      :host([suspended]) .panel {
        visibility: hidden;
      }
    `,
  ];

  declare open: boolean;
  declare label: string;
  declare side: Side;
  declare align: Align;
  /** Anchor element when there is no `trigger` slot (a HUD item, a menu's original trigger). */
  declare anchor: Element | undefined;
  /** `consume` (chrome popovers) or `pass` (HUD and inspector popovers). */
  declare outside: 'consume' | 'pass';
  /** Hidden while open (e.g. while the eyedropper picks). */
  declare suspended: boolean;
  /** Where focus goes when the trigger is gone on close (the canvas for HUD popovers). */
  declare returnFallback: Element | undefined;
  private anchored: AnchorHandle | undefined;
  private cause: OverlayDismissCause | 'trigger' | undefined;
  private focusReturn: FocusReturn | undefined;
  private readonly listeners: ConnectedListeners;
  private readonly session: OverlaySession;

  constructor() {
    super();
    this.open = false;
    this.label = '';
    this.side = 'block-end';
    this.align = 'start';
    this.anchor = undefined;
    this.outside = 'consume';
    this.suspended = false;
    this.returnFallback = undefined;
    this.session = new OverlaySession(this, {
      kind: () => 'popover',
      panel: () => this.panel,
      inside: () => [this, ...(this.panel === null ? [] : [this.panel]), ...(this.anchor === undefined ? [] : [this.anchor])],
      outside: () => this.outside,
      scroll: () => (this.outside === 'pass' ? 'close' : 'follow'),
      onDismiss: (cause) => this.close(cause),
    });
    this.listeners = new ConnectedListeners(this, (signal) => {
      this.addEventListener(
        'click',
        (event) => {
          const trigger = this.trigger;
          if (trigger === undefined || !event.composedPath().includes(trigger)) return;
          if (this.open) this.close('trigger');
          else this.show();
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

  /** Open; refused (SF-KIT-003) inside a popover or a menu. */
  show(): Result<void, SfError> {
    const verdict = this.session.check();
    if (!verdict.ok) {
      emit(this, 'sf-overlay-refused', { error: verdict.error });
      return err(verdict.error);
    }
    this.cause = undefined;
    this.open = true;
    return ok(undefined);
  }

  hide(): void {
    this.close(undefined);
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  private close(cause: OverlayDismissCause | 'trigger' | undefined): void {
    this.cause = cause;
    this.open = false;
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
    if (changed.has('open') && changed.get('open') !== undefined) {
      emit<ToggleDetail>(this, 'sf-toggle', this.open || this.cause === undefined ? { open: this.open } : { open: false, cause: this.cause });
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has('open')) return;
    if (this.open) this.setup();
    else if (changed.get('open') === true) {
      this.teardown();
      if (popoverReturnsFocus(this.cause, this.outside)) this.focusReturn?.restore();
      this.focusReturn = undefined;
      this.cause = undefined;
    }
  }

  private setup(): void {
    const panel = this.panel;
    if (panel === null) return;
    this.focusReturn = rememberFocusReturn(this.trigger ?? this.anchor ?? null, { fallback: () => this.returnFallback });
    openLayer(panel);
    const anchor = this.anchor ?? this.renderRoot.querySelector('.anchor') ?? this;
    this.anchored = anchorFloating(anchor, panel, { side: this.side, align: this.align, offset: OVERLAY_GAP.popover }, this.listeners.signal);
    this.session.open();
    // Focus moves in only when there is a control to type into or press (§1.3); otherwise it stays on the trigger.
    const content = [...this.children].filter((c) => c.getAttribute('slot') !== 'trigger');
    (firstFocusable(content) ?? content.map((c) => firstFocusableComposed(c)).find((c) => c !== undefined))?.focus();
  }

  private teardown(): void {
    this.session.close();
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
