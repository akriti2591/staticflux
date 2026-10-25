/**
 * Messaging surfaces (R13.4–R13.10). Features *request* surfaces; the surface
 * manager arbitrates and the kit's `<sf-surface-layer>` renders them (native <dialog>,
 * Popover API). Dialogs use the kit dialog frame (`defineDialogSurface`: the title is the
 * heading and the accessible name), toasts the kit toast (`defineToastSurface`), and
 * actions are kit buttons. Routable dialogs open from the URL (`/d/upgrade`,
 * `/studio/doc/:id/d/share`) through the router.
 * Data only (definitions): the units registering the routable dialogs are in the deferred
 * surfaces chunk (`deferred/surfaces.ts`), which also defines the kit elements. Not a boot
 * module: the one surface boot needs (Reconnecting) lives with its adapter (runtime-messaging).
 */
import { ok, type Result } from '@staticflux/core';
import { defineDialogSurface, defineToastSurface } from '@staticflux/kit/surface-defs';
import { defineSurface, type SurfaceDef } from '@staticflux/messaging';
import { html } from 'lit';
import { AiButtonTarget } from './contracts.js';

export interface ConfirmProps {
  readonly title: string;
  readonly message: string;
}

export const ConfirmDialog = defineDialogSurface<ConfirmProps, boolean>({
  id: 'studio/confirm',
  scope: 'app',
  priority: 'high',
  title: (props) => props.title,
  body: ({ props }) => html`<p>${props.message}</p>`,
  actions: ({ dismiss }) => html`
    <sf-button @click=${() => dismiss('action', false)}>Cancel</sf-button>
    <sf-button variant="primary" @click=${() => dismiss('action', true)}>Confirm</sf-button>
  `,
});

export const SavedToast = defineToastSurface<{ readonly message: string }>({
  id: 'studio/saved-toast',
  scope: 'app',
  durationMs: 2500,
  tone: 'success',
  message: (props) => props.message,
});

export const CreditBanner = defineSurface<{ readonly credits: number }>({
  id: 'billing/credit-banner',
  kind: 'banner',
  scope: 'app',
  priority: 'normal',
  dedupe: true,
  render: ({ props, dismiss }) =>
    html`<span>Only ${props.credits} credits left.</span> <a href="/d/upgrade">Upgrade</a>
      <sf-icon-button label="Dismiss" size="sm" @click=${() => dismiss('user')}><span aria-hidden="true">✕</span></sf-icon-button>`,
});

export const AiButtonCoachMark = defineSurface({
  id: 'onboarding/coach-ai-button',
  kind: 'coach-mark',
  scope: 'feature',
  target: AiButtonTarget,
  once: true,
  label: 'Meet the assistant',
  render: ({ dismiss }) => html`<p>Ask the assistant to write or illustrate.</p><sf-button variant="primary" size="sm" @click=${() => dismiss('completed')}>Got it</sf-button>`,
});

/** Routable upsell dialog `/d/upgrade`; its content lives in the billing chunk. */
export function upgradeDialog(load: (signal: AbortSignal) => Promise<Result<void>>): SurfaceDef<undefined, unknown> {
  return defineDialogSurface<undefined, unknown>({
    id: 'billing/upgrade-dialog',
    scope: 'route',
    priority: 'high',
    title: () => 'Upgrade to Pro',
    routable: { key: 'upgrade', params: () => ok(undefined), load },
    body: ({ dismiss }) => html`<billing-upgrade-dialog .dismiss=${(completed: boolean) => dismiss(completed ? 'completed' : 'user')}></billing-upgrade-dialog>`,
  });
}

export const ShareDialog = defineDialogSurface<{ readonly docId: string }>({
  id: 'studio/share-dialog',
  scope: 'route',
  title: (props) => `Share document ${props.docId}`,
  routable: { key: 'share', params: (raw) => ok({ docId: raw['id'] ?? '' }) },
  body: () => html`<sf-text-field label="Invite" type="email" placeholder="name@example.com" autocomplete="email"></sf-text-field>`,
  actions: ({ dismiss }) => html`<sf-button variant="primary" @click=${() => dismiss('completed')}>Done</sf-button>`,
});
