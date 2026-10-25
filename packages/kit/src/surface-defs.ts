/**
 * `@staticflux/kit/surface-defs` — messaging surface declarations rendered with the kit
 * frame and toast. Data only: no element classes, so boot modules can declare surfaces
 * and the elements load with `<sf-surface-layer>` (`@staticflux/kit/surfaces`).
 *
 * - `defineDialogSurface` — `defineSurface` with `<sf-dialog>` around the body: the title is
 *   the visible heading and the accessible name (`label`), so no cross-root `aria-labelledby`;
 *   the frame's close button dismisses with `user`.
 * - `defineToastSurface` — `<sf-toast>` with tone, message, optional action (dismiss `action`).
 */
import { defineSurface, type DismissReason, type SurfaceDef, type SurfaceDefInit, type SurfaceRenderContext } from '@staticflux/messaging';
import { html, nothing } from 'lit';

export type ToastTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface DialogSurfaceInit<P, R> extends Omit<SurfaceDefInit<P, R>, 'kind' | 'render' | 'label'> {
  readonly kind?: 'dialog' | 'sheet';
  /** Dialog title: the visible heading and the accessible name. */
  readonly title: (props: P) => string;
  readonly body: (context: SurfaceRenderContext<P, R>) => unknown;
  readonly actions?: (context: SurfaceRenderContext<P, R>) => unknown;
}

/** A messaging dialog surface rendered in the kit frame. The close button dismisses with `user`. */
/* @__NO_SIDE_EFFECTS__ */
export function defineDialogSurface<P = void, R = unknown>(init: DialogSurfaceInit<P, R>): SurfaceDef<P, R> {
  const { title, body, actions, kind, ...rest } = init;
  return defineSurface<P, R>({
    ...rest,
    kind: kind ?? 'dialog',
    label: title,
    render: (context) =>
      html`<sf-dialog heading=${title(context.props)} .dismissible=${init.dismissible ?? true} @sf-close=${() => context.dismiss('user')}
        >${body(context)}${actions === undefined ? nothing : html`<div slot="actions" style="display:contents">${actions(context)}</div>`}</sf-dialog
      >`,
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

/** A messaging toast surface rendered as `<sf-toast>` (dismiss button, optional action). */
/* @__NO_SIDE_EFFECTS__ */
export function defineToastSurface<P = void>(init: ToastSurfaceInit<P>): SurfaceDef<P, unknown> {
  const { message, tone, action, ...rest } = init;
  return defineSurface<P, unknown>({
    ...rest,
    kind: 'toast',
    label: message,
    render: ({ props, dismiss }) => {
      const reason: DismissReason = 'action';
      return html`<sf-toast tone=${typeof tone === 'function' ? tone(props) : (tone ?? 'neutral')} @sf-dismiss=${() => dismiss('user')}
        >${message(props)}${action === undefined
          ? nothing
          : html`<sf-button
              slot="action"
              variant="ghost"
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

