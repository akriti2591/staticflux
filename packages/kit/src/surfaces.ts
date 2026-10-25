/**
 * `@staticflux/kit/surfaces` — the visual layer for `@staticflux/messaging`. The surface manager stays the one owner
 * of every dialog, sheet, toast, banner, popover, tooltip and coach mark (arbitration, scope-bound lifetimes, gating,
 * routable `/d/<key>` dialogs); this module only renders what it says is showing. There is no second dialog system.
 *
 * - `<sf-surface-layer>` — layers 3–6 of OVERLAYS-FEEDBACK §1 on the platform: modals are native `<dialog>` elements
 *   opened with `showModal()` (top layer, inert background, focus containment by the browser; the messaging focus
 *   trap without it); anchored surfaces and the toast region use the Popover API. **Order is enforced, not z-indexed:**
 *   opening a modal announces it (`sf-overlay-open`), which closes every kit menu and popover opened before it, and
 *   the manager closes managed popovers and tooltips; while a modal is open the toast region renders inside it, so
 *   toasts stay above it and announced. Escape and the backdrop go through `manager.dismissTop` / `handle.dismiss`
 *   (destructive dialogs: `backdropDismiss: false`; `alert: true` → `alertdialog`). Focus returns to the element that
 *   had it, or — when that is gone — to its nearest surviving landmark, never to `body`. Initial focus: `[autofocus]`,
 *   else the first field, else the primary button, else the first focusable. Toasts: bottom-centre, ≤ 420 px, newest
 *   at the bottom; their timers pause while the pointer is over the stack, a toast has focus, or the tab is hidden.
 *   Below 720 px dialogs become full-height sheets (Home; Studio never gets that narrow).
 * - `<sf-dialog>` — the dialog frame for every dialog type (§2.1): `size` (confirm 420, form 520, wizard 640,
 *   settings 840 px), `tone="danger"`, a wizard **step frame** (`step`, `steps`: back chevron from step 2, `2 of 3`
 *   from three steps, sliding body; Escape on a later step goes back), held changes (`dirty`: Escape, the backdrop,
 *   Back and × show the inline `Discard changes?` row instead of closing).
 * - `<sf-takeover>` — the full-screen takeover frame (milestone preview, Compare, the blocking error): a one-line
 *   banner header with title, meta, actions and `Back`.
 * - `<sf-toast>` — toast content: tone dot, message (two lines), one action, a repeat count (`×3`), `×` when sticky.
 * - `defineDialogSurface` / `defineToastSurface` / `defineConfirmSurface` (re-exported from `./surface-defs`).
 */
import { rememberFocusReturn, type FocusReturn } from '@staticflux/a11y';
import type { Scope } from '@staticflux/core';
import { I18nToken } from '@staticflux/i18n';
import {
  deepActiveElement,
  type DismissReason,
  inertSiblings,
  MODAL_KINDS,
  renderContext,
  type SurfaceHandle,
  type SurfaceManager,
  SurfaceManagerToken,
  type SurfaceRenderContext,
  trapTab,
} from '@staticflux/messaging';
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { defineButton } from './button.js';
import { defineConfirmRow } from './confirm-row.js';
import { defineIconElement } from './icon.js';
import { defineIconButton } from './icon-button.js';
import { chevronLeftIcon } from './icons/chevron-left.js';
import { xIcon } from './icons/x.js';
import { OVERLAY_ATTR } from './overlay.js';
import { type AnchorHandle, anchorFloating } from './position.js';
import { emit } from './internal/events.js';
import { firstFocusableComposed } from './internal/focus.js';
import { closeLayer, openLayer } from './internal/layer.js';
import { announceOverlay, OVERLAY_CLOSE_EVENT, OVERLAY_OPEN_EVENT } from './internal/overlay-session.js';
import { floatingStyles } from './internal/floating-styles.js';
import { baseStyles, t } from './internal/styles.js';
import { kitMessages, kitText } from './messages.js';
import type { ToastTone } from './surface-defs.js';

export * from './surface-defs.js';

// ------------------------------------------------------------------ helpers

function labelOf(handle: SurfaceHandle): string | typeof nothing {
  const label = handle.def.label;
  if (label === undefined) return nothing;
  return typeof label === 'function' ? label(handle.props) : label;
}

