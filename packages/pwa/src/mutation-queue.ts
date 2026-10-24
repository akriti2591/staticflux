/**
 * Page side of the OPTIONAL background-sync plugin: queue idempotent mutations for
 * replay by the SW when connectivity returns (R4.6). Non-idempotent mutations are
 * refused here (`SF-PWA-008`) and again in the SW.
 *
 * Where Background Sync is missing (Safari, Firefox) the client asks the SW to replay
 * on the window `online` event instead.
 */
import { err, ok, type Result, type Scope } from '@staticflux/core';
import { NonIdempotentMutationError, ServiceWorkerUnsupportedError } from './errors.js';
import { listenTo, type MessageListenable, type ServiceWorkerContainerLike, type ServiceWorkerRegistrationLike } from './page-env.js';
import { nextMessageId, PWA_MESSAGE, type QueuedMutation } from './protocol.js';
import { DEFAULT_SYNC_TAG, type ReplayReport } from './sw-background-sync.js';
import { askServiceWorker } from './sw-client.js';

export interface MutationQueueClientOptions {
  readonly container: ServiceWorkerContainerLike | undefined;
  readonly registration?: () => ServiceWorkerRegistrationLike | undefined;
  /** `window` for the `online` fallback. */
  readonly window?: MessageListenable;
  readonly scope: Scope;
  readonly tag?: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export type MutationInput = Omit<QueuedMutation, 'queuedAt' | 'attempts' | 'id'> & { readonly id?: string };

export interface MutationQueueClient {
  enqueue(mutation: MutationInput, signal?: AbortSignal): Promise<Result<void>>;
  replay(signal?: AbortSignal): Promise<Result<ReplayReport>>;
}

export function createMutationQueueClient(options: MutationQueueClientOptions): MutationQueueClient {
  const tag = options.tag ?? DEFAULT_SYNC_TAG;
  const controller = (): Result<NonNullable<ServiceWorkerContainerLike['controller']>> => {
    const current = options.container?.controller ?? null;
    return current === null ? err(ServiceWorkerUnsupportedError({ message: 'No service worker controls this page; the mutation cannot be queued.' })) : ok(current);
  };
  const replay: MutationQueueClient['replay'] = async (signal) => {
    const worker = controller();
    if (!worker.ok || options.container === undefined) return err(worker.ok ? ServiceWorkerUnsupportedError() : worker.error);
    const answer = await askServiceWorker({
      container: options.container,
      worker: worker.value,
      message: { type: PWA_MESSAGE.replay, id: nextMessageId('replay') },
      reply: PWA_MESSAGE.replayed,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!answer.ok) return err(answer.error);
    return ok({ replayed: answer.value.replayed, dropped: answer.value.dropped, remaining: answer.value.remaining });
  };
  const hasSync = (): boolean => options.registration?.()?.sync !== undefined;
  if (options.window !== undefined) {
    options.scope.defer(
      listenTo(options.window, 'online', () => {
        if (!hasSync()) void replay();
      }),
    );
  }
  return {
    async enqueue(input, signal) {
      if (input.idempotent !== true) return err(NonIdempotentMutationError({ details: { url: input.url, method: input.method } }));
      const worker = controller();
      if (!worker.ok || options.container === undefined) return err(worker.ok ? ServiceWorkerUnsupportedError() : worker.error);
      const mutation: QueuedMutation = { ...input, id: input.id ?? nextMessageId('mut'), queuedAt: (options.now ?? Date.now)() };
      const answer = await askServiceWorker({
        container: options.container,
        worker: worker.value,
        message: { type: PWA_MESSAGE.queueMutation, id: nextMessageId('q'), mutation },
        reply: PWA_MESSAGE.queued,
        timeoutMs: options.timeoutMs ?? 5000,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!answer.ok) return err(answer.error);
      if (!answer.value.queued) return err(NonIdempotentMutationError({ message: `The service worker refused the mutation (${answer.value.reason ?? 'unknown'}).` }));
      await options.registration?.()?.sync?.register(tag).catch(() => undefined);
      return ok();
    },
    replay,
  };
}
