/**
 * Instaflow feedback (OVERLAYS-FEEDBACK §3): the `SfError` → level adapter and the toasts port features use.
 *
 * - `feedbackFor(error, origin)` — level by origin (kit `feedbackLevel`), then the code families of §3.2 refine it
 *   (`IF-PLAT-*` → blocking, `IF-WRK-*` → banner, `SF-STORE-*` quota → banner, `SF-NAV-*` → toast after the fallback,
 *   `SF-AI-*` → the chat turn); the message line and the fix come from `ERROR_COPY` when Instaflow has person-facing
 *   words for that error; the code never reaches the surface (it is in `diagnostics`).
 * - `ToastsToken` / `createToasts(manager, owner)` — `show({ message, tone, action })`, `undoable({ message, undo })`
 *   (`Undo`, then `Restored` for 3 s), `error(error, origin, run?)`; `undoNewest()` runs the newest toast's Undo
 *   (Home binds `Mod+Z` to it; Studio never does: there `Mod+Z` is document undo, §3.5).
 * - `INSTAFLOW_SURFACE_UNITS` — messaging under the strict overlay policy (one modal, one popover, Escape to toasts).
 */
import { type ErrorDefinition, type SfError, token } from '@staticflux/core';
import { type ErrorCopy, errorFeedback, type ErrorFeedback, type FeedbackLevel, feedbackLevel, type FeedbackOrigin } from '@staticflux/kit/feedback';
import { defineToastSurface, type ToastTone, toastDuration } from '@staticflux/kit/surface-defs';
import { strictMessagingUnits, type SurfaceHandle, type SurfaceManager, type SurfaceOwner } from '@staticflux/messaging';

export const INSTAFLOW_SURFACE_UNITS = strictMessagingUnits;

/** Code families → level (§3.2); `undefined` keeps the origin's level. Families are code prefixes (stable ids). */
export const FAMILY_LEVELS: readonly (readonly [prefix: string, level: FeedbackLevel | 'chat', kind?: SfError['kind']])[] = Object.freeze([
  ['IF-PLAT-', 'blocking'],
  ['IF-WRK-', 'banner'],
  ['SF-STORE-', 'banner', 'quota'],
  ['SF-NAV-', 'toast'],
  ['IF-LIB-', 'toast'],
  ['SF-AI-', 'chat'],
]);

/** Person-facing copy per error definition (the definition's `fix` is developer text and is never shown). */
export type ErrorCopyTable = ReadonlyMap<ErrorDefinition, ErrorCopy>;

export interface InstaflowFeedback extends ErrorFeedback {
  readonly level: FeedbackLevel | 'chat';
}

/** One error, one place (§3.1): the level for this error from this origin, with its words. */
export function feedbackFor(error: SfError, origin: FeedbackOrigin, copy: ErrorCopyTable = new Map()): InstaflowFeedback {
  // A field commit stays inline whatever the family: the person typed something the field cannot take.
  const family = origin === 'field' ? undefined : FAMILY_LEVELS.find(([prefix, , kind]) => error.code.startsWith(prefix) && (kind === undefined || kind === error.kind));
  const level = family?.[1] ?? feedbackLevel(origin);
  const words = [...copy].find(([definition]) => definition.code === error.code)?.[1];
  return { ...errorFeedback(error, words), level };
}

export interface ToastRequest {
  readonly message: string;
  readonly tone?: ToastTone;
  readonly action?: { readonly label: string; readonly run: () => void };
  /** Same id → one toast with a count (`Copied ×3`). */
  readonly dedupe?: string;
  readonly urgent?: boolean;
  /** B11c: a shorter life for a toast that only confirms (`Link copied`, the density name: 1.5 s, NAVIGATION §5). */
  readonly durationMs?: number;
}

export interface Toasts {
  show(request: ToastRequest): SurfaceHandle;
  /** A reversible non-local action: `Undo` (8 s), and `Restored` (3 s) once undone. */
  undoable(request: { readonly message: string; readonly undo: () => void; readonly undoLabel?: string; readonly restoredLabel?: string }): SurfaceHandle;
  /** An error from a capability run: the message, the fix as the action when it is one the app can run. */
  error(error: SfError, run?: () => void, copy?: ErrorCopyTable): SurfaceHandle;
  /** Run the newest showing toast's Undo (Home `Mod+Z`); false when none shows. */
  undoNewest(): boolean;
}

export const ToastsToken = /* @__PURE__ */ token('instaflow/toasts').type<Toasts>();

interface ToastProps {
  readonly message: string;
  readonly tone: ToastTone;
  readonly action: ToastRequest['action'];
  readonly undo: boolean;
}

const toastSurface = defineToastSurface<ToastProps>({
  id: 'instaflow/toast',
  scope: 'app',
  dedupe: (p) => `${p.tone}:${p.message}`,
  message: (p) => p.message,
  tone: (p) => p.tone,
  action: { label: (p) => p.action?.label ?? '', run: (p) => p.action?.run() },
});

const plainToastSurface = defineToastSurface<ToastProps>({
  id: 'instaflow/toast-plain',
  scope: 'app',
  dedupe: (p) => `${p.tone}:${p.message}`,
  message: (p) => p.message,
  tone: (p) => p.tone,
});

/** The toasts port over the surface manager (one queue, cap 3, pause on hover, §3.5). */
export function createToasts(manager: SurfaceManager, owner: SurfaceOwner): Toasts {
  const undos: { readonly handle: SurfaceHandle; readonly run: () => void }[] = [];
  const show = (request: ToastRequest, undo = false): SurfaceHandle => {
    const tone = request.tone ?? 'neutral';
    const props: ToastProps = { message: request.message, tone, action: request.action, undo };
    const durationMs = request.durationMs ?? toastDuration(tone, request.action !== undefined, request.urgent === true);
    const def = request.action === undefined ? plainToastSurface : toastSurface;
    return manager.request(def, { owner, props, durationMs });
  };
  return {
    show: (request) => show(request),
    undoable({ message, undo, undoLabel = 'Undo', restoredLabel = 'Restored' }) {
      let done = false;
      const run = (): void => {
        if (done) return;
        done = true;
        undo();
        manager.request(plainToastSurface, { owner, props: { message: restoredLabel, tone: 'neutral', action: undefined, undo: false }, durationMs: 3000 });
      };
      const handle = show({ message, action: { label: undoLabel, run } }, true);
      undos.push({ handle, run });
      void handle.closed.then(() => {
        const index = undos.findIndex((u) => u.handle === handle);
        if (index >= 0) undos.splice(index, 1);
      });
      return handle;
    },
    error(error, run, copy) {
      const feedback = feedbackFor(error, 'capability', copy);
      const fix = feedback.fix;
      const action = fix?.kind === 'action' && run !== undefined ? { label: fix.label, run } : undefined;
      return show({ message: fix?.kind === 'advice' ? `${feedback.message} ${fix.text}` : feedback.message, tone: 'danger', ...(action === undefined ? {} : { action }) });
    },
    undoNewest() {
      const newest = [...undos].reverse().find((u) => u.handle.state === 'showing');
      if (newest === undefined) return false;
      newest.run();
      newest.handle.dismiss('action');
      return true;
    },
  };
}
