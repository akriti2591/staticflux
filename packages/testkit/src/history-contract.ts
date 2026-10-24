/**
 * History contract suite (R7.4, R16.4). Every urlstate `HistoryPort` and router
 * `HistoryAdapter` implementation (memory, History API, Navigation API, host-bridged)
 * runs it. `level: 'port'` checks the urlstate surface; `level: 'adapter'` adds the
 * router extensions (`current`, `canGo`, `go({ silent })`, `listen`).
 *
 * @example
 * runHistoryContract('router memory', (url) => createMemoryHistory({ initial: url }), { describe, it }, { level: 'adapter' });
 * runHistoryContract('urlstate memory', (url) => createMemoryHistory(url), { describe, it });
 */
import type { ExternalNavigation, HistoryAdapter } from '@staticflux/router';
import type { HistoryChange, HistoryPort } from '@staticflux/urlstate';
import { assertEqual, assertTrue, type ContractRunner, within } from './contract-runner.js';

export type HistoryContractLevel = 'port' | 'adapter';

export interface HistoryContractOptions {
  readonly level?: HistoryContractLevel;
  /** Real-timer wait for asynchronous traversals (popstate, Navigation API). Default 1000 ms. */
  readonly timeoutMs?: number;
  readonly skip?: readonly string[];
}

/** Create a history whose current entry is `initialUrl` (path + search + hash). */
export type HistoryFactory<H extends HistoryPort> = (initialUrl: string) => H | Promise<H>;

interface Subject<H> {
  readonly history: H;
  readonly initial: string;
  readonly timeoutMs: number;
}

export interface HistoryContractCase<H> {
  readonly name: string;
  readonly level: HistoryContractLevel;
  run(subject: Subject<H>): Promise<void>;
}

const INITIAL = '/start?tab=a#top';

/** Resolve with the next change emitted after `act()`. */
function nextChange(history: HistoryPort, act: () => void, timeoutMs: number, label: string): Promise<HistoryChange> {
  let stop: () => void = () => undefined;
  const changed = new Promise<HistoryChange>((resolve) => {
    stop = history.subscribe((change) => {
      stop();
      resolve(change);
    });
  });
  act();
  return within(changed, timeoutMs, label).finally(stop);
}

