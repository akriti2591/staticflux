/**
 * Handle channel contract (SF-Δ17): ownership and close accounting over a link
 * transport. After `send()` the sender's handle is released (use throws
 * SF-WK-037), the receiver owns and must close it, sends are all-or-nothing,
 * undeclared kinds are refused on both ends, and a disposed ledger closes and
 * reports what leaked (SF-WK-038).
 *
 * Node has no platform handles, so by default the suite uses duck-typed fakes
 * (`createFakeHandle`), which only cross by-reference transports. In a browser,
 * pass `makeHandle` with real `VideoFrame`s / `ImageBitmap`s to run it over a
 * MessageChannel.
 *
 * @example
 * runHandleChannelContract(inProcessLinks, { describe, it });
 */
import {
  createHandleChannel,
  createHandleLedger,
  defineHandleChannel,
  type HandleKind,
  HandleLeakError,
  HandleReleasedError,
  UnsupportedHandleError,
} from '@staticflux/worker/pipeline';
import type { SfError } from '@staticflux/core';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue } from './contract-runner.js';
import { eventually, type LinkContractTransport } from './pipe-contract-support.js';

/** A duck-typed stand-in for a platform handle (records `close()`). */
export interface FakeHandle {
  readonly kind: HandleKind | 'file' | 'directory';
  closed: boolean;
  [key: string]: unknown;
}

/** Minimal shapes `classifyHandle` recognises (ownership tests only; not media fakes). */
export function createFakeHandle(kind: HandleKind): FakeHandle {
  const closeable = { closed: false, close(this: FakeHandle) {
    this.closed = true;
  } };
  switch (kind) {
    case 'video-frame':
      return { ...closeable, kind, codedWidth: 64, codedHeight: 64, timestamp: 0, clone() {
        return createFakeHandle('video-frame');
      } } as unknown as FakeHandle;
    case 'audio-data':
      return { ...closeable, kind, numberOfFrames: 128, sampleRate: 48_000, numberOfChannels: 2 } as unknown as FakeHandle;
    case 'image-bitmap':
      return { ...closeable, kind, width: 8, height: 8 } as unknown as FakeHandle;
    case 'offscreen-canvas':
      return { kind, closed: false, width: 8, height: 8, getContext: () => null, transferToImageBitmap: () => createFakeHandle('image-bitmap') } as unknown as FakeHandle;
    case 'file-system-handle':
      return { kind: 'directory', closed: false, name: 'workspace', isSameEntry: async () => false } as unknown as FakeHandle;
  }
}

const Frames = defineHandleChannel<{ readonly t: number }>({ id: 'contract/frames', kinds: ['video-frame', 'image-bitmap', 'offscreen-canvas', 'file-system-handle'] });
const AudioOnly = defineHandleChannel<{ readonly t: number }>({ id: 'contract/frames', kinds: ['audio-data'] });

export interface HandleChannelContractCase {
  readonly name: string;
  run(transport: LinkContractTransport, makeHandle: (kind: HandleKind) => unknown): Promise<void>;
}

const TIMEOUT = 2_000;

function open(transport: LinkContractTransport) {
  const links = transport.pair();
  const leaks: SfError[] = [];
  const senderLedger = createHandleLedger({ onLeak: (e) => leaks.push(e), finalization: () => undefined });
  const receiverLedger = createHandleLedger({ onLeak: (e) => leaks.push(e), finalization: () => undefined });
  const sender = createHandleChannel(links.a, Frames, { ledger: senderLedger });
  const receiver = createHandleChannel(links.b, Frames, { ledger: receiverLedger });
  return { links, leaks, senderLedger, receiverLedger, sender, receiver };
}

