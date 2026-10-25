/**
 * @staticflux/browser-test — the in-browser half of the real-browser harness.
 *
 * `*.browser.ts` files register tests with `describe`/`it` and assert with
 * `expect`; the runner (`run.ts`) loads each file in its own Chromium page,
 * calls `runRegistered()` and collects the results. The same `runRegistered`
 * works inside a dedicated worker (post its result back to the page).
 *
 * `*.scenario.ts` files run in Node and drive Playwright directly; they
 * export `scenario(ctx: ScenarioContext)`.
 *
 * Test-only: never import from package source.
 */
import type { Browser, BrowserContext } from 'playwright';

export type { Browser, BrowserContext, Page } from 'playwright';

export interface TestResult {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface SuiteResult {
  readonly tests: readonly TestResult[];
  /** A failure outside any test (import error). */
  readonly error?: string;
}

interface Registered {
  readonly name: string;
  readonly fn: () => unknown;
  readonly timeoutMs: number;
}

const registered: Registered[] = [];
const prefixes: string[] = [];

export function describe(name: string, fn: () => void): void {
  prefixes.push(name);
  try {
    fn();
  } finally {
    prefixes.pop();
  }
}

export function it(name: string, fn: () => unknown, options: { readonly timeoutMs?: number } = {}): void {
  registered.push({ name: [...prefixes, name].join(' › '), fn, timeoutMs: options.timeoutMs ?? 60_000 });
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? `Uint8Array(${v.length})` : v));
  } catch {
    return String(value);
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export interface Expectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toContain(item: unknown): void;
  toHaveLength(n: number): void;
}

export function expect(actual: unknown, label = ''): Expectation {
  const fail = (what: string): never => {
    throw new Error(`${label === '' ? '' : `${label}: `}expected ${describeValue(actual)} ${what}`);
  };
  return {
    toBe: (expected) => void (Object.is(actual, expected) || fail(`to be ${describeValue(expected)}`)),
    toEqual: (expected) => void (equal(actual, expected) || fail(`to equal ${describeValue(expected)}`)),
    toBeTruthy: () => void (Boolean(actual) || fail('to be truthy')),
    toBeFalsy: () => void (!actual || fail('to be falsy')),
    toBeGreaterThan: (n) => void ((typeof actual === 'number' && actual > n) || fail(`to be > ${n}`)),
    toBeGreaterThanOrEqual: (n) => void ((typeof actual === 'number' && actual >= n) || fail(`to be >= ${n}`)),
    toBeLessThanOrEqual: (n) => void ((typeof actual === 'number' && actual <= n) || fail(`to be <= ${n}`)),
    toContain: (item) =>
      void ((Array.isArray(actual) ? actual.some((x) => equal(x, item)) : typeof actual === 'string' && actual.includes(String(item))) ||
        fail(`to contain ${describeValue(item)}`)),
    toHaveLength: (n) => void ((actual as { length?: unknown } | null)?.length === n || fail(`to have length ${n}`)),
  };
}

/** Run every registered test in order (sequentially: OPFS state is shared). */
export async function runRegistered(): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  for (const test of registered.splice(0)) {
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${test.timeoutMs} ms`)), test.timeoutMs);
        Promise.resolve()
          .then(test.fn)
          .then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(describeValue(error)));
            },
          );
      });
      tests.push({ name: test.name, ok: true });
    } catch (error) {
      tests.push({ name: test.name, ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
  }
  return { tests };
}

/** Context handed to `*.scenario.ts` files (Node side). */
export interface ScenarioContext {
  readonly browser: Browser;
  /** A fresh browser context (one origin profile: shared OPFS, locks and BroadcastChannel across its pages). */
  newContext(): Promise<BrowserContext>;
  /** URL of a page that imports `entry` (a repo-root path such as `/packages/x/src/browser-tests/tab.page.ts`). */
  pageUrl(entry: string, query?: Readonly<Record<string, string>>): string;
  log(message: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
}
