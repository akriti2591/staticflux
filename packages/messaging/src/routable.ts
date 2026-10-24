/**
 * Routable dialog bridge (R7.16–R7.21, surface side). Router-agnostic:
 *
 * - The router calls `openDialog(key, params, { source, owner })` when the URL gains
 *   `/d/<key>`, and `closeDialog()` when it loses it (back button, navigation).
 * - Light pipeline (R7.17): availability (registered key) → authorize (gate, before any
 *   chunk is fetched — I-8) → lazy-load (`routable.load`) → enter (surface request).
 * - When the *user* dismisses the dialog (Escape, close, action), the bridge emits a
 *   dismiss intent: `back` when the dialog was opened in-app, `replace` (to the parent
 *   path) when the user arrived via deep link (R7.18). The router performs it.
 * - At most one routable dialog (R7.20): opening another replaces the current one.
 *   Dialogs stacked above it are plain (non-routable) surfaces.
 */
import { box, err, ok, type Result, type SfError, type Telemetry, createNoopTelemetry, toSfError } from '@staticflux/core';
import { allowAllDecide, type DecidePort } from '@staticflux/ui';
import {
  DuplicateSurfaceError,
  InvalidRoutableParamsError,
  SurfaceGatedError,
  SurfaceLoadFailedError,
  UnknownRoutableDialogError,
} from './errors.js';
import type { RequestOptions, SurfaceHandle, SurfaceManager, SurfaceOwner } from './manager.js';
import type { AnySurfaceDef, DismissReason } from './surface.js';
import { MESSAGING_SUBSYSTEM } from './telemetry.js';

export type DialogSource = 'in-app' | 'deep-link';

export interface DismissIntent {
  readonly key: string;
  /** `back`: history back (opened in-app). `replace`: replace with the parent path (deep link). */
  readonly kind: 'back' | 'replace';
  readonly reason: DismissReason;
}

export interface OpenDialogOptions {
  readonly source?: DialogSource;
  /** Owning scope (usually the route scope); defaults to the bridge's owner. */
  readonly owner?: SurfaceOwner;
  readonly signal?: AbortSignal;
}

/** The port the router calls. */
export interface RoutableDialogBridge {
  register(def: AnySurfaceDef): Result<void>;
  has(key: string): boolean;
  openDialog(key: string, params?: Readonly<Record<string, string>>, options?: OpenDialogOptions): Promise<Result<SurfaceHandle>>;
  /** Close the current routable dialog (router-initiated: no dismiss intent). */
  closeDialog(key?: string, reason?: DismissReason): Result<void>;
  /** Reactive: key of the open routable dialog. */
  readonly current: string | undefined;
  onDismissIntent(listener: (intent: DismissIntent) => void): () => void;
}

/** Router-initiated reasons never produce a dismiss intent. */
const ROUTER_REASONS: readonly DismissReason[] = ['navigation', 'replaced', 'scope-ended'];

export interface RoutableDialogBridgeOptions {
  readonly manager: SurfaceManager;
  readonly owner: SurfaceOwner;
  readonly surfaces?: readonly AnySurfaceDef[];
  readonly decide?: DecidePort;
  readonly telemetry?: Telemetry;
}

