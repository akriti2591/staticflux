/**
 * `@staticflux/kit/surfaces` — the visual layer for `@staticflux/messaging`. The surface
 * manager stays the one owner of every dialog, sheet, toast, banner, popover, tooltip and
 * coach mark (arbitration, scope-bound lifetimes, gating, routable `/d/<key>` dialogs);
 * this module only renders what it says is showing. There is no second dialog system.
 *
 * - `<sf-surface-layer>` — a drop-in alternative to messaging's `<sf-surface-host>` built
 *   on the platform: modals are native `<dialog>` elements opened with `showModal()` (top
 *   layer, inert background, focus containment by the browser; falls back to the
 *   messaging focus trap without it), anchored surfaces and the toast region use the
 *   Popover API (top layer) and CSS anchor positioning with a JS fallback. Escape and the
 *   backdrop go through `manager.dismissTop` / `handle.dismiss`, so dismissibility,
 *   arbitration and routable dismiss intents stay in messaging. While a modal is open the
 *   toast region renders inside it, so toasts stay announced (a modal makes everything
 *   outside it inert).
 * - `<sf-dialog>` — dialog content frame: heading, close button, body, `actions` slot.
 * - `<sf-toast>` — toast content: tone stripe, message, `action` slot, dismiss button.
 * - `defineDialogSurface` / `defineToastSurface` (re-exported from `./surface-defs`, which has
 *   no element code so boot modules can declare surfaces without loading the layer).
 */
import type { Scope } from '@staticflux/core';
import { I18nToken } from '@staticflux/i18n';
import {
  deepActiveElement,
  inertSiblings,
  MODAL_KINDS,
  type SurfaceHandle,
  type SurfaceManager,
  SurfaceManagerToken,
  trapTab,
} from '@staticflux/messaging';
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { defineButton } from './button.js';
import { defineIconButton } from './icon-button.js';
import { type AnchorHandle, anchorFloating } from './position.js';
import { emit } from './internal/events.js';
import { firstFocusableComposed } from './internal/focus.js';
import { closeLayer, openLayer } from './internal/layer.js';
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
  return handle.def.render({
    props: handle.props,
    dismiss: (reason, result) => handle.dismiss(reason ?? 'action', result),
    titleId: handle.titleId,
    ...(handle.step === undefined ? {} : { step: handle.step }),
  });
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

// ------------------------------------------------------------------ layer

