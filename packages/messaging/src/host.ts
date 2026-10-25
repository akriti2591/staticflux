/**
 * `<sf-surface-host>` — renders every surface of the manager with one stacking,
 * focus/a11y and motion model (R13.4, R13.5):
 *
 * - layers (bottom → top): banners · toasts · modal stack (dialog/sheet) · anchored
 *   (popover, coach mark, tooltip);
 * - modals: `role="dialog"`, `aria-modal`, backdrop, focus moved in and trapped (Tab),
 *   restored on close, background `inert`; suspended modals stay in the DOM but inert;
 * - Escape dismisses the top-most dismissible transient/modal surface;
 * - toasts in a polite live region; urgent toasts use `role="alert"`;
 * - anchored surfaces are positioned with a measure → mutate pass (no layout thrash);
 * - motion: opacity/transform only; `prefers-reduced-motion` disables transitions.
 *
 * It is a normal StaticFlux component: the manager is a render dependency.
 */
import type { Scope } from '@staticflux/core';
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { deepActiveElement, focusFirst, inertSiblings, trapTab } from './focus.js';
import { renderContext, type SurfaceHandle, type SurfaceManager } from './manager.js';
import { MODAL_KINDS } from './surface.js';
import { SurfaceManagerToken } from './tokens.js';

const hostSpec = component({
  tag: 'sf-surface-host',
  deps: { render: { surfaces: SurfaceManagerToken } },
  placeholder: () => nothing,
  description: 'Renders all messaging surfaces (dialogs, sheets, toasts, banners, popovers, tooltips, coach marks).',
});

function labelOf(handle: SurfaceHandle): string | typeof nothing {
  const label = handle.def.label;
  if (label === undefined) return nothing;
  return typeof label === 'function' ? label(handle.props) : label;
}

function content(handle: SurfaceHandle): unknown {
  return handle.def.render(renderContext(handle));
}

