/**
 * Shared plumbing for contract suites. Suites are test-framework neutral (like
 * storage's `runStoreContract`): pass your runner's `describe`/`it` (passing
 * `{ describe, it, expect }` from Vitest works too — `expect` is not needed).
 * Assertions throw plain `Error`s, so the package never imports Vitest at runtime.
 */
import type { Result } from '@staticflux/core';

export interface ContractRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
}

export interface ContractCaseBase<S> {
  readonly name: string;
  run(subject: S): Promise<void>;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

export function assertTrue(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function okValue<T>(result: Result<T>, message: string): T {
  if (!result.ok) throw new Error(`${message}: unexpected error ${result.error.code} ${result.error.message}`);
  return result.value;
}

export function errOf(result: Result<unknown>, message: string): Extract<Result<unknown>, { ok: false }>['error'] {
  if (result.ok) throw new Error(`${message}: expected an error, got ok(${JSON.stringify(result.value)})`);
  return result.error;
}

/** Race `promise` against a real timer (contract cases must never hang the suite). */
export function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message}: did not settle within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
