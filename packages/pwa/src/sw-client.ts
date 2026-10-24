/**
 * Page-side request/response over the SW message channel: post a message with an
 * `id` to a worker and wait for the reply with the same `id` on the container.
 */
import { AbortedError, err, ok, type Result } from '@staticflux/core';
import { SwMessageTimeoutError } from './errors.js';
import { listenTo, type ServiceWorkerContainerLike, type ServiceWorkerLike } from './page-env.js';
import { isMessageOf, type PageToSwMessage, type SwToPageMessage } from './protocol.js';

export interface AskOptions<T extends SwToPageMessage['type']> {
  readonly container: ServiceWorkerContainerLike;
  readonly worker: ServiceWorkerLike;
  readonly message: Extract<PageToSwMessage, { readonly id: string }>;
  readonly reply: T;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function askServiceWorker<T extends SwToPageMessage['type']>(
  options: AskOptions<T>,
): Promise<Result<Extract<SwToPageMessage, { type: T }>>> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: (() => void)[] = [];
    const finish = (result: Result<Extract<SwToPageMessage, { type: T }>>): void => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(result);
    };
    if (options.signal?.aborted === true) {
      finish(err(AbortedError()));
      return;
    }
    cleanups.push(
      listenTo(options.container, 'message', (event) => {
        const data = event.data;
        if (isMessageOf(data, options.reply) && (data as { id?: unknown }).id === options.message.id) {
          finish(ok(data as Extract<SwToPageMessage, { type: T }>));
        }
      }),
    );
    const timer = setTimeout(
      () => finish(err(SwMessageTimeoutError({ details: { type: options.message.type, reply: options.reply } }))),
      options.timeoutMs ?? 3000,
    );
    cleanups.push(() => clearTimeout(timer));
    if (options.signal !== undefined) {
      const signal = options.signal;
      const onAbort = (): void => finish(err(AbortedError({ cause: signal.reason })));
      // Removed via `cleanups` when the request finishes.
      // sf-lint-disable-next-line no-bare-listener
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }
    try {
      options.worker.postMessage(options.message);
    } catch (cause) {
      finish(err(SwMessageTimeoutError({ message: 'Posting to the service worker failed.', cause })));
    }
  });
}