function content(handle: SurfaceHandle): unknown {
  return handle.def.render(renderContext(handle));
}

/** Native modal dialogs available (`HTMLDialogElement.showModal`). */
export function supportsModalDialog(dialog: HTMLElement): boolean {
  return typeof (dialog as Partial<HTMLDialogElement>).showModal === 'function';
}

/** Was a click on a `<dialog>` a click on its backdrop (outside its box)? */
export function isBackdropClick(dialog: Element, event: MouseEvent): boolean {
  if (event.target !== dialog) return false;
  const rect = dialog.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return true;
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}

/** Dialog widths (OVERLAYS-FEEDBACK §1.5). */
export const DIALOG_WIDTHS = Object.freeze({ confirm: 420, form: 520, wizard: 640, settings: 840 });
export type DialogSize = keyof typeof DIALOG_WIDTHS;

const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [role="textbox"], [role="combobox"], [role="spinbutton"]';

/** Composed-tree search for the first element matching `selector` (open shadow roots and slots included). */
function findComposed(container: Element, selector: string): HTMLElement | undefined {
  const visit = (node: Element): HTMLElement | undefined => {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert')) return undefined;
    if (node !== container && node instanceof HTMLElement && node.matches(selector) && !node.hasAttribute('disabled')) return node;
    const children: Element[] =
      node.localName === 'slot' ? (node as HTMLSlotElement).assignedElements({ flatten: true }) : node.shadowRoot !== null ? [...node.shadowRoot.children] : [...node.children];
    for (const child of children) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(container);
}

/**
 * Initial focus in a dialog (OVERLAYS-FEEDBACK §1.3): `[autofocus]` (a destructive dialog marks Cancel), else the first
 * field, else the primary action, else the first focusable.
 */
export function dialogInitialFocus(dialog: Element): HTMLElement | undefined {
  return (
    findComposed(dialog, '[autofocus]') ??
    findComposed(dialog, FIELD_SELECTOR) ??
    findComposed(dialog, 'sf-button[variant="primary"], sf-button[variant="danger"], button[data-primary]') ??
    firstFocusableComposed(dialog)
  );
}

// ------------------------------------------------------------------ layer

const layerSpec = component({
  tag: 'sf-surface-layer',
  deps: { render: { surfaces: SurfaceManagerToken }, lazy: { i18n: I18nToken } },
  placeholder: () => nothing,
  description: 'Renders messaging surfaces with native <dialog>, the Popover API and anchor positioning; enforces the layer order.',
});

export class SfSurfaceLayerElement extends SfElement<typeof layerSpec> {
  static override readonly spec = layerSpec;
  static override styles = [
    baseStyles,
    floatingStyles,
    css`
      :host {
        display: contents;
      }
      .banners {
        position: fixed;
        inset-block-start: 0;
        inset-inline: 0;
        display: grid;
        gap: ${t.space.xs.css};
        z-index: ${t.z.toast.css};
        pointer-events: none;
      }
      .banner {
        pointer-events: auto;
      }
      .toasts {
        position: fixed;
        inset: auto;
        inset-block-end: var(--sf-toast-offset, 16px);
        inset-inline: 0;
        margin-block: 0;
        margin-inline: auto;
        padding: 0;
        border: 0;
        background: transparent;
        overflow: visible;
        display: grid;
        gap: ${t.space.sm.css};
        justify-items: center;
        inline-size: min(420px, calc(100vw - 32px));
      }
      .toasts:not([popover]) {
        z-index: ${t.z.toast.css};
      }
      .toast {
        inline-size: 100%;
        opacity: 1;
        transform: none;
        transition:
          opacity ${t.motion.durationNormal.css} ${t.motion.easeEnter.css},
          transform ${t.motion.durationNormal.css} ${t.motion.easeEnter.css};
      }
      @starting-style {
        .toast {
          opacity: 0;
          transform: translateY(8px);
        }
      }
      .toast[data-state='dismissing'] {
        opacity: 0;
        transition-duration: ${t.motion.durationFast.css};
        transition-timing-function: ${t.motion.easeExit.css};
      }
      dialog.modal {
        padding: 0;
        border: 1px solid ${t.color.border.css};
        border-radius: 22px;
        background: ${t.color.surface3.css};
        color: ${t.color.text.css};
        box-shadow: ${t.shadow.level3.css};
        inline-size: min(${DIALOG_WIDTHS.form}px, calc(100vw - 32px));
        max-block-size: 90vh;
        overflow: auto;
        opacity: 1;
        transition: opacity ${t.motion.durationNormal.css} ${t.motion.easeEnter.css};
      }
      dialog.modal:has(sf-dialog[size='confirm']) {
        inline-size: min(${DIALOG_WIDTHS.confirm}px, calc(100vw - 32px));
      }
      dialog.modal:has(sf-dialog[size='wizard']) {
        inline-size: min(${DIALOG_WIDTHS.wizard}px, calc(100vw - 32px));
      }
      dialog.modal:has(sf-dialog[size='settings']) {
        inline-size: min(${DIALOG_WIDTHS.settings}px, calc(100vw - 32px));
        block-size: min(600px, 90vh);
      }
      /* Takeovers fill the surface (milestone preview, Compare, the blocking error). */
      dialog.modal:has(sf-takeover),
      dialog.modal:has(sf-blocking-error) {
        inline-size: 100vw;
        max-inline-size: none;
        block-size: 100vh;
        max-block-size: none;
        margin: 0;
        border: 0;
        border-radius: 0;
      }
      dialog.modal:not([data-native]) {
        position: fixed;
        inset: 0;
        margin: auto;
        block-size: fit-content;
        z-index: ${t.z.overlay.css};
      }
      dialog.sheet {
        margin-block-end: 0;
        inline-size: min(720px, 100vw);
        border-end-start-radius: 0;
        border-end-end-radius: 0;
      }
      /* Narrow widths (Home < 720 px, OVERLAYS-FEEDBACK §1.6): dialogs become full-height sheets. */
      @media (max-width: 719.98px) {
        dialog.modal:not(:has(sf-takeover)):not(:has(sf-blocking-error)) {
          inline-size: 100vw;
          max-inline-size: none;
          margin-block-end: 0;
          block-size: calc(100vh - 24px);
          max-block-size: none;
          border-end-start-radius: 0;
          border-end-end-radius: 0;
          border-start-start-radius: 18px;
          border-start-end-radius: 18px;
        }
      }
      dialog.modal::backdrop {
        background: ${t.color.backdrop.css};
      }
      .backdrop {
        position: fixed;
        inset: 0;
        background: ${t.color.backdrop.css};
        z-index: ${t.z.overlay.css};
      }
      dialog[data-state='dismissing'] {
        opacity: 0;
        transition-timing-function: ${t.motion.easeExit.css};
      }
      dialog[data-state='suspended'] {
        visibility: hidden;
      }
      .content {
        padding: ${t.space.xl.css};
      }
      /* Kit frames (dialog frame, takeover, palette) bring their own padding. */
      .content:has(> sf-dialog, > sf-takeover, > sf-blocking-error, > [data-sf-frame]) {
        padding: 0;
        block-size: 100%;
      }
      .anchored {
        padding: ${t.space.sm.css};
        max-inline-size: min(360px, calc(100vw - 16px));
      }
      .anchored.tooltip {
        pointer-events: none;
        font-size: ${t.type.sizeSm.css};
        background: ${t.color.neutral12.css};
        color: ${t.color.neutral1.css};
        border-color: transparent;
      }
      .anchored.coach-mark {
        padding: 0;
        border: 0;
        background: transparent;
        box-shadow: none;
      }
      @starting-style {
        dialog.modal[open] {
          opacity: 0;
        }
      }
    `,
  ];

  private focusReturn: FocusReturn | undefined;
  private restoreInert: (() => void) | undefined;
  private lastTop: string | undefined;
  private releaseHold: (() => void) | undefined;
  private readonly holds = new Set<'pointer' | 'focus' | 'hidden'>();
  private readonly anchors = new Map<string, AnchorHandle>();

  protected override wireDeps(on: ComponentHooksOf<typeof layerSpec>): void {
    on.onReady('surfaces', (manager: SurfaceManager, scope: Scope) => {
      // Bubble phase: element-local overlays (menus, popovers) close first in the capture phase.
      scope.listen(this.ownerDocument, 'keydown', (event) => this.onKeydown(event as KeyboardEvent, manager));
      scope.listen(this.ownerDocument, 'visibilitychange', () => this.hold(manager, 'hidden', this.ownerDocument.visibilityState === 'hidden'));
      scope.defer(() => {
        this.releaseModal(manager);
        this.releaseHold?.();
        this.releaseHold = undefined;
        for (const anchor of this.anchors.values()) anchor.stop();
        this.anchors.clear();
      });
    });
  }

  /** Toast timers pause while any reason holds (pointer over the stack, focus inside it, tab hidden). */
  private hold(manager: SurfaceManager, reason: 'pointer' | 'focus' | 'hidden', on: boolean): void {
    if (on) this.holds.add(reason);
    else this.holds.delete(reason);
    if (this.holds.size > 0 && this.releaseHold === undefined) this.releaseHold = manager.holdToasts();
    else if (this.holds.size === 0 && this.releaseHold !== undefined) {
      this.releaseHold();
      this.releaseHold = undefined;
    }
  }

  override render(): TemplateResult {
    const manager = this.deps.surfaces;
    const active = manager.active;
    const visible = (h: SurfaceHandle): boolean => h.state !== 'queued';
    const modals = active.filter((h) => MODAL_KINDS.includes(h.def.kind) && visible(h));
    const top = manager.topModal;
    const toasts = this.renderToasts(manager, active.filter((h) => h.def.kind === 'toast' && visible(h)), top !== undefined);
    return html`
      <div class="banners" role="region" aria-label=${kitText(this.deps.i18n, kitMessages.announcements)}>
        ${repeat(
          active.filter((h) => h.def.kind === 'banner' && visible(h)),
          (h) => h.instanceId,
          (h) => html`<div class="banner" role="status" data-state=${h.state} data-surface=${h.def.id} aria-label=${labelOf(h)}>${content(h)}</div>`,
        )}
      </div>
      ${top === undefined ? toasts : nothing}
      ${repeat(
        modals,
        (h) => h.instanceId,
        (h) => html`${h === top && !this.nativeModals ? html`<div class="backdrop" @click=${() => (this.backdropDismisses(h) ? h.dismiss('backdrop') : undefined)}></div>` : nothing}
          <dialog
            class="modal ${h.def.kind}"
            role=${h.def.alert === true ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-label=${labelOf(h)}
            aria-labelledby=${h.def.label === undefined ? h.titleId : nothing}
            data-state=${h.state}
            data-surface=${h.def.id}
            data-instance=${h.instanceId}
            data-sf-overlay=${h.def.kind === 'sheet' ? 'sheet' : 'dialog'}
            ?inert=${h !== top}
            @cancel=${(e: Event) => e.preventDefault()}
            @click=${(e: MouseEvent) => (h === top && this.backdropDismisses(h) && isBackdropClick(e.currentTarget as Element, e) ? h.dismiss('backdrop') : undefined)}
          >
            <div class="content">${content(h)}</div>
            ${h === top ? toasts : nothing}
          </dialog>`,
      )}
      ${repeat(
        active.filter((h) => (h.def.kind === 'popover' || h.def.kind === 'coach-mark' || h.def.kind === 'tooltip') && (h.state === 'showing' || h.state === 'dismissing')),
        (h) => h.instanceId,
        (h) => html`<div
          class="floating anchored ${h.def.kind}"
          role=${h.def.kind === 'tooltip' ? 'tooltip' : 'dialog'}
          aria-label=${labelOf(h)}
          data-state=${h.state}
          data-surface=${h.def.id}
          data-instance=${h.instanceId}
        >
          ${h.step === undefined ? nothing : html`<span class="step">${h.step.index}/${h.step.total}</span>`} ${content(h)}
        </div>`,
      )}
    `;
  }

  private backdropDismisses(handle: SurfaceHandle): boolean {
    return handle.dismissible && handle.def.backdropDismiss !== false;
  }

  private renderToasts(manager: SurfaceManager, toasts: readonly SurfaceHandle[], insideModal: boolean): TemplateResult {
    return html`<div
      class="toasts"
      role="region"
      aria-label=${kitText(this.deps.i18n, kitMessages.notifications)}
      data-in-modal=${insideModal ? 'true' : nothing}
      data-sf-keep-interactive
      @pointerenter=${() => this.hold(manager, 'pointer', true)}
      @pointerleave=${() => this.hold(manager, 'pointer', false)}
      @focusin=${() => this.hold(manager, 'focus', true)}
      @focusout=${(e: FocusEvent) => !(e.currentTarget as Element).contains(e.relatedTarget as Node | null) && this.hold(manager, 'focus', false)}
    >
      <div role="status" aria-live="polite" style="display:contents">
        ${repeat(
          toasts.filter((h) => h.def.priority !== 'urgent'),
          (h) => h.instanceId,
          // No name on the polite rows: their text is what the live region announces.
          (h) => html`<div class="toast" data-state=${h.state} data-surface=${h.def.id}>${content(h)}</div>`,
        )}
      </div>
      ${repeat(
        toasts.filter((h) => h.def.priority === 'urgent'),
        (h) => h.instanceId,
        (h) => html`<div class="toast" role="alert" data-state=${h.state} data-surface=${h.def.id} aria-label=${labelOf(h)}>${content(h)}</div>`,
      )}
    </div>`;
  }

  /** Native `showModal` available in this document (decided once per element). */
  private get nativeModals(): boolean {
    return supportsModalDialog(this.ownerDocument.createElement('dialog'));
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (!this.ready) return;
    const manager = this.deps.surfaces;
    this.syncModals(manager);
    this.syncToasts(manager);
    this.syncAnchored(manager);
  }

  private dialogs(): HTMLDialogElement[] {
    return [...this.renderRoot.querySelectorAll<HTMLDialogElement>('dialog.modal')];
  }

  private syncModals(manager: SurfaceManager): void {
    const top = manager.topModal;
    for (const dialog of this.dialogs()) {
      if (dialog.open) continue;
      if (supportsModalDialog(dialog)) {
        dialog.setAttribute('data-native', '');
        dialog.showModal();
      } else dialog.setAttribute('open', '');
    }
    const topId = top?.instanceId;
    if (topId === this.lastTop) return;
    const opening = this.lastTop === undefined;
    this.lastTop = topId;
    if (top === undefined) {
      this.releaseModal(manager);
      return;
    }
    const element = this.dialogs().find((d) => d.dataset['instance'] === topId);
    if (opening) {
      this.focusReturn = rememberFocusReturn(deepActiveElement(this.ownerDocument));
      // Layer 3 never stays under layer 4: kit menus and popovers opened before this modal close now.
      announceOverlay(this.ownerDocument, OVERLAY_OPEN_EVENT, { host: element ?? this, kind: top.def.kind === 'sheet' ? 'sheet' : 'dialog' });
      // Native modal dialogs make the rest of the document inert themselves.
      if (!this.nativeModals) this.restoreInert = inertSiblings(this);
    }
    if (element === undefined) return;
    element.setAttribute(OVERLAY_ATTR, top.def.kind === 'sheet' ? 'sheet' : 'dialog');
    element.tabIndex = -1;
    element.focus();
    // Content components render after this pass: move focus in once they have (next task).
    setTimeout(() => {
      if (manager.topModal?.instanceId !== topId || !element.isConnected) return;
      const active = deepActiveElement(this.ownerDocument);
      if (active !== null && active !== element && element.contains(active)) return; // the user already moved
      dialogInitialFocus(element)?.focus();
    }, 0);
  }

  private syncToasts(manager: SurfaceManager): void {
    const region = this.renderRoot.querySelector<HTMLElement>('.toasts:not([data-in-modal])');
    if (region === null) return;
    // Outside a modal the region lives in the top layer while any toast shows.
    if (manager.showing('toast').length > 0 || manager.active.some((h) => h.def.kind === 'toast' && h.state === 'dismissing')) openLayer(region);
    else closeLayer(region);
  }

  private syncAnchored(manager: SurfaceManager): void {
    const live = new Set<string>();
    for (const element of this.renderRoot.querySelectorAll<HTMLElement>('.anchored')) {
      const id = element.dataset['instance'] ?? '';
      live.add(id);
      if (this.anchors.has(id)) continue;
      const handle = manager.active.find((h) => h.instanceId === id);
      const anchor = handle?.anchor ?? (handle?.def.target === undefined ? undefined : manager.targets.element(handle.def.target));
      openLayer(element);
      if (anchor !== undefined) this.anchors.set(id, anchorFloating(anchor, element, { side: handle?.def.kind === 'tooltip' ? 'block-start' : 'block-end', align: 'start', offset: 8 }, this.connectionScope?.signal));
    }
    for (const [id, anchor] of this.anchors) {
      if (live.has(id)) continue;
      anchor.stop();
      this.anchors.delete(id);
    }
  }

  private releaseModal(manager: SurfaceManager): void {
    this.restoreInert?.();
    this.restoreInert = undefined;
    const ret = this.focusReturn;
    this.focusReturn = undefined;
    if (this.lastTop !== undefined || ret !== undefined) announceOverlay(this.ownerDocument, OVERLAY_CLOSE_EVENT, { host: this, kind: 'dialog' });
    this.lastTop = undefined;
    // Toasts that moved into the modal move back out with their holds released.
    if (manager.topModal === undefined) this.hold(manager, 'focus', false);
    ret?.restore();
  }

  private onKeydown(event: KeyboardEvent, manager: SurfaceManager): void {
    if (event.key === 'Escape') {
      if (!event.defaultPrevented && manager.dismissTop('escape')) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (this.nativeModals) return; // the browser contains focus in a modal <dialog>
    const top = manager.topModal;
    const element = top === undefined ? undefined : this.dialogs().find((d) => d.dataset['instance'] === top.instanceId);
    if (element !== undefined) trapTab(event, element, deepActiveElement(this.ownerDocument));
  }
}

// ------------------------------------------------------------------ dialog frame

const dialogSpec = component({
  tag: 'sf-dialog',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html`<slot></slot>`,
  description: 'Dialog frame: heading, close, body, actions; sizes, danger tone, wizard steps, held changes with an inline discard row.',
});

export class SfDialogElement extends SfElement<typeof dialogSpec> {
  static override readonly spec = dialogSpec;
  static override properties = {
    heading: {},
    dismissible: { type: Boolean },
    size: { reflect: true },
    tone: { reflect: true },
    step: { type: Number, reflect: true },
    steps: { type: Number },
    dirty: { type: Boolean, reflect: true },
    surface: { attribute: false },
    discarding: { state: true },
  };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: ${t.space.lg.css};
        padding: ${t.space.xl.css};
        max-block-size: 90vh;
      }
      header {
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
      }
      h2 {
        flex: 1;
        margin: 0;
        font-family: ${t.font.familyDisplay.css};
        font-size: 20px;
        font-weight: ${t.font.weightSemibold.css};
        line-height: ${t.type.lineTight.css};
      }
      .indicator {
        font-family: ${t.font.familyMono.css};
        font-size: ${t.type.sizeXs.css};
        color: ${t.color.textMuted.css};
      }
      .body {
        overflow: auto;
        color: ${t.color.textMuted.css};
        line-height: ${t.type.lineNormal.css};
      }
      .body[data-slide] {
        animation: sf-dialog-step ${t.motion.durationNormal.css} ${t.motion.easeEnter.css};
      }
      .body[data-slide='back'] {
        animation-name: sf-dialog-step-back;
      }
      @keyframes sf-dialog-step {
        from {
          opacity: 0;
          transform: translateX(16px);
        }
      }
      @keyframes sf-dialog-step-back {
        from {
          opacity: 0;
          transform: translateX(-16px);
        }
      }
      footer {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: ${t.space.sm.css};
      }
      .start {
        display: flex;
        gap: ${t.space.sm.css};
        margin-inline-end: auto;
      }
      .end {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: ${t.space.sm.css};
        margin-inline-start: auto;
      }
      footer sf-confirm-row {
        flex: 1;
      }
    `,
  ];

  declare heading: string;
  declare dismissible: boolean;
  declare size: DialogSize;
  declare tone: 'neutral' | 'danger';
  /** Wizard: 1-based step (0 = not a wizard). */
  declare step: number;
  /** Wizard: number of steps (the indicator shows from three). */
  declare steps: number;
  /** The dialog holds changes until its verb (form, wizard step): closing asks `Discard changes?` inline. */
  declare dirty: boolean;
  /** The messaging render context: the frame guards dismissals through it (Escape = Back, discard row). */
  declare surface: SurfaceRenderContext<unknown, unknown> | undefined;
  declare discarding: boolean;
  private unguard: (() => void) | undefined;
  private lastStep = 0;
  private slide: 'next' | 'back' | undefined;

  constructor() {
    super();
    this.heading = '';
    this.dismissible = true;
    this.size = 'form';
    this.tone = 'neutral';
    this.step = 0;
    this.steps = 0;
    this.dirty = false;
    this.surface = undefined;
    this.discarding = false;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unguard?.();
    this.unguard = undefined;
  }

  /**
   * A user dismissal (Escape, backdrop, ×): a later wizard step goes back on Escape; held changes show the discard row
   * (OVERLAYS-FEEDBACK §2.1, §2.4). Returns whether the surface may close now.
   */
  allowDismiss(reason: DismissReason): boolean {
    if (this.discarding) return false;
    if (reason === 'escape' && this.step > 1 && !this.dirty) {
      this.back();
      return false;
    }
    if (this.dirty) {
      this.discarding = true;
      return false;
    }
    return true;
  }

  /** Go one step back (the header chevron, Escape on a later step). */
  back(): void {
    if (this.dirty) {
      this.discarding = true;
      return;
    }
    emit(this, 'sf-back', { step: this.step });
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('surface')) {
      this.unguard?.();
      this.unguard = this.surface?.guard?.((reason) => this.allowDismiss(reason));
    }
    if (changed.has('step')) {
      this.slide = this.lastStep === 0 || this.step === this.lastStep ? undefined : this.step > this.lastStep ? 'next' : 'back';
      this.lastStep = this.step;
    }
    if (changed.has('dirty') && !this.dirty) this.discarding = false;
    this.setAttribute('data-sf-frame', '');
  }

  private close(): void {
    if (this.surface !== undefined) this.surface.dismiss('user');
    else if (this.allowDismiss('user')) emit(this, 'sf-close', {});
  }

  private discard(): void {
    this.discarding = false;
    this.dirty = false;
    emit(this, 'sf-discard', {});
    if (this.surface !== undefined) this.surface.dismiss('user');
    else emit(this, 'sf-close', {});
  }

  override render(): TemplateResult {
    const i18n = this.deps.i18n;
    const backButton =
      this.step > 1
        ? html`<sf-icon-button label=${kitText(i18n, kitMessages.back)} size="sm" .tooltip=${false} @click=${() => this.back()}><sf-icon .icon=${chevronLeftIcon}></sf-icon></sf-icon-button>`
        : nothing;
    const indicator = this.steps >= 3 && this.step > 0 ? html`<span class="indicator">${kitText(i18n, kitMessages.stepOf, { step: this.step, total: this.steps })}</span>` : nothing;
    const footer = this.discarding
      ? html`<sf-confirm-row
          message=${kitText(i18n, kitMessages.discardChanges)}
          confirm-label=${kitText(i18n, kitMessages.discard)}
          cancel-label=${kitText(i18n, kitMessages.keepEditing)}
          @sf-confirm=${() => this.discard()}
          @sf-cancel=${() => (this.discarding = false)}
        ></sf-confirm-row>`
      : html`<span class="start"><slot name="actions-start"></slot></span><span class="end"><slot name="actions"></slot></span>`;
    return html`<header>
        ${backButton}
        <h2 part="heading">${this.heading}</h2>
        ${indicator}<slot name="header-actions"></slot>
        ${this.dismissible
          ? html`<sf-icon-button label=${kitText(i18n, kitMessages.close)} size="sm" .tooltip=${false} @click=${() => this.close()}><sf-icon .icon=${xIcon}></sf-icon></sf-icon-button>`
          : nothing}
      </header>
      <div class="body" part="body" data-slide=${this.slide ?? nothing}><slot></slot></div>
      <footer part="actions">${footer}</footer>`;
  }
}

// ------------------------------------------------------------------ takeover frame

const takeoverSpec = component({
  tag: 'sf-takeover',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html`<slot></slot>`,
  description: 'Full-screen takeover frame: one-line banner header (title, meta, actions, Back) over a full body.',
});

export class SfTakeoverElement extends SfElement<typeof takeoverSpec> {
  static override readonly spec = takeoverSpec;
  static override properties = { heading: {}, meta: {}, backLabel: { attribute: 'back-label' } };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        block-size: 100%;
        background: ${t.color.canvas.css};
      }
      header {
        display: flex;
        align-items: center;
        gap: ${t.space.md.css};
        min-block-size: 48px;
        padding-inline: ${t.space.lg.css};
        background: ${t.color.surface1.css};
        border-block-end: 1px solid ${t.color.border.css};
      }
      h2 {
        margin: 0;
        font-size: ${t.type.sizeMd.css};
        font-weight: ${t.font.weightSemibold.css};
      }
      .meta {
        flex: 1;
        min-inline-size: 0;
        color: ${t.color.textMuted.css};
        font-size: ${t.type.sizeSm.css};
      }
      .actions {
        display: flex;
        gap: ${t.space.sm.css};
      }
      .body {
        min-block-size: 0;
        overflow: auto;
      }
    `,
  ];

  declare heading: string;
  declare meta: string;
  declare backLabel: string;

  constructor() {
    super();
    this.heading = '';
    this.meta = '';
    this.backLabel = '';
  }

  protected override willUpdate(): void {
    this.setAttribute('data-sf-frame', '');
  }

  override render(): TemplateResult {
    const back = this.backLabel === '' ? kitText(this.deps.i18n, kitMessages.back) : this.backLabel;
    return html`<header part="header">
        <h2 part="heading">${this.heading}</h2>
        <span class="meta">${this.meta}</span>
        <span class="actions"><slot name="actions"></slot></span>
        <sf-button variant="primary" size="sm" @click=${() => emit(this, 'sf-back', {})}>${back}</sf-button>
      </header>
      <div class="body" part="body"><slot></slot></div>`;
  }
}

// ------------------------------------------------------------------ toast content

const toastSpec = component({
  tag: 'sf-toast',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html`<slot></slot>`,
  description: 'Toast content: tone dot, message (two lines), one action, repeat count, dismiss when sticky.',
});

export class SfToastElement extends SfElement<typeof toastSpec> {
  static override readonly spec = toastSpec;
  static override properties = { tone: { reflect: true }, dismissible: { type: Boolean }, count: { type: Number } };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        min-block-size: 44px;
        padding-block: ${t.space.sm.css};
        padding-inline: ${t.space.md.css};
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.lg.css};
        background: ${t.color.surface2.css};
        box-shadow: ${t.shadow.level2.css};
        font-size: 13px;
      }
      .dot {
        flex: none;
        inline-size: 8px;
        block-size: 8px;
        border-radius: 50%;
        background: ${t.color.neutral8.css};
      }
      :host([tone='neutral']) .dot {
        display: none;
      }
      :host([tone='info']) .dot {
        background: ${t.color.info.css};
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
      .message {
        flex: 1;
        line-height: ${t.type.lineNormal.css};
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .count {
        font-family: ${t.font.familyMono.css};
        color: ${t.color.textMuted.css};
      }
      @media (forced-colors: active) {
        .dot {
          background: CanvasText;
        }
      }
    `,
  ];

  declare tone: ToastTone;
  /** Sticky toasts show `×`; timed ones go by themselves (OVERLAYS-FEEDBACK §3.5). */
  declare dismissible: boolean;
  /** Repeats of a deduplicated toast (`Copied ×3`); not re-announced. */
  declare count: number;

  constructor() {
    super();
    this.tone = 'neutral';
    this.dismissible = true;
    this.count = 1;
  }

  override render(): TemplateResult {
    return html`<span class="dot" aria-hidden="true"></span><span class="message" part="message"><slot></slot>${this.count > 1
          ? html` <span class="count" aria-hidden="true">×${this.count}</span>`
          : nothing}</span
      ><slot name="action"></slot>${this.dismissible
        ? html`<sf-icon-button label=${kitText(this.deps.i18n, kitMessages.dismiss)} size="sm" .tooltip=${false} @click=${() => emit(this, 'sf-dismiss', {})}
            ><sf-icon .icon=${xIcon}></sf-icon></sf-icon-button
          >`
        : nothing}`;
  }
}

/** Register the layer, the frames and the toast element (and the controls they render). */
export function defineSurfaces(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconButton(registry);
  defineIconElement(registry);
  defineConfirmRow(registry);
  if (registry.get(dialogSpec.tag) === undefined) defineComponent(SfDialogElement, registry);
  if (registry.get(takeoverSpec.tag) === undefined) defineComponent(SfTakeoverElement, registry);
  if (registry.get(toastSpec.tag) === undefined) defineComponent(SfToastElement, registry);
  if (registry.get(layerSpec.tag) === undefined) defineComponent(SfSurfaceLayerElement, registry);
}