export const handleChannelContractCases: readonly HandleChannelContractCase[] = [
  {
    name: 'moves ownership: released on the sender, owned (and closed) by the receiver',
    async run(transport, makeHandle) {
      const { links, senderLedger, receiverLedger, sender, receiver } = open(transport);
      const received: { t: number; kinds: HandleKind[] }[] = [];
      const owned: { close(): void; readonly closed: boolean }[] = [];
      receiver.on(({ meta, handles }) => {
        received.push({ t: meta.t, kinds: handles.map((h) => h.kind) });
        owned.push(...handles);
      });
      const frame = okValue(senderLedger.own(makeHandle('video-frame')), 'own frame');
      const canvas = okValue(senderLedger.own(makeHandle('offscreen-canvas')), 'own canvas');
      assertEqual(senderLedger.live['video-frame'], 1, 'one live frame');
      okValue(sender.send({ t: 7 }, [frame, canvas]), 'send');
      assertTrue(frame.released && canvas.released, 'released on the sender');
      let threw: unknown;
      try {
        void frame.value;
      } catch (error) {
        threw = error;
      }
      assertEqual((threw as { code?: string } | undefined)?.code, HandleReleasedError.code, 'use after send throws SF-WK-037');
      assertEqual({ live: senderLedger.live['video-frame'], sent: senderLedger.totals.sent }, { live: 0, sent: 2 }, 'sender accounting');
      await eventually(() => received.length === 1, TIMEOUT, 'received');
      assertEqual(received[0], { t: 7, kinds: ['video-frame', 'offscreen-canvas'] }, 'meta and kinds');
      assertEqual({ live: receiverLedger.live['video-frame'], received: receiverLedger.totals.received }, { live: 1, received: 2 }, 'receiver owns them');
      for (const handle of owned) handle.close();
      assertEqual({ live: receiverLedger.live['video-frame'], closed: receiverLedger.totals.closed }, { live: 0, closed: 2 }, 'closed accounting');
      links.close();
    },
  },
  {
    name: 'send is all or nothing: undeclared kinds and released handles are refused',
    async run(transport, makeHandle) {
      const { links, senderLedger, sender } = open(transport);
      const frame = okValue(senderLedger.own(makeHandle('video-frame')), 'frame');
      const audio = okValue(senderLedger.own(makeHandle('audio-data')), 'audio');
      assertEqual(errOf(sender.send({ t: 1 }, [frame, audio]), 'undeclared').code, UnsupportedHandleError.code, 'SF-WK-039');
      assertTrue(!frame.released, 'nothing was released');
      frame.close();
      assertEqual(errOf(sender.send({ t: 1 }, [frame]), 'closed').code, HandleReleasedError.code, 'a closed handle cannot be sent');
      const foreign = okValue(createHandleLedger({ finalization: () => undefined }).own(makeHandle('video-frame')), 'foreign');
      assertEqual(errOf(sender.send({ t: 1 }, [foreign]), 'foreign').code, UnsupportedHandleError.code, 'handles of another ledger');
      assertEqual(errOf(senderLedger.own({ not: 'a handle' }), 'not a handle').code, UnsupportedHandleError.code, 'own() refuses non-handles');
      links.close();
    },
  },
  {
    name: 'the receiver refuses kinds its definition does not declare (and closes them)',
    async run(transport, makeHandle) {
      const links = transport.pair();
      const ledger = createHandleLedger({ finalization: () => undefined });
      const sender = createHandleChannel(links.a, Frames, { ledger });
      const strict = createHandleChannel(links.b, AudioOnly, { ledger: createHandleLedger({ finalization: () => undefined }) });
      let delivered = 0;
      strict.on(() => {
        delivered += 1;
      });
      const raw = makeHandle('video-frame');
      okValue(sender.send({ t: 1 }, [okValue(ledger.own(raw), 'own')]), 'send');
      await eventually(() => strict.stats.rejected === 1, TIMEOUT, 'rejected');
      assertEqual(delivered, 0, 'not delivered');
      if (transport.byReference) assertTrue((raw as FakeHandle).closed, 'the refused frame was closed');
      links.close();
    },
  },
  {
    name: 'a disposed ledger closes live handles and reports the leak (SF-WK-038)',
    async run(transport, makeHandle) {
      const { links, leaks, senderLedger } = open(transport);
      const raw = makeHandle('image-bitmap');
      okValue(senderLedger.own(raw), 'own');
      okValue(senderLedger.own(makeHandle('file-system-handle')), 'own directory');
      const errors = senderLedger.dispose();
      assertEqual(errors.map((e) => e.code), [HandleLeakError.code], 'one leak report');
      assertEqual(errors[0]?.details['kinds'], ['image-bitmap'], 'only closeable kinds leak');
      assertEqual(leaks.length, 1, 'onLeak called');
      assertEqual({ leaked: senderLedger.totals.leaked, live: senderLedger.live['image-bitmap'] }, { leaked: 1, live: 0 }, 'accounting');
      if (transport.byReference) assertTrue((raw as FakeHandle).closed, 'the leaked bitmap was closed');
      links.close();
    },
  },
];

export function runHandleChannelContract(
  transport: LinkContractTransport,
  runner: ContractRunner,
  options: { readonly makeHandle?: (kind: HandleKind) => unknown; readonly skip?: readonly string[] } = {},
): void {
  // Fakes have methods: they only cross transports that pass objects by reference.
  if (options.makeHandle === undefined && !transport.byReference) return;
  const makeHandle = options.makeHandle ?? createFakeHandle;
  runner.describe(`handle channel contract: ${transport.name}`, () => {
    for (const testCase of handleChannelContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, () => testCase.run(transport, makeHandle));
    }
  });
}