export class SfSurfaceHostElement extends SfElement<typeof hostSpec> {
  static override readonly spec = hostSpec;

  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: var(--sf-z-surfaces, 1000);
      contain: layout style;
    }
    .banners {
      position: absolute;
      inset-block-start: 0;
      inset-inline: 0;
      display: grid;
      gap: var(--sf-space-1, 4px);
    }
    .toasts {
      position: absolute;
      inset-block-end: var(--sf-space-3, 16px);
      inset-inline-end: var(--sf-space-3, 16px);
      display: grid;
      gap: var(--sf-space-2, 8px);
      max-inline-size: min(420px, calc(100vw - 32px));
    }
    .surface {
      pointer-events: auto;
      background: var(--sf-color-surface, #fff);
      color: var(--sf-color-fg, #111);
      border-radius: var(--sf-radius, 8px);
      box-shadow: var(--sf-shadow-overlay, 0 8px 32px rgba(0, 0, 0, 0.24));
      opacity: 1;
      transform: none;
      transition:
        opacity var(--sf-motion-duration, 150ms) ease,
        transform var(--sf-motion-duration, 150ms) ease;
    }
    .surface[data-state='dismissing'],
    .surface[data-state='queued'] {
      opacity: 0;
      transform: translateY(4px);
    }
    .surface[data-state='suspended'] {
      visibility: hidden;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      background: var(--sf-color-backdrop, rgba(0, 0, 0, 0.4));
    }
    .modal {
      position: fixed;
      inset-block-start: 50%;
      inset-inline-start: 50%;
      translate: -50% -50%;
      max-inline-size: min(640px, calc(100vw - 32px));
      max-block-size: calc(100vh - 64px);
      overflow: auto;
      padding: var(--sf-space-4, 24px);
    }
    .modal.sheet {
      inset-block-start: auto;
      inset-block-end: 0;
      translate: -50% 0;
      inline-size: min(720px, 100vw);
      border-end-start-radius: 0;
      border-end-end-radius: 0;
    }
    .anchored {
      position: fixed;
      inset-block-start: 0;
      inset-inline-start: 0;
      padding: var(--sf-space-2, 8px);
    }
    .anchored.tooltip {
      pointer-events: none;
      font-size: 0.875em;
    }
    :host([data-motion='reduce']) .surface {
      transition: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .surface {
        transition: none;
      }
    }
  `;

  private restoreFocus: Element | null = null;
  private restoreInert: (() => void) | undefined;
  private lastTop: string | undefined;

  protected override wireDeps(on: ComponentHooksOf<typeof hostSpec>): void {
    on.onReady('surfaces', (manager: SurfaceManager, scope: Scope) => {
      const doc = this.ownerDocument;
      scope.listen(doc, 'keydown', (event) => this.onKeydown(event as KeyboardEvent, manager));
      scope.defer(() => this.releaseModal());
      if (typeof matchMedia === 'function') {
        const query = matchMedia('(prefers-reduced-motion: reduce)');
        const apply = (): void => {
          if (query.matches) this.setAttribute('data-motion', 'reduce');
          else this.removeAttribute('data-motion');
        };
        apply();
        if (typeof query.addEventListener === 'function') scope.listen(query, 'change', apply);
      }
    });
  }

  override render(): TemplateResult {
    const manager = this.deps.surfaces;
    const active = manager.active;
    const of = (...kinds: readonly string[]): SurfaceHandle[] => active.filter((h) => kinds.includes(h.def.kind));
    const modals = active.filter((h) => MODAL_KINDS.includes(h.def.kind) && h.state !== 'queued');
    const top = manager.topModal;
    return html`
      <div class="banners" role="region" aria-label="Announcements">
        ${repeat(
          of('banner').filter((h) => h.state !== 'queued'),
          (h) => h.instanceId,
          (h) => html`<div class="surface banner" role="status" data-state=${h.state} data-surface=${h.def.id} aria-label=${labelOf(h)}>${content(h)}</div>`,
        )}
      </div>
      <div class="toasts" role="status" aria-live="polite">
        ${repeat(
          of('toast').filter((h) => h.state !== 'queued'),
          (h) => h.instanceId,
          (h) =>
            html`<div class="surface toast" role=${h.def.priority === 'urgent' ? 'alert' : nothing} data-state=${h.state} data-surface=${h.def.id} aria-label=${labelOf(h)}>${content(h)}</div>`,
        )}
      </div>
      ${repeat(
        modals,
        (h) => h.instanceId,
        (h) => html`
          ${h === top ? html`<div class="backdrop" @click=${() => (h.dismissible ? h.dismiss('backdrop') : undefined)}></div>` : nothing}
          <div
            class="surface modal ${h.def.kind}"
            role="dialog"
            aria-modal="true"
            tabindex="-1"
            aria-label=${labelOf(h)}
            aria-labelledby=${h.def.label === undefined ? h.titleId : nothing}
            data-state=${h.state}
            data-surface=${h.def.id}
            data-instance=${h.instanceId}
            ?inert=${h !== top}
          >
            ${content(h)}
          </div>
        `,
      )}
      ${repeat(
        of('popover', 'coach-mark', 'tooltip').filter((h) => h.state === 'showing' || h.state === 'dismissing'),
        (h) => h.instanceId,
        (h) => html`<div
          class="surface anchored ${h.def.kind}"
          role=${h.def.kind === 'tooltip' ? 'tooltip' : 'dialog'}
          aria-label=${labelOf(h)}
          data-state=${h.state}
          data-surface=${h.def.id}
          data-instance=${h.instanceId}
        >
          ${content(h)}
        </div>`,
      )}
    `;
  }

  protected override updated(): void {
    if (!this.ready) return;
    const manager = this.deps.surfaces;
    this.syncModalFocus(manager);
    this.positionAnchored(manager);
  }

  private modalElement(handle: SurfaceHandle): HTMLElement | null {
    return this.byInstance('.modal', handle.instanceId);
  }

  private byInstance(selector: string, instanceId: string): HTMLElement | null {
    for (const element of this.renderRoot.querySelectorAll<HTMLElement>(selector)) {
      if (element.dataset['instance'] === instanceId) return element;
    }
    return null;
  }

  private syncModalFocus(manager: SurfaceManager): void {
    const top = manager.topModal;
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
      this.restoreInert = inertSiblings(this);
    }
    const element = this.modalElement(top);
    if (element !== null) focusFirst(element);
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
      if (manager.dismissTop('escape')) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const top = manager.topModal;
    if (top === undefined) return;
    const element = this.modalElement(top);
    if (element === null) return;
    trapTab(event, element, deepActiveElement(this.shadowRoot ?? this.ownerDocument));
  }

  private positionAnchored(manager: SurfaceManager): void {
    for (const handle of manager.showing('popover', 'tooltip', 'coach-mark')) {
      const anchor = handle.anchor ?? (handle.def.target === undefined ? undefined : manager.targets.element(handle.def.target));
      const element = this.byInstance('.anchored', handle.instanceId);
      if (anchor === undefined || element === null) continue;
      void this.measure(() => anchor.getBoundingClientRect()).then((rect) => {
        if (!rect.ok) return;
        void this.mutate(() => {
          // Compositor-only placement (transform), below the anchor.
          element.style.transform = `translate(${Math.round(rect.value.left)}px, ${Math.round(rect.value.bottom + 4)}px)`;
        });
      });
    }
  }
}

export const SURFACE_HOST_TAG = 'sf-surface-host';

export function defineSurfaceHost(registry: CustomElementRegistry = customElements): void {
  if (registry.get(SURFACE_HOST_TAG) === undefined) defineComponent(SfSurfaceHostElement, registry);
}
