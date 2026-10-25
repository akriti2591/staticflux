/**
 * Peer channel contract (SF-Δ19): one `PeerChannel` API for both D15
 * topologies — `createPeerPair` (colocated) and a brokered pair (`acceptPeer`
 * in each worker, `createPeerBroker` on main) over in-process or MessageChannel
 * links. Events and requests both ways, and the **re-wire on respawn**: the
 * surviving side keeps its listeners and handlers, sees a new generation, and
 * re-runs `onConnect` (with the previous connection's cleanup).
 *
 * @example
 * runPeerChannelContract(colocatedPeerSetup, { describe, it });
 * runPeerChannelContract(brokeredPeerSetup(inProcessLinks), { describe, it });
 */
import type { Link } from '@staticflux/worker';
import {
  acceptPeer,
  createPeerBroker,
  createPeerPair,
  definePeer,
  memoryWire,
  messageChannelWire,
  type PeerChannel,
  type PeerHost,
  PeerNotConnectedError,
} from '@staticflux/worker/pipeline';
import { ok } from '@staticflux/core';
import { assertEqual, assertTrue, type ContractRunner, errOf, okValue, within } from './contract-runner.js';
import { eventually, type LinkContractTransport } from './pipe-contract-support.js';

const EditorRender = definePeer('contract/editor-render');
const Ping = 'contract/ping' as const;
const Echo = 'contract/echo' as const;

/** One connected pair; `killB` / `startB` mirror the render worker crashing and respawning. */
export interface PeerContractSetup {
  readonly a: PeerChannel;
  /** The current B end (replaced by `startB` in brokered setups). */
  readonly b: PeerChannel;
  killB(): Promise<void>;
  /** `prepare` runs on the new B end before it connects (register handlers there, as a worker's setup does). */
  startB(prepare?: (b: PeerChannel) => void): Promise<PeerChannel>;
  dispose(): void;
}

export interface PeerSetupFactory {
  readonly name: string;
  create(): Promise<PeerContractSetup>;
}

const TIMEOUT = 2_000;

/** Colocated topology: both ends in one worker. */
export const colocatedPeerSetup: PeerSetupFactory = {
  name: 'colocated (createPeerPair)',
  async create() {
    const pair = createPeerPair(EditorRender);
    return {
      a: pair.a,
      get b() {
        return pair.b;
      },
      async killB() {
        pair.disconnect();
      },
      async startB(prepare) {
        prepare?.(pair.b);
        pair.rewire();
        return pair.b;
      },
      dispose: () => pair.close(),
    };
  },
};