function nextNavigation(history: HistoryAdapter, act: () => void | Promise<void>, timeoutMs: number, label: string): Promise<ExternalNavigation> {
  let stop: () => void = () => undefined;
  const navigated = new Promise<ExternalNavigation>((resolve) => {
    stop = history.listen((navigation) => {
      stop();
      resolve(navigation);
    });
  });
  void act();
  return within(navigated, timeoutMs, label).finally(stop);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const historyContractCases: readonly HistoryContractCase<HistoryPort>[] = [
  {
    name: 'starts at the initial url (path + search + hash)',
    level: 'port',
    async run({ history, initial }) {
      assertEqual(history.url, initial, 'url');
      assertTrue(['navigation', 'history', 'memory'].includes(history.kind), `kind "${history.kind}"`);
    },
  },
  {
    name: 'push changes the url and reports cause + source',
    level: 'port',
    async run({ history, timeoutMs }) {
      const change = await nextChange(history, () => history.push('/next?x=1', { source: 'urlstate' }), timeoutMs, 'push');
      assertEqual(history.url, '/next?x=1', 'url after push');
      assertEqual(change, { url: '/next?x=1', cause: 'push', source: 'urlstate' }, 'change');
    },
  },
  {
    name: 'writes without a source are reported as external',
    level: 'port',
    async run({ history, timeoutMs }) {
      const change = await nextChange(history, () => history.push('/other'), timeoutMs, 'push');
      assertEqual(change.source, 'external', 'source');
    },
  },
  {
    name: 'replace changes the url without adding an entry',
    level: 'port',
    async run({ history, timeoutMs }) {
      const change = await nextChange(history, () => history.replace('/replaced', { source: 'router' }), timeoutMs, 'replace');
      assertEqual(change, { url: '/replaced', cause: 'replace', source: 'router' }, 'change');
      assertEqual(history.url, '/replaced', 'url');
      assertEqual(history.canGoBack, false, 'no entry was added');
    },
  },
  {
    name: 'canGoBack is false at the first entry and true after a push',
    level: 'port',
    async run({ history }) {
      assertEqual(history.canGoBack, false, 'initially');
      history.push('/a');
      assertEqual(history.canGoBack, true, 'after push');
    },
  },
  {
    name: 'back returns to the previous entry and reports a pop',
    level: 'port',
    async run({ history, initial, timeoutMs }) {
      history.push('/a');
      history.push('/b');
      const change = await nextChange(history, () => history.back(), timeoutMs, 'back');
      assertEqual(change.cause, 'pop', 'cause');
      assertEqual(change.url, '/a', 'change url');
      assertEqual(history.url, '/a', 'url');
      await nextChange(history, () => history.back(), timeoutMs, 'back again');
      assertEqual(history.url, initial, 'back at the start');
      assertEqual(history.canGoBack, false, 'canGoBack at the start');
    },
  },
  {
    name: 'replace after push keeps the back stack',
    level: 'port',
    async run({ history, initial, timeoutMs }) {
      history.push('/a');
      history.replace('/a2');
      await nextChange(history, () => history.back(), timeoutMs, 'back');
      assertEqual(history.url, initial, 'url');
    },
  },
  {
    name: 'unsubscribe stops notifications; listeners are independent',
    level: 'port',
    async run({ history }) {
      const first: string[] = [];
      const second: string[] = [];
      const stopFirst = history.subscribe((c) => first.push(c.url));
      const stopSecond = history.subscribe((c) => second.push(c.url));
      history.push('/one');
      stopFirst();
      history.push('/two');
      stopSecond();
      history.push('/three');
      assertEqual(first, ['/one'], 'first listener');
      assertEqual(second, ['/one', '/two'], 'second listener');
    },
  },
  {
    name: 'dispose is idempotent',
    level: 'port',
    async run({ history }) {
      history.dispose();
      history.dispose();
    },
  },
];

export const historyAdapterContractCases: readonly HistoryContractCase<HistoryAdapter>[] = [
  {
    name: 'current entry tracks url, index, key and state',
    level: 'adapter',
    async run({ history, initial }) {
      const start = history.current;
      assertEqual(start.url, initial, 'initial current.url');
      history.push('/a', { state: { from: 'test' } });
      assertEqual(history.current.url, '/a', 'current.url');
      assertEqual(history.current.index, start.index + 1, 'index increments on push');
      assertTrue(history.current.key !== start.key, 'a new entry has a new key');
      assertEqual(history.current.state, { from: 'test' }, 'state');
      history.replace('/a2', { state: 2 });
      assertEqual(history.current.index, start.index + 1, 'index unchanged on replace');
      assertEqual(history.current.state, 2, 'replaced state');
    },
  },
  {
    name: 'canGo reflects both directions; push after back drops forward entries',
    level: 'adapter',
    async run({ history, timeoutMs }) {
      assertEqual(history.canGo(-1), false, 'no back at start');
      assertEqual(history.canGo(1), false, 'no forward at start');
      history.push('/a');
      history.push('/b');
      assertEqual(history.canGo(-2), true, 'two back');
      await within(history.go(-1, { silent: true }), timeoutMs, 'silent go');
      assertEqual(history.canGo(1), true, 'forward after back');
      history.push('/c');
      assertEqual(history.canGo(1), false, 'forward dropped by push');
      assertEqual(history.url, '/c', 'url');
    },
  },
  {
    name: 'silent go moves without reaching listen',
    level: 'adapter',
    async run({ history, timeoutMs }) {
      history.push('/a');
      const navigations: ExternalNavigation[] = [];
      const stop = history.listen((n) => navigations.push(n));
      await within(history.go(-1, { silent: true }), timeoutMs, 'silent go');
      await tick();
      stop();
      assertEqual(navigations.length, 0, 'listen calls');
      assertEqual(history.canGo(1), true, 'moved back');
    },
  },
  {
    name: 'a non-silent traversal reaches listen with its target and delta',
    level: 'adapter',
    async run({ history, timeoutMs }) {
      history.push('/a');
      history.push('/b');
      const navigation = await nextNavigation(history, () => history.back(), timeoutMs, 'back → listen');
      assertEqual(navigation.type, 'traverse', 'type');
      assertEqual(navigation.url, '/a', 'url');
      assertEqual(navigation.delta, -1, 'delta');
    },
  },
  {
    name: 'out-of-range go is a no-op',
    level: 'adapter',
    async run({ history, initial, timeoutMs }) {
      await within(history.go(-5, { silent: true }), timeoutMs, 'go(-5)');
      assertEqual(history.url, initial, 'url');
    },
  },
];

export function runHistoryContract<H extends HistoryPort>(
  name: string,
  factory: HistoryFactory<H>,
  runner: ContractRunner,
  options: HistoryContractOptions = {},
): void {
  const level = options.level ?? 'port';
  const skip = new Set(options.skip ?? []);
  const timeoutMs = options.timeoutMs ?? 1_000;
  const cases: HistoryContractCase<HistoryPort>[] = [
    ...historyContractCases,
    ...(level === 'adapter' ? (historyAdapterContractCases as readonly HistoryContractCase<unknown>[] as readonly HistoryContractCase<HistoryPort>[]) : []),
  ];
  runner.describe(`history contract (${level}): ${name}`, () => {
    for (const contractCase of cases) {
      if (skip.has(contractCase.name)) continue;
      runner.it(contractCase.name, async () => {
        const history = await factory(INITIAL);
        try {
          await contractCase.run({ history, initial: INITIAL, timeoutMs });
        } finally {
          history.dispose();
        }
      });
    }
  });
}
