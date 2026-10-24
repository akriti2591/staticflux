/**
 * Routable dialogs (R7.16–R7.21, router side).
 *
 * - URL shape: `/d/<key>` (app-level, no owner) or `<owner-path>/d/<key>` (feature-level).
 *   At most one routable dialog is in the URL (R7.20); stacked dialogs are non-routable surfaces.
 * - Opening runs the light `dialog` pipeline: availability → authorize → load → enter (R7.17).
 * - Dismiss = history back when opened in-app, `replace` to the parent location when deep-linked (R7.18).
 * - Dialogs are scope-bound: leaving the owner route closes them; unsaved state registers an exit
 *   guard via `router.guardExit(dialog, guard)` (R7.19).
 *
 * The router never renders a dialog: it calls a `DialogSurfacePort`, which `@staticflux/messaging`
 * implements (surface open/close, focus trap, arbitration).
 */
import type { Result, Scope } from '@staticflux/core';
import type { NavigationContext } from './context.js';
import type { AnyRoute, GuardSpec, RouteMatch, RouteRequirements } from './routes.js';

export const DIALOG_SEGMENT = 'd';

export type DialogId = `${string}/${string}`;

/** Stages a dialog may guard (its light pipeline). */
export type DialogGuardStage = 'exit' | 'availability' | 'authorize' | 'load' | 'enter';

export interface DialogDef<Id extends DialogId = DialogId, Key extends string = string> {
  readonly kind: 'dialog';
  readonly id: Id;
  /** URL segment after `/d/` (`[a-z0-9-]+`). */
  readonly key: Key;
  /** Feature-level dialogs open only below this route; undefined = app-level. */
  readonly owner: AnyRoute | undefined;
  readonly requires: RouteRequirements;
  readonly guards: { readonly [S in DialogGuardStage]?: readonly GuardSpec[] };
  /** Lazy-load the dialog's code (load stage). Must honour `signal`. */
  readonly load: ((signal: AbortSignal) => Promise<Result<void>>) | undefined;
  readonly description: string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDialog = DialogDef<DialogId, string>;

export function defineDialog<const Id extends DialogId, const Key extends string>(config: {
  readonly id: Id;
  readonly key: Key;
  readonly owner?: AnyRoute;
  readonly requires?: RouteRequirements;
  readonly guards?: DialogDef['guards'];
  readonly load?: (signal: AbortSignal) => Promise<Result<void>>;
  readonly description?: string;
}): DialogDef<Id, Key> {
  return Object.freeze({
    kind: 'dialog' as const,
    id: config.id,
    key: config.key,
    owner: config.owner,
    requires: config.requires ?? {},
    guards: config.guards ?? {},
    load: config.load,
    description: config.description,
  });
}

/** `/studio/doc/42` + `share` → `/studio/doc/42/d/share`; `/` + `upsell` → `/d/upsell`. */
export function dialogPath(basePathname: string, key: string): string {
  const base = basePathname === '/' ? '' : basePathname.replace(/\/+$/, '');
  return `${base}/${DIALOG_SEGMENT}/${key}`;
}

// ---------------------------------------------------------------- surface port (messaging implements)

export type DialogCloseReason = 'dismissed' | 'navigation' | 'replaced' | 'disposed';

export interface DialogOpenRequest {
  readonly dialog: AnyDialog;
  /** Match of the dialog location (base route params/search + dialog). */
  readonly match: RouteMatch;
  readonly navigation: NavigationContext;
  /** Disposed when the dialog closes; non-routable surfaces stacked above bind to it (R7.20, R7.21). */
  readonly scope: Scope;
  /** The surface calls this when the user dismisses it (Esc, backdrop, close button). */
  dismiss(): void;
}

export interface DialogSurfaceHandle {
  close(reason: DialogCloseReason): void | Promise<void>;
}

/** Port implemented by `@staticflux/messaging` (routable dialogs). */
export interface DialogSurfacePort {
  open(request: DialogOpenRequest, signal: AbortSignal): Promise<Result<DialogSurfaceHandle>>;
}
