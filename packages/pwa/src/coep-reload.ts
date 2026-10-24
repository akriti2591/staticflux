/**
 * Page-side, one-time reload coordination for the COOP/COEP service worker (R11.16a).
 *
 * The first visit is never controlled by a SW, so it cannot be isolated. Once the COEP SW
 * controls the page, we reload ONCE; the reloaded document carries the injected headers
 * and is `crossOriginIsolated`. A session-scoped marker (an AsyncStore — use the
 * sessionStorage adapter from @staticflux/storage) prevents reload loops: if the page is
 * still not isolated after the reload, we stop and report `SF-PWA-009`.
 */
import { err, ok, type Result, type SfError } from '@staticflux/core';
import type { AsyncStore } from '@staticflux/storage';
import { IsolationReloadFailedError } from './errors.js';
import { listenTo, type PwaPageEnv } from './page-env.js';

export type IsolationReloadStatus =
  /** Already isolated (marker cleared). */
  | 'isolated'
  /** Reload issued; the page is going away. */
  | 'reloading'
  /** SW unavailable or embedded: isolation cannot be added this way. */
  | 'unsupported';

export interface IsolationReloadOptions {
  readonly env: Pick<PwaPageEnv, 'serviceWorker' | 'embedded' | 'reload' | 'crossOriginIsolated'>;
  /** Registers the COEP SW (e.g. `() => updater.register()`). */
  readonly register: () => Promise<Result<unknown>>;
  /** Session-scoped store for the loop guard. */
  readonly store: AsyncStore<number>;
  readonly key?: string;
  readonly now?: () => number;
  /** Wait for the SW to take control (default 10 s). */
  readonly timeoutMs?: number;
}

export const ISOLATION_RELOAD_KEY = 'sf-pwa/isolation-reload';

export async function coordinateIsolationReload(options: IsolationReloadOptions): Promise<Result<IsolationReloadStatus, SfError>> {
  const key = options.key ?? ISOLATION_RELOAD_KEY;
  const { env } = options;
  if (env.crossOriginIsolated()) {
    await options.store.delete(key);
    return ok('isolated');
  }
  const container = env.serviceWorker;
  if (env.embedded || container === undefined) return ok('unsupported');
  const marker = await options.store.get(key);
  if (marker.ok && marker.value !== undefined) {
    return err(IsolationReloadFailedError({ details: { reloadedAt: marker.value } }));
  }
  const registered = await options.register();
  if (!registered.ok) return err(registered.error as SfError);
  if (container.controller === null) {
    const controlled = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), options.timeoutMs ?? 10_000);
      const remove = listenTo(container, 'controllerchange', () => finish(true));
      function finish(value: boolean): void {
        clearTimeout(timer);
        remove();
        resolve(value);
      }
    });
    if (!controlled) return err(IsolationReloadFailedError({ message: 'The COOP/COEP service worker did not take control of the page.' }));
  }
  await options.store.set(key, (options.now ?? Date.now)());
  env.reload();
  return ok('reloading');
}
