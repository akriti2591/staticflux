/**
 * Windowed replica contract (SF-Δ19): a `WindowedSource` served by
 * `createWindowedPublisher` and read through `createWindowedReplica` over a link
 * transport. The suite drives the source through `WindowedSourceDriver`, so a
 * store's own source (a spatial index, a subtree index) can be checked against
 * the same cases as the reference `createMemoryWindowedSource`. Entities are
 * points on a line (`{ x }`), windows are ranges (`{ min, max }`); a driver maps
 * them onto its own geometry.
 *
 * @example
 * for (const transport of availableLinkTransports()) runWindowedReplicaContract(transport, memoryWindowedDriver, { describe, it });
 */
import {
  createMemoryWindowedSource,
  createWindowedPublisher,
  createWindowedReplica,
  defineWindowedReplica,
  type WindowedSource,
} from '@staticflux/worker/pipeline';
import { assertEqual, assertTrue, type ContractRunner, okValue, within } from './contract-runner.js';
import { eventually, type LinkContractTransport } from './pipe-contract-support.js';

export interface Point {
  readonly x: number;
}
export interface Range {
  readonly min: number;
  readonly max: number;
}

/** How the suite drives a source. */
export interface WindowedSourceDriver {
  readonly name: string;
  create(): {
    readonly source: WindowedSource<string, Point, Range>;
    set(key: string, entity: Point): void;
    remove(key: string): void;
  };
}

/** The reference driver over `createMemoryWindowedSource`. */
export const memoryWindowedDriver: WindowedSourceDriver = {
  name: 'memory source',
  create() {
    const source = createMemoryWindowedSource<string, Point, Range>((w, _k, p) => p.x >= w.min && p.x <= w.max);
    return { source, set: (key, entity) => source.set(key, entity), remove: (key) => void source.delete(key) };
  },
};

const Visible = defineWindowedReplica('contract/visible').type<Point, Range>();

export interface WindowedReplicaContractCase {
  readonly name: string;
  run(transport: LinkContractTransport, driver: WindowedSourceDriver): Promise<void>;
}

const TIMEOUT = 2_000;
const keys = (map: ReadonlyMap<string, unknown>): string[] => [...map.keys()].sort();

async function open(transport: LinkContractTransport, driver: WindowedSourceDriver) {
  const links = transport.pair();
  const store = driver.create();
  for (const [key, x] of [
    ['a', 1],
    ['b', 5],
    ['c', 9],
    ['d', 15],
  ] as const) {
    store.set(key, { x });
  }
  const publisher = createWindowedPublisher({ definition: Visible, source: store.source });
  publisher.attach(links.a);
  const replica = createWindowedReplica(Visible);
  okValue(await within(replica.attach(links.b), TIMEOUT, 'attach'), 'attach');
  return { links, store, publisher, replica };
}

export const windowedReplicaContractCases: readonly WindowedReplicaContractCase[] = [
  {
    name: 'fills the window with the entities inside it',
    async run(transport, driver) {
      const { links, publisher, replica } = await open(transport, driver);
      okValue(await within(replica.setWindow({ min: 0, max: 10 }), TIMEOUT, 'setWindow'), 'setWindow');
      assertEqual(keys(replica.entries), ['a', 'b', 'c'], 'a, b, c are inside');
      assertEqual(replica.status, 'live', 'live');
      assertEqual(replica.entries.get('b'), { x: 5 }, 'entity values');
      publisher.dispose();
      links.close();
    },
  },
  {
    name: 'routes changes: enter, update inside, leave, delete; outside changes are not sent',
    async run(transport, driver) {
      const { links, store, publisher, replica } = await open(transport, driver);
      okValue(await within(replica.setWindow({ min: 0, max: 10 }), TIMEOUT, 'setWindow'), 'setWindow');
      const events: { upserts: string[]; removes: string[] }[] = [];
      replica.subscribe((event) => events.push({ upserts: event.upserts.map(([k]) => k), removes: [...event.removes] }));
      store.set('d', { x: 4 }); // enters
      await eventually(() => replica.entries.has('d'), TIMEOUT, 'd entered');
      store.set('b', { x: 6 }); // changes inside
      await eventually(() => replica.entries.get('b')?.x === 6, TIMEOUT, 'b updated');
      store.set('c', { x: 50 }); // leaves
      await eventually(() => !replica.entries.has('c'), TIMEOUT, 'c left');
      store.remove('a'); // deleted
      await eventually(() => !replica.entries.has('a'), TIMEOUT, 'a deleted');
      store.set('z', { x: 100 }); // outside: no event
      store.set('e', { x: 2 }); // a later inside change proves ordering
      await eventually(() => replica.entries.has('e'), TIMEOUT, 'e entered');
      assertEqual(keys(replica.entries), ['b', 'd', 'e'], 'the window contents');
      assertTrue(events.every((e) => !e.upserts.includes('z')), 'outside changes were not sent');
      publisher.dispose();
      links.close();
    },
  },
  {
    name: 'moving the window sends only the difference',
    async run(transport, driver) {
      const { links, publisher, replica } = await open(transport, driver);
      okValue(await within(replica.setWindow({ min: 0, max: 6 }), TIMEOUT, 'first'), 'first');
      const events: { reset: boolean; upserts: string[]; removes: string[] }[] = [];
      replica.subscribe((event) => events.push({ reset: event.reset, upserts: event.upserts.map(([k]) => k), removes: [...event.removes] }));
      okValue(await within(replica.setWindow({ min: 4, max: 20 }), TIMEOUT, 'move'), 'move');
      assertEqual(keys(replica.entries), ['b', 'c', 'd'], 'new contents');
      assertEqual(events, [{ reset: false, upserts: ['c', 'd'], removes: ['a'] }], 'one diff, b kept');
      publisher.dispose();
      links.close();
    },
  },
  {
    name: 'a respawned owner (new epoch) resets the window on re-attach',
    async run(transport, driver) {
      const { links, store, publisher, replica } = await open(transport, driver);
      okValue(await within(replica.setWindow({ min: 0, max: 10 }), TIMEOUT, 'setWindow'), 'setWindow');
      const epoch = replica.epoch;
      publisher.dispose();
      links.close();
      store.set('a', { x: 3 });
      const fresh = transport.pair();
      createWindowedPublisher({ definition: Visible, source: store.source }).attach(fresh.a);
      let reset = false;
      replica.subscribe((event) => {
        if (event.reset) reset = true;
      });
      okValue(await within(replica.attach(fresh.b), TIMEOUT, 're-attach'), 're-attach');
      assertTrue(reset && replica.epoch !== epoch, 'reset from the new owner');
      assertEqual(keys(replica.entries), ['a', 'b', 'c'], 'same window, fresh contents');
      assertEqual(replica.entries.get('a'), { x: 3 }, 'current values');
      fresh.close();
    },
  },
];

export function runWindowedReplicaContract(
  transport: LinkContractTransport,
  driver: WindowedSourceDriver,
  runner: ContractRunner,
  options: { readonly skip?: readonly string[] } = {},
): void {
  runner.describe(`windowed replica contract: ${driver.name} over ${transport.name}`, () => {
    for (const testCase of windowedReplicaContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, () => testCase.run(transport, driver));
    }
  });
}
