/**
 * Routable dialog paths (R7.16, R7.18, R7.20): `/d/<key>` (app level) and
 * `<feature-path>/d/<key>` (feature level). At most one routable dialog is in
 * the URL; further stacked dialogs are non-routable surfaces.
 *
 * Dialog keys can be typed via the core Registry:
 *   declare module '@staticflux/core' { interface Registry { dialogs: { share: true; upgrade: true } } }
 */
import { err, ok, type Registry, type Result } from '@staticflux/core';
import { DialogPathError } from './errors.js';
import type { HistoryPort } from './history.js';
import { formatUrl, parseUrl } from './url.js';

type RegisteredDialogs = Registry extends { readonly dialogs: infer D } ? D : Record<never, never>;
/** Registered dialog keys, or any string when none are registered. */
export type DialogKey = [keyof RegisteredDialogs] extends [never] ? string : keyof RegisteredDialogs & string;

export const DIALOG_SEGMENT = 'd';
const KEY = /^[a-z0-9][a-z0-9-]*$/;

export interface DialogPath {
  /** Path without the dialog part (`/studio/doc/42`, or `/` for app-level dialogs). */
  readonly basePath: string;
  readonly dialog: string | undefined;
  readonly level: 'app' | 'feature' | undefined;
}

export function parseDialogPath(pathname: string): Result<DialogPath> {
  const segments = pathname.split('/').filter((s) => s !== '');
  const markers = segments.flatMap((s, i) => (s === DIALOG_SEGMENT ? [i] : []));
  if (markers.length === 0) return ok({ basePath: pathname === '' ? '/' : pathname, dialog: undefined, level: undefined });
  if (markers.length > 1) return err(DialogPathError({ message: `More than one routable dialog in "${pathname}".`, details: { pathname } }));
  const at = markers[0] ?? 0;
  const key = segments[at + 1];
  if (key === undefined || at + 2 !== segments.length || !KEY.test(key)) {
    return err(DialogPathError({ message: `Malformed dialog path "${pathname}" (expected …/d/<key> at the end).`, details: { pathname } }));
  }
  const base = segments.slice(0, at);
  return ok({ basePath: `/${base.join('/')}`, dialog: key, level: base.length === 0 ? 'app' : 'feature' });
}

export function formatDialogPath(basePath: string, key: DialogKey): Result<string> {
  if (!KEY.test(key)) return err(DialogPathError({ message: `Invalid dialog key "${key}".`, details: { key } }));
  const parsed = parseDialogPath(basePath);
  if (!parsed.ok) return parsed;
  if (parsed.value.dialog !== undefined) {
    return err(DialogPathError({ message: `"${basePath}" already has a routable dialog; stack "${key}" as a non-routable surface.`, details: { basePath, key } }));
  }
  const base = basePath.replace(/\/+$/, '');
  return ok(`${base}/${DIALOG_SEGMENT}/${key}`);
}

export interface DialogUrl {
  /** Dialog key in the current URL. */
  readonly current: string | undefined;
  /** Open a routable dialog over the current path (push; query and hash are kept). */
  open(key: DialogKey, options?: { readonly level?: 'app' | 'feature' }): Result<void>;
  /** R7.18: history back when opened in-app, `replace` to the parent path when arrived via deep link. */
  dismiss(): Result<void>;
}

export function createDialogUrl(options: { readonly history: HistoryPort; readonly source?: string }): DialogUrl {
  const { history } = options;
  const source = options.source ?? 'urlstate/dialog';
  let openedUrl: string | undefined; // URL we pushed, if the dialog was opened in-app

  const current = (): Result<DialogPath> => parseDialogPath(parseUrl(history.url).pathname);

  return {
    get current() {
      const parsed = current();
      return parsed.ok ? parsed.value.dialog : undefined;
    },
    open(key, openOptions = {}) {
      const parts = parseUrl(history.url);
      const parsed = parseDialogPath(parts.pathname);
      if (!parsed.ok) return parsed;
      const base = openOptions.level === 'app' ? '/' : parsed.value.basePath;
      if (parsed.value.dialog === key && base === parsed.value.basePath) return ok();
      const path = formatDialogPath(base, key);
      if (!path.ok) return path;
      const url = formatUrl({ ...parts, pathname: path.value });
      if (parsed.value.dialog !== undefined) {
        // Switching dialogs keeps one entry (R7.20); it stays "in-app" only if we opened the previous one.
        const wasInApp = openedUrl === history.url;
        history.replace(url, { source });
        openedUrl = wasInApp ? url : undefined;
      } else {
        history.push(url, { source });
        openedUrl = url;
      }
      return ok();
    },
    dismiss() {
      const parts = parseUrl(history.url);
      const parsed = parseDialogPath(parts.pathname);
      if (!parsed.ok) return parsed;
      if (parsed.value.dialog === undefined) return ok();
      if (openedUrl === history.url && history.canGoBack) {
        openedUrl = undefined;
        history.back();
        return ok();
      }
      openedUrl = undefined;
      history.replace(formatUrl({ ...parts, pathname: parsed.value.basePath }), { source });
      return ok();
    },
  };
}