function swappableHost(id: string): PeerHost & { set(link: Link | undefined): void } {
  let current: Link | undefined;
  const listeners = new Set<(link: Link | undefined) => void>();
  return {
    id,
    get link() {
      return current;
    },
    onLink(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(link) {
      current = link;
      for (const listener of [...listeners]) listener(link);
    },
  };
}

/** Split topology: a broker on "main" and `acceptPeer` in each "worker", over the given links. */
export function brokeredPeerSetup(transport: LinkContractTransport): PeerSetupFactory {
  return {
    name: `brokered over ${transport.name}`,
    async create() {
      const broker = createPeerBroker({ wire: transport.byReference ? memoryWire() : messageChannelWire });
      const hostA = swappableHost('worker-a');
      const hostB = swappableHost('worker-b');
      broker.connect(EditorRender, hostA, hostB);
      const toA = transport.pair();
      hostA.set(toA.a);
      const a = acceptPeer(toA.b, EditorRender);
      let toB = transport.pair();
      let b: PeerChannel | undefined;
      const start = async (prepare?: (b: PeerChannel) => void): Promise<PeerChannel> => {
        toB = transport.pair();
        hostB.set(toB.a);
        const next = acceptPeer(toB.b, EditorRender);
        prepare?.(next);
        b = next;
        okValue(await within(next.whenConnected(), TIMEOUT, 'B connects'), 'B connects');
        okValue(await within(a.whenConnected(), TIMEOUT, 'A connects'), 'A connects');
        await eventually(() => a.generation === next.generation, TIMEOUT, 'both ends on one generation');
        return next;
      };
      await start();
      return {
        a,
        get b() {
          return b as PeerChannel;
        },
        async killB() {
          b?.close();
          hostB.set(undefined);
          toB.close();
          await eventually(() => a.state === 'disconnected', TIMEOUT, 'A sees B go away');
        },
        startB: start,
        dispose() {
          broker.dispose();
          a.close();
          b?.close();
          toA.close();
          toB.close();
        },
      };
    },
  };
}

export interface PeerChannelContractCase {
  readonly name: string;
  run(setup: PeerContractSetup): Promise<void>;
}

const nextMessage = (peer: PeerChannel, channel: typeof Ping): Promise<unknown> =>
  new Promise((resolve) => {
    const off = peer.on(channel, (payload) => {
      off();
      resolve(payload);
    });
  });

export const peerChannelContractCases: readonly PeerChannelContractCase[] = [
  {
    name: 'connects both ends and carries events both ways',
    async run({ a, b }) {
      okValue(await within(a.whenConnected(), TIMEOUT, 'a'), 'a');
      okValue(await within(b.whenConnected(), TIMEOUT, 'b'), 'b');
      assertEqual([a.state, b.state], ['connected', 'connected'], 'connected');
      const toB = nextMessage(b, Ping);
      okValue(a.send(Ping, { n: 1 }), 'send a→b');
      assertEqual(await within(toB, TIMEOUT, 'a→b'), { n: 1 }, 'a → b');
      const toA = nextMessage(a, Ping);
      okValue(b.send(Ping, { n: 2 }), 'send b→a');
      assertEqual(await within(toA, TIMEOUT, 'b→a'), { n: 2 }, 'b → a');
    },
  },
  {
    name: 'serves requests both ways',
    async run({ a, b }) {
      b.handle(Echo, (payload) => ok({ echoed: payload }));
      a.handle(Echo, (payload) => ok({ back: payload }));
      assertEqual(okValue(await within(a.request(Echo, 'x'), TIMEOUT, 'a→b'), 'a→b'), { echoed: 'x' }, 'b answers');
      assertEqual(okValue(await within(b.request(Echo, 'y'), TIMEOUT, 'b→a'), 'b→a'), { back: 'y' }, 'a answers');
    },
  },
  {
    name: 're-wires on respawn: new generation, listeners and handlers survive, onConnect re-runs',
    async run(setup) {
      const { a } = setup;
      const connects: number[] = [];
      let cleanups = 0;
      a.onConnect((_link, generation) => {
        connects.push(generation);
        return () => {
          cleanups += 1;
        };
      });
      const received: unknown[] = [];
      a.on(Ping, (payload) => received.push(payload));
      a.handle(Echo, (payload) => ok({ from: 'a', payload }));
      const before = a.generation;
      await setup.killB();
      const b2 = await setup.startB();
      await eventually(() => a.generation > before && a.state === 'connected', TIMEOUT, 'A re-wired');
      assertEqual(connects.length, 2, 'onConnect ran for the first and the new connection');
      assertTrue((connects[1] as number) > (connects[0] as number), 'increasing generations');
      assertEqual(cleanups, 1, 'the first connection was cleaned up');
      okValue(b2.send(Ping, 'after respawn'), 'b2 sends');
      await eventually(() => received.length === 1, TIMEOUT, 'listener survived');
      assertEqual(received, ['after respawn'], 'listener survived the re-wire');
      assertEqual(okValue(await within(b2.request(Echo, 1), TIMEOUT, 'request'), 'request'), { from: 'a', payload: 1 }, 'handler survived');
    },
  },
  {
    name: 'while disconnected: send fails with SF-WK-040, waitForConnection waits for the next generation',
    async run(setup) {
      const { a } = setup;
      await setup.killB();
      assertEqual(a.state, 'disconnected', 'disconnected');
      assertEqual(errOf(a.send(Ping, 1), 'send').code, PeerNotConnectedError.code, 'send fails');
      assertEqual(errOf(await a.request(Echo, 1), 'request').code, PeerNotConnectedError.code, 'request fails fast');
      const waiting = a.request(Echo, 'later', { waitForConnection: true, timeoutMs: TIMEOUT });
      await setup.startB((b2) => b2.handle(Echo, (payload) => ok({ late: payload })));
      assertEqual(okValue(await within(waiting, TIMEOUT + 500, 'waited'), 'waited'), { late: 'later' }, 'answered by the new B');
    },
  },
  {
    name: 'in-flight requests fail when the peer goes away',
    async run(setup) {
      const { a, b } = setup;
      b.handle(Echo, () => new Promise(() => undefined)); // never answers
      const inFlight = a.request(Echo, 1, { timeoutMs: TIMEOUT });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await setup.killB();
      const outcome = await within(inFlight, TIMEOUT + 500, 'in flight');
      assertTrue(!outcome.ok, 'the request failed instead of hanging');
    },
  },
  {
    name: 'close() ends the channel',
    async run({ a }) {
      a.close();
      assertEqual(a.state, 'closed', 'closed');
      assertEqual(errOf(await a.whenConnected(), 'closed').code, PeerNotConnectedError.code, 'no more connections');
    },
  },
];

export function runPeerChannelContract(
  factory: PeerSetupFactory,
  runner: ContractRunner,
  options: { readonly skip?: readonly string[] } = {},
): void {
  runner.describe(`peer channel contract: ${factory.name}`, () => {
    for (const testCase of peerChannelContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, async () => {
        const setup = await factory.create();
        try {
          await testCase.run(setup);
        } finally {
          setup.dispose();
        }
      });
    }
  });
}
