/**
 * Shared fixtures for the pipeline contract suites (seqlock cell, clock cell,
 * record ring, delta stream): which media a suite runs on. Each suite runs the
 * same cases on every medium, so a pipe behaves the same with both ends in one
 * worker (`local`) or across workers (`shared`, `message`). Cross-thread runs
 * (real concurrency) live next to the implementation in `worker_threads` tests.
 */
import { createLink, createPortPair, fromMessagePort, type Link } from '@staticflux/worker';
import type { MessageEndpointPair, PipeMedium } from '@staticflux/worker/pipeline';

export interface PipeContractMedium {
  readonly name: string;
  readonly medium: PipeMedium;
  /** Port pairs for the message medium (default: a real MessageChannel). */
  readonly channel?: () => MessageEndpointPair;
}

/** The three media, in-thread. `shared` needs SharedArrayBuffer (Node, or an isolated page). */
export const PIPE_CONTRACT_MEDIA: readonly PipeContractMedium[] = [
  { name: 'local (colocated)', medium: 'local' },
  { name: 'shared (SharedArrayBuffer)', medium: 'shared' },
  { name: 'message (postMessage)', medium: 'message' },
];

/** Media available in this realm (drops `shared` without SharedArrayBuffer). */
export function availablePipeMedia(media: readonly PipeContractMedium[] = PIPE_CONTRACT_MEDIA): readonly PipeContractMedium[] {
  return media.filter((m) => m.medium !== 'shared' || typeof SharedArrayBuffer === 'function');
}

/** Region options for a medium (spread into `create*` calls). */
export function mediumOptions(medium: PipeContractMedium): { readonly medium: PipeMedium; readonly channel?: () => MessageEndpointPair } {
  return medium.channel === undefined ? { medium: medium.medium } : { medium: medium.medium, channel: medium.channel };
}

/** A pair of linked ends for link-based contracts (handle, blob, peer, windowed). */
export interface LinkContractTransport {
  readonly name: string;
  /** False when the transport structured-clones (fakes with methods cannot cross it). */
  readonly byReference: boolean;
  pair(): { readonly a: Link; readonly b: Link; close(): void };
}

/** Both ends in one thread: an in-memory pair passing objects by reference (colocated). */
export const inProcessLinks: LinkContractTransport = {
  name: 'in-process (port pair)',
  byReference: true,
  pair() {
    const ports = createPortPair({ clone: false });
    const a = createLink({ port: ports.a, name: 'a' });
    const b = createLink({ port: ports.b, name: 'b' });
    return { a, b, close: () => ports.close() };
  },
};

/** A real MessageChannel (structured clone + transfer, as across workers). */
export const messageChannelLinks: LinkContractTransport = {
  name: 'MessageChannel',
  byReference: false,
  pair() {
    const channel = new MessageChannel();
    const a = createLink({ port: fromMessagePort(channel.port1), name: 'a' });
    const b = createLink({ port: fromMessagePort(channel.port2), name: 'b' });
    return {
      a,
      b,
      close() {
        a.close();
        b.close();
      },
    };
  },
};

/** Link transports available in this realm. */
export function availableLinkTransports(): readonly LinkContractTransport[] {
  return typeof MessageChannel === 'function' ? [inProcessLinks, messageChannelLinks] : [inProcessLinks];
}

/** Let queued messages and microtasks run (message media deliver asynchronously). */
export function settle(turns = 3): Promise<void> {
  return new Promise((resolve) => {
    let left = turns;
    const step = (): void => {
      left -= 1;
      if (left <= 0) resolve();
      else setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

/** Poll `condition` (with real timers) until true or `ms` elapse. */
export async function eventually(condition: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${message}: condition not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
