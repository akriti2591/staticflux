/**
 * Messaging surfaces (R13.4–R13.10). Features *request* surfaces; the surface
 * manager arbitrates and `<sf-surface-host>` renders them. Routable dialogs open
 * from the URL (`/d/upgrade`, `/studio/doc/:id/d/share`) through the router.
 * Data only (definitions): the units registering the routable dialogs are in the deferred
 * surfaces chunk (`deferred/surfaces.ts`).
 */
import { ok, type Result } from '@staticflux/core';
import { defineSurface, type SurfaceDef } from '@staticflux/messaging';
import { html } from 'lit';
import { AiButtonTarget } from './contracts.js';

export interface ConfirmProps {
  readonly title: string;
  readonly message: string;
}

export const ConfirmDialog = defineSurface<ConfirmProps, boolean>({
  id: 'studio/confirm',
  kind: 'dialog',
  scope: 'app',
  priority: 'high',
  label: (props) => props.title,
  render: ({ props, dismiss, titleId }) => html`
    <h2 id=${titleId}>${props.title}</h2>
    <p>${props.message}</p>
    <div class="actions">
      <button @click=${() => dismiss('action', false)}>Cancel</button>
      <button class="primary" @click=${() => dismiss('action', true)}>Confirm</button>
    </div>
  `,
});

export const SavedToast = defineSurface<{ readonly message: string }>({
  id: 'studio/saved-toast',
  kind: 'toast',
  scope: 'app',
  durationMs: 2500,
  render: ({ props }) => html`${props.message}`,
});

export const CreditBanner = defineSurface<{ readonly credits: number }>({
  id: 'billing/credit-banner',
  kind: 'banner',
  scope: 'app',
  priority: 'normal',
  dedupe: true,
  render: ({ props, dismiss }) =>
    html`<span>Only ${props.credits} credits left.</span> <a href="/d/upgrade">Upgrade</a>
      <button aria-label="Dismiss" @click=${() => dismiss('user')}>×</button>`,
});

export const ReconnectingDialog = defineSurface({
  id: 'studio/reconnecting',
  kind: 'dialog',
  scope: 'app',
  priority: 'urgent',
  dismissible: false,
  label: 'Reconnecting',
  render: () => html`<p role="status">Reconnecting… your changes are kept.</p>`,
});

export const AiButtonCoachMark = defineSurface({
  id: 'onboarding/coach-ai-button',
  kind: 'coach-mark',
  scope: 'feature',
  target: AiButtonTarget,
  once: true,
  label: 'Meet the assistant',
  render: ({ dismiss }) => html`<p>Ask the assistant to write or illustrate.</p><button @click=${() => dismiss('completed')}>Got it</button>`,
});

/** Routable upsell dialog `/d/upgrade`; its content lives in the billing chunk. */
export function upgradeDialog(load: (signal: AbortSignal) => Promise<Result<void>>): SurfaceDef<undefined, unknown> {
  return defineSurface<undefined, unknown>({
    id: 'billing/upgrade-dialog',
    kind: 'dialog',
    scope: 'route',
    priority: 'high',
    label: 'Upgrade to Pro',
    routable: { key: 'upgrade', params: () => ok(undefined), load },
    render: ({ dismiss, titleId }) =>
      html`<billing-upgrade-dialog .titleId=${titleId} .dismiss=${(completed: boolean) => dismiss(completed ? 'completed' : 'user')}></billing-upgrade-dialog>`,
  });
}

export const ShareDialog = defineSurface<{ readonly docId: string }>({
  id: 'studio/share-dialog',
  kind: 'dialog',
  scope: 'route',
  label: 'Share document',
  routable: { key: 'share', params: (raw) => ok({ docId: raw['id'] ?? '' }) },
  render: ({ props, dismiss, titleId }) => html`
    <h2 id=${titleId}>Share document ${props.docId}</h2>
    <label>Invite <input type="email" placeholder="name@example.com" /></label>
    <div class="actions"><button @click=${() => dismiss('completed')}>Done</button></div>
  `,
});
