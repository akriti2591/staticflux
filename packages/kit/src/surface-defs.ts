/**
 * `@staticflux/kit/surface-defs` — messaging surface declarations rendered with the kit frames. Data only: no element
 * classes, so boot modules can declare surfaces and the elements load with `<sf-surface-layer>`
 * (`@staticflux/kit/surfaces`).
 *
 * - `defineDialogSurface` — `defineSurface` with `<sf-dialog>` around the body: the title is the visible heading and
 *   the accessible name (`label`), so no cross-root `aria-labelledby`; the frame guards user dismissals through the
 *   render context (wizard Back, the discard row) and its × dismisses with `user`.
 * - `defineConfirmSurface` — the confirm and destructive types (OVERLAYS-FEEDBACK §2.1): 420 px, one sentence,
 *   `Cancel · <Verb>`; destructive is an `alertdialog` with focus on Cancel and no backdrop dismiss. Resolves `true`
 *   when confirmed.
 * - `defineToastSurface` — `<sf-toast>` with tone, message, one action (`Undo`, `Open`, the error's fix), a repeat count
 *   when deduplicated, and `×` only when sticky (OVERLAYS-FEEDBACK §3.5).
 */
import { defineSurface, type DismissReason, type SurfaceDef, type SurfaceDefInit, type SurfaceRenderContext } from '@staticflux/messaging';
import { html, nothing } from 'lit';

export type ToastTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Toast durations (OVERLAYS-FEEDBACK §3.5): neutral and success 5 s, with an action 8 s, danger 10 s, urgent sticky. */
export const TOAST_DURATIONS = Object.freeze({ plain: 5_000, action: 8_000, danger: 10_000 });

/** The duration a toast gets from its tone and whether it carries an action (`null` = sticky). */
export function toastDuration(tone: ToastTone, hasAction: boolean, urgent = false): number | null {
  if (urgent) return null;
  if (tone === 'danger') return TOAST_DURATIONS.danger;
  return hasAction ? TOAST_DURATIONS.action : TOAST_DURATIONS.plain;
}

export interface DialogSurfaceInit<P, R> extends Omit<SurfaceDefInit<P, R>, 'kind' | 'render' | 'label'> {
  readonly kind?: 'dialog' | 'sheet';
  /** Dialog title: the visible heading and the accessible name. */
  readonly title: (props: P) => string;
  readonly body: (context: SurfaceRenderContext<P, R>) => unknown;
  readonly actions?: (context: SurfaceRenderContext<P, R>) => unknown;
  /** Width class (confirm 420, form 520 (default), wizard 640, settings 840). */
  readonly size?: 'confirm' | 'form' | 'wizard' | 'settings';
  readonly tone?: 'neutral' | 'danger';
}

/** A messaging dialog surface rendered in the kit frame. The close button dismisses with `user`. */
/* @__NO_SIDE_EFFECTS__ */
export function defineDialogSurface<P = void, R = unknown>(init: DialogSurfaceInit<P, R>): SurfaceDef<P, R> {
  const { title, body, actions, kind, size, tone, ...rest } = init;
  return defineSurface<P, R>({
    ...rest,
    kind: kind ?? 'dialog',
    label: title,
    render: (context) =>
      html`<sf-dialog
        heading=${title(context.props)}
        size=${size ?? 'form'}
        tone=${tone ?? 'neutral'}
        .dismissible=${init.dismissible ?? true}
        .surface=${context}
        @sf-close=${() => context.dismiss('user')}
        >${body(context)}${actions === undefined ? nothing : html`<div slot="actions" style="display:contents">${actions(context)}</div>`}</sf-dialog
      >`,
  });
}

export interface ConfirmSurfaceInit<P> extends Omit<SurfaceDefInit<P, boolean>, 'kind' | 'render' | 'label' | 'alert' | 'backdropDismiss'> {
  readonly title: (props: P) => string;
  /** One sentence: what will happen, naming and counting the thing. */
  readonly message: (props: P) => string;
  /** The verb (`Delete 14 designs forever`). */
  readonly confirmLabel: (props: P) => string;
  readonly cancelLabel?: (props: P) => string;
  /** `destructive`: `alertdialog`, danger button, focus on Cancel, the backdrop does nothing. */
  readonly destructive?: boolean;
}

/** Confirm / destructive dialog; resolves `true` on the verb, `false` on Cancel (Escape = Cancel). */
/* @__NO_SIDE_EFFECTS__ */
export function defineConfirmSurface<P = void>(init: ConfirmSurfaceInit<P>): SurfaceDef<P, boolean> {
  const { title, message, confirmLabel, cancelLabel, destructive, ...rest } = init;
  const danger = destructive === true;
  return defineSurface<P, boolean>({
    ...rest,
    kind: 'dialog',
    label: title,
    alert: danger,
    backdropDismiss: !danger,
    render: (context) =>
      html`<sf-dialog heading=${title(context.props)} size="confirm" tone=${danger ? 'danger' : 'neutral'} .surface=${context}>
        <p style="margin:0">${message(context.props)}</p>
        <div slot="actions" style="display:contents">
          <sf-button variant="secondary" ?autofocus=${danger} @click=${() => context.dismiss('action', false)}>${cancelLabel?.(context.props) ?? 'Cancel'}</sf-button>
          <sf-button variant=${danger ? 'danger' : 'primary'} @click=${() => context.dismiss('action', true)}>${confirmLabel(context.props)}</sf-button>
        </div>
      </sf-dialog>`,
  });
}

export interface ToastAction<P> {
  readonly label: (props: P) => string;
  readonly run: (props: P) => void;
}

export interface ToastSurfaceInit<P> extends Omit<SurfaceDefInit<P, unknown>, 'kind' | 'render' | 'label'> {
  readonly message: (props: P) => string;
  readonly tone?: ToastTone | ((props: P) => ToastTone);
  readonly action?: ToastAction<P>;
}

/** A messaging toast surface rendered as `<sf-toast>` (one action, repeat count, `×` when sticky). */
/* @__NO_SIDE_EFFECTS__ */
export function defineToastSurface<P = void>(init: ToastSurfaceInit<P>): SurfaceDef<P, unknown> {
  const { message, tone, action, ...rest } = init;
  const sticky = init.durationMs === null || (init.durationMs === undefined && init.priority === 'urgent');
  return defineSurface<P, unknown>({
    ...rest,
    kind: 'toast',
    label: message,
    render: ({ props, dismiss, count }) => {
      const reason: DismissReason = 'action';
      return html`<sf-toast tone=${typeof tone === 'function' ? tone(props) : (tone ?? 'neutral')} .count=${count ?? 1} .dismissible=${sticky} @sf-dismiss=${() => dismiss('user')}
        >${message(props)}${action === undefined
          ? nothing
          : html`<sf-button
              slot="action"
              variant="secondary"
              size="sm"
              @click=${() => {
                action.run(props);
                dismiss(reason);
              }}
              >${action.label(props)}</sf-button
            >`}</sf-toast
      >`;
    },
  });
}