export function createRoutableDialogBridge(options: RoutableDialogBridgeOptions): RoutableDialogBridge {
  const { manager } = options;
  const decide = options.decide ?? allowAllDecide;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const defs = new Map<string, AnySurfaceDef>();
  const listeners = new Set<(intent: DismissIntent) => void>();
  const currentKey = box<string | undefined>(undefined);
  let open: { key: string; handle: SurfaceHandle; source: DialogSource } | undefined;

  const register = (def: AnySurfaceDef): Result<void> => {
    const key = def.routable?.key;
    if (key === undefined) return err(UnknownRoutableDialogError({ message: `Surface "${def.id}" is not routable.` }));
    const existing = defs.get(key);
    if (existing !== undefined && existing !== def) {
      return err(DuplicateSurfaceError({ details: { key, surfaces: [existing.id, def.id] } }));
    }
    defs.set(key, def);
    return ok();
  };
  for (const def of options.surfaces ?? []) {
    const registered = register(def);
    if (!registered.ok) throw registered.error;
  }

  const span = (key: string, source: DialogSource) =>
    telemetry.span('messaging.dialog.open', { subsystem: MESSAGING_SUBSYSTEM, level: 'standard', attrs: { key, source } });

  return {
    register,
    has: (key) => defs.has(key),
    get current() {
      return currentKey.get();
    },
    async openDialog(key, params = {}, openOptions = {}) {
      const source = openOptions.source ?? 'in-app';
      const trace = span(key, source);
      const fail = (error: SfError): Result<SurfaceHandle> => {
        trace.end('error', error);
        return err(error);
      };
      // 1. availability
      const def = defs.get(key);
      if (def === undefined) return fail(UnknownRoutableDialogError({ details: { key } }));
      if (open?.key === key && open.handle.state !== 'dismissed') {
        trace.end('ok');
        return ok(open.handle);
      }
      const parsed: Result<unknown> = def.routable?.params === undefined ? ok(undefined) : def.routable.params(params);
      if (!parsed.ok) return fail(InvalidRoutableParamsError({ cause: parsed.error, details: { key } }));
      const owner = openOptions.owner ?? options.owner;
      const signal = openOptions.signal ?? owner.scope.signal;
      // 2. authorize — before any chunk is fetched (I-8).
      if (def.gate !== undefined) {
        let denied: string | undefined;
        try {
          const verdict = await decide.decide(def.gate, signal);
          if (verdict.effect === 'deny') denied = verdict.reason;
        } catch (error) {
          denied = toSfError(error).message;
        }
        if (denied !== undefined) {
          // The manager re-checks and resolves the denial to the upsell surface (R13.9).
          manager.request(def, { owner, props: parsed.value } as unknown as RequestOptions<never>);
          return fail(SurfaceGatedError({ details: { key, reason: denied } }));
        }
      }
      // 3. lazy-load
      if (def.routable?.load !== undefined) {
        let loaded: Result<void>;
        try {
          loaded = await def.routable.load(signal);
        } catch (error) {
          loaded = err(toSfError(error));
        }
        if (!loaded.ok) return fail(SurfaceLoadFailedError({ cause: loaded.error, details: { key } }));
      }
      if (signal.aborted) return fail(toSfError(signal.reason ?? new DOMException('aborted', 'AbortError')));
      // 4. enter — at most one routable dialog (R7.20).
      if (open !== undefined) open.handle.dismiss('replaced');
      const handle = manager.request(def, { owner, props: parsed.value, ...(openOptions.signal === undefined ? {} : { signal: openOptions.signal }) } as unknown as RequestOptions<never>);
      const record = { key, handle, source };
      open = record;
      currentKey.set(key);
      void handle.closed.then((outcome) => {
        if (open !== record) return;
        open = undefined;
        currentKey.set(undefined);
        const reason = outcome.reason as DismissReason;
        if (outcome.state === 'dismissed' && !ROUTER_REASONS.includes(reason)) {
          const intent: DismissIntent = { key, kind: source === 'in-app' ? 'back' : 'replace', reason };
          telemetry.event('messaging.dialog.dismiss-intent', { subsystem: MESSAGING_SUBSYSTEM, level: 'verbose', attrs: { ...intent } });
          for (const listener of [...listeners]) listener(intent);
        }
      });
      trace.end('ok');
      return ok(handle);
    },
    closeDialog(key, reason = 'navigation') {
      if (open === undefined) return ok();
      if (key !== undefined && open.key !== key) return err(UnknownRoutableDialogError({ message: `Routable dialog "${key}" is not open.`, details: { key, open: open.key } }));
      open.handle.dismiss(reason);
      return ok();
    },
    onDismissIntent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
