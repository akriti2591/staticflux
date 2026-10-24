/**
 * OPTIONAL plugin: POST `share_target` receiver (files). The SW reads the multipart
 * form, stores the payload in a durable AsyncStore (IndexedDB inside the SW), and
 * answers `303 → <action>?sf-share=<id>`. The page then calls `receiveShareTarget()`,
 * which loads the payload once (consume-once), deletes it, and hands it to the intent port.
 * GET share targets need no SW (query params only).
 */
import type { AsyncStore } from '@staticflux/storage';
import type { FetchEventLike, ResponseLike } from './sw-env.js';
import type { SwPlugin, SwPluginContext } from './sw-runtime.js';

export const SHARE_ID_PARAM = 'sf-share';

/** Field names, as declared in the manifest's `share_target.params`. */
export interface ShareTargetParams {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
  /** Form field name of the files. */
  readonly files?: string;
}

export interface SharePayload {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
  /** Blobs/Files (structured-clone safe). */
  readonly files: readonly unknown[];
  readonly receivedAt: number;
}

export interface ShareTargetPluginOptions {
  /** Manifest `share_target.action` (path). */
  readonly action: string;
  readonly params: ShareTargetParams;
  readonly store: AsyncStore<SharePayload>;
  readonly id?: () => string;
}

export function shareTargetPlugin(options: ShareTargetPluginOptions): SwPlugin {
  const makeId = options.id ?? (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  return {
    id: 'pwa/share-target',
    fetch(event: FetchEventLike, context: SwPluginContext): Promise<ResponseLike> | undefined {
      const request = event.request;
      if (request.method !== 'POST' || request.formData === undefined) return undefined;
      const origin = context.env.self.location.origin;
      const action = new URL(options.action, origin);
      const url = new URL(request.url);
      if (url.origin !== origin || url.pathname !== action.pathname) return undefined;
      const formData = request.formData.bind(request);
      return (async () => {
        const id = makeId();
        const redirect = new URL(action.href);
        try {
          const form = await formData();
          const p = options.params;
          const field = (key: 'title' | 'text' | 'url'): Partial<Record<'title' | 'text' | 'url', string>> => {
            const name = p[key];
            if (name === undefined) return {};
            const value = form.get(name);
            return typeof value === 'string' && value !== '' ? { [key]: value } : {};
          };
          const payload: SharePayload = {
            ...field('title'),
            ...field('text'),
            ...field('url'),
            files: p.files === undefined ? [] : form.getAll(p.files).filter((f) => typeof f !== 'string'),
            receivedAt: context.env.now(),
          };
          const stored = await options.store.set(id, payload);
          if (stored.ok) redirect.searchParams.set(SHARE_ID_PARAM, id);
        } catch {
          // Fall through: redirect without a payload; the page shows "nothing to share".
        }
        return context.env.createResponse(null, { status: 303, headers: { location: redirect.href } });
      })();
    },
  };
}
