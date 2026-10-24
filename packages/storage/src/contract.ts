/**
 * Shared contract suite every `AsyncStore` must pass (adapters, middleware
 * chains, consumer-provided backends). Test-framework neutral: pass your
 * runner's `describe`/`it` (Vitest, Jest, node:test); assertions throw `Error`.
 *
 * @example
 * import { describe, it } from 'vitest';
 * runStoreContract('memory', () => createMemoryStore(), { describe, it }, { advanceTime: (ms) => clock.advance(ms) });
 */
import type { Result } from '@staticflux/core';
import type { AsyncStore, StoreChange } from './types.js';

export interface ContractRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
}

export interface ContractOptions {
  /** Advance the clock the store's TTL uses (enables expiry checks for `capabilities.ttl` stores). */
  readonly advanceTime?: (ms: number) => void;
  /** Wait for async change delivery (default: a few microtask/macrotask turns). */
  readonly settle?: () => Promise<void>;
  /** Skip named cases (e.g. a backend that cannot store some value shape). */
  readonly skip?: readonly string[];
}

export type StoreFactoryFn = () => AsyncStore<unknown> | Promise<AsyncStore<unknown>>;

export interface ContractCase {
  readonly name: string;
  run(store: AsyncStore<unknown>, options: ContractOptions): Promise<void>;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function value<T>(result: Result<T>, message: string): T {
  if (!result.ok) throw new Error(`${message}: unexpected error ${result.error.code} ${result.error.message}`);
  return result.value;
}

function code(result: Result<unknown>, expected: string, message: string): void {
  if (result.ok) throw new Error(`${message}: expected ${expected}, got ok(${JSON.stringify(result.value)})`);
  if (result.error.code !== expected) throw new Error(`${message}: expected ${expected}, got ${result.error.code} (${result.error.message})`);
}

const defaultSettle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const SAMPLE = { title: 'Draft', count: 3, ok: true, none: null, tags: ['a', 'b'], nested: { deep: [1, { x: 2 }] } };

export const storeContractCases: readonly ContractCase[] = [
  {
    name: 'missing keys read as undefined',
    async run(store) {
      equal(value(await store.get('missing'), 'get'), undefined, 'get(missing)');
      equal(value(await store.has('missing'), 'has'), false, 'has(missing)');
    },
  },
  {
    name: 'set/get round-trips plain data',
    async run(store) {
      for (const [key, v] of [['obj', SAMPLE], ['str', 'hello'], ['num', 42], ['bool', false], ['nil', null], ['arr', [1, 'two', { three: 3 }]]] as const) {
        value(await store.set(key, v), `set(${key})`);
        equal(value(await store.get(key), `get(${key})`), v, `round-trip ${key}`);
        equal(value(await store.has(key), `has(${key})`), true, `has(${key})`);
      }
    },
  },
  {
    name: 'overwrites and deletes',
    async run(store) {
      value(await store.set('k', 1), 'set');
      value(await store.set('k', 2), 'overwrite');
      equal(value(await store.get('k'), 'get'), 2, 'overwritten value');
      value(await store.delete('k'), 'delete');
      equal(value(await store.get('k'), 'get after delete'), undefined, 'deleted');
      value(await store.delete('never-existed'), 'delete missing is ok');
    },
  },
  {
    name: 'returned values are copies',
    async run(store) {
      value(await store.set('copy', { list: [1] }), 'set');
      const first = value(await store.get('copy'), 'get') as { list: number[] };
      first.list.push(2);
      equal(value(await store.get('copy'), 'get again'), { list: [1] }, 'mutating a read value must not change the store');
    },
  },
  {
    name: 'keys with special characters',
    async run(store) {
      const keys = ['a/b', 'ü-ñ', 'a:b c', '.', '..', 'x=y;z', 'emoji-😀'];
      for (const key of keys) value(await store.set(key, key), `set(${key})`);
      for (const key of keys) equal(value(await store.get(key), `get(${key})`), key, `special key ${key}`);
      equal(value(await store.seek().keys(), 'keys'), [...keys].sort(), 'all special keys listed (sorted)');
    },
  },
  {
    name: 'rejects invalid keys and undefined values',
    async run(store) {
      code(await store.get(''), 'SF-STORE-006', 'empty key');
      code(await store.set('k', undefined), 'SF-STORE-006', 'undefined value');
      code(await store.batch([{ type: 'set', key: 'a', value: 1 }, { type: 'set', key: 'b', value: undefined }]), 'SF-STORE-006', 'invalid batch');
      equal(value(await store.get('a'), 'get a'), undefined, 'invalid batch writes nothing');
    },
  },
  {
    name: 'seek is sorted and honours prefix/range/limit/reverse',
    async run(store) {
      for (const key of ['b:2', 'a:1', 'b:1', 'c', 'a:2', 'b:3']) value(await store.set(key, key.toUpperCase()), `set ${key}`);
      equal(value(await store.seek().keys(), 'all'), ['a:1', 'a:2', 'b:1', 'b:2', 'b:3', 'c'], 'ascending');
      equal(value(await store.seek({ prefix: 'b:' }).keys(), 'prefix'), ['b:1', 'b:2', 'b:3'], 'prefix');
      equal(value(await store.seek({ gte: 'a:2', lt: 'b:3' }).keys(), 'range'), ['a:2', 'b:1', 'b:2'], 'range');
      equal(value(await store.seek({ limit: 2 }).keys(), 'limit'), ['a:1', 'a:2'], 'limit');
      equal(value(await store.seek({ reverse: true, limit: 2 }).keys(), 'reverse'), ['c', 'b:3'], 'reverse + limit');
      equal(value(await store.seek({ prefix: 'b:', reverse: true }).toArray(), 'entries'), [['b:3', 'B:3'], ['b:2', 'B:2'], ['b:1', 'B:1']], 'entries');
      const iterated: string[] = [];
      const cursor = store.seek({ prefix: 'a:' });
      for await (const [key] of cursor) iterated.push(key);
      equal(iterated, ['a:1', 'a:2'], 'async iteration');
      equal(cursor.error, undefined, 'no cursor error');
      equal(value(await store.seek({ prefix: 'zzz' }).keys(), 'empty'), [], 'no matches');
    },
  },
  {
    name: 'batch applies sets and deletes',
    async run(store) {
      value(await store.set('gone', 1), 'set');
      value(
        await store.batch([
          { type: 'set', key: 'x', value: 1 },
          { type: 'set', key: 'y', value: { two: 2 } },
          { type: 'delete', key: 'gone' },
          { type: 'set', key: 'x', value: 3 },
        ]),
        'batch',
      );
      equal(value(await store.seek().toArray(), 'entries'), [['x', 3], ['y', { two: 2 }]], 'batch result');
      value(await store.batch([]), 'empty batch');
    },
  },
  {
    name: 'clear removes everything',
    async run(store) {
      value(await store.batch([{ type: 'set', key: 'a', value: 1 }, { type: 'set', key: 'b', value: 2 }]), 'batch');
      value(await store.clear(), 'clear');
      equal(value(await store.seek().keys(), 'keys'), [], 'empty after clear');
    },
  },
  {
    name: 'watch reports local changes, filters by prefix, unsubscribes',
    async run(store, options) {
      const settle = options.settle ?? defaultSettle;
      const all: StoreChange<unknown>[] = [];
      const prefixed: StoreChange<unknown>[] = [];
      const stop = store.watch((change) => all.push(change));
      const stopPrefixed = store.watch((change) => prefixed.push(change), { prefix: 'p:' });
      value(await store.set('p:1', 'one'), 'set p:1');
      value(await store.set('q', 'q'), 'set q');
      value(await store.delete('p:1'), 'delete');
      await settle();
      equal(all.map((c) => (c.type === 'clear' ? 'clear' : `${c.type}:${c.key}:${c.origin}`)), ['set:p:1:local', 'set:q:local', 'delete:p:1:local'], 'all changes');
      equal(prefixed.map((c) => (c.type === 'clear' ? 'clear' : `${c.type}:${c.key}`)), ['set:p:1', 'delete:p:1'], 'prefixed changes');
      stop();
      stopPrefixed();
      value(await store.set('p:2', 'two'), 'set after unsubscribe');
      await settle();
      equal(all.length, 3, 'no events after unsubscribe');
    },
  },
  {
    name: 'aborted operations fail with SF-STORE-004 and write nothing',
    async run(store) {
      const controller = new AbortController();
      controller.abort();
      code(await store.set('aborted', 1, { signal: controller.signal }), 'SF-STORE-004', 'aborted set');
      code(await store.get('aborted', { signal: controller.signal }), 'SF-STORE-004', 'aborted get');
      code(await store.seek({ signal: controller.signal }).toArray(), 'SF-STORE-004', 'aborted seek');
      equal(value(await store.get('aborted'), 'get'), undefined, 'nothing written');
    },
  },
  {
    name: 'ttl expires entries or is reported unsupported',
    async run(store, options) {
      if (!store.capabilities.ttl) {
        code(await store.set('t', 1, { ttlMs: 100 }), 'SF-STORE-005', 'ttl unsupported');
        return;
      }
      value(await store.set('t', 1, { ttlMs: 1000 }), 'set with ttl');
      value(await store.set('forever', 2), 'set without ttl');
      equal(value(await store.get('t'), 'get before expiry'), 1, 'live before expiry');
      if (options.advanceTime === undefined) return;
      options.advanceTime(1001);
      equal(value(await store.get('t'), 'get after expiry'), undefined, 'expired');
      equal(value(await store.seek().keys(), 'keys after expiry'), ['forever'], 'expired entries are not listed');
    },
  },
  {
    name: 'dispose is idempotent and blocks further use',
    async run(store) {
      value(await store.set('k', 1), 'set');
      value(await store.dispose(), 'dispose');
      value(await store.dispose(), 'dispose again');
      code(await store.get('k'), 'SF-STORE-007', 'get after dispose');
      code(await store.set('k', 2), 'SF-STORE-007', 'set after dispose');
    },
  },
];

/** Register the contract cases with a test runner. Each case gets a fresh store, disposed afterwards. */
export function runStoreContract(name: string, factory: StoreFactoryFn, runner: ContractRunner, options: ContractOptions = {}): void {
  runner.describe(`AsyncStore contract: ${name}`, () => {
    for (const testCase of storeContractCases) {
      if (options.skip?.includes(testCase.name) === true) continue;
      runner.it(testCase.name, async () => {
        const store = await factory();
        try {
          await testCase.run(store, options);
        } finally {
          await store.dispose();
        }
      });
    }
  });
}
