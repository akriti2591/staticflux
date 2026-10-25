/**
 * Blob side channel contract (SF-Δ18): `createBlobSender` / `createBlobReceiver`
 * over a link transport. Content-addressed dedupe, re-send after a receiver
 * restart, eviction → re-request → re-send, `gone` when nothing is retained.
 *
 * @example
 * for (const transport of availableLinkTransports()) runBlobSideChannelContract(transport, { describe, it });
 */
import { createBlobReceiver, createBlobSender, defineBlobChannel, digestBytes } from '@staticflux/worker/pipeline';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue, within } from './contract-runner.js';
import { eventually, type LinkContractTransport, settle } from './pipe-contract-support.js';

const SceneBlobs = defineBlobChannel('contract/scene-blobs');

export interface BlobSideChannelContractCase {
  readonly name: string;
  run(transport: LinkContractTransport): Promise<void>;
}

const TIMEOUT = 2_000;
const bytesOf = (...values: number[]): Uint8Array => new Uint8Array(values);

export const blobSideChannelContractCases: readonly BlobSideChannelContractCase[] = [
  {
    name: 'sends a blob once by digest and dedupes repeats',
    async run(transport) {
      const { a, b, close } = transport.pair();
      const receiver = createBlobReceiver(b, SceneBlobs);
      await settle();
      const sender = createBlobSender(a, SceneBlobs);
      const input = bytesOf(1, 2, 3, 4, 5);
      const digest = okValue(sender.put(input), 'put');
      assertEqual(digest, digestBytes(input), 'the default digest');
      assertEqual(input.byteLength, 5, 'the caller keeps its bytes (a copy is transferred)');
      okValue(await within(receiver.waitFor([digest], { timeoutMs: TIMEOUT }), TIMEOUT + 500, 'waitFor'), 'arrived');
      assertEqual([...(receiver.get(digest) ?? [])], [1, 2, 3, 4, 5], 'content');
      okValue(sender.put(bytesOf(1, 2, 3, 4, 5)), 'put again');
      assertEqual({ sent: sender.stats.sent, deduped: sender.stats.deduped }, { sent: 1, deduped: 1 }, 'deduped');
      assertTrue(sender.has(digest), 'the sender knows the receiver holds it');
      sender.close();
      receiver.close();
      close();
    },
  },
  {
    name: 'a restarted receiver gets blobs again',
    async run(transport) {
      const { a, b, close } = transport.pair();
      const first = createBlobReceiver(b, SceneBlobs);
      await settle();
      const sender = createBlobSender(a, SceneBlobs);
      const digest = okValue(sender.put(bytesOf(9, 9)), 'put');
      okValue(await within(first.waitFor([digest], { timeoutMs: TIMEOUT }), TIMEOUT + 500, 'first'), 'first');
      first.close();
      const second = createBlobReceiver(b, SceneBlobs); // announces reset
      await eventually(() => !sender.has(digest), TIMEOUT, 'sender forgot after reset');
      okValue(sender.put(bytesOf(9, 9)), 'put after restart');
      okValue(await within(second.waitFor([digest], { timeoutMs: TIMEOUT }), TIMEOUT + 500, 'second'), 'resent');
      assertEqual(sender.stats.sent, 2, 'sent twice');
      sender.close();
      second.close();
      close();
    },
  },
  {
    name: 'eviction → request → re-send from retained copies',
    async run(transport) {
      const { a, b, close } = transport.pair();
      const receiver = createBlobReceiver(b, SceneBlobs, { budgetBytes: 4 });
      await settle();
      const sender = createBlobSender(a, SceneBlobs);
      const first = okValue(sender.put(bytesOf(1, 1, 1)), 'first');
      const second = okValue(sender.put(bytesOf(2, 2, 2)), 'second');
      okValue(await within(receiver.waitFor([second], { timeoutMs: TIMEOUT }), TIMEOUT + 500, 'second'), 'second arrived');
      assertTrue(!receiver.has(first), 'the first blob was evicted');
      await eventually(() => !sender.has(first), TIMEOUT, 'the sender learned about the eviction');
      receiver.request([first]);
      okValue(await within(receiver.waitFor([first], { timeoutMs: TIMEOUT }), TIMEOUT + 500, 'resent'), 'resent');
      assertEqual(sender.stats.resent, 1, 're-sent once');
      assertTrue(receiver.stats.evicted >= 1, 'evictions counted');
      sender.close();
      receiver.close();
      close();
    },
  },
  {
    name: 'answers gone when nothing is retained',
    async run(transport) {
      const { a, b, close } = transport.pair();
      const receiver = createBlobReceiver(b, SceneBlobs);
      await settle();
      const sender = createBlobSender(a, SceneBlobs, { retainBytes: 0 });
      receiver.request(['never-sent']);
      const waited = await within(receiver.waitFor(['never-sent'], { timeoutMs: TIMEOUT }), TIMEOUT + 500, 'gone');
      assertEqual(errOf(waited, 'gone').details['digest'], 'never-sent', 'the wait fails with the digest');
      assertTrue(receiver.gone('never-sent'), 'marked gone');
      assertEqual(sender.stats.gone, 1, 'the sender answered gone');
      assertEqual(okValue(await receiver.waitFor(['other'], { timeoutMs: 5 }), 'timeout'), false, 'waitFor times out');
      sender.close();
      receiver.close();
      close();
    },
  },
];

export function runBlobSideChannelContract(
  transport: LinkContractTransport,
  runner: ContractRunner,
  options: { readonly skip?: readonly string[] } = {},
): void {
  runner.describe(`blob side channel contract: ${transport.name}`, () => {
    for (const testCase of blobSideChannelContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, () => testCase.run(transport));
    }
  });
}