const layerSpec = component({
  tag: 'sf-surface-layer',
  deps: { render: { surfaces: SurfaceManagerToken }, lazy: { i18n: I18nToken } },
  placeholder: () => nothing,
  description: 'Renders messaging surfaces with native <dialog>, the Popover API and anchor positioning.',
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
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        padding-block: ${t.space.sm.css};
        padding-inline: ${t.space.lg.css};
        background: ${t.color.infoSubtle.css};
        color: ${t.color.text.css};
        border-block-end: 1px solid ${t.color.border.css};
      }
      .toasts {
        position: fixed;
        inset: auto;
        inset-block-end: ${t.space.lg.css};
        inset-inline-end: ${t.space.lg.css};
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        overflow: visible;
        display: grid;
        gap: ${t.space.sm.css};
        inline-size: min(380px, calc(100vw - 32px));
      }
      .toasts:not([popover]) {
        z-index: ${t.z.toast.css};
      }
      .toast {
        opacity: 1;
        transition: opacity ${t.motion.durationNormal.css} ${t.motion.easeEnter.css};
      }
      .toast[data-state='dismissing'] {
        opacity: 0;
        transition-timing-function: ${t.motion.easeExit.css};
      }
      dialog.modal {
        padding: 0;
        border: 1px solid ${t.color.border.css};
        border-radius: ${t.radius.lg.css};
        background: ${t.color.surface3.css};
        color: ${t.color.text.css};
        box-shadow: ${t.shadow.level3.css};
        inline-size: min(560px, calc(100vw - 32px));
        max-block-size: calc(100vh - 64px);
        overflow: auto;
        opacity: 1;
        transition: opacity ${t.motion.durationNormal.css} ${t.motion.easeEnter.css};
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
      /* Kit frames (dialog frame, palette) bring their own padding. */
      .content:has(> sf-dialog, > [data-sf-frame]) {
        padding: 0;
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
        padding: ${t.space.md.css};
        border-color: ${t.color.accent.css};
        box-shadow: ${t.shadow.level2.css};
      }
      @starting-style {
        dialog.modal[open] {
          opacity: 0;
        }
      }
    `,
  ];

  private restoreFocus: Element | null = null;
  private restoreInert: (() => void) | undefined;
  private lastTop: string | undefined;
  private readonly anchors = new Map<string, AnchorHandle>();

  protected override wireDeps(on: ComponentHooksOf<typeof layerSpec>): void {
    on.onReady('surfaces', (manager: SurfaceManager, scope: Scope) => {
      // Bubble phase: element-local overlays (menus, popovers) close first in the capture phase.
      scope.listen(this.ownerDocument, 'keydown', (event) => this.onKeydown(event as KeyboardEvent, manager));
      scope.defer(() => {
        this.releaseModal();
        for (const anchor of this.anchors.values()) anchor.stop();
        this.anchors.clear();
      });
    });
  }

  override render(): TemplateResult {
    const manager = this.deps.surfaces;
    const active = manager.active;
    const visible = (h: SurfaceHandle): boolean => h.state !== 'queued';
    const modals = active.filter((h) => MODAL_KINDS.includes(h.def.kind) && visible(h));
    const top = manager.topModal;
    const toasts = this.renderToasts(active.filter((h) => h.def.kind === 'toast' && visible(h)), top !== undefined);
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
        (h) => html`${h === top && !this.nativeModals ? html`<div class="backdrop" @click=${() => (h.dismissible ? h.dismiss('backdrop') : undefined)}></div>` : nothing}
          <dialog
            class="modal ${h.def.kind}"
            aria-modal="true"
            aria-label=${labelOf(h)}
            aria-labelledby=${h.def.label === undefined ? h.titleId : nothing}
            data-state=${h.state}
            data-surface=${h.def.id}
            data-instance=${h.instanceId}
            ?inert=${h !== top}
            @cancel=${(e: Event) => e.preventDefault()}
            @click=${(e: MouseEvent) => (h === top && h.dismissible && isBackdropClick(e.currentTarget as Element, e) ? h.dismiss('backdrop') : undefined)}
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

  private renderToasts(toasts: readonly SurfaceHandle[], insideModal: boolean): TemplateResult {
    return html`<div class="toasts" role="region" aria-label=${kitText(this.deps.i18n, kitMessages.notifications)} data-in-modal=${insideModal ? 'true' : nothing}>
      <div role="status" aria-live="polite" style="display:contents">
        ${repeat(
          toasts.filter((h) => h.def.priority !== 'urgent'),
          (h) => h.instanceId,
          (h) => html`<div class="toast" data-state=${h.state} data-surface=${h.def.id} aria-label=${labelOf(h)}>${content(h)}</div>`,
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
      this.releaseModal();
      return;
    }
    if (opening) {
      this.restoreFocus = deepActiveElement(this.ownerDocument);
      // Native modal dialogs make the rest of the document inert themselves.
      if (!this.nativeModals) this.restoreInert = inertSiblings(this);
    }
    const element = this.dialogs().find((d) => d.dataset['instance'] === topId);
    if (element === undefined) return;
    element.tabIndex = -1;
    element.focus();
    // Content components render after this pass: move focus in once they have (next task).
    setTimeout(() => {
      if (manager.topModal?.instanceId !== topId || !element.isConnected) return;
      const active = deepActiveElement(this.ownerDocument);
      if (active !== null && active !== element && element.contains(active)) return; // the user already moved
      firstFocusableComposed(element)?.focus();
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
      if (anchor !== undefined) this.anchors.set(id, anchorFloating(anchor, element, { side: handle?.def.kind === 'tooltip' ? 'block-start' : 'block-end', align: 'start', offset: 6 }, this.connectionScope?.signal));
    }
    for (const [id, anchor] of this.anchors) {
      if (live.has(id)) continue;
      anchor.stop();
      this.anchors.delete(id);
    }
  }

  private releaseModal(): void {
    this.restoreInert?.();
    this.restoreInert = undefined;
    const target = this.restoreFocus;
    this.restoreFocus = null;
    this.lastTop = undefined;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
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
  description: 'Dialog content frame: heading, close button, body, actions.',
});

export class SfDialogElement extends SfElement<typeof dialogSpec> {
  static override readonly spec = dialogSpec;
  static override properties = { heading: {}, dismissible: { type: Boolean } };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        gap: ${t.space.lg.css};
        padding: ${t.space.xl.css};
      }
      header {
        display: flex;
        align-items: flex-start;
        gap: ${t.space.md.css};
      }
      h2 {
        flex: 1;
        margin: 0;
        font-size: ${t.type.sizeXl.css};
        font-weight: ${t.font.weightSemibold.css};
        line-height: ${t.type.lineTight.css};
      }
      .body {
        color: ${t.color.textMuted.css};
        line-height: ${t.type.lineNormal.css};
      }
      footer {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: ${t.space.sm.css};
      }
      footer:not(:has(slot)) {
        display: none;
      }
    `,
  ];

  declare heading: string;
  declare dismissible: boolean;

  constructor() {
    super();
    this.heading = '';
    this.dismissible = true;
  }

  override render(): TemplateResult {
    return html`<header>
        <h2 part="heading">${this.heading}</h2>
        ${this.dismissible
          ? html`<sf-icon-button label=${kitText(this.deps.i18n, kitMessages.close)} size="sm" .tooltip=${false} @click=${() => emit(this, 'sf-close', {})}
              ><span aria-hidden="true">✕</span></sf-icon-button
            >`
          : nothing}
      </header>
      <div class="body" part="body"><slot></slot></div>
      <footer part="actions"><slot name="actions"></slot></footer>`;
  }
}

// ------------------------------------------------------------------ toast content


const toastSpec = component({
  tag: 'sf-toast',
  deps: { lazy: { i18n: I18nToken } },
  placeholder: () => html`<slot></slot>`,
  description: 'Toast content: tone stripe, message, action slot, dismiss button.',
});

export class SfToastElement extends SfElement<typeof toastSpec> {
  static override readonly spec = toastSpec;
  static override properties = { tone: { reflect: true }, dismissible: { type: Boolean } };
  static override styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: ${t.space.sm.css};
        padding-block: ${t.space.sm.css};
        padding-inline: ${t.space.md.css};
        border: 1px solid ${t.color.border.css};
        border-inline-start: 3px solid ${t.color.neutral8.css};
        border-radius: ${t.radius.md.css};
        background: ${t.color.surface2.css};
        box-shadow: ${t.shadow.level2.css};
      }
      :host([tone='info']) {
        border-inline-start-color: ${t.color.info.css};
      }
      :host([tone='success']) {
        border-inline-start-color: ${t.color.success.css};
      }
      :host([tone='warning']) {
        border-inline-start-color: ${t.color.warning.css};
      }
      :host([tone='danger']) {
        border-inline-start-color: ${t.color.danger.css};
      }
      .message {
        flex: 1;
        line-height: ${t.type.lineNormal.css};
      }
    `,
  ];

  declare tone: ToastTone;
  declare dismissible: boolean;

  constructor() {
    super();
    this.tone = 'neutral';
    this.dismissible = true;
  }

  override render(): TemplateResult {
    return html`<span class="message" part="message"><slot></slot></span><slot name="action"></slot>${this.dismissible
        ? html`<sf-icon-button label=${kitText(this.deps.i18n, kitMessages.dismiss)} size="sm" .tooltip=${false} @click=${() => emit(this, 'sf-dismiss', {})}
            ><span aria-hidden="true">✕</span></sf-icon-button
          >`
        : nothing}`;
  }
}

/** Register the layer, the frame and the toast element (and the buttons they render). */
export function defineSurfaces(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineIconButton(registry);
  if (registry.get(dialogSpec.tag) === undefined) defineComponent(SfDialogElement, registry);
  if (registry.get(toastSpec.tag) === undefined) defineComponent(SfToastElement, registry);
  if (registry.get(layerSpec.tag) === undefined) defineComponent(SfSurfaceLayerElement, registry);
}
